// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL
// was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// This code is a port of 'Wyckoff Accumulation Distribution' by faytterro, licensed under the Mozilla Public
// License 2.0 (https://mozilla.org/MPL/2.0/).
// Original Pine Script® source © faytterro.

import type { Chart, IndicatorDrawParams, KLineData } from 'klinecharts';
import { wyckoff, WYCKOFF_COLORS, type WyckoffBox, type WyckoffSignal } from '../wyckoffCalc';
import type { CustomIndicator } from '../types';

/** One calc result per bar. Boxes are attached to the bar of their right-most edge. */
export interface WyckoffBarResult {
  barColor: string | null;
  signals: WyckoffSignal[];
  boxes: WyckoffBox[];
}

/** Theme text colour (Pine's default `color_` is white; the theme colour keeps labels readable in light mode). */
function textColor(chart: Chart): string {
  const s = chart.getStyles();
  return s.candle?.tooltip?.title?.color ?? s.indicator?.tooltip?.title?.color ?? '#888888';
}

function fontFamily(chart: Chart): string {
  return chart.getStyles().candle?.tooltip?.title?.family ?? 'Helvetica Neue';
}

const TRIANGLE_GAP = 3;
const LABEL_SIZE = 10;

/** Draws a triangle (tip up when `up`) whose base/tip spans [y, y ± h] centred on x. */
function triangle(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, up: boolean, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (up) {
    ctx.moveTo(x, y);
    ctx.lineTo(x + w / 2, y + h);
    ctx.lineTo(x - w / 2, y + h);
  } else {
    ctx.moveTo(x, y);
    ctx.lineTo(x + w / 2, y - h);
    ctx.lineTo(x - w / 2, y - h);
  }
  ctx.closePath();
  ctx.fill();
}

export function drawWyckoff({ ctx, chart, indicator, xAxis, yAxis }: IndicatorDrawParams<WyckoffBarResult, number, unknown>): boolean {
  const data: KLineData[] = chart.getDataList();
  const result = indicator.result ?? [];
  if (data.length === 0 || result.length === 0) return true;
  const { realFrom, realTo } = chart.getVisibleRange();
  const { gapBar, halfGapBar } = chart.getBarSpace();
  const from = Math.max(0, Math.floor(realFrom) - 1);
  const to = Math.min(data.length, result.length, Math.ceil(realTo) + 1);
  if (to <= from) return true;
  const text = textColor(chart);
  const family = fontFamily(chart);
  const styles = chart.getStyles();

  ctx.save();

  // Boxes (rect + centred text), in creation order so newer boxes paint over older ones.
  for (const r of result) {
    for (const b of r?.boxes ?? []) {
      const l = Math.min(b.left, b.right);
      const rt = Math.max(b.left, b.right);
      if (rt < from || l >= to || !Number.isFinite(b.top) || !Number.isFinite(b.bottom)) continue;
      const x0 = xAxis.convertToPixel(l);
      const x1 = xAxis.convertToPixel(rt);
      const yTop = yAxis.convertToPixel(Math.max(b.top, b.bottom));
      const yBot = yAxis.convertToPixel(Math.min(b.top, b.bottom));
      const w = x1 - x0;
      const h = yBot - yTop;
      if (b.bgColor) {
        ctx.fillStyle = b.bgColor;
        ctx.fillRect(x0, yTop, w, h);
      }
      ctx.strokeStyle = WYCKOFF_COLORS.gray;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(x0) + 0.5, Math.round(yTop) + 0.5, Math.round(w), Math.round(h));
      if (b.text) {
        // Pine's size.auto: shrink the text to fit the box.
        let size = 14;
        ctx.font = `${size}px ${family}`;
        const tw = ctx.measureText(b.text).width;
        if (tw > w - 4) size = Math.floor((size * (w - 4)) / tw);
        size = Math.min(size, Math.floor(h - 2));
        if (size >= 7) {
          ctx.font = `${size}px ${family}`;
          ctx.globalAlpha = 0.2; // color.new(color_, 80)
          ctx.fillStyle = text;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(b.text, x0 + w / 2, yTop + h / 2);
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  // barcolor: repaint the candle (body + wick) of coloured bars over the chart's own candles.
  if (styles.candle?.type !== 'area') {
    for (let i = from; i < to; i++) {
      const color = result[i]?.barColor;
      const d = data[i];
      if (!color || !d) continue;
      const x = xAxis.convertToPixel(i);
      const yH = yAxis.convertToPixel(d.high);
      const yL = yAxis.convertToPixel(d.low);
      const yO = yAxis.convertToPixel(d.open);
      const yC = yAxis.convertToPixel(d.close);
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(x) - 0.5, yH, 1, Math.max(1, yL - yH));
      const top = Math.min(yO, yC);
      ctx.fillRect(Math.round(x - halfGapBar), top, Math.max(1, Math.round(gapBar)), Math.max(1, Math.abs(yC - yO)));
    }
  }

  // Triangles with their labels (stacked when several shapes share a bar and side).
  const tw = Math.max(6, Math.min(10, gapBar + 2));
  const th = tw * 0.8;
  ctx.font = `${LABEL_SIZE}px ${family}`;
  ctx.textAlign = 'center';
  for (let i = from; i < to; i++) {
    const signals = result[i]?.signals;
    const d = data[i];
    if (!signals?.length || !d) continue;
    const x = xAxis.convertToPixel(i);
    let below = yAxis.convertToPixel(d.low) + TRIANGLE_GAP;
    let above = yAxis.convertToPixel(d.high) - TRIANGLE_GAP;
    for (const s of signals) {
      const small = s.text === '' ? 0.8 : 1; // the unlabelled orange pivots (size.auto) are a little smaller
      const w = tw * small;
      const h = th * small;
      if (s.position === 'below') {
        triangle(ctx, x, below, w, h, true, s.color);
        below += h + 2;
        if (s.text) {
          ctx.fillStyle = text;
          ctx.textBaseline = 'top';
          ctx.fillText(s.text, x, below);
          below += LABEL_SIZE + 2;
        }
      } else {
        triangle(ctx, x, above, w, h, false, s.color);
        above -= h + 2;
        if (s.text) {
          ctx.fillStyle = text;
          ctx.textBaseline = 'bottom';
          ctx.fillText(s.text, x, above);
          above -= LABEL_SIZE + 2;
        }
      }
    }
  }

  ctx.restore();
  return true;
}

/** Per-bar calc result from the pure calculation. */
export function wyckoffBarResults(
  dataList: ReadonlyArray<Pick<KLineData, 'high' | 'low' | 'close'>>,
  calcParams: readonly number[],
): WyckoffBarResult[] {
  const r = wyckoff(dataList, { rsiLen: calcParams[0] ?? 14, sens: calcParams[1] ?? 20, pivotLen: calcParams[2] ?? 5 });
  const out: WyckoffBarResult[] = dataList.map((_, i) => ({ barColor: r.barColors[i] ?? null, signals: [], boxes: [] }));
  for (const s of r.signals) out[s.index]?.signals.push(s);
  for (const b of r.boxes) out[Math.max(b.left, b.right)]?.boxes.push(b);
  return out;
}

/**
 * Wyckoff accumulation/distribution (port of faytterro's Pine script): RSI-based sideways ranges drawn as boxes
 * (recoloured Accumulation / Distribution by the trend that follows), Wyckoff events (SC, AR, ST / BC, AR, ST)
 * on pivots, and trend bar colours. Computed on the last 1000 bars, like the original's calc_bars_count.
 */
const indicator: CustomIndicator = {
  template: {
    name: 'WYCKOFF',
    shortName: 'Wyckoff',
    series: 'price',
    calcParams: [14, 20, 5],
    figures: [],
    calc: (dataList, ind) => wyckoffBarResults(dataList, ind.calcParams),
    draw: drawWyckoff,
  },
  catalog: {
    name: 'WYCKOFF',
    label: 'Wyckoff Accumulation and Distribution',
    pane: 'main',
    defaultParams: [14, 20, 5],
    paramLabels: ['RSI Length', 'Trend Sensitivity', 'Pivot Length'],
    paramMin: [1, 0, 1],
    paramMax: [1000, 50, 1000],
    lines: [],
    description:
      "Port of faytterro's 'Wyckoff Accumulation Distribution' (MPL-2.0). Higher trend sensitivity gives fewer bull/bear signals and more sideways ranges. Computed on the last 1000 bars.",
  },
};

export default indicator;
