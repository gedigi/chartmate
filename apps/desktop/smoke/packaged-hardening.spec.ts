// Checks on the UNMODIFIED packaged artifact (SMOKE_HARDENED_APP=<Chartmate.app>): it starts, opens no listening
// socket at all, and ignores the classic code-injection switches that the fuses disable.
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, closeSync, writeFileSync, writeSync, fstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { executableOf, listeningSockets, processTree } from './helpers.js';

const appPath = process.env.SMOKE_HARDENED_APP;
test.skip(!appPath, 'set SMOKE_HARDENED_APP to a packaged app');

const exe = () => executableOf(appPath!);

function start(env: Record<string, string>, args: string[] = [], bin = exe()) {
  const userData = mkdtempSync(join(tmpdir(), 'chartmate-hard-'));
  const fullEnv = { ...process.env, ALTV_USER_DATA_DIR: userData, ALTV_PROVIDERS: 'fixture', ...env } as Record<string, string>;
  const child = spawn(bin, args, { env: fullEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout!.on('data', (d) => { output += String(d); });
  child.stderr!.on('data', (d) => { output += String(d); });
  return { child, userData, output: () => output };
}

async function waitFor(fn: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

const logOf = (dir: string) => (existsSync(join(dir, 'logs', 'main.log')) ? readFileSync(join(dir, 'logs', 'main.log'), 'utf8') : '');
const shown = (dir: string) => /startup: window shown \d+ ms/.test(logOf(dir));

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 10_000);
  if (child.exitCode === null) child.kill('SIGKILL');
}

test('starts, shows the window, and has NO listening TCP socket in any of its processes', async () => {
  const t = Date.now();
  const { child, userData } = start({});
  try {
    expect(await waitFor(() => shown(userData), 30_000)).toBe(true);
    const m = /startup: window shown (\d+) ms/.exec(logOf(userData));
    console.log(`[hardened] cold start → window shown: ${m?.[1]} ms (main-process clock), ${Date.now() - t} ms wall`);
    await new Promise((r) => setTimeout(r, 2000)); // let the renderer finish loading and fetching
    const pids = processTree(child.pid!);
    const listeners = listeningSockets(pids);
    console.log(`[hardened] processes=${pids.length} listeners=${JSON.stringify(listeners)}`);
    expect(pids.length).toBeGreaterThanOrEqual(3);
    expect(listeners).toEqual([]);
  } finally {
    await stop(child);
  }
});

test('RunAsNode fuse: ELECTRON_RUN_AS_NODE does not turn the binary into node', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'chartmate-m-')), 'pwned');
  const { child, userData } = start({ ELECTRON_RUN_AS_NODE: '1' }, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]);
  try {
    expect(await waitFor(() => shown(userData), 30_000)).toBe(true); // it ran as the app instead
    expect(existsSync(marker)).toBe(false);
  } finally {
    await stop(child);
  }
});

test('NodeOptions fuse: NODE_OPTIONS --require is ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chartmate-m-'));
  const marker = join(dir, 'pwned');
  const evil = join(dir, 'evil.cjs');
  writeFileSync(evil, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`);
  const { child, userData } = start({ NODE_OPTIONS: `--require ${evil}` });
  try {
    expect(await waitFor(() => shown(userData), 30_000)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  } finally {
    await stop(child);
  }
});

/** Starts the shipped app with `args` and expects it to refuse: exit code 1, no window, no debugger. */
async function expectRefused(args: string[]): Promise<string> {
  const { child, userData, output } = start({}, args);
  try {
    expect(await waitFor(() => child.exitCode !== null, 15_000), `${args.join(' ')} should exit`).toBe(true);
    expect(child.exitCode).toBe(1);
    expect(shown(userData)).toBe(false);
    expect(output()).toMatch(/refusing to start: forbidden command-line switch/);
    expect(output()).not.toMatch(/Debugger listening/);
    return output();
  } finally {
    await stop(child);
  }
}

// The switch guard (src/boot.ts) is also why no test harness can attach to the shipped app; the functional smoke
// test drives a separately prepared TEST-ONLY copy (smoke/prepare-inspectable.mjs).
test('switch guard: --remote-debugging-port=0 → exits 1 and no CDP endpoint is reachable', async () => {
  const out = await expectRefused(['--remote-debugging-port=0']);
  const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(out);
  if (m) {
    // Chromium may announce the port before the guard runs; it must be gone with the process.
    const reachable = await fetch(`http://127.0.0.1:${m[1]}/json/version`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
    expect(reachable).toBe(false);
  }
});

test('switch guard + inspect fuse: --inspect / --inspect-brk exit 1 without a debugger', async () => {
  await expectRefused(['--inspect=0']);
  await expectRefused(['--inspect-brk=0']);
});

test('switch guard: sandbox/web-security/proxy/profile switches are refused', async () => {
  for (const a of ['--no-sandbox', '--disable-web-security', '--proxy-server=http://127.0.0.1:9', '--user-data-dir=/tmp/x', '--remote-debugging-pipe', '-js-flags=--expose-gc']) {
    await expectRefused([a]);
  }
});

test('unsigned build: the auto-updater is not in the package at all', async () => {
  const asar = (await import('@electron/asar')).default;
  const archive = appPath!.endsWith('.app') ? join(appPath!, 'Contents', 'Resources', 'app.asar') : join(appPath!, '..', 'resources', 'app.asar');
  const files = asar.listPackage(archive, { isPack: false });
  expect(files.some((f) => f.includes('updater'))).toBe(false);
  const main = asar.extractFile(archive, 'dist/main.cjs').toString('utf8');
  expect(main).not.toContain('updater.cjs');
  expect(main).not.toContain('electron-updater');
});

test('ASAR integrity: a tampered app.asar refuses to run', async () => {
  test.skip(process.platform !== 'darwin', 'macOS bundle layout');
  const dir = mkdtempSync(join(tmpdir(), 'chartmate-tamper-'));
  const copy = join(dir, 'Chartmate.app');
  cpSync(appPath!, copy, { recursive: true, verbatimSymlinks: true });
  // Flip one byte near the end of the archive (file data, not the header).
  const asar = join(copy, 'Contents', 'Resources', 'app.asar');
  const fd = openSync(asar, 'r+');
  const pos = fstatSync(fd).size - 100;
  const b = Buffer.alloc(1);
  readSync(fd, b, 0, 1, pos);
  b[0] = b[0]! ^ 0xff;
  writeSync(fd, b, 0, 1, pos);
  closeSync(fd);
  const { child, userData } = start({}, [], executableOf(copy));
  try {
    const exited = await waitFor(() => child.exitCode !== null || child.signalCode !== null, 20_000);
    expect(shown(userData)).toBe(false);
    expect(exited).toBe(true);
  } finally {
    await stop(child);
  }
});
