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

// This is also why Playwright's _electron.launch (which waits for "Debugger listening") cannot drive the shipped
// artifact; the functional smoke test uses a copy with only this fuse flipped (prepare-inspectable.mjs).
test('Inspect fuse: --inspect / --inspect-brk open no debugger', async () => {
  const { child, userData, output } = start({}, ['--inspect=0', '--inspect-brk=0']);
  try {
    expect(await waitFor(() => shown(userData), 30_000)).toBe(true);
    expect(output()).not.toMatch(/Debugger listening/);
    expect(listeningSockets(processTree(child.pid!))).toEqual([]);
  } finally {
    await stop(child);
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
  const { child, userData } = start({}, [], executableOf(copy));
  try {
    const exited = await waitFor(() => child.exitCode !== null || child.signalCode !== null, 20_000);
    expect(shown(userData)).toBe(false);
    expect(exited).toBe(true);
  } finally {
    await stop(child);
  }
});
