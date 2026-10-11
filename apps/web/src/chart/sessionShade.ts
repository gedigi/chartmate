import { registerIndicator, type KLineData } from 'klinecharts';

export const SESSION_SHADE = 'SESSION_SHADE';
const FILL = 'rgba(120,120,160,0.10)';

const isExtended = (d: KLineData | undefined) => d?.session === 'pre' || d?.session === 'post';

let registered = false;

/**
 * Registers the SESSION_SHADE indicator (once): a figure-less overlay on the candle pane that shades the
 * columns of pre-/post-market bars. Adjacent extended-hours bars are filled as one rectangle so
 * translucent fills don't produce seams.
 */
export function registerSessionShade(): void {
  if (registered) return;
  registered = true;
  registerIndicator<{ s: unknown }>({
    name: SESSION_SHADE,
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
      ctx.fillStyle = FILL;
      let runStart: number | null = null;
      let runEnd = 0;
      for (let i = from; i < to; i++) {
        const d = data[i];
        if (isExtended(d)) {
          const x = xAxis.convertTimestampToPixel(d!.timestamp);
          if (runStart === null) runStart = x - halfBar;
          runEnd = x - halfBar + bar;
        } else if (runStart !== null) {
          ctx.fillRect(runStart, 0, runEnd - runStart, bounding.height);
          runStart = null;
        }
      }
      if (runStart !== null) ctx.fillRect(runStart, 0, runEnd - runStart, bounding.height);
      ctx.restore();
      return false;
    },
  });
}
