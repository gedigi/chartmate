import { useEffect, useRef, type JSX, type KeyboardEvent, type PointerEvent } from 'react';

const KEY_STEP = 16;

export interface SidebarResizerProps {
  width: number;
  min: number;
  max: number;
  /** A live width while dragging (not stored). */
  onPreview: (width: number) => void;
  /** A settled width (drag released, key pressed): stored. */
  onCommit: (width: number) => void;
  /** Double-click / Enter: back to the default width. */
  onReset: () => void;
}

interface Drag { pointerId: number; startX: number; startWidth: number; x: number; frame: number | null }

/**
 * The drag handle on the sidebar's left edge (a window splitter: role="separator" with a value). Dragging left widens
 * the sidebar; moves are coalesced to one update per animation frame so the chart re-lays out at most once a frame.
 */
export function SidebarResizer({ width, min, max, onPreview, onCommit, onReset }: SidebarResizerProps): JSX.Element {
  const drag = useRef<Drag | null>(null);
  const widthAt = (d: Drag) => d.startWidth + d.startX - d.x;

  useEffect(() => () => {
    if (drag.current?.frame != null) cancelAnimationFrame(drag.current.frame);
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection, keeps focus where it was
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: width, x: e.clientX, frame: null };
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* pointer already gone */ }
    e.currentTarget.dataset.dragging = '';
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    d.x = e.clientX;
    if (d.frame !== null) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = null;
      if (drag.current === d) onPreview(widthAt(d));
    });
  };

  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    if (d.frame !== null) cancelAnimationFrame(d.frame);
    d.x = e.clientX;
    try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    delete e.currentTarget.dataset.dragging;
    onCommit(widthAt(d));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = width + KEY_STEP;
    else if (e.key === 'ArrowRight') next = width - KEY_STEP;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    else if (e.key === 'Enter') { e.preventDefault(); onReset(); return; }
    if (next === null) return;
    e.preventDefault();
    onCommit(next);
  };

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize watchlist"
      aria-controls="right-sidebar"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
