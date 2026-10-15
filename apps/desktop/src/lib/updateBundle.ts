import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { isNewerVersion, parseSemver } from './semver.js';

/**
 * Pre-install check of a downloaded macOS update: before electron-updater hands the zip to Squirrel.Mac, read the
 * app's own Info.plist out of the zip and require its CFBundleShortVersionString to be the version the release
 * advertised AND newer than the running app. Squirrel.Mac itself would install an older (validly signed) app, so
 * this is what makes "no downgrade" hold for the bundle actually installed, not just for latest-mac.yml.
 * Everything unexpected fails closed (throws).
 */

const MAX_PLIST_BYTES = 1 << 20;
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

interface Entry { name: string; method: number; compressedSize: number; size: number; offset: number }

async function readAt(fh: Awaited<ReturnType<typeof open>>, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  if (bytesRead !== len) throw new Error('truncated zip');
  return buf;
}

async function centralDirectory(fh: Awaited<ReturnType<typeof open>>, fileSize: number): Promise<Entry[]> {
  const tailLen = Math.min(fileSize, 22 + 0xffff);
  if (tailLen < 22) throw new Error('not a zip');
  const tail = await readAt(fh, fileSize - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('zip64 is not supported');
  if (cdOffset + cdSize > fileSize || cdSize > 64 << 20) throw new Error('bad zip central directory');
  const cd = await readAt(fh, cdOffset, cdSize);
  const entries: Entry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CEN_SIG) throw new Error('bad zip central directory');
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    entries.push({
      method: cd.readUInt16LE(p + 10),
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      offset: cd.readUInt32LE(p + 42),
      name: cd.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The uncompressed bytes of the single entry whose name matches, or null when none does. */
export async function readZipEntry(file: string, match: (name: string) => boolean, maxBytes: number): Promise<Buffer | null> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const hits = (await centralDirectory(fh, size)).filter((e) => match(e.name));
    if (hits.length === 0) return null;
    if (hits.length > 1) throw new Error('the zip must contain exactly one app');
    const e = hits[0]!;
    if (e.size > maxBytes || e.compressedSize > maxBytes) throw new Error('zip entry too large');
    const loc = await readAt(fh, e.offset, 30);
    if (loc.readUInt32LE(0) !== LOC_SIG) throw new Error('bad zip local header');
    const dataStart = e.offset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28);
    const raw = await readAt(fh, dataStart, e.compressedSize);
    const data = e.method === 0 ? raw : e.method === 8 ? inflateRawSync(raw, { maxOutputLength: maxBytes }) : null;
    if (!data) throw new Error('unsupported zip compression');
    if (data.length !== e.size) throw new Error('zip entry size mismatch');
    return data;
  } finally {
    await fh.close();
  }
}

/** CFBundleShortVersionString from an XML plist, when it appears exactly once and is semver. */
export function plistBundleVersion(xml: string): string | null {
  const all = [...xml.matchAll(/<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>([^<]{1,128})<\/string>/g)];
  if (all.length !== 1) return null;
  const v = all[0]![1]!.trim();
  return parseSemver(v) ? v : null;
}

const APP_INFO_PLIST = /^[^/]+\.app\/Contents\/Info\.plist$/;

export async function checkDownloadedBundle(zipFile: string, o: { advertised: unknown; current: string }): Promise<void> {
  const plist = await readZipEntry(zipFile, (n) => APP_INFO_PLIST.test(n), MAX_PLIST_BYTES);
  if (!plist) throw new Error('downloaded update has no app Info.plist');
  const text = plist.toString('utf8');
  if (text.startsWith('bplist')) throw new Error('downloaded update has a binary Info.plist');
  const version = plistBundleVersion(text);
  if (!version) throw new Error('downloaded update has no valid version');
  if (version !== o.advertised) throw new Error(`downloaded update version ${version} does not match the release`);
  if (!isNewerVersion(version, o.current)) throw new Error(`downloaded update version ${version} is not newer than ${o.current}`);
}
