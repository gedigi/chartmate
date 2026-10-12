import { MAX_LINE_WIDTH, MIN_LINE_WIDTH } from '@altv/shared';
import { useEffect, useState, type JSX } from 'react';
import type { ChartAdapter, SelectedDrawing } from '../chart/ChartAdapter';

export type DrawingStyleControls = Pick<ChartAdapter, 'onSelectionChange' | 'setSelectedStyle'>;

const WIDTHS = Array.from({ length: MAX_LINE_WIDTH - MIN_LINE_WIDTH + 1 }, (_, i) => MIN_LINE_WIDTH + i);
const FONT_SIZES = [10, 12, 14, 16, 18, 20, 22, 24];

/**
 * Floating style bar for the selected drawing: colour, width and solid/dashed for lines; colour and font size
 * for text annotations. Read-only for locked drawings; hidden while a drawing is being placed. Changes go through the adapter (overrideOverlay) and are saved with the drawings.
 */
export function DrawingStyleBar({ controls }: { controls: DrawingStyleControls | null }): JSX.Element | null {
  const [sel, setSel] = useState<SelectedDrawing | null>(null);
  useEffect(() => {
    setSel(null);
    return controls?.onSelectionChange(setSel);
  }, [controls]);
  if (!controls || !sel) return null;

  const locked = sel.locked;
  const sizes = sel.kind === 'text' && !FONT_SIZES.includes(sel.style.size) ? [...FONT_SIZES, sel.style.size].sort((a, b) => a - b) : FONT_SIZES;
  return (
    <div className="drawing-style-bar" role="toolbar" aria-label="Drawing style" aria-disabled={locked || undefined}>
      <input
        type="color" aria-label="Drawing colour" title="Colour" value={sel.style.color} disabled={locked}
        onChange={(e) => controls.setSelectedStyle({ color: e.target.value })}
      />
      {sel.kind === 'line' ? (
        <>
          <select aria-label="Line width" title="Width" value={sel.style.size} disabled={locked}
            onChange={(e) => controls.setSelectedStyle({ size: Number(e.target.value) })}>
            {WIDTHS.map((w) => <option key={w} value={w}>{w}px</option>)}
          </select>
          <select aria-label="Line style" title="Style" value={sel.style.style} disabled={locked}
            onChange={(e) => controls.setSelectedStyle({ style: e.target.value === 'dashed' ? 'dashed' : 'solid' })}>
            <option value="solid">Solid</option>
            <option value="dashed">Dashed</option>
          </select>
        </>
      ) : (
        <select aria-label="Font size" title="Font size" value={sel.style.size} disabled={locked}
          onChange={(e) => controls.setSelectedStyle({ size: Number(e.target.value) })}>
          {sizes.map((s) => <option key={s} value={s}>{s}px</option>)}
        </select>
      )}
      {locked && <span className="drawing-style-locked">Locked</span>}
    </div>
  );
}
