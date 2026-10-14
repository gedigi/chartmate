import { registerIndicator, type KLineData } from 'klinecharts';

export const SESSION_SHADE = 'SESSION_SHADE';
/** Background indicators the app manages itself (never listed or overridden as user indicators). */
export const SHADE_INDICATORS: ReadonlySet<string> = new Set([SESSION_SHADE]);

const SESSION_FILL = 'rgba(120,120,160,0.10)';

export const isExtendedSession = (d: KLineData | undefined) => d?.session === 'pre' || d?.session === 'post';

/** Runs [start, end) of adjacent bars in data[from, to) matching `pred`. */
export function shadeRuns(data: readonly KLineData[], from: number, to: number, pred: (d: KLineData | undefined) => boolean): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start: number | null = null;
  for (let i = from; i < to; i++) {
    if (pred(data[i])) {
      if (start === null) start = i;
    } else if (start !== null) {
      runs.push([start, i]);
      start = null;
    }
  }
  if (start !== null) runs.push([start, to]);
  return runs;
}

const registered = new Set<string>();

/**
 * Registers a figure-less indicator on the candle pane that shades the columns of bars matching `pred`.
 * Adjacent matching bars are filled as one rectangle so translucent fills don't produce seams.
 */
function registerShade(name: string, fill: string, pred: (d: KLineData | undefined) => boolean): void {
  if (registered.has(name)) return;
  registered.add(name);
  registerIndicator<{ s: unknown }>({
    name,
    shortName: '',
    figures: [],
    calc: (dataList) => dataList.map((b) => ({ s: b.session })),
    createTooltipDataSource: () => ({ name: '', calcParamsText: '', features: [], legends: [] }),
    draw: ({ ctx, chart, bounding, xAxis }) => {
      const data = chart.getDataList();
      if (data.length === 0) return false;
      const { realFrom, realTo } = chart.getVisibleRange();
      const { bar, halfBar } = chart.getBarSpace();
      const from = Math.max(0, Math.floor(realFrom) - 1);
      const to = Math.min(data.length, Math.ceil(realTo) + 1);
      ctx.save();
      ctx.fillStyle = fill;
      for (const [s, e] of shadeRuns(data, from, to, pred)) {
        // The data index is known: convert it directly (convertTimestampToPixel would binary-search it again).
        const x0 = xAxis.convertToPixel(s) - halfBar;
        const x1 = xAxis.convertToPixel(e - 1) - halfBar + bar;
        ctx.fillRect(x0, 0, x1 - x0, bounding.height);
      }
      ctx.restore();
      return false;
    },
  });
}

/** Registers SESSION_SHADE (pre-/post-market columns), once. */
export function registerSessionShade(): void {
  registerShade(SESSION_SHADE, SESSION_FILL, isExtendedSession);
}
