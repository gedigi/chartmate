/**
 * Release data from GitHub (version, release notes) is untrusted input: it only ever reaches native dialogs, as
 * plain text, after these filters. Nothing is rendered as HTML.
 */

const SEMVER = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,40})?(?:\+[0-9A-Za-z.-]{1,40})?$/;

/** The version if it is plain semver (what the release tags are), else null. */
export function safeVersion(v: unknown): string | null {
  return typeof v === 'string' && SEMVER.test(v) ? v : null;
}

export const MAX_NOTES_CHARS = 600;
export const MAX_NOTES_LINES = 12;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8}|#39);/gi, (m, name: string) => {
    const lower = name.toLowerCase();
    if (lower in ENTITIES) return ENTITIES[lower]!;
    const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : lower.startsWith('#') ? parseInt(lower.slice(1), 10) : NaN;
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

function htmlToText(html: string): string {
  return decodeEntities(html
    .replace(/<(script|style|template|iframe|object|svg)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/ul|\/ol|\/tr|hr)\b[^>]*>/gi, '\n')
    .replace(/<(p|div|h[1-6]|ul|ol|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>?/g, ''));
}

/**
 * Every Unicode control (Cc, except newline), format (Cf: zero-width, bidirectional overrides and isolates, soft
 * hyphen, tags …), line separator (Zl) and paragraph separator (Zp) character.
 */
const UNSAFE_CHARS = /(?!\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Release notes (electron-updater gives the GitHub release body as HTML, or an array of { version, note }) as short
 * plain text: tags removed, entities decoded, control/bidi characters dropped, at most MAX_NOTES_LINES lines and
 * MAX_NOTES_CHARS characters. Null when there is nothing to show.
 */
export function releaseNotesText(notes: unknown): string | null {
  let html: string;
  if (typeof notes === 'string') html = notes;
  else if (Array.isArray(notes)) {
    html = notes.map((n) => {
      const o = (n ?? {}) as { version?: unknown; note?: unknown };
      const v = safeVersion(o.version);
      return typeof o.note === 'string' && o.note.trim() !== '' ? `<p>${v ?? ''}</p>${o.note}` : '';
    }).join('');
  } else return null;

  const lines = htmlToText(html.slice(0, 50_000))
    .replace(/\t/g, ' ')
    .replace(UNSAFE_CHARS, '')
    .split('\n')
    .map((l) => l.replace(/[ \t\u00A0]+/g, ' ').trim())
    .filter((l) => l !== '' && l !== '•');
  if (lines.length === 0) return null;
  const text = lines.slice(0, MAX_NOTES_LINES).join('\n');
  const moreLines = lines.length > MAX_NOTES_LINES;
  const limit = MAX_NOTES_CHARS - 2; // room for the ellipsis
  if (text.length > limit) return `${text.slice(0, limit).trimEnd()}…`;
  return moreLines ? `${text}\n…` : text;
}
