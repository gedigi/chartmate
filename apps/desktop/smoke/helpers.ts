import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
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
  if (process.platform === 'win32') return out;
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

/** TCP sockets in LISTEN state owned by any of `pids` (lsof; macOS/Linux). */
export function listeningSockets(pids: number[]): Listener[] {
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
