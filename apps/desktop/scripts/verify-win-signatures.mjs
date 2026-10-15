// Verifies a signed Windows release directory (electron-builder output) before it is published:
// - every NSIS installer (*.exe), each unpacked chartmate.exe and the chartmate.exe inside each zip carry a valid
//   Authenticode signature from CHARTMATE_WIN_PUBLISHER_NAME with an RFC 3161 timestamp;
// - every installer's uninstaller was signed before it was embedded (from the sign hook's log, since electron-builder
//   deletes the uninstaller after embedding it);
// - latest.yml lists exactly the installers on disk, with matching sizes and SHA-512 (so it describes the final signed
//   files), and each installer has its blockmap;
// - each unpacked app's app-update.yml pins the publisher (electron-updater refuses updates without it).
// Windows uses Get-AuthenticodeSignature (the check electron-updater itself relies on); macOS/Linux use
// `osslsigncode verify` (CHARTMATE_WIN_VERIFY_CAFILE overrides its trust store).
//
// Usage: node scripts/verify-win-signatures.mjs <release-dir> [--sign-log=<file>]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { findSigntool } = require('../build/win-sign.cjs');

/** The CN of a subject DN printed as "O=Test,CN=Jane Doe" (osslsigncode) or "CN=Jane Doe, O=Test" (Windows). */
export function commonName(subject) {
  const m = /(?:^|,\s*)CN=("(?:[^"]|"")*"|(?:\\,|[^,])*)/.exec(subject ?? '');
  if (!m) return null;
  const v = m[1].trim();
  return v.startsWith('"') ? v.slice(1, -1).replace(/""/g, '"') : v.replace(/\\,/g, ',');
}

/** Reads `osslsigncode verify` output. */
export function parseOsslVerify(output, status) {
  const signer = /Signer's certificate:[\s\S]*?Subject:\s*(.+)/.exec(output);
  return {
    ok: status === 0 && /Signature verification: ok/.test(output) && !/Signature verification: failed/.test(output),
    cn: signer ? commonName(signer[1].trim()) : null,
    timestamped: /Timestamp time:|Timestamp Server Signature verification: ok/.test(output),
    sha256: /Message digest algorithm\s*:\s*SHA256/i.test(output),
  };
}

/** Problems with one file's signature, as messages (empty = fine). */
export function signatureProblems(name, sig, publisher) {
  const problems = [];
  if (!sig.ok) problems.push(`${name}: signature is not valid`);
  if (sig.cn !== publisher) problems.push(`${name}: signed by "${sig.cn ?? 'nobody'}", expected "${publisher}"`);
  if (!sig.timestamped) problems.push(`${name}: no timestamp`);
  if (sig.sha256 === false) problems.push(`${name}: not a SHA-256 signature`);
  return problems;
}

/** latest.yml vs the files on disk. `files` maps name → { size, sha512 (base64) }. */
export function latestYmlProblems(latest, files, installers) {
  const problems = [];
  const listed = (latest?.files ?? []).map((f) => f.url);
  for (const f of latest?.files ?? []) {
    const actual = files[f.url];
    if (!actual) problems.push(`latest.yml: ${f.url} is not in the release directory`);
    else if (actual.size !== f.size || actual.sha512 !== f.sha512) problems.push(`latest.yml: ${f.url} size/sha512 do not match the file`);
  }
  for (const i of installers) if (!listed.includes(i)) problems.push(`latest.yml: ${i} is missing`);
  const main = (latest?.files ?? []).find((f) => f.url === latest?.path);
  if (!main || main.sha512 !== latest.sha512) problems.push('latest.yml: path/sha512 do not match a listed file');
  return problems;
}

/** Sign-hook log vs the expected set: each installer and its uninstaller, and each app executable. */
export function signLogProblems(logLines, installers, appExes) {
  const signedPaths = logLines.map((l) => String(JSON.parse(l).file).replace(/\\/g, '/'));
  const signed = signedPaths.map((p) => basename(p));
  const problems = [];
  for (const i of installers) {
    if (!signed.includes(i)) problems.push(`sign log: installer ${i} was not signed by the hook`);
    // electron-builder names it `${basename(installer, "exe")}__uninstaller.exe`, e.g. "App-1.0.0-win.__uninstaller.exe".
    if (!signed.includes(`${i.slice(0, -'exe'.length)}__uninstaller.exe`)) problems.push(`sign log: the uninstaller of ${i} was not signed`);
  }
  for (const e of appExes) if (!signedPaths.some((p) => p.endsWith(e))) problems.push(`sign log: ${e} was not signed by the hook`);
  return problems;
}

/** Reads `signtool verify /pa /v` output (file digest algorithm, timestamp, overall result). */
export function parseSigntoolVerify(output, status) {
  return {
    ok: status === 0 && /Successfully verified/i.test(output),
    timestamped: /The signature is timestamped:/i.test(output),
    sha256: /Hash of file \(sha256\):/i.test(output),
  };
}

function verifyFile(file) {
  if (process.platform === 'win32') {
    // Get-AuthenticodeSignature is what electron-updater checks (status + signer subject); signtool adds the digest.
    const ps = `$s = Get-AuthenticodeSignature -LiteralPath $env:VERIFY_FILE; ` +
      `[pscustomobject]@{ Status = [string]$s.Status; Subject = $s.SignerCertificate.Subject; Ts = [bool]$s.TimeStamperCertificate } | ConvertTo-Json -Compress`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', env: { ...process.env, VERIFY_FILE: file } });
    const j = JSON.parse(r.stdout || '{}');
    const st = spawnSync(findSigntool(process.env), ['verify', '/pa', '/v', file], { encoding: 'utf8' });
    const v = parseSigntoolVerify(`${st.stdout ?? ''}${st.stderr ?? ''}`, st.status);
    return { ok: j.Status === 'Valid' && v.ok, cn: commonName(j.Subject ?? ''), timestamped: j.Ts === true && v.timestamped, sha256: v.sha256 };
  }
  const tool = process.env.CHARTMATE_OSSLSIGNCODE?.trim() || 'osslsigncode';
  const ca = process.env.CHARTMATE_WIN_VERIFY_CAFILE?.trim();
  const r = spawnSync(tool, ['verify', ...(ca ? ['-CAfile', ca] : []), '-in', file], { encoding: 'utf8' });
  return parseOsslVerify(`${r.stdout}${r.stderr}`, r.status);
}

/**
 * How to print one zip entry to stdout: bsdtar on macOS (/usr/bin/tar) and Windows (%SystemRoot%\System32\tar.exe,
 * by full path so a tar.exe from Git or MSYS earlier in PATH is never used), unzip on Linux.
 */
export function zipExtractCommand(platform, env, zip, entry) {
  if (platform === 'win32') return { command: join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), args: ['-xOf', zip, entry] };
  if (platform === 'darwin') return { command: '/usr/bin/tar', args: ['-xOf', zip, entry] };
  return { command: 'unzip', args: ['-p', zip, entry] };
}

/** latestYmlProblems for the text of latest.yml; one that does not parse is a problem of its own. */
export function latestYmlTextProblems(text, files, installers) {
  let latest;
  try {
    latest = require('js-yaml').load(text); // js-yaml 5 throws on an empty document
  } catch (e) {
    return [`latest.yml is not valid YAML (${e.message.split('\n')[0]})`];
  }
  return latestYmlProblems(latest, files, installers);
}

/** Problems with an unpacked app's resources/app-update.yml: the updater must pin the publisher. */
export function appUpdateProblems(label, text, publisher) {
  if (text == null) return [`${label}: resources/app-update.yml is missing (the signed build would have no updater config)`];
  let doc;
  try {
    doc = require('js-yaml').load(text); // js-yaml 5 throws on an empty document
  } catch (e) {
    return [`${label}: resources/app-update.yml is not valid YAML (${e.message.split('\n')[0]})`];
  }
  const names = [doc?.publisherName ?? []].flat();
  return names.includes(publisher) ? [] : [`${label}: app-update.yml publisherName is ${JSON.stringify(names)}, expected "${publisher}"`];
}

function extractFromZip(zip, entry, dir) {
  const out = join(dir, `${basename(zip)}-${entry}`);
  const { command, args } = zipExtractCommand(process.platform, process.env, zip, entry);
  const r = spawnSync(command, args, { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`cannot extract ${entry} from ${basename(zip)}`);
  writeFileSync(out, r.stdout);
  return out;
}

const sha512 = (f) => createHash('sha512').update(readFileSync(f)).digest('base64');

/** @returns {string[]} problems (empty = release is consistent and fully signed) */
export function verifyRelease(dir, { publisher, signLog, exeName = 'chartmate.exe' }) {
  const problems = [];
  const names = readdirSync(dir);
  const installers = names.filter((n) => n.endsWith('.exe') && !n.includes('__uninstaller')).sort();
  const zips = names.filter((n) => /-win(-[\w]+)?\.zip$/.test(n)).sort();
  const unpacked = names.filter((n) => /^win(-[\w]+)?-unpacked$/.test(n) && existsSync(join(dir, n, exeName)));
  if (installers.length === 0) problems.push('no installers found');
  if (unpacked.length === 0) problems.push('no unpacked app found');

  const check = (label, file) => problems.push(...signatureProblems(label, verifyFile(file), publisher));
  for (const i of installers) check(i, join(dir, i));
  for (const u of unpacked) check(`${u}/${exeName}`, join(dir, u, exeName));
  for (const u of unpacked) {
    const yml = join(dir, u, 'resources', 'app-update.yml');
    problems.push(...appUpdateProblems(u, existsSync(yml) ? readFileSync(yml, 'utf8') : null, publisher));
  }
  const tmp = mkdtempSync(join(tmpdir(), 'chartmate-verify-'));
  try {
    for (const z of zips) check(`${z}:${exeName}`, extractFromZip(join(dir, z), exeName, tmp));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  for (const i of installers) if (!existsSync(join(dir, `${i}.blockmap`))) problems.push(`${i}.blockmap is missing`);
  const yml = join(dir, 'latest.yml');
  if (!existsSync(yml)) problems.push('latest.yml is missing');
  else {
    const files = Object.fromEntries(installers.map((i) => [i, { size: statSync(join(dir, i)).size, sha512: sha512(join(dir, i)) }]));
    problems.push(...latestYmlTextProblems(readFileSync(yml, 'utf8'), files, installers));
  }
  if (signLog) {
    const lines = existsSync(signLog) ? readFileSync(signLog, 'utf8').split('\n').filter(Boolean) : [];
    problems.push(...signLogProblems(lines, installers, unpacked.map((u) => `${u}/${exeName}`)));
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2];
  const signLog = process.argv.find((a) => a.startsWith('--sign-log='))?.split('=').slice(1).join('=');
  const publisher = process.env.CHARTMATE_WIN_PUBLISHER_NAME?.trim();
  if (!dir || !publisher) {
    console.error('usage: CHARTMATE_WIN_PUBLISHER_NAME=<CN> node scripts/verify-win-signatures.mjs <release-dir> [--sign-log=<file>]');
    process.exit(2);
  }
  const problems = verifyRelease(dir, { publisher, signLog });
  if (problems.length) {
    console.error(`Windows release verification FAILED:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`Windows release verified: every installer, uninstaller and chartmate.exe is signed by "${publisher}" and timestamped; latest.yml and blockmaps match.`);
}
