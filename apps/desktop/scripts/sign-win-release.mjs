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
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
      ? 'set CHARTMATE_WIN_PUBLISHER_NAME and CHARTMATE_WIN_CERT_SHA1 (SimplySign Desktop logged in), see the README'
      : 'set CHARTMATE_WIN_PUBLISHER_NAME and CHARTMATE_WIN_PKCS11_MODULE (SimplySign Desktop logged in), see the README');
  }
  const publisher = process.env.CHARTMATE_WIN_PUBLISHER_NAME.trim();

  const repo = process.env.GITHUB_REPOSITORY?.trim() || sh('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { capture: true });
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`cannot tell the GitHub repository (got "${repo}"); set GITHUB_REPOSITORY=owner/name`);

  // When publishing, the build must be exactly the tagged source, the tag the one on GitHub, and the release must exist.
  if (upload) {
    const head = sh('git', ['rev-parse', 'HEAD'], { capture: true });
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

  // The PIN is never part of the general build environment: it is asked for right before electron-builder and given
  // only to it (and from there, by build/win-sign.cjs, to osslsigncode as PKCS11_PIN).
  const env = { ...process.env, CHARTMATE_PUBLISH: 'github', GITHUB_REPOSITORY: repo };
  let pin = env.CHARTMATE_WIN_PKCS11_PIN;
  delete env.CHARTMATE_WIN_PKCS11_PIN;

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
    sh(process.execPath, [require.resolve('electron-builder/cli.js'), '--config', 'electron-builder.config.cjs', '--win', '--publish', 'never',
      `-c.directories.output=${out}`], { env: pin ? { ...env, CHARTMATE_WIN_PKCS11_PIN: pin } : env });
    pin = undefined;

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
