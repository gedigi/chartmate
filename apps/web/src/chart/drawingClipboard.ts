import type { DrawingState } from '@chartmate/shared';

/** A copied drawing: what is pasted, never its id or its own lock. */
export interface DrawingClip {
  name: string;
  /** As stored: a daily-anchored drawing's daily points (see anchorTf), otherwise the points as shown. */
  points: Array<{ timestamp: number; value: number }>;
  /** Set when the copied drawing was daily-anchored and unmoved: the copy is re-anchored on paste. */
  anchorTf?: DrawingState['anchorTf'];
  text?: string;
  styles?: DrawingState['styles'];
  /** Bar index of each point relative to the earliest one, on the chart it was copied from. */
  barOffsets: number[];
}

let current: DrawingClip | null = null;

/**
 * In-app clipboard of drawings (⌘C / ⌘V). Module state, so it outlives a chart (the chart view unmounts while
 * Baskets is open) and is shared by symbols and timeframes; a page reload empties it. The system clipboard is
 * never read or written.
 */
export const drawingClipboard = {
  get: (): DrawingClip | null => current,
  set: (clip: DrawingClip): void => { current = clip; },
  clear: (): void => { current = null; },
};
