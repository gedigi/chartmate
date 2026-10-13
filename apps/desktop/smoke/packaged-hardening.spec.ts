// Checks on the UNMODIFIED packaged artifact (SMOKE_HARDENED_APP=<Chartmate.app | chartmate.exe>): it starts, opens
// no listening socket, and refuses or ignores the classic code-injection switches and variables.
//
// Packaged builds ignore ALTV_USER_DATA_DIR, so these tests run against the real per-user data directories (current
// and previous product names). They are moved aside first and put back afterwards; nothing is deleted (the run's
// own directory is renamed to *.smoke-trash-<timestamp>). Runs only in CI or with SMOKE_ALLOW_REAL_USERDATA=1, and
// the app must not be running.
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, cpSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { debugEndpointKind, defaultUserDataDir, executableOf, isolateUserData, listeningSockets, processTree, realUserDataAllowed } from './helpers.js';

const appPath = process.env.SMOKE_HARDENED_APP;
test.skip(!appPath, 'set SMOKE_HARDENED_APP to a packaged app');
test.skip(!realUserDataAllowed, 'uses the real per-user data directory: runs in CI, or locally with SMOKE_ALLOW_REAL_USERDATA=1');

const exe = () => executableOf(appPath!);
const userData = defaultUserDataDir();
const logFile = join(userData, 'logs', 'main.log');

let restore: (() => void) | null = null;
test.beforeAll(() => {
  restore = isolateUserData();
});
test.afterAll(() => {
  restore?.();
});

const FORBIDDEN_ENV = ['NODE_USE_ENV_PROXY', 'NODE_USE_SYSTEM_CA', 'NODE_EXTRA_CA_CERTS', 'SSLKEYLOGFILE', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'];

let logStart = 0;
const fullLog = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '');

function start(env: Record<string, string>, args: string[] = [], bin = exe()) {
  logStart = fullLog().length; // only lines written by this launch count

  const base = { ...process.env, ALTV_PROVIDERS: 'fixture' } as Record<string, string>;
  for (const k of FORBIDDEN_ENV) delete base[k];
  const child = spawn(bin, args, { env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout!.on('data', (d) => { output += String(d); });
  child.stderr!.on('data', (d) => { output += String(d); });
  return { child, output: () => output };
}

async function waitFor(fn: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

const log = () => fullLog().slice(logStart);
const shown = () => /startup: window shown \d+ ms/.test(log());

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500)); // let helpers exit and the single-instance lock go away
}

test('uses the per-user data directory even when ALTV_USER_DATA_DIR is set', async () => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'chartmate-ignored-'));
  const { child } = start({ ALTV_USER_DATA_DIR: elsewhere });
  try {
    expect(await waitFor(shown, 30_000)).toBe(true);
    expect(existsSync(join(userData, 'altv.db'))).toBe(true);
    expect(existsSync(join(elsewhere, 'altv.db'))).toBe(false);
  } finally {
    await stop(child);
  }
});

test('starts, shows the window, and has NO listening TCP socket in any of its processes', async () => {
  const t = Date.now();
  const { child } = start({});
  try {
    expect(await waitFor(shown, 30_000)).toBe(true);
    const m = /startup: window shown (\d+) ms/.exec(log());
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
  const { child } = start({ ELECTRON_RUN_AS_NODE: '1' }, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]);
  try {
    expect(await waitFor(shown, 30_000)).toBe(true); // it ran as the app instead
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
  const { child } = start({ NODE_OPTIONS: `--require ${evil}` });
  try {
    expect(await waitFor(shown, 30_000)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  } finally {
    await stop(child);
  }
});

/**
 * Starts the shipped app and expects it to refuse: the reason on stderr (also shown in a native error box, which
 * keeps the process alive until dismissed, so the harness kills it), no window, no debugger, no listener at all.
 * The exit code (1) after the box is dismissed is covered by test/startupGuards.test.ts.
 */
async function expectRefused(args: string[], env: Record<string, string> = {}, what = /forbidden command-line switch/): Promise<string> {
  const { child, output } = start(env, args);
  try {
    expect(await waitFor(() => /refusing to start/.test(output()) || child.exitCode !== null, 15_000), `${args.join(' ')} ${JSON.stringify(env)} should be refused`).toBe(true);
    expect(output()).toMatch(what);
    await new Promise((r) => setTimeout(r, 1000));
    expect(shown()).toBe(false);
    expect(output()).not.toMatch(/Debugger listening/);
    if (child.exitCode === null) {
      // Still alive (error box open): it must not be listening anywhere, CDP included.
      const listeners = listeningSockets(processTree(child.pid!));
      expect(listeners, 'listeners while refused').toEqual([]);
    } else {
      expect(child.exitCode).toBe(1);
    }
    return output();
  } finally {
    await stop(child);
  }
}

// The switch guard (src/boot.ts) is also why no test harness can attach to the shipped app; the functional smoke
// test drives a separately prepared TEST-ONLY copy (smoke/prepare-inspectable.mjs).
test('switch guard: --remote-debugging-port=0 → refused, no CDP endpoint reachable', async () => {
  const out = await expectRefused(['--remote-debugging-port=0']);
  const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(out);
  if (m) {
    // Chromium may announce the port before the guard runs; nothing may answer on it.
    expect(await debugEndpointKind(Number(m[1]))).toBe('unknown');
  }
});

test('switch guard + inspect fuse: --inspect / --inspect-brk are refused without a debugger', async () => {
  await expectRefused(['--inspect=0']);
  await expectRefused(['--inspect-brk=0']);
});

test('switch guard: sandbox/web-security/feature/TLS/proxy/profile switches are refused', async () => {
  for (const a of ['--no-sandbox', '--disable-web-security', '--disable-features=TrustedDOMTypes', '--enable-features=X',
    '--disable-gpu-sandbox', '--allow-file-access-from-files', '--ssl-key-log-file=/tmp/k', '--proxy-server=http://127.0.0.1:9',
    '--user-data-dir=/tmp/x', '--remote-debugging-pipe', '-js-flags=--expose-gc']) {
    await expectRefused([a]);
  }
});

test('switch guard (Windows): /switch syntax is refused too', async () => {
  test.skip(process.platform !== 'win32', 'the /switch form only exists on Windows');
  await expectRefused(['/remote-debugging-port=0']);
  await expectRefused(['/no-sandbox']);
});

test('environment guard: proxy/system-CA/TLS-key-log variables are refused', async () => {
  for (const [k, v] of [['NODE_USE_ENV_PROXY', '1'], ['NODE_USE_SYSTEM_CA', '1'], ['SSLKEYLOGFILE', join(tmpdir(), 'keys.log')]] as const) {
    await expectRefused([], { [k]: v }, new RegExp(`forbidden environment variable\\(s\\): ${k}`));
  }
});

// Electron's EnableNodeOptionsEnvironmentVariable fuse (off) covers NODE_EXTRA_CA_CERTS as well as NODE_OPTIONS:
// Electron drops it before Node starts, so it never reaches app code (and the provider fetch pins the bundled
// roots anyway). The app therefore starts normally instead of hitting the environment guard.
test('NodeOptions fuse: NODE_EXTRA_CA_CERTS is dropped before the app runs', async () => {
  const { child, output } = start({ NODE_EXTRA_CA_CERTS: join(tmpdir(), 'ca.pem') });
  try {
    expect(await waitFor(shown, 30_000)).toBe(true);
    expect(output()).not.toMatch(/refusing to start/);
  } finally {
    await stop(child);
  }
});

test('auto-updater presence matches the build signing (SMOKE_EXPECT_UNSIGNED)', async () => {
  const expect_ = process.env.SMOKE_EXPECT_UNSIGNED;
  test.skip(expect_ !== '1' && expect_ !== '0', 'set SMOKE_EXPECT_UNSIGNED=1 (unsigned build) or 0 (signed build)');
  const asar = (await import('@electron/asar')).default;
  const archive = appPath!.endsWith('.app') ? join(appPath!, 'Contents', 'Resources', 'app.asar') : join(dirname(exe()), 'resources', 'app.asar');
  const files = asar.listPackage(archive, { isPack: false });
  const main = asar.extractFile(archive, 'dist/main.cjs').toString('utf8');
  if (expect_ === '1') {
    expect(files.some((f) => f.includes('updater'))).toBe(false);
    expect(main).not.toContain('updater.cjs');
    expect(main).not.toContain('electron-updater');
  } else {
    expect(files.some((f) => /dist[\\/]updater\.cjs$/.test(f))).toBe(true);
    expect(main).toContain('updater.cjs');
  }
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
  const { child } = start({}, [], executableOf(copy));
  try {
    const exited = await waitFor(() => child.exitCode !== null || child.signalCode !== null, 20_000);
    expect(shown()).toBe(false);
    expect(exited).toBe(true);
  } finally {
    await stop(child);
  }
});
