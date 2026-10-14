// Verifies a signed Windows release directory (electron-builder output) before it is published:
// - every NSIS installer (*.exe), each unpacked chartmate.exe and the chartmate.exe inside each zip carry a valid
//   Authenticode signature from CHARTMATE_WIN_PUBLISHER_NAME with an RFC 3161 timestamp;
// - every installer's uninstaller was signed before it was embedded (from the sign hook's log, since electron-builder
//   deletes the uninstaller after embedding it);
// - latest.yml lists exactly the installers on disk, with matching sizes and SHA-512 (so it describes the final signed
//   files), and each installer has its blockmap.
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

function verifyFile(file) {
  if (process.platform === 'win32') {
    const ps = `$s = Get-AuthenticodeSignature -LiteralPath $env:VERIFY_FILE; ` +
      `[pscustomobject]@{ Status = [string]$s.Status; Subject = $s.SignerCertificate.Subject; Ts = [bool]$s.TimeStamperCertificate; ` +
      `Alg = $s.SignerCertificate.SignatureAlgorithm.FriendlyName } | ConvertTo-Json -Compress`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', env: { ...process.env, VERIFY_FILE: file } });
    const j = JSON.parse(r.stdout || '{}');
    return { ok: j.Status === 'Valid', cn: commonName(j.Subject ?? ''), timestamped: j.Ts === true, sha256: undefined };
  }
  const tool = process.env.CHARTMATE_OSSLSIGNCODE?.trim() || 'osslsigncode';
  const ca = process.env.CHARTMATE_WIN_VERIFY_CAFILE?.trim();
  const r = spawnSync(tool, ['verify', ...(ca ? ['-CAfile', ca] : []), '-in', file], { encoding: 'utf8' });
  return parseOsslVerify(`${r.stdout}${r.stderr}`, r.status);
}

function extractFromZip(zip, entry, dir) {
  const out = join(dir, `${basename(zip)}-${entry}`);
  const r = process.platform === 'linux'
    ? spawnSync('unzip', ['-p', zip, entry], { maxBuffer: 1 << 30 })
    : spawnSync('tar', ['-xOf', zip, entry], { maxBuffer: 1 << 30 });
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
    const latest = require('js-yaml').load(readFileSync(yml, 'utf8'));
    const files = Object.fromEntries(installers.map((i) => [i, { size: statSync(join(dir, i)).size, sha512: sha512(join(dir, i)) }]));
    problems.push(...latestYmlProblems(latest, files, installers));
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
