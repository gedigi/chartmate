import type { IndicatorState } from '@altv/shared';
import { useId, useState, type FormEvent, type JSX } from 'react';
import { catalogEntry, defaultLineColor, validateParam } from '../chart/indicators/catalog';
import { Modal } from './Modal';
import './Indicators.css';

export interface IndicatorSettingsProps {
  state: IndicatorState;
  onSave: (s: IndicatorState) => void;
  onClose: () => void;
}

/**
 * Edits one indicator's params (validated: integers ≥ 1, except params the catalog marks as decimal, which
 * must be > 0) and line colours. Colours are only saved once they differ from the defaults (or were
 * customised before), so untouched indicators keep following KLineChart's palette.
 */
export function IndicatorSettings({ state, onSave, onClose }: IndicatorSettingsProps): JSX.Element {
  const entry = catalogEntry(state.name);
  const defaults = entry?.defaultParams ?? state.calcParams;
  const labels = entry?.paramLabels ?? state.calcParams.map((_, i) => `Param ${i + 1}`);
  const lines = entry?.lines ?? [];
  const defaultColors = lines.map((_, i) => defaultLineColor(i));

  const [values, setValues] = useState(() => labels.map((_, i) => String(state.calcParams[i] ?? defaults[i] ?? '')));
  const [colors, setColors] = useState(() => lines.map((_, i) => state.lineColors?.[i] ?? defaultLineColor(i)));
  const idBase = useId();

  const errors = values.map((v, i) => validateParam(state.name, i, v));
  const valid = errors.every((e) => e === null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const next: IndicatorState = { name: state.name, pane: state.pane, calcParams: values.map(Number), visible: state.visible };
    const customised = colors.some((c, i) => c !== defaultColors[i]);
    if (lines.length > 0 && (customised || state.lineColors)) next.lineColors = colors;
    onSave(next);
    onClose();
  };

  const reset = () => {
    setValues(labels.map((_, i) => String(defaults[i] ?? '')));
    setColors(defaultColors);
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
                <div key={id} className="settings-row">
                  <label htmlFor={id}>{line} colour</label>
                  <input
                    id={id}
                    type="color"
                    value={colors[i]}
                    onChange={(e) => setColors((cs) => cs.map((c, j) => (j === i ? e.target.value : c)))}
                  />
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
