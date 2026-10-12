import { MAX_LINE_WIDTH, MIN_LINE_WIDTH, type IndicatorState, type LineStyleKind } from '@altv/shared';
import { useId, useState, type FormEvent, type JSX } from 'react';
import { catalogEntry, DEFAULT_BAR_COLORS, defaultLineColor, validateParam } from '../chart/indicators/catalog';
import { Modal } from './Modal';
import './Indicators.css';

export interface IndicatorSettingsProps {
  state: IndicatorState;
  onSave: (s: IndicatorState) => void;
  onClose: () => void;
}

const WIDTHS = Array.from({ length: MAX_LINE_WIDTH - MIN_LINE_WIDTH + 1 }, (_, i) => MIN_LINE_WIDTH + i);

/**
 * Edits one indicator's params (validated: integers ≥ 1, except params the catalog marks as decimal, which
 * must be > 0) and line colours. Colours are only saved once they differ from the defaults (or were
 * customised before), so untouched indicators keep following KLineChart's palette. The same applies to line widths
 * (1–4) / styles (solid, dashed) and, for histogram indicators, the up/down bar colours.
 */
export function IndicatorSettings({ state, onSave, onClose }: IndicatorSettingsProps): JSX.Element {
  const entry = catalogEntry(state.name);
  const defaults = entry?.defaultParams ?? state.calcParams;
  const labels = entry?.paramLabels ?? state.calcParams.map((_, i) => `Param ${i + 1}`);
  const lines = entry?.lines ?? [];
  const defaultColors = lines.map((_, i) => defaultLineColor(i, state.name));

  const [values, setValues] = useState(() => labels.map((_, i) => String(state.calcParams[i] ?? defaults[i] ?? '')));
  const [colors, setColors] = useState(() => lines.map((_, i) => state.lineColors?.[i] ?? defaultLineColor(i, state.name)));
  const [widths, setWidths] = useState(() => lines.map((_, i) => state.lineWidths?.[i] ?? 1));
  const [styles, setStyles] = useState<LineStyleKind[]>(() => lines.map((_, i) => state.lineStyles?.[i] ?? 'solid'));
  const hasBars = entry?.bars === true;
  const [bars, setBars] = useState(() => ({ ...DEFAULT_BAR_COLORS, ...state.barColors }));
  const idBase = useId();

  const errors = values.map((v, i) => validateParam(state.name, i, v));
  const valid = errors.every((e) => e === null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const next: IndicatorState = { name: state.name, pane: state.pane, calcParams: values.map(Number), visible: state.visible };
    const customised = colors.some((c, i) => c !== defaultColors[i]);
    if (lines.length > 0 && (customised || state.lineColors)) next.lineColors = colors;
    // Only saved while they differ from the defaults (the adapter writes the defaults back when an override goes).
    if (lines.length > 0 && widths.some((w) => w !== 1)) next.lineWidths = widths;
    if (lines.length > 0 && styles.some((s) => s !== 'solid')) next.lineStyles = styles;
    if (hasBars && (bars.up !== DEFAULT_BAR_COLORS.up || bars.down !== DEFAULT_BAR_COLORS.down)) next.barColors = { ...bars };
    onSave(next);
    onClose();
  };

  const reset = () => {
    setValues(labels.map((_, i) => String(defaults[i] ?? '')));
    setColors(defaultColors);
    setWidths(lines.map(() => 1));
    setStyles(lines.map(() => 'solid'));
    setBars({ ...DEFAULT_BAR_COLORS });
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
            <legend>Colours</legend>
            {lines.map((line, i) => {
              const id = `${idBase}-c${i}`;
              return (
                <div key={id} className="settings-row settings-line">
                  <label htmlFor={id}>{line} colour</label>
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
                    onChange={(e) => setStyles((ss) => ss.map((s, j) => (j === i ? (e.target.value === 'dashed' ? 'dashed' : 'solid') : s)))}
                  >
                    <option value="solid">Solid</option>
                    <option value="dashed">Dashed</option>
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
                  <label htmlFor={id}>{k === 'up' ? 'Up' : 'Down'} bar colour</label>
                  <input id={id} type="color" value={bars[k]} onChange={(e) => setBars((b) => ({ ...b, [k]: e.target.value }))} />
                </div>
              );
            })}
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
