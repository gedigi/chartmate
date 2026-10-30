import { LABELED_DRAWINGS, MAX_LINE_WIDTH, MIN_LINE_WIDTH, type DrawingDefaults, type PositionDefaults } from '@chartmate/shared';
import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { MAX_PRICE_DECIMALS, type ChartAdapter, type SelectedDrawing } from '../chart/ChartAdapter';
import { LINE_STYLES, parseLineStyle } from '../chart/drawingStyles';
import type { ExtendOptions, LabelOptions } from '../chart/drawingTemplates';
import { ArrangeMenu, type ArrangeControls } from './ArrangeMenu';
import { PaletteColorPicker } from './PaletteColorPicker';
import { DrawingLockToggle } from './LockIcon';
import { PositionStyleBar, type PositionControls } from './PositionStyleBar';

export type DrawingStyleControls = Pick<ChartAdapter, 'onSelectionChange' | 'setSelectedStyle' | 'setSelectedPrice' | 'setSelectedLabel' | 'setSelectedExtend' | 'setSelectedFill' | 'onPriceEditRequest' | 'setSelectedLock' | 'drawingSwatches' | 'resetSelectedColor'>
  & PositionControls & ArrangeControls;

/** `value` with the symbol precision, or with its own decimals (≤ MAX_PRICE_DECIMALS) when it is finer. */
export function formatPrice(value: number, precision: number): string {
  const fixed = value.toFixed(precision);
  if (Number(fixed) === value) return fixed;
  return String(Number(value.toFixed(MAX_PRICE_DECIMALS)));
}

/** Error message for a typed price, or null when it is valid. */
function priceError(text: string, badInput = false): string | null {
  // A number input reports unparsable text (e.g. "1.2.3") as an empty value with validity.badInput.
  if (badInput) return 'Price must be a positive number';
  const t = text.trim();
  if (t === '') return 'Enter a price';
  // Plain decimal notation only: exponents ('1e-9') would slip past the decimals check and round to 0.
  if (/e/i.test(t)) return 'Price must be a positive number';
  const v = Number(t);
  if (!Number.isFinite(v) || v <= 0) return 'Price must be a positive number';
  const decimals = /\.(\d+)$/.exec(t)?.[1]?.length ?? 0;
  if (decimals > MAX_PRICE_DECIMALS) return `At most ${MAX_PRICE_DECIMALS} decimals`;
  // The price is applied rounded to MAX_PRICE_DECIMALS: it must stay positive.
  if (!(Number(v.toFixed(MAX_PRICE_DECIMALS)) > 0)) return 'Price must be a positive number';
  return null;
}

/**
 * Exact price of a horizontal drawing: Enter or blur applies, Escape reverts. Shown with the symbol precision
 * (step 10^-precision); finer prices (up to 8 decimals, e.g. crypto) are accepted.
 */
function PriceField({ controls, value, precision, locked, focusRequest, onFocused }: {
  controls: DrawingStyleControls; value: number; precision: number; locked: boolean;
  /** Set (a new number per request) when the field must take the focus; onFocused acknowledges it. */
  focusRequest: number | null; onFocused: () => void;
}): JSX.Element {
  const shown = formatPrice(value, precision);
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { setText(shown); setError(null); }, [shown]);
  useEffect(() => {
    if (focusRequest === null) return;
    onFocused();
    if (locked) return;
    ref.current?.focus();
    ref.current?.select();
  }, [focusRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = () => {
    const err = priceError(text, ref.current?.validity?.badInput === true);
    setError(err);
    if (err) return;
    const v = Number(text.trim());
    if (v !== value) controls.setSelectedPrice(v);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      apply();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // reverts the field only: the drawing stays selected
      setText(shown);
      setError(null);
    }
  };
  const errorId = 'drawing-price-error';
  return (
    <span className="drawing-style-price">
      <input
        ref={ref} type="number" aria-label="Price" title="Price" inputMode="decimal" min={0}
        step={precision > 0 ? `0.${'0'.repeat(precision - 1)}1` : '1'}
        value={text} disabled={locked}
        aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
        onChange={(e) => { setText(e.target.value); setError(null); }}
        onKeyDown={onKeyDown}
        onBlur={apply}
      />
      {error && <span id={errorId} role="alert" className="drawing-style-error">{error}</span>}
    </span>
  );
}

const WIDTHS = Array.from({ length: MAX_LINE_WIDTH - MIN_LINE_WIDTH + 1 }, (_, i) => MIN_LINE_WIDTH + i);
const FONT_SIZES = [10, 12, 14, 16, 18, 20, 22, 24];

/**
 * Floating style bar for the selected drawing: color (theme palette swatches; the pick becomes the color of new
 * drawings), width and solid/dashed/dotted for lines; color and font size
 * for text annotations, plus the exact price of horizontal lines, price-label toggles of price / horizontal lines and
 * "Extend left / right" of parallel channels, "Fill" of rectangles; long / short positions get their own settings bar. Every bar ends with
 * "Arrange" (bring to front … send to back) and the drawing's own lock toggle; locked drawings (own lock
 * or "Lock all drawings") are read-only except that toggle. Hidden while a drawing is being placed. Changes go through the adapter (overrideOverlay) and are saved with the drawings.
 */
export function DrawingStyleBar({ controls, onUsePositionDefaults, onPickColor, onResetColor, onStyleDefaults }: {
  controls: DrawingStyleControls | null;
  /** A swatch was picked for the selected drawing: it becomes the color of new drawings. */
  onPickColor?: (token: string) => void;
  /** "Reset to default" in the color popover: new drawings go back to the default color. */
  onResetColor?: () => void;
  /**
   * Any other style choice (width, dash, font size, fill, extend, price labels): it becomes what new drawings start
   * with, like a picked color. Price labels are per tool.
   */
  onStyleDefaults?: (patch: DrawingDefaults) => void;
  /** "Use as default" of a long / short position: its target / stop distances (%) become the defaults of new positions. */
  onUsePositionDefaults?: (d: PositionDefaults) => void;
}): JSX.Element | null {
  const [sel, setSel] = useState<SelectedDrawing | null>(null);
  /** Pending double-click request: the drawing whose Price field must take the focus. */
  const [focusReq, setFocusReq] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
    setSel(null);
    return controls?.onSelectionChange(setSel);
  }, [controls]);
  // Double-click on a horizontal drawing: focus its Price field.
  useEffect(() => controls?.onPriceEditRequest((id) => setFocusReq((r) => ({ id, n: (r?.n ?? 0) + 1 }))), [controls]);
  if (!controls || !sel) return null;
  if (sel.kind === 'position') return <PositionStyleBar controls={controls} sel={sel} onUseAsDefault={onUsePositionDefaults} />;

  const locked = sel.locked;
  const setLabel = (patch: Partial<LabelOptions>) => {
    if (sel.kind !== 'line' || !sel.label) return;
    controls.setSelectedLabel(patch);
    if ((LABELED_DRAWINGS as readonly string[]).includes(sel.name)) onStyleDefaults?.({ labels: { [sel.name]: { ...sel.label, ...patch } } });
  };
  const setExtend = (patch: Partial<ExtendOptions>) => {
    if (sel.kind !== 'line' || !sel.extend) return;
    controls.setSelectedExtend(patch);
    onStyleDefaults?.({ extend: { ...sel.extend, ...patch } });
  };
  const sizes = sel.kind === 'text' && !FONT_SIZES.includes(sel.style.size) ? [...FONT_SIZES, sel.style.size].sort((a, b) => a - b) : FONT_SIZES;
  return (
    <div className="drawing-style-bar" role="toolbar" aria-label="Drawing style">
      <PaletteColorPicker
        key={sel.id} value={sel.style.color} swatches={controls.drawingSwatches()} disabled={locked}
        onPick={(token) => {
          // Re-picking the drawing's own swatch changes nothing on it, but still makes it the color of new drawings.
          if (token !== sel.style.color) controls.setSelectedStyle({ color: token });
          onPickColor?.(token);
        }}
        onReset={() => { controls.resetSelectedColor(); onResetColor?.(); }}
      />
      {sel.kind === 'line' ? (
        <>
          <select aria-label="Line width" title="Width" value={sel.style.size} disabled={locked}
            onChange={(e) => { const size = Number(e.target.value); controls.setSelectedStyle({ size }); onStyleDefaults?.({ size }); }}>
            {WIDTHS.map((w) => <option key={w} value={w}>{w}px</option>)}
          </select>
          <select aria-label="Line style" title="Style" value={sel.style.style} disabled={locked}
            onChange={(e) => { const style = parseLineStyle(e.target.value); controls.setSelectedStyle({ style }); onStyleDefaults?.({ style }); }}>
            {LINE_STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </>
      ) : (
        <select aria-label="Font size" title="Font size" value={sel.style.size} disabled={locked}
          onChange={(e) => { const size = Number(e.target.value); controls.setSelectedStyle({ size }); onStyleDefaults?.({ textSize: size }); }}>
          {sizes.map((s) => <option key={s} value={s}>{s}px</option>)}
        </select>
      )}
      {sel.kind === 'line' && sel.price && (
        <PriceField key={sel.id} controls={controls} value={sel.price.value} precision={sel.price.precision} locked={locked}
          focusRequest={focusReq?.id === sel.id ? focusReq.n : null} onFocused={() => setFocusReq(null)} />
      )}
      {sel.kind === 'line' && sel.label && (
        <>
          <label className="drawing-style-toggle" title="Show the price on the line">
            <input type="checkbox" aria-label="Price on line" checked={sel.label.onLine} disabled={locked}
              onChange={(e) => setLabel({ onLine: e.target.checked })} />
            On line
          </label>
          <label className="drawing-style-toggle" title="Show the price label on the price axis">
            <input type="checkbox" aria-label="Price on axis" checked={sel.label.onAxis} disabled={locked}
              onChange={(e) => setLabel({ onAxis: e.target.checked })} />
            On axis
          </label>
        </>
      )}
      {sel.kind === 'line' && sel.extend && (
        <>
          <label className="drawing-style-toggle" title="Extend the channel to the left edge">
            <input type="checkbox" aria-label="Extend left" checked={sel.extend.left} disabled={locked}
              onChange={(e) => setExtend({ left: e.target.checked })} />
            Extend left
          </label>
          <label className="drawing-style-toggle" title="Extend the channel to the right edge">
            <input type="checkbox" aria-label="Extend right" checked={sel.extend.right} disabled={locked}
              onChange={(e) => setExtend({ right: e.target.checked })} />
            Extend right
          </label>
        </>
      )}
      {sel.kind === 'line' && sel.fill !== undefined && (
        <label className="drawing-style-toggle" title="Tint the inside of the rectangle">
          <input type="checkbox" aria-label="Fill" checked={sel.fill} disabled={locked}
            onChange={(e) => { controls.setSelectedFill(e.target.checked); onStyleDefaults?.({ fill: e.target.checked }); }} />
          Fill
        </label>
      )}
      <span className="drawing-style-sep" role="separator" aria-orientation="vertical" />
      <ArrangeMenu controls={controls} locked={locked} />
      <DrawingLockToggle locked={locked} ownLock={sel.ownLock} onToggle={(v) => controls.setSelectedLock(v)} />
    </div>
  );
}
