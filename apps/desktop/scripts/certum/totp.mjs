// RFC 6238 TOTP for the SimplySign login in CI. The SimplySign activation QR code is a standard otpauth:// URI;
// the same seed the SimplySign phone app holds produces the same one-time codes here.
//
// CLI (used by login.ps1): reads CHARTMATE_CERTUM_OTP_URI (an otpauth:// URI, or a bare base32 seed) from the environment and
// prints the current code. When fewer than `--min-remaining` seconds (default 5) are left in the current period it
// waits for the next one, so the code is still valid when SimplySign checks it. Never prints the seed.
// CHARTMATE_CERTUM_TOTP_ALGORITHM (SHA1 | SHA256 | SHA512) overrides the algorithm.
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ALGORITHMS = { SHA1: 'sha1', SHA256: 'sha256', SHA512: 'sha512' };

/** RFC 4648 base32 (case-insensitive, padding and spaces ignored). */
export function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let acc = 0;
  const out = [];
  for (const ch of clean) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error('TOTP seed is not valid base32');
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  if (out.length === 0) throw new Error('TOTP seed is empty');
  return Buffer.from(out);
}

/**
 * @param {string} uriOrSeed otpauth://totp/...?secret=...&algorithm=...&digits=...&period=... or a bare base32 seed
 * @param {string} [algorithmOverride]
 */
export function parseOtp(uriOrSeed, algorithmOverride) {
  const raw = String(uriOrSeed ?? '').trim();
  let secret;
  let algorithm = 'SHA1'; // the otpauth default
  let digits = 6;
  let period = 30;
  if (/^otpauth:\/\//i.test(raw)) {
    const u = new URL(raw);
    if (u.host.toLowerCase() !== 'totp') throw new Error('only otpauth://totp URIs are supported');
    secret = u.searchParams.get('secret') ?? '';
    algorithm = (u.searchParams.get('algorithm') ?? algorithm).toUpperCase();
    digits = Number(u.searchParams.get('digits') ?? digits);
    period = Number(u.searchParams.get('period') ?? period);
  } else {
    secret = raw;
  }
  if (algorithmOverride) algorithm = algorithmOverride.toUpperCase().replace('-', '');
  if (!(algorithm in ALGORITHMS)) throw new Error(`unsupported TOTP algorithm ${algorithm}`);
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) throw new Error('unsupported TOTP digits');
  if (!Number.isInteger(period) || period < 10 || period > 300) throw new Error('unsupported TOTP period');
  return { key: base32Decode(secret), algorithm, digits, period };
}

/** The code at `timeMs` (RFC 6238 / RFC 4226 dynamic truncation). */
export function totp({ key, algorithm, digits, period }, timeMs) {
  const counter = Math.floor(timeMs / 1000 / period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(ALGORITHMS[algorithm], key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** Milliseconds to wait so that at least `minRemainingS` seconds of the period are left after the wait. */
export function waitForFreshWindow(period, timeMs, minRemainingS) {
  const remaining = period * 1000 - (timeMs % (period * 1000));
  return remaining < minRemainingS * 1000 ? remaining + 250 : 0;
}

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--min-remaining='));
  const minRemaining = arg ? Number(arg.split('=')[1]) : 5;
  const params = parseOtp(process.env.CHARTMATE_CERTUM_OTP_URI, process.env.CHARTMATE_CERTUM_TOTP_ALGORITHM);
  const wait = waitForFreshWindow(params.period, Date.now(), minRemaining);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  process.stdout.write(`${totp(params, Date.now())}\n`);
  params.key.fill(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(`totp: ${e.message}`);
    process.exit(1);
  });
}
