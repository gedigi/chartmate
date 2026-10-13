import { MAX_CURRENCY_LENGTH, type PositionDefaults, type PositionRiskMode, type PositionSettings } from '@altv/shared';
import { useEffect, useId, useState, type JSX, type KeyboardEvent } from 'react';
import type { ChartAdapter, SelectedDrawing } from '../chart/ChartAdapter';
import {
  distanceTicks, formatAmount, formatQty, outcomeLabel, priceFromPct, priceFromTicks, validatePrices,
} from '../chart/position';
import { positionContext } from '../chart/positionOverlay';

export type PositionControls = Pick<ChartAdapter, 'setSelectedPositionPrices' | 'setSelectedPositionSettings'>;
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
function EditField<T>({ label, shown, parse, apply, disabled, className, inputMode = 'decimal', title }: {
  label: string; shown: string; parse: (text: string) => Parsed<T>; apply: (v: T) => string | null | void; disabled: boolean;
  className?: string; inputMode?: 'decimal' | 'numeric' | 'text'; title?: string;
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
    <span className={`drawing-style-price ${className ?? ''}`}>
      <input
        type="text" inputMode={inputMode} aria-label={label} title={title ?? label} value={text} disabled={disabled}
        aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
        onChange={(e) => { setText(e.target.value); setError(null); }}
        onKeyDown={onKeyDown} onBlur={commit}
      />
      {error && <span id={errorId} role="alert" className="drawing-style-error">{error}</span>}
    </span>
  );
}

const RISK_MODES: ReadonlyArray<{ value: PositionRiskMode; label: string }> = [
  { value: 'percent', label: '% of account' }, { value: 'amount', label: 'Amount' },
];

/**
 * Settings of the selected long / short position: precise Entry / Target / Stop (symbol precision), target / stop
 * distances as % and ticks, the risk settings (account size, risk mode and value, currency), the derived
 * quantity / amounts / R:R and the outcome. "Use as default" stores the risk settings as the global defaults.
 */
export function PositionStyleBar({ controls, sel, onUseAsDefault }: {
  controls: PositionControls; sel: SelectedPosition; onUseAsDefault?: (d: PositionDefaults) => void;
}): JSX.Element {
  const { side, precision, locked, settings, metrics: m } = sel;
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
      <EditField label={label} shown={fixed(prices[key])} disabled={locked} parse={(t) => parsePositive(t, 'Price')}
        apply={(v) => setPrices({ [key]: v })} />
    );
  };
  const distance = (kind: 'target' | 'stop') => {
    const Label = kind === 'target' ? 'Target' : 'Stop';
    const pct = kind === 'target' ? m.targetPct : m.stopPct;
    return (
      <>
        <EditField label={`${Label} %`} title={`${Label} distance (% of entry)`} className="position-narrow" shown={pct.toFixed(2)} disabled={locked}
          parse={(t) => parsePositive(t, 'Distance')}
          apply={(v) => setPrices({ [kind]: priceFromPct(side, kind, sel.entry, v, precision) })} />
        <EditField label={`${Label} ticks`} title={`${Label} distance (ticks of ${(10 ** -precision).toFixed(precision)})`} className="position-narrow"
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
  const setSettings = (patch: PositionSettings) => { controls.setSelectedPositionSettings(patch); };
  const outcome = outcomeLabel(sel.outcome, settings.currency, positionContext.formatTime);

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
        <EditField label="Account size" shown={String(settings.accountSize)} disabled={locked}
          parse={(t) => parsePositive(t, 'Account size')} apply={(v) => setSettings({ accountSize: v })} />
        <select aria-label="Risk mode" title="Risk mode" value={settings.riskMode} disabled={locked}
          onChange={(e) => setSettings({ riskMode: e.target.value === 'amount' ? 'amount' : 'percent' })}>
          {RISK_MODES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        <EditField label="Risk" title={settings.riskMode === 'percent' ? 'Risk (% of account)' : 'Risk (amount)'} className="position-narrow"
          shown={String(settings.riskValue)} disabled={locked}
          parse={(t) => {
            const r = parsePositive(t, 'Risk');
            if ('value' in r && settings.riskMode === 'percent' && r.value > 100) return { error: 'Risk must be at most 100 %' };
            return r;
          }}
          apply={(v) => setSettings({ riskValue: v })} />
        <EditField label="Currency" className="position-narrow" shown={settings.currency} disabled={locked} inputMode="text"
          parse={(t) => {
            const c = t.trim();
            if (c.length === 0) return { error: 'Enter a currency label' };
            if (c.length > MAX_CURRENCY_LENGTH) return { error: `At most ${MAX_CURRENCY_LENGTH} characters` };
            return { value: c };
          }}
          apply={(v) => setSettings({ currency: v })} />
        <span className="position-summary" data-testid="position-summary">
          Qty {formatQty(m.qty)} · Risk {formatAmount(m.riskAmount, settings.currency).slice(1)} · Reward {formatAmount(m.rewardAmount, settings.currency).slice(1)} · R:R {m.rr.toFixed(2)}
        </span>
        <button type="button" className="position-default" onClick={() => onUseAsDefault?.({ ...settings })}
          title="Use these risk settings for new positions">Use as default</button>
      </div>
      {(outcome || locked) && (
        <div className="position-row">
          {outcome && <span className="position-outcome" data-testid="position-outcome">{outcome}</span>}
          {locked && <span className="drawing-style-locked">Locked</span>}
        </div>
      )}
    </div>
  );
}
