/**
 * Color math for the market color family: OKLab / OKLCH conversions and the soft tone derived from a strong color.
 *
 * Why not alpha: blending red toward white in sRGB (what an rgba() fill over a white chart does) rotates its hue
 * toward pink (OKLCH hue 19.5° → 7°), and toward a near-black background toward brown. A soft tone computed in OKLCH
 * with the hue held fixed stays in the same family as the strong color on both themes.
 */

type Rgb = [number, number, number];

const HEX6 = /^#([0-9a-f]{6})$/i;
const HEX3 = /^#([0-9a-f]{3})$/i;
const RGB = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*(\d*(?:\.\d+)?)\s*)?\)$/i;

/** '#rrggbb' / '#rgb' / 'rgb()' / 'rgba()' → [r, g, b] 0–255 and alpha 0–1; null for anything else. */
export function parseColor(color: string): { rgb: Rgb; alpha: number } | null {
  const c = color.trim();
  let hex = HEX6.exec(c)?.[1] ?? null;
  const short = HEX3.exec(c)?.[1];
  if (!hex && short) hex = [...short].map((ch) => ch + ch).join('');
  if (hex) {
    const n = parseInt(hex, 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const m = RGB.exec(c);
  if (!m) return null;
  const ch = (v: string) => Math.min(255, Math.max(0, Number(v)));
  const alpha = m[4] === undefined || m[4] === '' ? 1 : Math.min(1, Math.max(0, Number(m[4])));
  return { rgb: [ch(m[1]!), ch(m[2]!), ch(m[3]!)], alpha };
}

export function toHex(rgb: Rgb): string {
  return `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}

const toLinear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** sRGB (0–255) → OKLab [L, a, b]. */
export function rgbToOklab(rgb: Rgb): Rgb {
  const [r, g, b] = rgb.map(toLinear) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → linear sRGB (may fall outside 0–1 when out of gamut). */
function oklabToLinear([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** '#rrggbb' → OKLCH [L 0–1, C, H degrees]. */
export function oklch(color: string): Rgb {
  const p = parseColor(color);
  const [L, a, b] = rgbToOklab(p ? p.rgb : [0, 0, 0]);
  return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
}

const inGamut = (v: Rgb) => v.every((x) => x >= -1e-4 && x <= 1 + 1e-4);

/** OKLCH → '#rrggbb', keeping L and H and lowering chroma until the color fits in sRGB. */
export function fromOklch(L: number, C: number, H: number): string {
  const at = (c: number) => oklabToLinear([L, c * Math.cos((H * Math.PI) / 180), c * Math.sin((H * Math.PI) / 180)]);
  let lin = at(C);
  if (!inGamut(lin)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(at(mid))) lo = mid;
      else hi = mid;
    }
    lin = at(lo);
  }
  return toHex(lin.map((x) => fromLinear(Math.min(1, Math.max(0, x)))) as Rgb);
}

/**
 * How far a soft tone moves toward the background (OKLCH lightness), and how much of that it gives up in chroma. Kept
 * short of the background so the soft tone still reads as the same hue (and as a bar) on both themes: ≥ 3:1 against
 * the dark chart, clearly apart from the strong color.
 */
export const SOFT_TONE = { lightness: 0.3, chromaLoss: 0.2 } as const;

const softCache = new Map<string, string>();

/**
 * The soft tone of `color` on `bg` (both CSS colors; a translucent `color` is first composited onto `bg`): same OKLCH
 * hue, lightness moved SOFT_TONE.lightness of the way toward the background, chroma scaled by
 * (1 − chromaLoss × lightness) — opaque, so it looks the same wherever it is drawn. Unparseable input is returned as
 * is. Memoized (it runs for every rising histogram bar on every repaint).
 */
export function softTone(color: string, bg: string): string {
  const key = `${color}|${bg}`;
  const hit = softCache.get(key);
  if (hit !== undefined) return hit;
  const out = computeSoftTone(color, bg);
  if (softCache.size > 256) softCache.clear();
  softCache.set(key, out);
  return out;
}

function computeSoftTone(color: string, bg: string): string {
  const c = parseColor(color);
  const b = parseColor(bg);
  if (!c || !b) return color;
  const rgb = c.rgb.map((v, i) => v * c.alpha + b.rgb[i]! * (1 - c.alpha)) as Rgb;
  const [L, C, H] = oklch(toHex(rgb));
  const [Lb] = oklch(toHex(b.rgb));
  const t = SOFT_TONE.lightness;
  return fromOklch(L + (Lb - L) * t, C * (1 - SOFT_TONE.chromaLoss * t), H);
}

/** Perceptual (OKLab) distance of two sRGB colors. */
export function colorDistance(a: Rgb, b: Rgb): number {
  const x = rgbToOklab(a);
  const y = rgbToOklab(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

const rgbaText = (rgb: readonly number[], a: number) => `rgba(${rgb.map((v) => Math.round(v)).join(',')},${Number(a.toFixed(3))})`;

/** The hue-locked tint of `color` `amount` of the way toward `bg` (OKLCH lightness; chroma scaled by 1 − 0.75 × amount). */
function tintAt(color: Rgb, bg: Rgb, amount: number): Rgb {
  const [L, C, H] = oklch(toHex(color));
  const [Lb] = oklch(toHex(bg));
  return parseColor(fromOklch(L + (Lb - L) * amount, C * (1 - amount * 0.75), H))!.rgb;
}

/** The least opaque rgba() over `bg` that composites onto the opaque `target`; null when none exists below 0.6 opacity. */
function rgbaOnto(target: Rgb, bg: Rgb): { rgb: Rgb; alpha: number } | null {
  let up = 0;
  let down = 0;
  for (let i = 0; i < 3; i++) {
    const t = target[i]!;
    const g = bg[i]!;
    if (t > g) up = Math.max(up, (t - g) / (255 - g));
    else if (t < g) down = Math.max(down, (g - t) / g);
  }
  let alpha = Math.max(up, down);
  // A near-white background leaves little headroom above it (#fafbfd: 2–5 per channel), so a channel the tint wants
  // ABOVE the background can need an almost opaque fill. Then the darkening channels set the opacity and the others
  // saturate at 255: the composite lands within a hair of the tint, same hue.
  if (alpha >= 0.6 && down > 0 && down < 0.6) alpha = down;
  if (!(alpha > 0) || alpha >= 0.6) return null;
  return { rgb: target.map((t, i) => Math.min(255, Math.max(0, bg[i]! + (t - bg[i]!) / alpha))) as Rgb, alpha };
}

/**
 * A translucent fill of `color` on `bg`: the least opaque rgba() that composites EXACTLY onto the hue-locked tint of
 * `color` on `bg` (OKLCH lightness `amount` of the way toward bg, chroma scaled by 1 − 0.75 × amount). On white that
 * is a coral / mint tint of the color's own hue, where a plain rgba() of a crimson turns pink. When no such rgba
 * exists below 0.6 opacity (typically on a dark background, where the tint would need a channel darker than the
 * background's), `color` at `fallbackAlpha`.
 */
export function tintFill(color: string, bg: string, amount: number, fallbackAlpha: number): string {
  const c = parseColor(color);
  const b = parseColor(bg);
  if (!c || !b) return color;
  const fill = rgbaOnto(tintAt(c.rgb, b.rgb, amount), b.rgb);
  return fill ? rgbaText(fill.rgb, fill.alpha) : rgbaText(c.rgb, fallbackAlpha);
}

/**
 * A translucent zone fill (a position's profit / loss zone, drawn over candles) of `color` on `bg` with a set
 * perceived WEIGHT: its composite sits `weight` (OKLab distance) away from `bg`, so an up and a down zone read equally
 * strong on either theme. Preferably the hue-locked tint (see tintFill) when an rgba() of at most `maxAlpha` lands on
 * it, else `color` itself at the opacity that reaches the weight. Never above `maxAlpha`, so the candles under the
 * zone keep their own color. Unparseable input is returned as is.
 */
export function zoneTint(color: string, bg: string, weight: number, maxAlpha: number): string {
  const c = parseColor(color);
  const b = parseColor(bg);
  if (!c || !b) return color;
  // The tint's distance from bg falls as `amount` grows (1 = bg itself).
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (colorDistance(tintAt(c.rgb, b.rgb, mid), b.rgb) > weight) lo = mid;
    else hi = mid;
  }
  const exact = rgbaOnto(tintAt(c.rgb, b.rgb, hi), b.rgb);
  const mix = (a: number) => c.rgb.map((v, i) => v * a + b.rgb[i]! * (1 - a)) as Rgb;
  lo = 0;
  hi = maxAlpha;
  if (colorDistance(mix(maxAlpha), b.rgb) > weight) {
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (colorDistance(mix(mid), b.rgb) < weight) lo = mid;
      else hi = mid;
    }
  }
  // Both reach the weight: the less opaque one changes the candles under the zone less.
  if (exact && exact.alpha <= Math.min(hi, maxAlpha)) return rgbaText(exact.rgb, exact.alpha);
  return rgbaText(c.rgb, hi);
}
