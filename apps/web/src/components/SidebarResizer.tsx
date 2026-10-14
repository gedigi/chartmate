import { useEffect, useRef, type JSX, type KeyboardEvent, type PointerEvent } from 'react';

const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

export interface SidebarResizerProps {
  width: number;
  min: number;
  max: number;
  /** A live width while dragging (not stored, no React render); returns the clamped width shown. */
  onPreview: (width: number) => number;
  /** A settled width (drag ended, key pressed): stored; returns the clamped width. */
  onCommit: (width: number) => number;
  /** Double-click / Enter: back to the default width. */
  onReset: () => void;
}

interface Drag { pointerId: number; startX: number; startWidth: number; x: number; shown: number; frame: number | null }

/**
 * The drag handle on the sidebar's left edge (a window splitter: role="separator" with a value). Dragging left widens
 * the sidebar. Moves are coalesced to one preview per animation frame, and a preview only writes the shell's CSS
 * variable and this element's aria-valuenow, so nothing re-renders until the drag ends.
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
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: width, x: e.clientX, shown: width, frame: null };
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* pointer already gone */ }
    e.currentTarget.dataset.dragging = '';
  };

  /**
   * Ends the drag. A release (pointerup) settles at the pointer's position; a cancel, a lost capture or a release we
   * missed settle at the last width shown, since their coordinates are not a position the user chose.
   */
  const finish = (el: HTMLDivElement, pointerId: number, releaseX: number | null) => {
    const d = drag.current;
    if (!d || pointerId !== d.pointerId) return;
    drag.current = null;
    if (d.frame !== null) cancelAnimationFrame(d.frame);
    try { if (el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId); } catch { /* not captured */ }
    delete el.dataset.dragging;
    if (releaseX !== null) d.x = releaseX;
    const settled = onCommit(releaseX !== null ? widthAt(d) : d.shown);
    el.setAttribute('aria-valuenow', String(settled));
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (e.buttons === 0) { finish(e.currentTarget, e.pointerId, null); return; }
    d.x = e.clientX;
    if (d.frame !== null) return;
    const el = e.currentTarget;
    d.frame = requestAnimationFrame(() => {
      d.frame = null;
      if (drag.current !== d) return;
      d.shown = onPreview(widthAt(d));
      el.setAttribute('aria-valuenow', String(d.shown));
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = width + step;
    else if (e.key === 'ArrowRight') next = width - step;
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
      onPointerUp={(e) => finish(e.currentTarget, e.pointerId, e.clientX)}
      onPointerCancel={(e) => finish(e.currentTarget, e.pointerId, null)}
      onLostPointerCapture={(e) => finish(e.currentTarget, e.pointerId, null)}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
