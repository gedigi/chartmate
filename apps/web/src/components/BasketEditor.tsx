import {
  BasketValidationError, maxEffectiveDate, MIN_EFFECTIVE_DATE, normalizeWeights, parseDateString, utcDateString, validateVersions,
  type Basket, type BasketVersion, type SymbolId,
} from '@altv/shared';
import { useState, type FormEvent, type JSX } from 'react';
import { api, errorMessage } from '../api/client';
import { BasketPreview } from './BasketPreview';
import { newRow, normalizePercents, tickerOf, validateRows, WeightsTable, type WeightRow } from './WeightsTable';

const DAY = 86_400_000;
const DEFAULT_BASE_VALUE = 100;

export const EFFECTIVE_DATE_HINT = 'New weights take effect from the start of this date, sized at the prior close. The chart stays continuous.';

const todayString = () => utcDateString(Date.now());
const dayAfter = (date: string) => utcDateString(parseDateString(date) + DAY);

function isValidDate(s: string): boolean {
  try {
    parseDateString(s);
    return true;
  } catch {
    return false;
  }
}

/** "70%", "33.33%" — up to 2 decimals, no trailing zeros. */
export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 10_000) / 100}%`;
}

/** "AAPL 70% · BTC 30%" — largest weight first. */
export function weightsSummary(weights: Record<SymbolId, number>): string {
  return Object.entries(weights)
    .sort((a, b) => b[1] - a[1])
    .map(([id, w]) => `${tickerOf(id)} ${formatPercent(w)}`)
    .join(' · ');
}

/** Rows prefilled from a version's fractional weights, as percents summing to exactly 100. */
function rowsFromWeights(weights: Record<SymbolId, number>): WeightRow[] {
  const entries = Object.entries(weights);
  if (entries.length === 0) return [newRow()];
  const pct = normalizePercents(entries.map(([, w]) => w));
  return entries.map(([id], i) => newRow(id, String(pct[i])));
}

/** Validated version from table rows, or null. Converts % → fractions with the shared normalizeWeights. */
function versionFromRows(rows: WeightRow[], effectiveFrom: string): BasketVersion | null {
  const { percents } = validateRows(rows);
  if (!percents || !isValidDate(effectiveFrom)) return null;
  return { effectiveFrom, weights: normalizeWeights(percents) };
}

/** Same bounds as the server (shared validateVersions): 1970-01-01 … tomorrow (UTC). */
function outOfRange(date: string, max: string): boolean {
  return date < MIN_EFFECTIVE_DATE || date > max;
}

/** Error for a create-mode start date, or null. Checked before any preview request is made. */
function startDateError(date: string, max: string): string | null {
  if (!isValidDate(date)) return 'Enter a valid start date';
  if (outOfRange(date, max)) return `Start date must be between ${MIN_EFFECTIVE_DATE} and ${max}`;
  return null;
}

/** Error for a new version's effective date, or null. */
function effectiveDateError(date: string, latest: string, max: string): string | null {
  if (!isValidDate(date)) return 'Enter a valid effective date';
  if (outOfRange(date, max)) return `Effective date must be between ${MIN_EFFECTIVE_DATE} and ${max}`;
  if (date <= latest) return `Effective date must be after ${latest}`;
  return null;
}

/** Runs the shared client-side version checks; returns a message or null. */
function checkVersions(versions: BasketVersion[]): string | null {
  try {
    validateVersions(versions);
    return null;
  } catch (err) {
    if (err instanceof BasketValidationError) return err.message;
    throw err;
  }
}

export interface BasketEditorProps {
  /** Basket to edit; omitted for create mode. */
  basket?: Basket;
  /** Called with the server's basket after a successful create, rename or new version. */
  onSaved: (b: Basket) => void;
  onCancel: () => void;
}

export function BasketEditor(props: BasketEditorProps): JSX.Element {
  return props.basket ? <EditBasket {...props} basket={props.basket} /> : <CreateBasket {...props} />;
}

function EditorHeader({ title, onCancel }: { title: string; onCancel: () => void }): JSX.Element {
  return (
    <div className="editor-header">
      <button type="button" onClick={onCancel}>Back to baskets</button>
      <h2>{title}</h2>
    </div>
  );
}

function CreateBasket({ onSaved, onCancel }: BasketEditorProps): JSX.Element {
  const today = todayString();
  const maxDate = maxEffectiveDate();
  const [name, setName] = useState('');
  const [rows, setRows] = useState<WeightRow[]>(() => [newRow()]);
  const [startDate, setStartDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dateError = startDateError(startDate, maxDate);
  const version = dateError ? null : versionFromRows(rows, startDate);
  const canSave = !busy && name.trim() !== '' && version !== null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSave || !version) return;
    const versions = [version];
    const invalid = checkVersions(versions);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.baskets.create({ name: name.trim(), versions }));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form className="basket-editor" onSubmit={submit} aria-label="Create basket">
      <EditorHeader title="New basket" onCancel={onCancel} />
      <div className="editor-grid">
        <div className="editor-form">
          <label className="field">
            <span>Name</span>
            <input type="text" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tech + BTC" />
          </label>
          <h3 className="panel-title">Constituents</h3>
          <WeightsTable rows={rows} onChange={setRows} />
          <label className="field">
            <span>Start date (UTC)</span>
            <input type="date" value={startDate} min={MIN_EFFECTIVE_DATE} max={maxDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <p className="hint">The basket starts at {DEFAULT_BASE_VALUE} from 00:00 UTC on this date, sized at the prior close.</p>
          {dateError && <p className="form-error">{dateError}</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="editor-actions">
            <button type="submit" className="primary" disabled={!canSave}>{busy ? 'Creating…' : 'Create basket'}</button>
            <button type="button" onClick={onCancel}>Cancel</button>
          </div>
        </div>
        <BasketPreview versions={version ? [version] : null} baseValue={DEFAULT_BASE_VALUE} />
      </div>
    </form>
  );
}

function EditBasket({ basket, onSaved, onCancel }: BasketEditorProps & { basket: Basket }): JSX.Element {
  const today = todayString();
  const maxDate = maxEffectiveDate();
  const latest = basket.versions[basket.versions.length - 1]!;
  const minDate = dayAfter(latest.effectiveFrom);
  const canAppendToday = minDate <= maxDate;

  const [name, setName] = useState(basket.name);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const [changing, setChanging] = useState(false);
  const [rows, setRows] = useState<WeightRow[]>([]);
  const [effDate, setEffDate] = useState(today);
  const [appending, setAppending] = useState(false);
  const [appendError, setAppendError] = useState<string | null>(null);

  // A single-version basket may move its start date (PUT with the version replaced; same bounds as create).
  const single = basket.versions.length === 1;
  const first = basket.versions[0]!;
  const [startDate, setStartDate] = useState(first.effectiveFrom);
  const [movingStart, setMovingStart] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const startDateErr = single ? startDateError(startDate, maxDate) : null;
  const startChanged = single && startDate !== first.effectiveFrom;

  const dateError = effectiveDateError(effDate, latest.effectiveFrom, maxDate);
  const draft = changing && !dateError ? versionFromRows(rows, effDate) : null;
  const weightsValid = validateRows(rows).percents !== null;
  const previewVersions = draft
    ? [...basket.versions, draft]
    : startChanged && !startDateErr ? [{ ...first, effectiveFrom: startDate }] : basket.versions;

  function openChange() {
    setRows(rowsFromWeights(latest.weights));
    setEffDate(minDate > today ? minDate : today);
    setAppendError(null);
    setChanging(true);
  }

  async function rename(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === basket.name) return;
    setRenaming(true);
    setRenameError(null);
    try {
      onSaved(await api.baskets.update(basket.id, { name: trimmed }));
    } catch (err) {
      setRenameError(errorMessage(err));
    } finally {
      setRenaming(false);
    }
  }

  async function moveStart(e: FormEvent) {
    e.preventDefault();
    if (!startChanged || startDateErr) return;
    const versions = [{ ...first, effectiveFrom: startDate }];
    const invalid = checkVersions(versions);
    if (invalid) {
      setStartError(invalid);
      return;
    }
    setMovingStart(true);
    setStartError(null);
    try {
      onSaved(await api.baskets.update(basket.id, { versions }));
    } catch (err) {
      setStartError(errorMessage(err));
    } finally {
      setMovingStart(false);
    }
  }

  async function append(e: FormEvent) {
    e.preventDefault();
    if (dateError) {
      setAppendError(dateError);
      return;
    }
    const version = versionFromRows(rows, effDate);
    if (!version) return;
    const invalid = checkVersions([...basket.versions, version]);
    if (invalid) {
      setAppendError(invalid);
      return;
    }
    setAppending(true);
    setAppendError(null);
    try {
      const updated = await api.baskets.appendVersion(basket.id, version);
      setChanging(false);
      onSaved(updated);
    } catch (err) {
      setAppendError(errorMessage(err));
    } finally {
      setAppending(false);
    }
  }

  const history = [...basket.versions].map((v, i) => ({ v, n: i + 1 })).reverse();

  return (
    <div className="basket-editor">
      <EditorHeader title={basket.name} onCancel={onCancel} />
      <div className="editor-grid">
        <div className="editor-form">
          <form className="rename-form" onSubmit={rename} aria-label="Rename basket">
            <label className="field">
              <span>Name</span>
              <input type="text" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
            </label>
            <button type="submit" disabled={renaming || name.trim() === '' || name.trim() === basket.name}>Rename</button>
          </form>
          {renameError && <p className="form-error" role="alert">{renameError}</p>}

          {single && !changing && (
            <form className="rename-form" onSubmit={moveStart} aria-label="Change start date">
              <label className="field">
                <span>Start date (UTC)</span>
                <input type="date" value={startDate} min={MIN_EFFECTIVE_DATE} max={maxDate}
                  onChange={(e) => { setStartDate(e.target.value); setStartError(null); }} />
              </label>
              <button type="submit" disabled={movingStart || !startChanged || startDateErr !== null}>
                {movingStart ? 'Saving…' : 'Change start date'}
              </button>
            </form>
          )}
          {single && startDateErr && <p className="form-error">{startDateErr}</p>}
          {startError && <p className="form-error" role="alert">{startError}</p>}

          <h3 className="panel-title">Version history</h3>
          <ol className="version-history" aria-label="Version history">
            {history.map(({ v, n }) => (
              <li key={v.effectiveFrom}>
                <span className="version-tag">v{n}</span>
                <span className="version-date">{v.effectiveFrom}</span>
                <span className="version-weights">{weightsSummary(v.weights)}</span>
              </li>
            ))}
          </ol>

          {!changing && (
            <div className="editor-actions">
              <button type="button" className="primary" onClick={openChange} disabled={!canAppendToday}>Change weights</button>
              {!canAppendToday && <span className="hint">The latest version starts {latest.effectiveFrom}; a new one can start from {minDate}.</span>}
            </div>
          )}

          {changing && (
            <form className="change-weights" onSubmit={append} aria-label="Change weights">
              <h3 className="panel-title">New version</h3>
              <WeightsTable rows={rows} onChange={setRows} />
              <label className="field">
                <span>Effective date (UTC)</span>
                <input type="date" value={effDate} min={minDate < MIN_EFFECTIVE_DATE ? MIN_EFFECTIVE_DATE : minDate} max={maxDate} onChange={(e) => { setEffDate(e.target.value); setAppendError(null); }} />
              </label>
              <p className="hint">{EFFECTIVE_DATE_HINT}</p>
              {dateError && <p className="form-error">{dateError}</p>}
              {appendError && appendError !== dateError && <p className="form-error" role="alert">{appendError}</p>}
              <div className="editor-actions">
                <button type="submit" className="primary" disabled={appending || !weightsValid}>{appending ? 'Saving…' : 'Add version'}</button>
                <button type="button" onClick={() => setChanging(false)}>Cancel</button>
              </div>
            </form>
          )}
        </div>
        <BasketPreview versions={previewVersions} baseValue={basket.baseValue} />
      </div>
    </div>
  );
}
