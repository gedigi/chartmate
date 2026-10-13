import { MAX_CONSTITUENTS, parseSymbolId, type AssetClass, type SymbolId, type SymbolInfo } from '@chartmate/shared';
import type { JSX } from 'react';
import { SymbolSearch } from './SymbolSearch';

/** One editable constituent. `weight` is the raw text of the percent input. */
export interface WeightRow { key: string; symbol: SymbolId | null; weight: string }

/** Allowed |total − 100| in percentage points. */
export const TOTAL_TOLERANCE = 0.01;

let rowSeq = 0;
export function newRow(symbol: SymbolId | null = null, weight = ''): WeightRow {
  rowSeq += 1;
  return { key: `row-${rowSeq}`, symbol, weight };
}

/** Ticker part of a symbol id ("stock:AAPL" → "AAPL"); falls back to the raw id. */
export function tickerOf(id: SymbolId): string {
  try {
    return parseSymbolId(id).code;
  } catch {
    return id;
  }
}

function assetClassOf(id: SymbolId): AssetClass | null {
  try {
    return parseSymbolId(id).assetClass;
  } catch {
    return null;
  }
}

/** Parsed weight: a finite number, or null when the input is empty/invalid. */
export function parseWeight(text: string): number | null {
  if (text.trim() === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export function rowsTotal(rows: WeightRow[]): number {
  return rows.reduce((sum, r) => sum + (parseWeight(r.weight) ?? 0), 0);
}

export interface RowsValidation {
  errors: string[];
  /** Percent weights keyed by symbol (insertion order = row order), or null when invalid. */
  percents: Record<SymbolId, number> | null;
}

export function validateRows(rows: WeightRow[]): RowsValidation {
  const errors: string[] = [];
  if (rows.length === 0) return { errors: ['Add at least one constituent'], percents: null };
  if (rows.length > MAX_CONSTITUENTS) errors.push(`At most ${MAX_CONSTITUENTS} constituents per version`);
  if (rows.some((r) => r.symbol === null)) errors.push('Choose a symbol for every row');
  if (rows.some((r) => { const w = parseWeight(r.weight); return w === null || !(w > 0); })) {
    errors.push('Every weight must be a positive number');
  }
  const seen = new Set<SymbolId>();
  const dups = new Set<SymbolId>();
  for (const r of rows) {
    if (r.symbol === null) continue;
    if (seen.has(r.symbol)) dups.add(r.symbol);
    seen.add(r.symbol);
  }
  for (const d of dups) errors.push(`Duplicate symbol: ${tickerOf(d)}`);
  const total = rowsTotal(rows);
  if (Math.abs(total - 100) > TOTAL_TOLERANCE + 1e-9) errors.push(`Total must be 100% (currently ${total.toFixed(2)}%)`);
  if (errors.length > 0) return { errors, percents: null };
  const percents: Record<SymbolId, number> = {};
  for (const r of rows) percents[r.symbol!] = parseWeight(r.weight)!;
  return { errors, percents };
}

/**
 * Rescales positive values proportionally to percentages with 2 decimals that sum to exactly 100.00.
 * Rounding is done in integer hundredths; every value gets at least 0.01 (a positive weight never rounds
 * away to 0), and the remaining difference goes to the largest weight (first on ties).
 */
export function normalizePercents(values: number[]): number[] {
  if (values.length === 0 || values.length > 10_000) throw new Error('Need between 1 and 10000 weights');
  if (values.some((v) => !(v > 0) || !Number.isFinite(v))) throw new Error('Weights must be positive finite numbers');
  const sum = values.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum)) throw new Error('Weights must sum to a finite number');
  const cents = values.map((v) => Math.max(1, Math.round((v / sum) * 10_000)));
  let largest = 0;
  values.forEach((v, i) => { if (v > values[largest]!) largest = i; });
  cents[largest]! += 10_000 - cents.reduce((a, b) => a + b, 0);
  return cents.map((c) => c / 100);
}

const isConstituent = (s: SymbolInfo) => s.assetClass === 'stock' || s.assetClass === 'crypto';

export interface WeightsTableProps {
  rows: WeightRow[];
  onChange: (rows: WeightRow[]) => void;
}

/** Editable constituents table: symbol + weight %, live total, normalize, validation errors. */
export function WeightsTable({ rows, onChange }: WeightsTableProps): JSX.Element {
  const { errors } = validateRows(rows);
  const total = rowsTotal(rows);
  const totalOk = Math.abs(total - 100) <= TOTAL_TOLERANCE + 1e-9;
  const positive = rows.map((r) => parseWeight(r.weight)).map((w) => (w !== null && w > 0 ? w : 0));
  const canNormalize = positive.some((w) => w > 0);
  const hasUnsized = rows.some((_, i) => positive[i] === 0);

  const update = (key: string, patch: Partial<WeightRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const remove = (key: string) => onChange(rows.filter((r) => r.key !== key));

  function normalize() {
    const idx = positive.flatMap((w, i) => (w > 0 ? [i] : []));
    const scaled = normalizePercents(idx.map((i) => positive[i]!));
    const next = rows.slice();
    idx.forEach((i, k) => { next[i] = { ...next[i]!, weight: String(scaled[k]) }; });
    onChange(next);
  }

  return (
    <div className="weights-table">
      <table>
        <thead>
          <tr><th scope="col">Symbol</th><th scope="col" className="num">Weight %</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const label = r.symbol ? tickerOf(r.symbol) : `row ${i + 1}`;
            const cls = r.symbol ? assetClassOf(r.symbol) : null;
            return (
              <tr key={r.key} data-testid="weight-row">
                <td>
                  {r.symbol ? (
                    <span className="weights-symbol">
                      <span className="search-ticker">{tickerOf(r.symbol)}</span>
                      {cls && <span className={`badge badge-${cls}`}>{cls.toUpperCase()}</span>}
                    </span>
                  ) : (
                    <SymbolSearch
                      placeholder="Stock or crypto…"
                      ariaLabel={`Symbol for row ${i + 1}`}
                      filter={isConstituent}
                      onSelect={(id) => update(r.key, { symbol: id })}
                    />
                  )}
                </td>
                <td className="num">
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    max="100"
                    step="any"
                    className="weight-input"
                    aria-label={`Weight for ${label}`}
                    value={r.weight}
                    onChange={(e) => update(r.key, { weight: e.target.value })}
                  />
                </td>
                <td className="actions">
                  <button type="button" className="icon-button" aria-label={`Remove ${label}`} title="Remove" onClick={() => remove(r.key)}>×</button>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td>
              <button type="button" disabled={rows.length >= MAX_CONSTITUENTS}
                onClick={() => { if (rows.length < MAX_CONSTITUENTS) onChange([...rows, newRow()]); }}>Add constituent</button>
            </td>
            <td className="num">
              Total <strong data-testid="weights-total" className={totalOk ? 'total-ok' : 'total-bad'}>{total.toFixed(2)}%</strong>
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
      <div className="weights-actions">
        <button type="button" onClick={normalize} disabled={!canNormalize}>Normalize to 100%</button>
      </div>
      {rows.length >= MAX_CONSTITUENTS && (
        <p className="hint weights-hint" data-testid="constituent-limit">A version can hold at most {MAX_CONSTITUENTS} constituents.</p>
      )}
      {hasUnsized && canNormalize && (
        <p className="hint weights-hint">
          Normalize only rescales positive weights. Rows with an empty, zero or negative weight are left unchanged: remove them or fill in a weight.
        </p>
      )}
      {errors.length > 0 && (
        <ul className="form-error weights-errors" role="alert">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
    </div>
  );
}
