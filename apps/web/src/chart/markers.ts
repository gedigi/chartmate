import { registerOverlay, type DeepPartial, type OverlayStyle } from 'klinecharts';
import { THEME_TOKENS, type ThemeName } from './theme';

/** Overlay template of chart markers (basket Start, version changes). Never a user drawing. */
export const MARKER_OVERLAY = 'altvMarker';
const MARKER_DASH = [4, 4];

let registered = false;

/**
 * Registers the marker template once: a dashed vertical line across the whole pane at the marker's bar, with
 * its label at the top. Its figures ignore events, so a marker cannot be selected, hovered or dragged.
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
        { type: 'text', attrs: { x: x + 4, y: 4, text, align: 'left', baseline: 'top' }, ignoreEvent: true },
      ];
    },
  });
}

/** Fixed, theme-based marker style (muted text colour, thin dashed line): independent of user drawing defaults. */
export function markerStyles(theme: ThemeName): DeepPartial<OverlayStyle> {
  const color = THEME_TOKENS[theme].muted;
  return {
    line: { color, size: 1, style: 'dashed', dashedValue: MARKER_DASH },
    text: {
      color, size: 11, backgroundColor: 'rgba(0,0,0,0)', borderColor: 'rgba(0,0,0,0)', borderSize: 0,
      paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0,
    },
  };
}
