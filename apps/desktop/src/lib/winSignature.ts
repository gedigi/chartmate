import { win32 } from 'node:path';
import { isNewerVersion, parseSemver } from './semver.js';

/**
 * Windows update signature check, replacing electron-updater's default verifier (which skips the check when
 * PowerShell cannot run, and accepts a CN-only publisher match). This one fails CLOSED: any error, timeout,
 * stderr output (other than CLIXML progress records), unparsable result, status other than Valid, path mismatch,
 * subject mismatch, or an installer version that is not the advertised one and newer than the running app refuses
 * the installer. The publisher is pinned by its distinguished name (at least CN, O and C), baked in at build time.
 * Pure: the process runner is injected.
 */

/** Distinguished name as attribute type (upper case) → values, in order. */
export type Dn = Map<string, string[]>;

/** Parses a subject as Windows/.NET prints it (`CN="a, b", O=x, C=PL`; `\,` escapes too). Null when malformed. */
export function parseDn(s: unknown): Dn | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > 2048) return null;
  const dn: Dn = new Map();
  let i = 0;
  const n = s.length;
  const skipSpaces = () => { while (i < n && s[i] === ' ') i++; };
  while (i < n) {
    skipSpaces();
    const eq = s.indexOf('=', i);
    if (eq < 0) return null;
    const key = s.slice(i, eq).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.]*$/.test(key)) return null;
    i = eq + 1;
    skipSpaces();
    let value = '';
    if (s[i] === '"') {
      i++;
      let closed = false;
      while (i < n) {
        if (s[i] === '"') {
          if (s[i + 1] === '"') { value += '"'; i += 2; continue; }
          closed = true;
          i++;
          break;
        }
        value += s[i++];
      }
      if (!closed) return null;
      skipSpaces();
    } else {
      while (i < n && s[i] !== ',') {
        if (s[i] === '\\' && i + 1 < n) { value += s[i + 1]; i += 2; continue; }
        value += s[i++];
      }
      value = value.trim();
    }
    if (value === '') return null;
    dn.set(key, [...(dn.get(key) ?? []), value]);
    if (i < n) {
      if (s[i] !== ',') return null;
      i++;
      if (i >= n) return null;
    }
  }
  return dn.size > 0 ? dn : null;
}

const REQUIRED = ['CN', 'O', 'C'];

/** A usable pin: a well-formed DN naming at least CN, O and C. */
export function isPinnedPublisherDn(pin: unknown): boolean {
  const dn = parseDn(pin);
  return dn !== null && REQUIRED.every((k) => dn.has(k));
}

/** Every attribute type in the pin must carry exactly the pinned values in the subject; extra subject fields are fine. */
export function subjectMatches(subject: unknown, pin: string): boolean {
  if (!isPinnedPublisherDn(pin)) return false;
  const want = parseDn(pin)!;
  const got = parseDn(subject);
  if (!got) return false;
  for (const [k, values] of want) {
    const have = got.get(k);
    if (!have || have.length !== values.length) return false;
    const a = [...values].sort();
    const b = [...have].sort();
    if (a.some((v, idx) => v !== b[idx])) return false;
  }
  return true;
}

export type ExecFile = (
  file: string,
  args: string[],
  opts: { env: Record<string, string>; timeout: number; windowsHide: boolean; maxBuffer: number; shell: false },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * The PowerShell script. The file path arrives in CHARTMATE_VERIFY_FILE, never inside the command text. Progress
 * output is silenced and every error stops the script (a non-zero exit and stderr: refused). The JSON is made
 * ASCII-only (non-ASCII characters escaped as \uXXXX), so the console code page cannot garble a subject. Under
 * Constrained Language Mode the type casts here are not allowed: the script fails, so updates are refused.
 * electron-builder's NSIS installer carries the app version as its ProductVersion (VIAddVersionKey ProductVersion).
 */
export const VERIFY_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$ErrorActionPreference = 'Stop'",
  '$s = Get-AuthenticodeSignature -LiteralPath $env:CHARTMATE_VERIFY_FILE',
  '$v = (Get-Item -LiteralPath $env:CHARTMATE_VERIFY_FILE).VersionInfo.ProductVersion',
  '$j = [pscustomobject]@{ Status = $s.Status.ToString(); Path = $s.Path; Subject = $s.SignerCertificate.Subject; ProductVersion = $v } | ConvertTo-Json -Compress',
  "[regex]::Replace($j, '[^\\x00-\\x7F]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value })",
].join('; ');

/**
 * PowerShell may write progress records to stderr as CLIXML even with progress silenced (module loading). Such a
 * stderr is harmless; any other stream (errors, warnings) is not.
 */
export function isOnlyProgressClixml(stderr: string): boolean {
  const t = stderr.trim();
  if (!t.startsWith('#< CLIXML')) return false;
  const body = t.slice('#< CLIXML'.length).trim();
  if (!/^<Objs\b[\s\S]*<\/Objs>$/.test(body)) return false;
  const streams = [...body.matchAll(/\bS="([^"]*)"/g)].map((m) => m[1]!.toLowerCase());
  return streams.every((x) => x === 'progress');
}

export const VERIFY_TIMEOUT_MS = 30_000;

export function createWindowsSignatureVerifier(o: {
  exec: ExecFile;
  /** The pinned publisher DN (build-time); an unusable pin refuses every installer. */
  expectedDn: string;
  log: (msg: string) => void;
  /** Environment for PowerShell (SystemRoot, TEMP, …); PSModulePath is dropped. */
  baseEnv?: Record<string, string | undefined>;
  /** The version the release advertised for the download being verified (null when unknown: refused). */
  expectedVersion: () => string | null;
  /** The running app's version: the installer must be newer. */
  currentVersion: string;
}): (publisherNames: string[], file: string) => Promise<string | null> {
  return async (_publisherNames, file) => {
    const refuse = (why: string) => {
      o.log(`updater: installer signature refused: ${why}`);
      return `installer signature refused: ${why}`;
    };
    if (!isPinnedPublisherDn(o.expectedDn)) return refuse('no publisher DN pinned in this build');
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.baseEnv ?? {})) {
      if (typeof v === 'string' && k.toUpperCase() !== 'PSMODULEPATH') env[k] = v;
    }
    env.CHARTMATE_VERIFY_FILE = file;
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
    const powershell = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let stdout: string;
    try {
      const r = await o.exec(powershell, ['-NoProfile', '-NonInteractive', '-NoLogo', '-InputFormat', 'None', '-Command', VERIFY_SCRIPT], {
        env, timeout: VERIFY_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20, shell: false,
      });
      if (r.stderr.trim() !== '' && !isOnlyProgressClixml(r.stderr)) return refuse('PowerShell reported an error');
      stdout = r.stdout;
    } catch (err) {
      return refuse(`PowerShell could not run (${err instanceof Error ? err.message.split('\n')[0]!.slice(0, 200) : 'error'})`);
    }
    let data: { Status?: unknown; Path?: unknown; Subject?: unknown; ProductVersion?: unknown };
    try {
      data = JSON.parse(stdout.trim()) as typeof data;
      if (!data || typeof data !== 'object') throw new Error('not an object');
    } catch {
      return refuse('unreadable verification result');
    }
    if (data.Status !== 'Valid' && data.Status !== 0) return refuse(`status ${String(data.Status).slice(0, 40)}`);
    if (typeof data.Path !== 'string' || win32.normalize(data.Path).toLowerCase() !== win32.normalize(file).toLowerCase()) {
      return refuse('verified a different file');
    }
    if (!subjectMatches(data.Subject, o.expectedDn)) return refuse('signed by a different publisher');
    const advertised = o.expectedVersion();
    const own = typeof data.ProductVersion === 'string' ? data.ProductVersion.trim() : null;
    if (!advertised || !parseSemver(own) || own !== advertised) return refuse('installer version does not match the release');
    if (!isNewerVersion(own, o.currentVersion)) return refuse('installer is not newer than the running app');
    return null;
  };
}
