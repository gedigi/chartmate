import { registerOverlay, type DeepPartial, type OverlayStyle } from 'klinecharts';
import { readableTextOnAll } from './contrast';
import { themeTokens, type ThemeName } from './theme';

/** Overlay template of chart markers (basket Start, version changes). Never a user drawing. */
export const MARKER_OVERLAY = 'chartmateMarker';
const MARKER_DASH = [4, 4];

let registered = false;

/**
 * Registers the marker template once: a dashed vertical line across the whole pane at the marker's bar, with
 * its label at the bottom (above the x-axis). Its figures ignore events, so a marker cannot be selected, hovered or dragged.
 */
export function registerMarkerOverlay(): void {
  if (registered) return;
  registered = true;
  registerOverlay({
    name: MARKER_OVERLAY,
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ overlay, coordinates, bounding }) => {
      const x = coordinates[0]?.x;
      if (x === undefined) return [];
      const text = typeof overlay.extendData === 'string' ? overlay.extendData : '';
      return [
        { type: 'line', attrs: { coordinates: [{ x, y: 0 }, { x, y: bounding.height }] }, ignoreEvent: true },
        // Label at the bottom of the pane (just above the x-axis), clear of the OHLC legend at the top-left.
        { type: 'text', attrs: { x: x + 4, y: bounding.height - 4, text, align: 'left', baseline: 'bottom' }, ignoreEvent: true },
      ];
    },
  });
}

/**
 * Fixed, theme-based marker style (muted color, thin dashed line): independent of user drawing defaults. The
 * label sits on the chart background: muted is kept while it reaches 3:1 there, else white / dark text.
 */
export function markerStyles(theme: ThemeName): DeepPartial<OverlayStyle> {
  const t = themeTokens(theme);
  const color = t.muted;
  const textColor = readableTextOnAll([t.bg], t.muted);
  return {
    line: { color, size: 1, style: 'dashed', dashedValue: MARKER_DASH },
    text: {
      color: textColor, size: 11, backgroundColor: 'rgba(0,0,0,0)', borderColor: 'rgba(0,0,0,0)', borderSize: 0,
      paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0,
    },
  };
}
