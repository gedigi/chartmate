// Manual Windows release signing with a Certum SimplySign cloud certificate (the fallback when CI cannot log in).
//
// Run it from a checkout of the release tag, with SimplySign Desktop logged in (you type the one-time code from the
// SimplySign phone app into SimplySign Desktop yourself; nothing secret is stored on disk):
//   macOS / Linux:  CHARTMATE_WIN_PUBLISHER_NAME=… CHARTMATE_WIN_PKCS11_MODULE=… pnpm --filter @chartmate/desktop sign:win
//   Windows:        CHARTMATE_WIN_PUBLISHER_NAME=… CHARTMATE_WIN_CERT_SHA1=…      pnpm --filter @chartmate/desktop sign:win
//
// It rebuilds the Windows app for the tag (re-signing CI's artifacts is not enough: the app executable and the
// uninstaller sit inside the NSIS installer, so they have to be signed while it is built), signing chartmate.exe, each
// uninstaller and each installer through build/win-sign.cjs; verifies every signature, latest.yml and the blockmaps
// (scripts/verify-win-signatures.mjs); then, after you confirm, replaces the Windows assets of the GitHub Release
// (`gh release upload --clobber`) and updates the release notes' signing row.
//
// Before publishing it checks: HEAD is the tag, the tree is clean (no untracked files, no ignored .env files), the
// local tag equals the tag on GitHub, and the release exists. It always reinstalls node_modules from the lockfile.
//
// Options: --tag=vX.Y.Z (default: v<package.json version>), --no-upload (build + verify only; any commit),
//          --yes (do not ask before uploading).
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyRelease } from './verify-win-signatures.mjs';

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL('..', import.meta.url));

/** The Windows files a release carries (what CI uploads for Windows). */
export function windowsAssets(names) {
  return names.filter((n) => (n.endsWith('.exe') && !n.includes('__uninstaller')) || /\.exe\.blockmap$/.test(n)
    || /-win(-[\w]+)?\.zip(\.blockmap)?$/.test(n) || n === 'latest.yml').sort();
}

/** Release notes (as desktop.yml writes them) with the Windows row set to `method` and the unsigned warnings fixed. */
export function rewriteReleaseNotes(body, method) {
  let out = body.replace(/^(\| Windows \([^)]*\) \| )[^|\n]*( \|)$/m, `$1${method}$2`);
  out = out.replace(/\*\*Windows build is unsigned\.\*\*[^\n]*\n(\n)?/, '');
  out = out.replace(/\*\*Windows signing (step )?failed in CI\*\*[^\n]*\n(\n)?/, '');
  const macUnsigned = /^\| macOS \([^)]*\) \| unsigned \|$/m.test(out);
  if (!macUnsigned) out = out.replace(/Unsigned builds contain no auto-updater[^\n]*\n?(\n)?/, '');
  return out.replace(/\n{3,}/g, '\n\n');
}

/** Ignored files that would change the build (`git ls-files --others --ignored --exclude-standard` output). */
export function buildAffectingIgnored(paths) {
  return paths.filter((p) => /(^|\/)\.env(\..+)?$/.test(p) && !/(^|\/)\.env\.example$/.test(p) && !/(^|\/)node_modules\//.test(p));
}

/**
 * The environment electron-builder runs with: never the PIN itself (it would reach every child process electron-builder
 * starts), only the path of the owner-only file build/win-sign.cjs reads it from (or no PIN at all).
 */
export function builderEnv(env, pinFile) {
  const out = { ...env };
  delete out.CHARTMATE_WIN_PKCS11_PIN;
  delete out.CHARTMATE_WIN_PKCS11_PIN_FILE;
  if (pinFile) out.CHARTMATE_WIN_PKCS11_PIN_FILE = pinFile;
  return out;
}

/** Writes the PIN to `<fresh 0700 dir>/pin` (0600, exclusive create); `cleanup` removes the directory. */
export function writePinFile(pin) {
  const dir = mkdtempSync(join(tmpdir(), 'chartmate-pin-'));
  chmodSync(dir, 0o700);
  const file = join(dir, 'pin');
  writeFileSync(file, pin, { mode: 0o600, flag: 'wx' });
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Removes CHARTMATE_WIN_PKCS11_PIN from `env` (process.env) and returns it, so no child process inherits it. */
export function takePin(env) {
  const pin = env.CHARTMATE_WIN_PKCS11_PIN;
  delete env.CHARTMATE_WIN_PKCS11_PIN;
  return pin;
}

/** Windows' taskkill, by absolute path (never looked up on PATH, where a planted taskkill.exe could sit). */
export function taskkillPath(env = process.env) {
  return win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
}

const defaultKillGroup = (pid, s) => process.kill(-pid, s);
const defaultTaskkill = (pid) => spawnSync(taskkillPath(), ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).status === 0;

/**
 * SIGKILLs what is left of `child`'s process group (POSIX; shAsync starts the child as a group leader), so no
 * grandchild of electron-builder (a signing tool that may have the PIN) outlives it. Best effort and synchronous, so it
 * also works in an `exit` handler: an empty group (ESRCH) is fine. On Windows a still running child's tree is
 * ended with taskkill (an exited one's orphans can no longer be found there).
 */
export function reapGroup(child, { platform = process.platform, killGroup = defaultKillGroup, taskkill = defaultTaskkill } = {}) {
  if (platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null && !taskkill(child.pid)) {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
    return;
  }
  try {
    killGroup(child.pid, 'SIGKILL');
  } catch {
    // ESRCH: nothing left in the group.
  }
}

/**
 * Stops `child` (electron-builder) and everything it started, resolving once it has exited. POSIX: `sig` goes to its
 * process group, or to the child alone if there is no group; after `timeoutMs` the group gets SIGKILL, and once the
 * leader has exited the rest of the group always does (reapGroup). Windows has no signals: `taskkill /T /F` ends the
 * whole tree, `child.kill()` if that fails.
 */
export function stopChild(child, sig, {
  platform = process.platform,
  killGroup = defaultKillGroup,
  taskkill = defaultTaskkill,
  timeoutMs = 10_000,
} = {}) {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    const timers = [];
    const finish = () => {
      for (const t of timers) clearTimeout(t);
      done();
    };
    child.once('exit', () => {
      reapGroup(child, { platform, killGroup, taskkill });
      finish();
    });
    const send = (s) => {
      if (platform === 'win32') {
        if (!taskkill(child.pid)) child.kill(s);
        return;
      }
      try {
        killGroup(child.pid, s);
      } catch {
        child.kill(s);
      }
    };
    send(sig);
    timers.push(setTimeout(() => {
      send('SIGKILL');
      // Give up waiting shortly after SIGKILL, so the parent still cleans up and exits.
      timers.push(setTimeout(finish, 2000));
    }, timeoutMs));
  });
}

/** The signals forwarded to electron-builder: Ctrl-C, kill, and the terminal closing. */
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Runs `run` (the electron-builder step) with `cleanup` (removing the PIN file) guaranteed. `run` gets a
 * `track(child)` function for the process it starts.
 * - When the step ends, whatever the outcome: the rest of the child's process group is killed (reapGroup), then
 *   cleanup runs.
 * - On SIGINT / SIGTERM / SIGHUP: the child's group gets the signal too, and the PIN file is removed only once the
 *   child has exited (SIGKILL after a timeout), since the sign hook may hold the PIN in memory and a builder left
 *   running would keep signing with it. Then the signal is re-raised with its default action, so the exit status
 *   still says how the script ended; the returned promise never settles in that case. Further signals while waiting
 *   are absorbed.
 * - On any other exit of this process (process.exit, an uncaught error): the child's group is killed and cleanup
 *   runs, synchronously, in the `exit` handler. Only a SIGKILL of this process itself skips all of this.
 */
export function withSignalCleanup(cleanup, run, proc = process, { stopChild: stop = stopChild, reapGroup: reap = reapGroup } = {}) {
  const handlers = new Map();
  let child = null;
  let interrupted = null;
  const remove = () => {
    for (const [event, h] of handlers) proc.removeListener(event, h);
    handlers.clear();
  };
  const interrupt = async (sig) => {
    try {
      if (child) await stop(child, sig);
    } finally {
      remove();
      try {
        cleanup();
      } finally {
        proc.kill(proc.pid, sig);
      }
    }
  };
  for (const sig of FORWARDED) {
    const h = () => {
      if (!interrupted) interrupted = interrupt(sig);
    };
    handlers.set(sig, h);
    proc.on(sig, h);
  }
  const onExit = () => {
    remove();
    try {
      if (child) reap(child);
    } finally {
      cleanup();
    }
  };
  handlers.set('exit', onExit);
  proc.on('exit', onExit);
  const track = (c) => {
    child = c;
  };
  const pending = () => interrupted.then(() => new Promise(() => {}), () => new Promise(() => {}));
  const settle = () => {
    remove();
    try {
      if (child) reap(child);
    } finally {
      cleanup();
    }
  };
  return Promise.resolve().then(() => run(track)).then(
    (value) => {
      if (interrupted) return pending();
      settle();
      return value;
    },
    (error) => {
      if (interrupted) return pending();
      settle();
      throw error;
    },
  );
}

/**
 * The GitHub ref variables for the web build (the About dialog's source link, apps/web/build/sourceRef.cjs). When
 * publishing, HEAD has been checked to be `tag`, so the build is of that tag; otherwise (--no-upload, any commit)
 * only the commit is known. Ref variables already in the shell are never trusted.
 */
export function sourceRefEnv(env, { upload, tag, head }) {
  const out = { ...env };
  delete out.GITHUB_REF_TYPE;
  delete out.GITHUB_REF_NAME;
  if (upload) {
    out.GITHUB_REF_TYPE = 'tag';
    out.GITHUB_REF_NAME = tag;
  }
  out.GITHUB_SHA = head;
  return out;
}

/** sh(), asynchronously: the event loop keeps running, so signal handlers fire while the child runs. */
function shAsync(command, args, opts = {}) {
  return new Promise((resolveRun, reject) => {
    // Its own process group on POSIX, so a forwarded signal reaches everything electron-builder starts.
    const child = spawn(command, args, { stdio: 'inherit', cwd: opts.cwd ?? desktop, env: opts.env ?? process.env, detached: process.platform !== 'win32' });
    opts.onSpawn?.(child);
    child.once('error', reject);
    child.once('exit', (code, signal) => (code === 0 ? resolveRun() : reject(new Error(`${command} ${args.join(' ')} failed (${code ?? signal})`))));
  });
}

function sh(command, args, opts = {}) {
  const r = spawnSync(command, args, { stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8', cwd: opts.cwd ?? desktop, env: opts.env ?? process.env, shell: process.platform === 'win32' && command === 'pnpm' });
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${r.status ?? r.error})`);
  return (r.stdout ?? '').trim();
}

function ask(question, { hidden = false } = {}) {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Do not echo what is typed (only the prompt itself).
      rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    }
    rl.question(question, (a) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      done(a);
    });
  });
}

async function main() {
  // Before anything runs: no child (git, gh, pnpm install, the web build) may inherit the PIN.
  let pin = takePin(process.env);
  const argv = process.argv.slice(2);
  const opt = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const upload = !argv.includes('--no-upload');
  const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
  const tag = opt('tag') ?? `v${pkg.version}`;
  if (!/^v\d+\.\d+\.\d+(-[\w.]+)?$/.test(tag)) throw new Error(`not a release tag: ${tag}`);

  const { signingFor } = require('../build/signing.cjs');
  const signing = signingFor(process.env, 'win32');
  if (!signing.certum || signing.certum === 'ci-login') {
    throw new Error(process.platform === 'win32'
      ? 'set CHARTMATE_WIN_PUBLISHER_NAME and CHARTMATE_WIN_CERT_SHA1 (SimplySign Desktop logged in), see docs/desktop.md'
      : 'set CHARTMATE_WIN_PUBLISHER_NAME and CHARTMATE_WIN_PKCS11_MODULE (SimplySign Desktop logged in), see docs/desktop.md');
  }
  const publisher = process.env.CHARTMATE_WIN_PUBLISHER_NAME.trim();

  const repo = process.env.GITHUB_REPOSITORY?.trim() || sh('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { capture: true });
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`cannot tell the GitHub repository (got "${repo}"); set GITHUB_REPOSITORY=owner/name`);

  const head = sh('git', ['rev-parse', 'HEAD'], { capture: true });
  // When publishing, the build must be exactly the tagged source, the tag the one on GitHub, and the release must exist.
  if (upload) {
    const tagged = sh('git', ['rev-parse', `${tag}^{commit}`], { capture: true });
    if (head !== tagged) throw new Error(`HEAD is not ${tag}: run it from a checkout of the tag (git checkout ${tag})`);
    if (sh('git', ['status', '--porcelain'], { capture: true }) !== '') throw new Error('the working tree has changes or untracked files');
    const ignored = buildAffectingIgnored(sh('git', ['ls-files', '--others', '--ignored', '--exclude-standard'], { capture: true }).split('\n'));
    if (ignored.length) throw new Error(`files that would change the build are present (move them away first): ${ignored.join(', ')}`);
    const remote = spawnSync('gh', ['api', `repos/${repo}/commits/refs/tags/${tag}`, '-q', '.sha'], { encoding: 'utf8' }).stdout?.trim() || null;
    if (remote !== tagged) throw new Error(`local ${tag} (${tagged.slice(0, 12)}) is not the ${tag} on GitHub (${remote?.slice(0, 12) ?? 'missing'})`);
    const view = spawnSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'tagName'], { encoding: 'utf8' });
    if (view.status !== 0) {
      throw new Error(`there is no GitHub Release ${tag} on ${repo}: push the tag and let desktop.yml publish it first (${(view.stderr ?? '').trim()})`);
    }
  }

  // node_modules must be exactly the lockfile (no install scripts), as in CI.
  sh('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: resolve(desktop, '..', '..') });

  // The PIN is never in any build environment, electron-builder's included (its children would inherit it): it is
  // asked for right before electron-builder and written to an owner-only file in a private temp directory, whose path
  // build/win-sign.cjs gets; the hook reads and deletes it on first use and gives it to osslsigncode as PKCS11_PIN.
  // The web build's About dialog links the source at the tag when publishing (HEAD is the tag), else at HEAD.
  const env = builderEnv(sourceRefEnv({ ...process.env, CHARTMATE_PUBLISH: 'github', GITHUB_REPOSITORY: repo }, { upload, tag, head }), null);
  let pinFile = null;

  const out = resolve(desktop, 'release-win-signed', tag);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'chartmate-sign-'));
  env.CHARTMATE_WIN_SIGN_LOG = join(work, 'sign-log.jsonl');
  writeFileSync(env.CHARTMATE_WIN_SIGN_LOG, '');

  try {
    console.log(`\n== Building and signing Chartmate ${tag} for Windows (${signing.method}, ${signing.certum}) ==`);
    sh('pnpm', ['--filter', '@chartmate/web', 'build'], { env });
    sh(process.execPath, ['scripts/bundle.mjs', '--platform=win32'], { env });
    if (signing.certum === 'pkcs11' && pin === undefined && process.stdin.isTTY) {
      pin = await ask('SimplySign card PIN (press Enter if your setup does not ask for one): ', { hidden: true });
    }
    if (pin) pinFile = writePinFile(pin);
    pin = undefined;
    // The PIN file goes away when packaging ends. On Ctrl-C / SIGTERM / SIGHUP, electron-builder and its children get
    // the signal too, and the PIN file is removed once they have exited (SIGKILL after 10 s); then the signal is
    // re-raised. Any other exit kills them and removes the file too.
    await withSignalCleanup(() => {
      pinFile?.cleanup();
      pinFile = null;
    }, (track) => shAsync(process.execPath, [require.resolve('electron-builder/cli.js'), '--config', 'electron-builder.config.cjs', '--win', '--publish', 'never',
      `-c.directories.output=${out}`], { env: builderEnv(env, pinFile?.file ?? null), onSpawn: track }));

    console.log('\n== Verifying ==');
    const problems = verifyRelease(out, { publisher, signLog: env.CHARTMATE_WIN_SIGN_LOG });
    if (problems.length) throw new Error(`verification failed:\n  - ${problems.join('\n  - ')}`);
    console.log(`OK: installers, uninstallers and chartmate.exe signed by "${publisher}" and timestamped; latest.yml and blockmaps match.`);

    const assets = windowsAssets(readdirSync(out));
    console.log(`\nWindows assets (${out}):\n  ${assets.join('\n  ')}`);
    if (!upload) return;
    if (!argv.includes('--yes')) {
      const a = await ask(`\nReplace these assets on the ${tag} release of ${repo}? [y/N] `);
      if (!/^y(es)?$/i.test(a.trim())) return console.log('Not uploaded.');
    }
    sh('gh', ['release', 'upload', tag, '--repo', repo, '--clobber', ...assets.map((a) => join(out, a))]);
    const body = sh('gh', ['release', 'view', tag, '--repo', repo, '--json', 'body', '-q', '.body'], { capture: true });
    const notes = join(work, 'notes.md');
    writeFileSync(notes, `${rewriteReleaseNotes(body, signing.method)}\n`);
    sh('gh', ['release', 'edit', tag, '--repo', repo, '--notes-file', notes]);
    console.log(`\nDone: ${tag} now carries the signed Windows build.`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(`\nsign:win: ${e.message}`);
    process.exit(1);
  });
}
