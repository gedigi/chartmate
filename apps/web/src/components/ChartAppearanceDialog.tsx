import {
  MAX_LINE_WIDTH, MIN_LINE_WIDTH,
  type CandleBodyStyle, type ChartAppearance, type ChartType, type DrawingLineStyle,
} from '@chartmate/shared';
import { useId, type JSX } from 'react';
import { contrastRatio } from '../chart/contrast';
import { resolveThemeAppearance, themeTokens, type ThemeName } from '../chart/theme';
import { LINE_STYLES, parseLineStyle } from '../chart/drawingStyles';
import { Modal } from './Modal';
import './Indicators.css';

export interface ChartAppearanceDialogProps {
  /** Stored appearance of `theme` (unset fields follow the theme). */
  appearance: ChartAppearance | undefined;
  /** The active theme: the one whose settings are edited. */
  theme: ThemeName;
  chartType: ChartType;
  /** Called on every change (applied live); undefined = reset to the theme defaults. */
  onChange: (a: ChartAppearance | undefined) => void;
  onClose: () => void;
}

const WIDTHS = Array.from({ length: MAX_LINE_WIDTH - MIN_LINE_WIDTH + 1 }, (_, i) => MIN_LINE_WIDTH + i);
const BODY_STYLES: ReadonlyArray<{ value: CandleBodyStyle; label: string }> = [
  { value: 'solid', label: 'Filled' },
  { value: 'hollow', label: 'Hollow' },
  { value: 'hollow_up', label: 'Hollow up' },
  { value: 'hollow_down', label: 'Hollow down' },
];

/** Up + down candle drawn with the chosen colors and body style. */
function CandlePreview({ up, down, body }: { up: string; down: string; body: CandleBodyStyle }): JSX.Element {
  const hollowUp = body === 'hollow' || body === 'hollow_up';
  const hollowDown = body === 'hollow' || body === 'hollow_down';
  const candle = (x: number, color: string, hollow: boolean, top: number, bottom: number, testId: string) => (
    <g>
      <line x1={x + 6} x2={x + 6} y1={top - 6} y2={bottom + 6} stroke={color} strokeWidth="1.5" />
      <rect data-testid={testId} x={x} y={top} width="12" height={bottom - top} fill={hollow ? 'none' : color} stroke={color} strokeWidth="1.5" />
    </g>
  );
  return (
    <svg className="appearance-preview" width="56" height="44" viewBox="0 0 56 44" aria-hidden="true" focusable="false">
      {candle(8, up, hollowUp, 12, 30, 'candle-preview-up')}
      {candle(34, down, hollowDown, 10, 26, 'candle-preview-down')}
    </svg>
  );
}

/** Below this contrast ratio against the chart background a color barely shows. */
export const LOW_CONTRAST_RATIO = 1.5;

const THEME_LABEL: Record<ThemeName, string> = { dark: 'Dark theme', light: 'Light theme' };

/**
 * Chart appearance of the active theme (each theme keeps its own): candle colors and body style, line/area
 * color and width, and the default style of new drawings. Changes apply live; "Reset to defaults" returns this
 * theme to its default colors. Colors that barely show on the theme background get an inline warning.
 */
export function ChartAppearanceDialog({ appearance, theme, chartType, onChange, onClose }: ChartAppearanceDialogProps): JSX.Element {
  const r = resolveThemeAppearance(theme, appearance);
  const idBase = useId();
  const id = (k: string) => `${idBase}-${k}`;
  const bg = themeTokens(theme).bg;
  const warningText = `Low contrast on the ${theme} background`;
  const lowContrast = (c: string) => contrastRatio(c, bg) < LOW_CONTRAST_RATIO;
  /** Input + inline warning for a color drawn on the chart background. */
  const colorInput = (k: string, label: string, value: string, onPick: (v: string) => void, autoFocus = false) => {
    const low = lowContrast(value);
    return (
      <>
        <div className="settings-row">
          <label htmlFor={id(k)}>{label}</label>
          <input id={id(k)} type="color" value={value} onChange={(e) => onPick(e.target.value)}
            aria-describedby={low ? id(`${k}-warn`) : undefined} {...(autoFocus ? { 'data-autofocus': true } : {})} />
        </div>
        {low && <p id={id(`${k}-warn`)} className="appearance-warning">{warningText}</p>}
      </>
    );
  };
  const set = (patch: ChartAppearance) => onChange({ ...appearance, ...patch });
  const setDrawing = (patch: Partial<DrawingLineStyle>) => set({ drawing: { ...r.drawing, ...patch } });
  const widthOptions = WIDTHS.map((w) => <option key={w} value={w}>{w}px</option>);

  return (
    <Modal title="Chart appearance" onClose={onClose} className="indicator-settings chart-appearance">
      <p className="indicator-settings-subtitle appearance-theme">{THEME_LABEL[theme]}</p>
      <fieldset className="settings-colors">
        <legend>Candles</legend>
        {colorInput('up', 'Up color', r.upColor, (v) => set({ upColor: v }), true)}
        {colorInput('down', 'Down color', r.downColor, (v) => set({ downColor: v }))}
        <div className="settings-row">
          <label htmlFor={id('body')}>Body style</label>
          <select id={id('body')} value={r.candleBody} onChange={(e) => set({ candleBody: e.target.value as CandleBodyStyle })}>
            {BODY_STYLES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        </div>
        <CandlePreview up={r.upColor} down={r.downColor} body={r.candleBody} />
        {chartType === 'ohlc' && <p className="indicator-settings-note">OHLC bars use the up/down colors only.</p>}
      </fieldset>
      <fieldset className="settings-colors">
        <legend>Line / area</legend>
        {colorInput('line', 'Line color', r.lineColor, (v) => set({ lineColor: v }))}
        <div className="settings-row">
          <label htmlFor={id('lw')}>Line width</label>
          <select id={id('lw')} value={r.lineWidth} onChange={(e) => set({ lineWidth: Number(e.target.value) })}>{widthOptions}</select>
        </div>
      </fieldset>
      <fieldset className="settings-colors">
        <legend>Default drawing style</legend>
        {colorInput('dc', 'Drawing color', r.drawing.color, (v) => setDrawing({ color: v }))}
        <div className="settings-row">
          <label htmlFor={id('dw')}>Drawing width</label>
          <select id={id('dw')} value={r.drawing.size} onChange={(e) => setDrawing({ size: Number(e.target.value) })}>{widthOptions}</select>
        </div>
        <div className="settings-row">
          <label htmlFor={id('ds')}>Drawing line style</label>
          <select id={id('ds')} value={r.drawing.style} onChange={(e) => setDrawing({ style: parseLineStyle(e.target.value) })}>
            {LINE_STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
      </fieldset>
      <div className="settings-actions">
        <button type="button" onClick={() => onChange(undefined)}>Reset to defaults</button>
        <span className="settings-actions-spacer" />
        <button type="button" className="primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
