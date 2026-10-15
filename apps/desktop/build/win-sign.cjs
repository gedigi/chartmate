// electron-builder custom Windows sign hook (win.signtoolOptions.sign) for a Certum SimplySign cloud certificate.
// electron-builder calls it for every file it signs: the app executable (before the zip and the NSIS packages are
// made), each NSIS uninstaller (before it is embedded) and each NSIS installer (before its blockmap and latest.yml
// entry are computed). So everything downstream already sees the final signed bytes.
//
// Backends (build/signing.cjs decides which one the environment configures):
// - signtool (Windows): SimplySign Desktop is logged in, so the certificate sits in CurrentUser\My; signtool picks it by
//   thumbprint (CHARTMATE_WIN_CERT_SHA1). Used by CI after scripts/certum/login.ps1, and by a local Windows release.
// - pkcs11 (macOS/Linux): osslsigncode + an OpenSSL PKCS#11 provider + the SimplySign PKCS#11 module
//   (CHARTMATE_WIN_PKCS11_MODULE). SimplySign Desktop must be logged in (the owner types the one-time code).
// Every signature is SHA-256 with an RFC 3161 timestamp from Certum. Nothing secret is passed on a command line: an
// optional card PIN reaches libp11's provider as PKCS11_PIN in osslsigncode's environment only (osslsigncode's
// -pass/-readpass do not reach a provider). scripts/sign-win-release.mjs hands the PIN over out of band: an
// owner-only file whose path is CHARTMATE_WIN_PKCS11_PIN_FILE, read and deleted by the first signing call (pinFrom),
// so the PIN itself is never in the environment of electron-builder or the tools it starts. (A same-user process
// could still read the file before that first call; the file only narrows the exposure an environment variable has.) Signing tools get a minimal environment (toolEnv), never the build's secrets, and the
// first rejected PIN stops all further signing attempts.
const { spawnSync } = require('node:child_process');
const { appendFileSync, existsSync, lstatSync, readFileSync, renameSync, rmSync, readdirSync } = require('node:fs');
const { basename, dirname, join } = require('node:path');
const { certumBackend, CERTUM_TIMESTAMP_URL } = require('./signing.cjs');

const DEFAULT_PKCS11_CERT = 'pkcs11:type=cert';
const DEFAULT_PKCS11_KEY = 'pkcs11:type=private';
/** Where Homebrew puts libp11's OpenSSL 3+ provider (Apple silicon, then Intel / Rosetta prefix). */
const PROVIDER_CANDIDATES = {
  arm64: ['/opt/homebrew/opt/libp11/lib/ossl-modules/pkcs11prov.dylib'],
  x86_64: ['/usr/local/opt/libp11/lib/ossl-modules/pkcs11prov.dylib'],
  linux: ['/usr/lib/x86_64-linux-gnu/ossl-modules/pkcs11prov.so', '/usr/lib64/ossl-modules/pkcs11prov.so', '/usr/lib/aarch64-linux-gnu/ossl-modules/pkcs11prov.so'],
};

const value = (env, k) => (typeof env[k] === 'string' && env[k].trim() !== '' ? env[k].trim() : undefined);

/** signtool arguments for one file (thumbprint selection, SHA-256, RFC 3161 timestamp). */
function signtoolArgs({ thumbprint, file, description }) {
  if (!/^[0-9A-Fa-f]{40}$/.test(thumbprint ?? '')) throw new Error('CHARTMATE_WIN_CERT_SHA1 must be a 40-hex-digit certificate thumbprint');
  return ['sign', '/sha1', thumbprint.toUpperCase(), '/fd', 'sha256', '/tr', CERTUM_TIMESTAMP_URL, '/td', 'sha256',
    ...(description ? ['/d', description] : []), '/v', file];
}

/**
 * The osslsigncode command for one file. Pure: the caller passes what it found on the host.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ file: string, out: string, description?: string, pin?: string, hostPlatform: string, hostArch: string,
 *   moduleArchs: string[] | null, exists: (p: string) => boolean }} host
 */
function osslsigncodePlan(env, host) {
  const module = value(env, 'CHARTMATE_WIN_PKCS11_MODULE');
  if (!module) throw new Error('CHARTMATE_WIN_PKCS11_MODULE is not set');
  if (!host.exists(module)) throw new Error(`PKCS#11 module not found: ${module}`);

  // SimplySign Desktop for macOS ships an Intel-only module (the Homebrew cask requires Rosetta). An arm64
  // osslsigncode cannot load it, so it has to run as x86_64 with an Intel toolchain (/usr/local Homebrew).
  let arch = value(env, 'CHARTMATE_OSSLSIGNCODE_ARCH');
  if (!arch && host.hostPlatform === 'darwin' && host.hostArch === 'arm64' && host.moduleArchs && !host.moduleArchs.includes('arm64')) {
    if (!host.moduleArchs.includes('x86_64')) throw new Error(`PKCS#11 module has no usable architecture (${host.moduleArchs.join(', ')})`);
    arch = 'x86_64';
  }
  const toolArch = arch ?? (host.hostPlatform === 'darwin' ? host.hostArch : 'linux');
  const osslsigncode = value(env, 'CHARTMATE_OSSLSIGNCODE') ?? (arch === 'x86_64' && host.hostPlatform === 'darwin' ? '/usr/local/bin/osslsigncode' : 'osslsigncode');
  const provider = value(env, 'CHARTMATE_WIN_PKCS11_PROVIDER')
    ?? (PROVIDER_CANDIDATES[toolArch === 'arm64' || toolArch === 'x86_64' ? toolArch : 'linux'] ?? []).find((p) => host.exists(p));
  if (!provider) throw new Error('OpenSSL PKCS#11 provider not found: install libp11 (brew install libp11) or set CHARTMATE_WIN_PKCS11_PROVIDER');
  const chain = value(env, 'CHARTMATE_WIN_CERT_CHAIN');
  if (chain && !host.exists(chain)) throw new Error(`CHARTMATE_WIN_CERT_CHAIN not found: ${chain}`);
  const pin = typeof host.pin === 'string' && host.pin !== '' ? host.pin
    : typeof env.CHARTMATE_WIN_PKCS11_PIN === 'string' && env.CHARTMATE_WIN_PKCS11_PIN !== '' ? env.CHARTMATE_WIN_PKCS11_PIN : undefined;

  const args = ['sign', '-provider', provider, '-pkcs11module', module,
    '-pkcs11cert', value(env, 'CHARTMATE_WIN_PKCS11_CERT') ?? DEFAULT_PKCS11_CERT,
    '-key', value(env, 'CHARTMATE_WIN_PKCS11_KEY') ?? DEFAULT_PKCS11_KEY,
    ...(chain ? ['-ac', chain] : []),
    '-h', 'sha256', ...(host.description ? ['-n', host.description] : []), '-ts', CERTUM_TIMESTAMP_URL,
    '-in', host.file, '-out', host.out];
  const useArch = arch && host.hostPlatform === 'darwin' && arch !== host.hostArch;
  return {
    command: useArch ? '/usr/bin/arch' : osslsigncode,
    args: useArch ? [`-${arch}`, osslsigncode, ...args] : args,
    env: pin ? { PKCS11_PIN: pin } : {},
  };
}

/** Network / timestamp hiccups are retried; anything else (and anything about a PIN: a card locks after 3 bad PINs) is not. */
function isTransient(output) {
  if (/\bPIN\b|CKR_PIN|login/i.test(output)) return false;
  return /timestamp server|time ?stamp(ing)? (server|failed|error)|failed to connect|could not connect|connection (refused|reset|timed out)|timed out|0x80072ee2|0x80190[0-9a-f]{3}|HTTP (error|status) 5\d\d/i
    .test(output);
}

/** A wrong, locked or missing PIN. After one, no further signing attempt is made (a card locks after 3 bad PINs). */
function isPinFailure(output) {
  return /CKR_PIN_(INCORRECT|INVALID|LOCKED|LEN_RANGE|EXPIRED)|No PIN was entered|Login to token failed|\bPIN\b.*\b(incorrect|invalid|locked|blocked)\b/i.test(output);
}
let pinFailed = false;
/** The PIN read from CHARTMATE_WIN_PKCS11_PIN_FILE (the file is deleted on first read), by file path. */
let pinFromFile = null;
/** Test only. */
function resetPinLatch() {
  pinFailed = false;
  pinFromFile = null;
}

/**
 * The card PIN, if any. scripts/sign-win-release.mjs hands it over out of band: CHARTMATE_WIN_PKCS11_PIN_FILE names
 * an owner-only file (0600, in a private 0700 directory) that is read once, deleted, and kept in this process's
 * memory for the following files, so the PIN is never in the environment of electron-builder or its children.
 * The file must be a regular, non-symlinked file nobody else can read. A direct electron-builder run can still set
 * CHARTMATE_WIN_PKCS11_PIN instead.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
function pinFrom(env) {
  const file = value(env, 'CHARTMATE_WIN_PKCS11_PIN_FILE');
  if (file) {
    if (pinFromFile && pinFromFile.file === file) return pinFromFile.pin || undefined;
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (!st || !st.isFile() || st.isSymbolicLink() || (process.platform !== 'win32' && (st.mode & 0o077) !== 0) || st.size > 256) {
      throw new Error('CHARTMATE_WIN_PKCS11_PIN_FILE: the PIN file must be an owner-only regular file');
    }
    const pin = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    rmSync(file, { force: true });
    pinFromFile = { file, pin };
    return pin === '' ? undefined : pin;
  }
  return typeof env.CHARTMATE_WIN_PKCS11_PIN === 'string' && env.CHARTMATE_WIN_PKCS11_PIN !== '' ? env.CHARTMATE_WIN_PKCS11_PIN : undefined;
}

/**
 * The environment a signing tool gets: only what Windows / a PKCS#11 module needs to run, never the build's
 * secrets. CHARTMATE_WIN_SIGN_PASS_ENV names extra variables to pass (e.g. a PKCS#11 module's own config).
 * @param {NodeJS.ProcessEnv} env
 * @param {Record<string, string>} [extra]
 */
function toolEnv(env, extra = {}) {
  const keep = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'APPDATA',
    'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)',
    'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'HOMEDRIVE', 'HOMEPATH', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
    'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE',
    ...String(env.CHARTMATE_WIN_SIGN_PASS_ENV ?? '').split(',').map((k) => k.trim()).filter(Boolean)];
  const out = {};
  for (const k of keep) if (typeof env[k] === 'string') out[k] = env[k];
  return { ...out, ...extra };
}

/** Newest x64 signtool.exe from the Windows SDK (an ARM64 signtool cannot load the x64 SimplySign minidriver). */
function findSigntool(env) {
  const explicit = value(env, 'CHARTMATE_SIGNTOOL');
  if (explicit) return explicit;
  const root = join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  const versions = existsSync(root) ? readdirSync(root).filter((d) => /^10\./.test(d)) : [];
  versions.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  for (const v of versions) {
    const p = join(root, v, 'x64', 'signtool.exe');
    if (existsSync(p)) return p;
  }
  return 'signtool.exe';
}

function moduleArchs(module) {
  if (process.platform !== 'darwin') return null;
  const r = spawnSync('/usr/bin/lipo', ['-archs', module], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split(/\s+/) : null;
}

function run(command, args, env) {
  const r = spawnSync(command, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Signs `file` in place with the configured Certum backend.
 * @param {string} file
 * @param {{ env?: NodeJS.ProcessEnv, description?: string }} [opts]
 */
async function signFile(file, opts = {}) {
  const env = opts.env ?? process.env;
  const backend = certumBackend(env);
  if (!backend) throw new Error('Certum signing is not configured (see build/signing.cjs)');
  const thumbprint = value(env, 'CHARTMATE_WIN_CERT_SHA1');
  if (backend === 'ci-login' && !thumbprint) throw new Error('CHARTMATE_WIN_CERT_SHA1 is not set: run scripts/certum/login.ps1 before packaging');
  if (pinFailed) throw new Error(`not signing ${basename(file)}: an earlier PIN / token login failed, refusing further attempts`);

  for (let attempt = 1; ; attempt++) {
    let result;
    const tmp = join(dirname(file), `.${basename(file)}.signed`);
    if (backend === 'pkcs11') {
      const plan = osslsigncodePlan(env, {
        file, out: tmp, description: opts.description, pin: pinFrom(env), hostPlatform: process.platform, hostArch: process.arch === 'x64' ? 'x86_64' : process.arch,
        moduleArchs: moduleArchs(env.CHARTMATE_WIN_PKCS11_MODULE.trim()), exists: existsSync,
      });
      rmSync(tmp, { force: true });
      result = run(plan.command, plan.args, toolEnv(env, plan.env));
      if (result.ok) renameSync(tmp, file);
      else rmSync(tmp, { force: true });
    } else {
      result = run(findSigntool(env), signtoolArgs({ thumbprint, file, description: opts.description }), toolEnv(env));
    }
    if (result.ok) break;
    if (isPinFailure(result.output)) {
      pinFailed = true;
      throw new Error(`Certum signing failed for ${basename(file)}: PIN / token login rejected; no further attempts will be made:\n${result.output.trim()}`);
    }
    if (attempt >= 3 || !isTransient(result.output)) {
      throw new Error(`Certum signing failed for ${basename(file)} (${backend}):\n${result.output.trim()}`);
    }
    console.warn(`  • signing ${basename(file)} failed (attempt ${attempt}), retrying: ${result.output.trim().split('\n').pop()}`);
    await sleep(5000 * attempt);
  }

  const log = value(env, 'CHARTMATE_WIN_SIGN_LOG');
  if (log) appendFileSync(log, `${JSON.stringify({ file, backend, at: new Date().toISOString() })}\n`);
  console.log(`  • signed (Certum, ${backend})  file=${basename(file)}`);
}

/**
 * electron-builder hook: `configuration.path` is the file, `configuration.hash` the digest (only sha256 is
 * configured, see builder-config.cjs).
 * @param {{ path: string, hash?: string, name?: string }} configuration
 */
async function sign(configuration) {
  if (configuration.hash && configuration.hash !== 'sha256') throw new Error(`unexpected signing hash ${configuration.hash}`);
  await signFile(configuration.path, { description: configuration.name });
}

module.exports = {
  sign, signFile, signtoolArgs, osslsigncodePlan, pinFrom, isTransient, isPinFailure, resetPinLatch, toolEnv, findSigntool, DEFAULT_PKCS11_CERT, DEFAULT_PKCS11_KEY,
};
