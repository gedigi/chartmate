import { describe, expect, it } from 'vitest';
import { normalizeOverlayStyles, sanitizeDrawingStyles, toOverlayStyles } from '../../src/chart/drawingStyles';

describe('channel extend options in drawing styles', () => {
  it('sanitize keeps boolean extend sides only (alone or with a line); invalid ones are dropped', () => {
    expect(sanitizeDrawingStyles({ extend: { right: true } })).toEqual({ extend: { right: true } });
    expect(sanitizeDrawingStyles({ extend: { left: false, right: true, up: true } })).toEqual({ extend: { left: false, right: true } });
    expect(sanitizeDrawingStyles({ extend: { left: 'yes' } })).toBeUndefined();
    expect(sanitizeDrawingStyles({ extend: 'both' })).toBeUndefined();
    expect(sanitizeDrawingStyles({ line: { color: '#FF0000', size: 2, style: 'dashed' }, extend: { left: true } }))
      .toEqual({ line: { color: '#ff0000', size: 2, style: 'dashed' }, extend: { left: true } });
  });

  it('round trip: stored extend → overlay styles → stored extend (only what differs from the drawing defaults)', () => {
    const stored = { extend: { right: true } };
    const overlay = toOverlayStyles(sanitizeDrawingStyles(stored));
    expect(overlay).toEqual({ chartmateExtend: { right: true } });
    expect(normalizeOverlayStyles('parallelChannel', overlay)).toEqual(stored);
    // Defaults are not stored: a finite new channel, an extended legacy channel.
    expect(normalizeOverlayStyles('parallelChannel', { chartmateExtend: { left: false, right: false } })).toBeUndefined();
    expect(normalizeOverlayStyles('parallelStraightLine', { chartmateExtend: { left: true, right: true } })).toBeUndefined();
    expect(normalizeOverlayStyles('parallelStraightLine', { chartmateExtend: { left: false, right: true } })).toEqual({ extend: { left: false } });
    // Other drawings never carry extend options.
    expect(normalizeOverlayStyles('segment', { chartmateExtend: { left: true } })).toBeUndefined();
  });
});
