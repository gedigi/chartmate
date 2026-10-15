import { MAX_LINE_WIDTH, MIN_LINE_WIDTH, type IndicatorState, type LineStyleKind, type ThemedAppearance } from '@chartmate/shared';
import { useId, useState, type FormEvent, type JSX } from 'react';
import { catalogEntry, defaultLineColor, effectiveLineColor, migrateCalcParams, sparseLineColors, validateParam } from '../chart/indicators/catalog';
import { defaultBarColors, effectiveBarColors, type ThemeName } from '../chart/theme';
import { LINE_STYLES, parseLineStyle } from '../chart/drawingStyles';
import { formatLevels, parseLevels } from '../chart/indicators/levels';
import { Modal } from './Modal';
import './Indicators.css';

export interface IndicatorSettingsProps {
  state: IndicatorState;
  onSave: (s: IndicatorState) => void;
  onClose: () => void;
  /** Active theme: the default bar colors of histogram indicators follow its up / down colors. */
  theme?: ThemeName;
  /** Chart appearance: default bar colors are the active theme's (custom) candle colors. */
  appearance?: ThemedAppearance;
}

const WIDTHS = Array.from({ length: MAX_LINE_WIDTH - MIN_LINE_WIDTH + 1 }, (_, i) => MIN_LINE_WIDTH + i);

/**
 * Edits one indicator's params (validated: integers ≥ 1, except params the catalog marks as decimal, which
 * must be > 0) and line colors. Colors are only saved while they differ from the defaults, so untouched
 * (or reset) indicators keep following the active theme's indicator palette. The same applies to line widths
 * (1–4) / styles (solid, dashed, dotted) and, for histogram indicators, the up/down bar colors.
 * Oscillators with catalog reference levels (RSI 70 / 30, MACD 0, …) get a Levels section: a show toggle and the
 * level values, saved only while they differ from the defaults (hidden → `showLevels: false`).
 */
export function IndicatorSettings({ state, onSave, onClose, theme = 'dark', appearance }: IndicatorSettingsProps): JSX.Element {
  const DEFAULT_BAR_COLORS = defaultBarColors(theme, appearance);
  const entry = catalogEntry(state.name);
  const defaults = entry?.defaultParams ?? state.calcParams;
  const labels = entry?.paramLabels ?? state.calcParams.map((_, i) => `Param ${i + 1}`);
  const lines = entry?.lines ?? [];
  const defaultColors = lines.map((_, i) => defaultLineColor(i, state.name, theme));

  // Explicit migration of stored params (shorter lists are padded with defaults); the user sees complete values
  // and Save writes the clean, complete list.
  const [values, setValues] = useState(() => {
    const params = entry ? migrateCalcParams(state.name, state.calcParams) : state.calcParams;
    return labels.map((_, i) => String(params[i] ?? ''));
  });
  const [colors, setColors] = useState(() => lines.map((_, i) => effectiveLineColor(state, i, theme)));
  const [widths, setWidths] = useState(() => lines.map((_, i) => state.lineWidths?.[i] ?? 1));
  const [styles, setStyles] = useState<LineStyleKind[]>(() => lines.map((_, i) => state.lineStyles?.[i] ?? 'solid'));
  const hasBars = entry?.bars === true;
  const [bars, setBars] = useState(() => effectiveBarColors(theme, appearance, state.barColors));
  const defaultLevels = entry?.levels;
  const [showLevels, setShowLevels] = useState(state.showLevels !== false);
  const [levelsText, setLevelsText] = useState(() => formatLevels(state.levels ?? defaultLevels ?? []));
  const idBase = useId();

  const errors = values.map((v, i) => validateParam(state.name, i, v));
  const parsedLevels = parseLevels(levelsText);
  // Hidden levels never block saving: invalid text then keeps the stored values.
  const levelsError = defaultLevels && showLevels && 'error' in parsedLevels ? parsedLevels.error : null;
  const valid = errors.every((e) => e === null) && levelsError === null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const next: IndicatorState = { name: state.name, pane: state.pane, calcParams: values.map(Number), visible: state.visible };
    // Style overrides are only saved while they differ from the defaults (clean shape; the adapter writes the
    // defaults back when an override goes away). Colors are per line: only the edited lines are stored ('' = the
    // theme default), so the others keep following the active theme.
    const lineColors = lines.length > 0 ? sparseLineColors(state.name, colors) : undefined;
    if (lineColors) next.lineColors = lineColors;
    if (lines.length > 0 && widths.some((w) => w !== 1)) next.lineWidths = widths;
    if (lines.length > 0 && styles.some((s) => s !== 'solid')) next.lineStyles = styles;
    if (hasBars && (bars.up !== DEFAULT_BAR_COLORS.up || bars.down !== DEFAULT_BAR_COLORS.down)) next.barColors = { ...bars };
    if (defaultLevels) {
      const levels = 'levels' in parsedLevels ? parsedLevels.levels : state.levels;
      if (levels && (levels.length !== defaultLevels.length || levels.some((v, i) => v !== defaultLevels[i]))) next.levels = levels;
      if (!showLevels) next.showLevels = false;
    }
    onSave(next);
    onClose();
  };

  const reset = () => {
    setValues(labels.map((_, i) => String(defaults[i] ?? '')));
    setColors(defaultColors);
    setWidths(lines.map(() => 1));
    setStyles(lines.map(() => 'solid'));
    setBars({ ...DEFAULT_BAR_COLORS });
    setShowLevels(true);
    setLevelsText(formatLevels(defaultLevels ?? []));
  };

  return (
    <Modal title={`${state.name} settings`} onClose={onClose} className="indicator-settings">
      <form onSubmit={submit} noValidate>
        {entry && entry.label !== state.name && <p className="indicator-settings-subtitle">{entry.label}</p>}
        {labels.length === 0 && <p className="indicator-settings-note">This indicator has no parameters.</p>}
        {labels.map((label, i) => {
          const id = `${idBase}-p${i}`;
          const err = errors[i];
          return (
            <div key={id} className="settings-row">
              <label htmlFor={id}>{label}</label>
              <input
                id={id}
                type="text"
                inputMode="decimal"
                value={values[i]}
                aria-invalid={err ? 'true' : undefined}
                aria-describedby={err ? `${id}-err` : undefined}
                onChange={(e) => setValues((vs) => vs.map((v, j) => (j === i ? e.target.value : v)))}
                data-autofocus={i === 0 ? true : undefined}
              />
              {err && <span id={`${id}-err`} className="form-error settings-error">{err}</span>}
            </div>
          );
        })}
        {lines.length > 0 && (
          <fieldset className="settings-colors">
            <legend>Colors</legend>
            {lines.map((line, i) => {
              const id = `${idBase}-c${i}`;
              return (
                <div key={id} className="settings-row settings-line">
                  <label htmlFor={id}>{line} color</label>
                  <input
                    id={id}
                    type="color"
                    value={colors[i]}
                    onChange={(e) => setColors((cs) => cs.map((c, j) => (j === i ? e.target.value : c)))}
                  />
                  <select
                    aria-label={`${line} width`} title="Width" value={widths[i]}
                    onChange={(e) => setWidths((ws) => ws.map((w, j) => (j === i ? Number(e.target.value) : w)))}
                  >
                    {WIDTHS.map((w) => <option key={w} value={w}>{w}px</option>)}
                  </select>
                  <select
                    aria-label={`${line} style`} title="Style" value={styles[i]}
                    onChange={(e) => setStyles((ss) => ss.map((s, j) => (j === i ? parseLineStyle(e.target.value) : s)))}
                  >
                    {LINE_STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
              );
            })}
          </fieldset>
        )}
        {hasBars && (
          <fieldset className="settings-colors">
            <legend>Histogram</legend>
            {(['up', 'down'] as const).map((k) => {
              const id = `${idBase}-bar-${k}`;
              return (
                <div key={k} className="settings-row">
                  <label htmlFor={id}>{k === 'up' ? 'Up' : 'Down'} bar color</label>
                  <input id={id} type="color" value={bars[k]} onChange={(e) => setBars((b) => ({ ...b, [k]: e.target.value }))} />
                </div>
              );
            })}
          </fieldset>
        )}
        {defaultLevels && (
          <fieldset className="settings-colors">
            <legend>Levels</legend>
            <label className="settings-check">
              <input type="checkbox" checked={showLevels} onChange={(e) => setShowLevels(e.target.checked)} />
              Show reference lines
            </label>
            <div className="settings-row">
              <label htmlFor={`${idBase}-levels`}>Values</label>
              <input
                id={`${idBase}-levels`}
                type="text"
                value={levelsText}
                disabled={!showLevels}
                placeholder="None"
                aria-invalid={levelsError ? 'true' : undefined}
                aria-describedby={levelsError ? `${idBase}-levels-err` : undefined}
                onChange={(e) => setLevelsText(e.target.value)}
              />
              {levelsError && <span id={`${idBase}-levels-err`} className="form-error settings-error">{levelsError}</span>}
            </div>
          </fieldset>
        )}
        <div className="settings-actions">
          <button type="button" onClick={reset}>Reset</button>
          <span className="settings-actions-spacer" />
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!valid}>Save</button>
        </div>
      </form>
    </Modal>
  );
}
