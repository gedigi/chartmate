/**
 * Chromium/Node command-line switches a packaged build refuses to start with. Each of them either opens a debug
 * channel into the app (CDP, inspector), weakens the sandbox or web security, redirects or intercepts its network
 * traffic, loads foreign code, or relocates its profile. The fuses cover the Node-side equivalents
 * (ELECTRON_RUN_AS_NODE, NODE_OPTIONS, --inspect); Chromium switches have no fuse, so they are checked here,
 * before anything else runs.
 */
export const FORBIDDEN_SWITCHES: readonly string[] = Object.freeze([
  'remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'remote-allow-origins',
  'inspect', // also inspect-brk, inspect-port, inspect-publish-uid … (prefix match below)
  'js-flags',
  'no-sandbox', 'disable-web-security', 'disable-site-isolation-trials',
  'ignore-certificate-errors', 'ignore-certificate-errors-spki-list', 'allow-insecure-localhost',
  'unsafely-treat-insecure-origin-as-secure',
  'proxy-server', 'proxy-pac-url', 'host-resolver-rules', 'host-rules',
  'load-extension', 'enable-blink-features',
  'renderer-cmd-prefix', 'utility-cmd-prefix', 'gpu-launcher', 'browser-subprocess-path',
  'log-net-log', 'user-data-dir',
]);

const PREFIXES: readonly string[] = ['inspect'];

function matches(name: string): string | null {
  if (FORBIDDEN_SWITCHES.includes(name)) return name;
  for (const p of PREFIXES) if (name.startsWith(`${p}-`)) return name;
  return null;
}

/**
 * Forbidden switches in `argv` (Chromium syntax: `--x`, `-x`, and `/x` on Windows; `--` ends switch parsing) and,
 * optionally, among the switches Chromium itself already parsed (`app.commandLine.hasSwitch`).
 */
export function findForbiddenSwitches(argv: readonly string[], platform: NodeJS.Platform = process.platform, hasSwitch?: (name: string) => boolean): string[] {
  const found = new Set<string>();
  for (const arg of argv.slice(1)) {
    if (arg === '--') break;
    let body: string | null = null;
    if (arg.startsWith('--')) body = arg.slice(2);
    else if (arg.startsWith('-')) body = arg.slice(1);
    else if (platform === 'win32' && arg.startsWith('/')) body = arg.slice(1);
    if (body === null || body === '') continue;
    const name = body.split('=', 1)[0]!.toLowerCase();
    const hit = matches(name);
    if (hit) found.add(hit);
  }
  if (hasSwitch) for (const s of FORBIDDEN_SWITCHES) if (hasSwitch(s)) found.add(s);
  return [...found];
}

/** Variables that would let the environment proxy or re-root TLS for the main process's outbound requests. */
export const STRIPPED_ENV_VARS: readonly string[] = Object.freeze(['NODE_USE_ENV_PROXY', 'NODE_USE_SYSTEM_CA', 'NODE_EXTRA_CA_CERTS']);

/** Deletes STRIPPED_ENV_VARS from `env`; returns the names that were present. */
export function sanitizeEnv(env: Record<string, string | undefined>): string[] {
  const removed: string[] = [];
  for (const k of STRIPPED_ENV_VARS) {
    if (k in env) {
      delete env[k];
      removed.push(k);
    }
  }
  return removed;
}
