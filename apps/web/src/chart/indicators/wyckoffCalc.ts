// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL
// was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// This code is a port of 'Wyckoff Accumulation Distribution' by faytterro, licensed under the Mozilla Public
// License 2.0 (https://mozilla.org/MPL/2.0/).
// Original Pine Script® source © faytterro.

/**
 * Pure calculation of the Wyckoff Accumulation/Distribution indicator (no klinecharts import), reproducing
 * the Pine Script v5 semantics bar by bar. `na` is represented as NaN, so every comparison with it is false,
 * exactly as in Pine. Unit-tested in test/indicators/wyckoff.test.ts.
 */

const NA = Number.NaN;
const isNa = (v: number | undefined): boolean => v === undefined || Number.isNaN(v);

/**
 * `ta.rsi(src, len)`: Wilder's RSI. Gains/losses are smoothed with `ta.rma`, whose first value is the SMA of
 * the first `len` changes, so the first RSI is at index `len` (na before). `down == 0 → 100`, `up == 0 → 0`.
 */
export function pineRsi(src: readonly number[], len: number): number[] {
  const n = Math.max(1, Math.floor(len));
  const out: number[] = new Array<number>(src.length).fill(NA);
  let up = NA;
  let down = NA;
  let sumUp = 0;
  let sumDown = 0;
  for (let i = 1; i < src.length; i++) {
    const ch = src[i]! - src[i - 1]!;
    const u = Math.max(ch, 0);
    const d = Math.max(-ch, 0);
    if (i < n) {
      sumUp += u;
      sumDown += d;
      continue;
    }
    if (i === n) {
      up = (sumUp + u) / n;
      down = (sumDown + d) / n;
    } else {
      up = (u + (n - 1) * up) / n;
      down = (d + (n - 1) * down) / n;
    }
    out[i] = down === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / down);
  }
  return out;
}

/**
 * `ta.pivothigh(src, left, right)` / `ta.pivotlow`: on bar t, the value of bar c = t − right when it is the
 * extreme of the window [c − left, c + right], otherwise na. Ties follow Pine Script's ta.pivothigh / ta.pivotlow (as reproduced by
 * PyneCore, which validates against the original output): an equal value on the LEFT (older) side does not
 * disqualify the pivot, an equal value on the RIGHT (newer) side does — i.e. of equal extremes the newest wins.
 * The whole window must exist (na in the first left + right bars).
 */
function pivot(src: readonly number[], left: number, right: number, isHigh: boolean): number[] {
  const out: number[] = new Array<number>(src.length).fill(NA);
  const beats = (c: number, o: number, strict: boolean) =>
    isHigh ? (strict ? c > o : c >= o) : (strict ? c < o : c <= o);
  for (let t = left + right; t < src.length; t++) {
    const c = t - right;
    const v = src[c]!;
    if (isNa(v)) continue;
    let ok = true;
    for (let k = 1; ok && k <= left; k++) ok = beats(v, src[c - k]!, false);
    for (let k = 1; ok && k <= right; k++) ok = beats(v, src[c + k]!, true);
    if (ok) out[t] = v;
  }
  return out;
}

export const pivotHigh = (src: readonly number[], left: number, right: number): number[] => pivot(src, left, right, true);
export const pivotLow = (src: readonly number[], left: number, right: number): number[] => pivot(src, left, right, false);

/** Pine's `calc_bars_count = 1000`: the script only runs on the last 1000 bars. */
export const CALC_BARS_COUNT = 1000;
/** Pine's `max_boxes_count = 500`: older boxes are deleted. */
export const MAX_BOXES = 500;

/**
 * The script's colors as ROLES; the draw callback (custom/wyckoff.ts) maps them onto the active theme's palette at draw
 * time, so they follow the theme and the user's up / down colors. The original's Pine colors, for reference:
 * bull / bear bars color.lime / color.purple; SC, AR, ST color.green; BC and the distribution AR, ST color.red; other
 * pivots color.orange; box borders color.gray; range boxes gray at 90% transparency, accumulation / distribution
 * boxes green / red at 95%.
 */
export type WyckoffTrend = 'bull' | 'bear';
/** Which phase a signal or box belongs to: accumulation (up family), distribution (down family), or neither. */
export type WyckoffTone = 'accumulation' | 'distribution' | 'pivot';
export type WyckoffBoxKind = 'range' | 'accumulation' | 'distribution';

export interface WyckoffBar { high: number; low: number; close: number }
export interface WyckoffParams { rsiLen: number; sens: number; pivotLen: number }

export type WyckoffSignalKind = 'SC' | 'AR' | 'ST' | 'BC' | 'DAR' | 'DST' | 'PIVOT_LOW' | 'PIVOT_HIGH';
export interface WyckoffSignal {
  /** Bar the shape is plotted on (the pivot bar: the confirmation bar − pivotLen). */
  index: number;
  kind: WyckoffSignalKind;
  /** Shape text ('' for the unlabeled orange pivots). */
  text: string;
  /** 'below': triangle up under the bar's low; 'above': triangle down over the bar's high. */
  position: 'below' | 'above';
  tone: WyckoffTone;
}
export interface WyckoffBox {
  /** Bar index of the box's left / right edge (bar centers, like Pine's xloc.bar_index). */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** A sideways range, recolored Accumulation / Distribution by the trend that follows. */
  kind: WyckoffBoxKind;
  /** Whether the box has a background (Pine `na` for a range whose x1 >= x2). */
  filled: boolean;
  /** Centered text ('Accumulation' / 'Distribution'), or null. */
  text: string | null;
}
export interface WyckoffResult {
  /** ta.rsi per bar (NaN = na), for every input bar. */
  rsi: number[];
  boxes: WyckoffBox[];
  signals: WyckoffSignal[];
  /** barcolor per bar as the trend (null = default candle color). */
  barTrends: Array<WyckoffTrend | null>;
}

const SIGNAL_STYLE: Record<WyckoffSignalKind, Pick<WyckoffSignal, 'text' | 'position' | 'tone'>> = {
  SC: { text: 'SC', position: 'below', tone: 'accumulation' },
  AR: { text: 'AR', position: 'above', tone: 'accumulation' },
  ST: { text: 'ST', position: 'below', tone: 'accumulation' },
  BC: { text: 'BC', position: 'above', tone: 'distribution' },
  DAR: { text: 'AR', position: 'below', tone: 'distribution' },
  DST: { text: 'ST', position: 'above', tone: 'distribution' },
  PIVOT_LOW: { text: '', position: 'below', tone: 'pivot' },
  PIVOT_HIGH: { text: '', position: 'above', tone: 'pivot' },
};

/**
 * Runs the script over `bars` (oldest first). Only the last `calcBarsCount` bars are calculated (Pine's
 * `calc_bars_count`); everything before produces nothing, and the calculation (RSI seed, `var` state, history
 * references) starts fresh at the first calculated bar, as in Pine Script. All returned indices refer to `bars`.
 */
export function wyckoff(
  bars: readonly WyckoffBar[],
  params: WyckoffParams,
  { calcBarsCount = CALC_BARS_COUNT, maxBoxes = MAX_BOXES }: { calcBarsCount?: number; maxBoxes?: number } = {},
): WyckoffResult {
  const total = bars.length;
  const start = Math.max(0, total - Math.max(0, Math.floor(calcBarsCount)));
  const data = bars.slice(start);
  const n = data.length;
  const rsiLen = Math.max(1, Math.floor(params.rsiLen));
  const rsisens = Math.floor(params.sens);
  const len = Math.max(1, Math.floor(params.pivotLen));

  const close = data.map((b) => b.close);
  const high = data.map((b) => b.high);
  const low = data.map((b) => b.low);
  const rsi = pineRsi(close, rsiLen);
  const hist = (s: readonly number[], t: number, k: number) => (t - k >= 0 ? s[t - k]! : NA);

  const rsiAll = new Array<number>(total).fill(NA);
  rsi.forEach((v, i) => { rsiAll[start + i] = v; });
  const barTrends = new Array<WyckoffTrend | null>(total).fill(null);
  const boxes: WyckoffBox[] = [];
  const signals: WyckoffSignal[] = [];
  const emit = (t: number, kind: WyckoffSignalKind) => signals.push({ index: start + t - len, kind, ...SIGNAL_STYLE[kind] });

  const ph = pivotHigh(high, len, len);
  const pl = pivotLow(low, len, len);
  const rsiLow = 50 - rsisens;
  const rsiHigh = 50 + rsisens;

  // Per-bar series read through history references.
  const side: boolean[] = [];
  const myhighSeries: number[] = [];
  const mylowSeries: number[] = [];

  // `var` state
  let lastSideStart = NA; // ta.valuewhen(side and not side[1], bar_index, 0); also drives ta.barssince
  let lastSideEnd = NA; // ta.valuewhen(not side and side[1], bar_index[1], 0)
  let trendBox: WyckoffBox | null = null;
  let afterTrend: 'Accumulation' | 'Distribution' | null = null;
  let isSCFlag = false;
  let isARFlag = false;
  let isSTFlag = false;
  let isBCFlag = false;
  let isDARFlag = false;
  let isDSTFlag = false;
  let scBarIndex = NA;
  let pivotCounter = 0;
  let bcBarIndex = NA;
  let darBarIndex = NA;

  for (let t = 0; t < n; t++) {
    const r = rsi[t]!;
    const r1 = hist(rsi, t, 1);
    const utad = r < 50 + rsisens && r1 > 50 + rsisens;
    const spring = r > 50 - rsisens && r1 < 50 - rsisens;

    const sideNow = (r < 50 + rsisens && r > 50 - rsisens) || (r1 < 50 + rsisens && r1 > 50 - rsisens);
    side.push(sideNow);
    const side1 = t >= 1 ? side[t - 1]! : false; // side[1] is na on the first bar → false
    const bull = r > 50 + rsisens && r1 > 50 + rsisens;
    const bear = r < 50 - rsisens && r1 < 50 - rsisens;

    if (sideNow && !side1) lastSideStart = t;
    const boxlen = isNa(lastSideStart) ? NA : t - lastSideStart; // ta.barssince(side and not side[1])

    // barcolor(bull ? color.lime : bear ? color.purple : na, offset = -2)
    if ((bull || bear) && t - 2 >= 0) barTrends[start + t - 2] = bull ? 'bull' : 'bear';

    const x1 = lastSideStart;
    if (!sideNow && side1) lastSideEnd = t - 1;
    const x2 = lastSideEnd - 1;

    // myhigh/mylow(math.max(1, boxlen + 1)): highest high / lowest low of the last N bars (na while boxlen is na;
    // bars before the first calculated bar are na and ignored).
    const windowLen = isNa(boxlen) ? NA : Math.max(1, boxlen + 1);
    let hi = NA;
    let lo = NA;
    if (!isNa(windowLen)) {
      for (let i = 0; i < windowLen && t - i >= 0; i++) {
        if (isNa(hi) || high[t - i]! > hi) hi = high[t - i]!;
        if (isNa(lo) || low[t - i]! < lo) lo = low[t - i]!;
      }
    }
    myhighSeries.push(hi);
    mylowSeries.push(lo);
    const y1 = hist(myhighSeries, t, 2);
    const y2 = hist(mylowSeries, t, 2);

    if (side1 && !sideNow) {
      trendBox = { left: start + x1, right: start + x2, top: y1, bottom: y2, kind: 'range', filled: x1 < x2, text: null };
      boxes.push(trendBox);
      if (boxes.length > maxBoxes) boxes.shift();
    }

    if (bull) afterTrend = 'Accumulation';
    else if (bear) afterTrend = 'Distribution';

    if (trendBox && afterTrend === 'Accumulation') {
      trendBox.kind = 'accumulation';
      trendBox.filled = true;
      trendBox.text = 'Accumulation';
    } else if (trendBox && afterTrend === 'Distribution') {
      trendBox.kind = 'distribution';
      trendBox.filled = true;
      trendBox.text = 'Distribution';
    }

    const pivotLowNow = !isNa(pl[t]);
    const pivotHighNow = !isNa(ph[t]);
    const rsiAtPivot = hist(rsi, t, len);

    // SC
    const isSC: boolean = pivotLowNow && rsiAtPivot < rsiLow && !isSCFlag && !spring;
    isSCFlag = isSC ? true : isSCFlag;

    // AR (accumulation)
    if (isSC) scBarIndex = t - len;
    let isAR = false;
    if (!isNa(scBarIndex) && pivotHighNow && t - len > scBarIndex && !isARFlag) {
      isAR = true;
      scBarIndex = NA;
    }
    isARFlag = isAR ? true : isARFlag;

    // ST (accumulation)
    if (pivotLowNow) pivotCounter += 1;
    if (rsiAtPivot < rsiLow) pivotCounter = 0;
    const isST: boolean = pivotCounter === 1 && pivotLowNow && !isSTFlag;
    isSTFlag = isST ? true : isSTFlag;

    // BC
    const isBC: boolean = rsiAtPivot > rsiHigh && pivotHighNow && !isBCFlag && !utad;
    isBCFlag = isBC ? true : isBCFlag;

    // DAR (automatic reaction)
    if (isBC) bcBarIndex = t - len;
    let isDAR = false;
    if (!isNa(bcBarIndex) && pivotLowNow && t - len > bcBarIndex && !isDARFlag) {
      isDAR = true;
      bcBarIndex = NA;
    }
    isDARFlag = isDAR ? true : isDARFlag;

    // DST (secondary test of distribution)
    if (isDAR) darBarIndex = t - len;
    let isDST = false;
    if (!isNa(darBarIndex) && pivotHighNow && t - len > darBarIndex && !isDSTFlag && !isBC) {
      isDST = true;
      darBarIndex = NA;
    }
    isDSTFlag = isDST ? true : isDSTFlag;

    // plotshape calls in script order, all at offset −pivotLen
    if (isSC) emit(t, 'SC');
    if (isAR) emit(t, 'AR');
    if (isST) emit(t, 'ST');
    if (isBC) emit(t, 'BC');
    if (isDAR) emit(t, 'DAR');
    if (isDST) emit(t, 'DST');
    if (pivotLowNow && !isSC && !isST && !isAR && !isDAR) emit(t, 'PIVOT_LOW');
    if (pivotHighNow && !isAR && !isDST && !isBC) emit(t, 'PIVOT_HIGH');

    // `if bar_index != bar_index[1]`: false on the first bar (bar_index[1] is na), true on every later bar, so
    // the flags never survive into the next bar and never block a signal. Reproduced literally.
    if (t >= 1) {
      isSCFlag = false;
      isARFlag = false;
      isSTFlag = false;
      isBCFlag = false;
      isDARFlag = false;
      isDSTFlag = false;
    }
  }

  return { rsi: rsiAll, boxes, signals, barTrends };
}
