/**
 * Chromium/Node command-line switches a packaged build refuses to start with. Each of them either opens a debug
 * channel into the app (CDP, inspector), weakens the sandbox, site isolation, web security or TLS, toggles engine
 * features (which can switch security features off), redirects or records its network traffic, loads foreign
 * code, or relocates its profile. The fuses cover the Node-side equivalents (ELECTRON_RUN_AS_NODE, NODE_OPTIONS,
 * --inspect); Chromium switches have no fuse, so they are checked here, before anything else runs.
 */
export const FORBIDDEN_SWITCHES: readonly string[] = Object.freeze([
  // Debugging / automation channels
  'remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'remote-allow-origins',
  'remote-debugging-targets', 'auto-open-devtools-for-tabs', 'enable-automation',
  'inspect', // also inspect-brk, inspect-port, inspect-publish-uid … (prefix match below)
  'js-flags',
  // Sandbox / process model
  'no-sandbox', 'disable-gpu-sandbox', 'disable-setuid-sandbox', 'disable-seccomp-filter-sandbox',
  'disable-namespace-sandbox', 'no-zygote', 'single-process', 'in-process-gpu',
  // Web security / isolation / engine features
  'disable-web-security', 'disable-site-isolation-trials', 'allow-file-access-from-files', 'allow-file-access',
  'allow-running-insecure-content', 'reduce-security-for-testing', 'unsafely-treat-insecure-origin-as-secure',
  'enable-features', 'disable-features', 'force-fieldtrials', 'force-fieldtrial-params',
  'enable-blink-features', 'disable-blink-features', 'enable-experimental-web-platform-features',
  'enable-unsafe-webgpu', 'enable-unsafe-swiftshader',
  // TLS
  'ignore-certificate-errors', 'ignore-certificate-errors-spki-list', 'allow-insecure-localhost',
  'ssl-key-log-file', 'ssl-version-min', 'ssl-version-max', 'cipher-suite-blacklist',
  // Network redirection / capture
  'proxy-server', 'proxy-pac-url', 'proxy-bypass-list', 'proxy-auto-detect', 'winhttp-proxy-resolver',
  'host-resolver-rules', 'host-rules', 'log-net-log',
  // Foreign code
  'load-extension', 'renderer-cmd-prefix', 'utility-cmd-prefix', 'gpu-launcher', 'browser-subprocess-path',
  // Profile relocation
  'user-data-dir', 'disk-cache-dir',
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

/**
 * Environment variables a packaged build refuses to start with. Node acts on NODE_USE_ENV_PROXY during
 * pre-execution, before any app code runs (global proxy dispatcher), so it cannot be neutralized by deleting it
 * later; SSLKEYLOGFILE would make TLS session keys loggable. NODE_USE_SYSTEM_CA is allowed: it is common in
 * developer and corporate environments (refusing it made the app silently fail to open), and it has no effect on
 * provider traffic, which pins the bundled root CAs (directFetch.ts).
 * NODE_EXTRA_CA_CERTS is normally removed by Electron already (the EnableNodeOptionsEnvironmentVariable fuse covers
 * it), and stays listed as defense in depth. The provider fetch also ignores proxies and pins the bundled root CAs
 * regardless (directFetch.ts).
 */
export const FORBIDDEN_ENV_VARS: readonly string[] = Object.freeze(['NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSLKEYLOGFILE']);

/** Forbidden variables that are set to a non-empty value. */
export function findForbiddenEnv(env: Record<string, string | undefined>): string[] {
  return FORBIDDEN_ENV_VARS.filter((k) => typeof env[k] === 'string' && env[k]!.trim() !== '');
}

export interface StartupGuardDeps {
  isPackaged: boolean;
  /** False only in the TEST-ONLY inspectable copy (the switch check is compiled out there). */
  checkSwitches: boolean;
  argv: readonly string[];
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  productName: string;
  /** `dialog.showErrorBox` (safe before `ready`). */
  showError: (title: string, content: string) => void;
  writeStderr: (line: string) => void;
  exit: (code: number) => never;
}

/**
 * Packaged builds refuse to start with a forbidden environment variable or command-line switch: the reason goes to
 * stderr and to a native error box naming the offending items, then the process exits with code 1.
 */
export function runStartupGuards(d: StartupGuardDeps): void {
  if (!d.isPackaged) return;
  const refuse = (kind: string, items: string[], hint: string) => {
    d.writeStderr(`refusing to start: forbidden ${kind}: ${items.join(', ')}\n`);
    d.showError(`${d.productName} cannot start`,
      `For security reasons, ${d.productName} does not run with the following ${kind}:\n\n${items.join('\n')}\n\n${hint}`);
    d.exit(1);
  };
  const env = findForbiddenEnv(d.env);
  if (env.length > 0) refuse('environment variable(s)', env, 'Unset them and start the app again.');
  if (d.checkSwitches) {
    const sw = findForbiddenSwitches(d.argv, d.platform);
    if (sw.length > 0) refuse('command-line switch(es)', sw.map((s) => `--${s}`), 'Start the app without them.');
  }
}
