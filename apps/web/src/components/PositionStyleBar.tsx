import { isValidPositionDefaults, type PositionDefaults } from '@chartmate/shared';
import { useEffect, useId, useState, type JSX, type KeyboardEvent } from 'react';
import type { ChartAdapter, SelectedDrawing } from '../chart/ChartAdapter';
import { distanceTicks, outcomeLabel, priceFromPct, priceFromTicks, validatePrices } from '../chart/position';
import { positionContext } from '../chart/positionOverlay';
import { DrawingLockToggle } from './LockIcon';

export type PositionControls = Pick<ChartAdapter, 'setSelectedPositionPrices' | 'setSelectedLock'>;
export type SelectedPosition = Extract<SelectedDrawing, { kind: 'position' }>;

type Parsed<T> = { value: T } | { error: string };

/** Typed positive number (finite, > 0). */
function parsePositive(text: string, what: string): Parsed<number> {
  const t = text.trim();
  const v = Number(t);
  if (t === '' || !Number.isFinite(v) || v <= 0) return { error: `${what} must be a positive number` };
  return { value: v };
}

/**
 * A text field that applies on Enter or blur and reverts on Escape. `parse` validates the text (inline error);
 * `apply` may still refuse (its error is shown too). Re-synced whenever the shown value changes.
 */
function EditField<T>({ label, shown, parse, apply, disabled, className, inputMode = 'decimal', title, caption, suffix }: {
  label: string; shown: string; parse: (text: string) => Parsed<T>; apply: (v: T) => string | null | void; disabled: boolean;
  className?: string; inputMode?: 'decimal' | 'numeric' | 'text'; title?: string;
  /** Visible text before / after the input (the accessible name is `label`). */
  caption?: string; suffix?: string;
}): JSX.Element {
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  useEffect(() => { setText(shown); setError(null); }, [shown]);
  const commit = () => {
    if (text === shown) { setError(null); return; }
    const r = parse(text);
    if ('error' in r) { setError(r.error); return; }
    const err = apply(r.value);
    setError(typeof err === 'string' ? err : null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // reverts the field only: the position stays selected
      setText(shown);
      setError(null);
    }
  };
  return (
    <span className={`drawing-style-price position-field ${className ?? ''}`}>
      {caption && <span className="position-caption" aria-hidden="true">{caption}</span>}
      <input
        type="text" inputMode={inputMode} aria-label={label} title={title ?? label} value={text} disabled={disabled}
        aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
        onChange={(e) => { setText(e.target.value); setError(null); }}
        onKeyDown={onKeyDown} onBlur={commit}
      />
      {suffix && <span className="position-caption" aria-hidden="true">{suffix}</span>}
      {error && <span id={errorId} role="alert" className="drawing-style-error">{error}</span>}
    </span>
  );
}

/** A distance in % rounded for storing as a default (4 decimals). */
const roundPct = (v: number) => Math.round(v * 1e4) / 1e4;

/**
 * Settings of the selected long / short position: precise Entry / Target / Stop (symbol precision), target / stop
 * distances as % and ticks, the R:R and the outcome. No position size (no account yet). "Use as default" stores the
 * target / stop distances (%) as the global defaults of new positions.
 */
export function PositionStyleBar({ controls, sel, onUseAsDefault }: {
  controls: PositionControls; sel: SelectedPosition; onUseAsDefault?: (d: PositionDefaults) => void;
}): JSX.Element {
  const { side, precision, locked, ownLock, metrics: m } = sel;
  const fixed = (v: number) => v.toFixed(precision);
  const prices = { entry: sel.entry, target: sel.target, stop: sel.stop };

  /** Validates the sides with the new price(s), then hands them to the adapter. */
  const setPrices = (patch: Partial<typeof prices>): string | null => {
    const err = validatePrices(side, { ...prices, ...patch });
    return err ?? controls.setSelectedPositionPrices(patch);
  };
  const price = (label: 'Entry' | 'Target' | 'Stop') => {
    const key = label.toLowerCase() as keyof typeof prices;
    return (
      <EditField label={label} caption={label} shown={fixed(prices[key])} disabled={locked} parse={(t) => parsePositive(t, 'Price')}
        apply={(v) => setPrices({ [key]: v })} />
    );
  };
  const distance = (kind: 'target' | 'stop') => {
    const Label = kind === 'target' ? 'Target' : 'Stop';
    const pct = kind === 'target' ? m.targetPct : m.stopPct;
    return (
      <>
        <EditField label={`${Label} %`} suffix="%" title={`${Label} distance (% of entry)`} className="position-narrow" shown={pct.toFixed(2)} disabled={locked}
          parse={(t) => parsePositive(t, 'Distance')}
          apply={(v) => setPrices({ [kind]: priceFromPct(side, kind, sel.entry, v, precision) })} />
        <EditField label={`${Label} ticks`} suffix="ticks" title={`${Label} distance (ticks of ${(10 ** -precision).toFixed(precision)})`} className="position-narrow"
          shown={String(distanceTicks(sel.entry, prices[kind], precision))} disabled={locked} inputMode="numeric"
          parse={(t) => {
            const r = parsePositive(t, 'Ticks');
            if ('value' in r && !Number.isInteger(r.value)) return { error: 'Ticks must be a whole number' };
            return r;
          }}
          apply={(v) => setPrices({ [kind]: priceFromTicks(side, kind, sel.entry, v, precision) })} />
      </>
    );
  };
  const outcome = outcomeLabel(sel.outcome, positionContext.formatTime);
  const defaults: PositionDefaults = { targetPct: roundPct(m.targetPct), stopPct: roundPct(m.stopPct) };
  const validDefaults = isValidPositionDefaults(defaults);

  return (
    <div className="drawing-style-bar position-bar" role="toolbar" aria-label="Position settings" aria-disabled={locked || undefined}>
      <div className="position-row">
        <span className="position-side">{side === 'long' ? 'Long' : 'Short'}</span>
        {price('Entry')}
        {price('Target')}
        {distance('target')}
        {price('Stop')}
        {distance('stop')}
      </div>
      <div className="position-row">
        <span className="position-summary" data-testid="position-summary">R:R {m.rr.toFixed(2)}</span>
        <button type="button" className="position-default" disabled={!validDefaults} onClick={() => { if (validDefaults) onUseAsDefault?.(defaults); }}
          title={validDefaults ? 'Use these target / stop distances (%) for new positions' : 'Distances must be at most 99 % to be used as defaults'}>Use as default</button>
        {outcome && <span className="position-outcome" data-testid="position-outcome">{outcome}</span>}
        <span className="position-lock">
          <DrawingLockToggle locked={locked} ownLock={ownLock} onToggle={(v) => controls.setSelectedLock(v)} />
        </span>
      </div>
    </div>
  );
}
