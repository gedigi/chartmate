import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Path of the executable inside a packaged app (macOS .app bundle or a Windows/Linux executable). */
export function executableOf(app: string): string {
  if (app.endsWith('.app')) {
    const dir = join(app, 'Contents', 'MacOS');
    const exe = readdirSync(dir)[0];
    if (!exe) throw new Error(`no executable in ${dir}`);
    return join(dir, exe);
  }
  if (!existsSync(app)) throw new Error(`not found: ${app}`);
  return app;
}

/** The process and all its descendants (Electron helpers: renderer, GPU, network/utility processes). */
export function processTree(pid: number): number[] {
  const out = [pid];
  if (process.platform === 'win32') {
    // ParentProcessId pairs from CIM (wmic is gone on current Windows).
    const json = execFileSync('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { encoding: 'utf8' });
    const rows = JSON.parse(json) as { ProcessId: number; ParentProcessId: number }[];
    for (let i = 0; i < out.length; i++) for (const r of rows) if (r.ParentProcessId === out[i] && !out.includes(r.ProcessId)) out.push(r.ProcessId);
    return out;
  }
  for (let i = 0; i < out.length; i++) {
    let children = '';
    try {
      children = execFileSync('pgrep', ['-P', String(out[i])], { encoding: 'utf8' });
    } catch { /* no children */ }
    for (const c of children.split('\n').map((s) => Number(s.trim())).filter((n) => n > 0)) out.push(c);
  }
  return out;
}

export interface Listener { pid: number; port: number; name: string }

/** TCP sockets in LISTEN state owned by any of `pids` (lsof on macOS/Linux, netstat on Windows). */
export function listeningSockets(pids: number[]): Listener[] {
  if (process.platform === 'win32') {
    const res: Listener[] = [];
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
      if (m && pids.includes(Number(m[3]))) res.push({ pid: Number(m[3]), port: Number(m[2]), name: `${m[1]}:${m[2]}` });
    }
    const out6 = execFileSync('netstat', ['-ano', '-p', 'TCPv6'], { encoding: 'utf8' });
    for (const line of out6.split(/\r?\n/)) {
      const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
      if (m && pids.includes(Number(m[3]))) res.push({ pid: Number(m[3]), port: Number(m[2]), name: `${m[1]}:${m[2]}` });
    }
    return res;
  }
  let out = '';
  try {
    out = execFileSync('lsof', ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN', '-F', 'pn'], { encoding: 'utf8' });
  } catch (err) {
    // lsof exits 1 when nothing matches.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
  const res: Listener[] = [];
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (line.startsWith('n')) {
      const port = Number(line.slice(line.lastIndexOf(':') + 1));
      res.push({ pid, port, name: line.slice(1) });
    }
  }
  return res;
}

/** What answers on a local debug port: 'cdp' (Chromium DevTools), 'node-inspector', or 'unknown'. */
export async function debugEndpointKind(port: number): Promise<'cdp' | 'node-inspector' | 'unknown'> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    const j = (await r.json()) as Record<string, string>;
    if (typeof j['Browser'] === 'string' && typeof j['webSocketDebuggerUrl'] === 'string') return 'cdp';
    if (typeof j['Browser'] === 'string' && j['Browser'].startsWith('node.js')) return 'node-inspector';
    if (j['Protocol-Version'] && !j['webSocketDebuggerUrl']) return 'node-inspector';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Launches a packaged app with Chromium's --remote-debugging-port=0 and returns the DevTools WebSocket URL. Only
 * works on the TEST-ONLY inspectable copy (smoke/prepare-inspectable.mjs): the shipped app exits on this switch.
 * (Playwright's _electron.launch is not used for packaged builds: it needs the Node inspector, which the
 * EnableNodeCliInspectArguments fuse disables in every packaged build, the test copy included.)
 */
export async function spawnWithCdp(exe: string, env: Record<string, string>): Promise<{ child: ChildProcess; wsUrl: string }> {
  const child = spawn(exe, ['--remote-debugging-port=0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`no DevTools URL after 30s:\n${buf}`)), 30_000);
    const onData = (d: Buffer) => {
      buf += String(d);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    };
    child.stderr!.on('data', onData);
    child.stdout!.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`exited with ${code}:\n${buf}`));
    });
  });
  return { child, wsUrl };
}

const product = JSON.parse(readFileSync(new URL('../product.json', import.meta.url), 'utf8')) as {
  productName: string; previousProductNames: string[];
};

/** The per-user data directory a packaged build always uses (packaged builds ignore ALTV_USER_DATA_DIR). */
export function defaultUserDataDir(productName = product.productName): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', productName);
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), productName);
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), productName);
}

/** The current data directory plus those of previous product names (which the app migrates data from). */
export function userDataDirsTouchedByApp(): string[] {
  return [defaultUserDataDir(), ...product.previousProductNames.map((n) => defaultUserDataDir(n))];
}

/** True when the hardened spec may run against the real per-user directories (CI, or explicit local opt-in). */
export const realUserDataAllowed = process.env.CI === 'true' || process.env.SMOKE_ALLOW_REAL_USERDATA === '1';

/** renameSync with retries (Windows reports EBUSY/EPERM while a just-exited process still holds handles). */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); // synchronous sleep
    }
  }
}

/**
 * Moves the app's real per-user data directories (current and legacy names) aside for a test run and puts them
 * back afterwards. Nothing is ever deleted: the directory the tests created is renamed to a timestamped
 * `*.smoke-trash-*` sibling (safe to remove by hand). Refuses to run over a leftover backup.
 */
export function isolateUserData(dirs: readonly string[] = userDataDirsTouchedByApp()): () => void {
  const moved: { dir: string; backup: string }[] = [];
  for (const dir of dirs) {
    const backup = `${dir}.smoke-backup`;
    if (existsSync(backup)) throw new Error(`leftover backup ${backup}: move it back to ${dir} (or remove it) first`);
  }
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const backup = `${dir}.smoke-backup`;
    renameWithRetry(dir, backup);
    moved.push({ dir, backup });
  }
  return () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const errors: unknown[] = [];
    for (const dir of dirs) {
      try {
        if (existsSync(dir)) renameWithRetry(dir, `${dir}.smoke-trash-${stamp}`);
      } catch (err) {
        errors.push(err);
      }
    }
    for (const { dir, backup } of moved) {
      try {
        renameWithRetry(backup, dir);
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) throw new Error(`user data restore incomplete (backups are kept as *.smoke-backup): ${errors.map(String).join('; ')}`);
  };
}
