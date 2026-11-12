import { describe, expect, it } from 'vitest';
import { afterEach as after, beforeEach } from 'vitest';
import { alertBadgeFigures, alertBadges, alertBadgeSettings, badgeCenter, withAlertBadge } from '../../src/chart/alertBadge';

beforeEach(() => { alertBadgeSettings.enabled = true; });
after(() => { alertBadges.clear(); alertBadgeSettings.enabled = false; });

const params = (id: string, coordinates: Array<{ x: number; y: number }>, color = '#3366ff') => ({
  overlay: { id, styles: { line: { color } } },
  coordinates,
  bounding: { width: 400, height: 300 },
  chart: { getStyles: () => ({ overlay: { line: { color: '#999999' } } }) },
}) as never;

describe('alert bell on drawings', () => {
  it('sits up and to the right of the rightmost point (the top one on a tie), inside the pane', () => {
    expect(badgeCenter([{ x: 10, y: 200 }, { x: 100, y: 120 }], { width: 400, height: 300 })).toEqual({ x: 112, y: 108 });
    expect(badgeCenter([{ x: 100, y: 200 }, { x: 100, y: 50 }], { width: 400, height: 300 })).toEqual({ x: 112, y: 38 });
    expect(badgeCenter([{ x: 398, y: 2 }], { width: 400, height: 300 })).toEqual({ x: 390, y: 10 }); // clamped
    expect(badgeCenter([], { width: 400, height: 300 })).toBeNull();
    // Scrolled off the left: no bell, unless the drawing reaches across the pane (a horizontal line), then at the edge.
    expect(badgeCenter([{ x: -50, y: 120 }, { x: -5, y: 100 }], { width: 400, height: 300 })).toBeNull();
    expect(badgeCenter([{ x: -50, y: 120 }], { width: 400, height: 300 }, true)).toEqual({ x: 10, y: 108 });
  });

  it('only on drawings with an alert: filled in the drawing color when on, hollow when off; it takes no clicks', () => {
    expect(alertBadgeFigures(params('a', [{ x: 50, y: 50 }]))).toEqual([]);
    alertBadges.set('a', { on: true });
    const on = alertBadgeFigures(params('a', [{ x: 50, y: 50 }])) as unknown as Array<{ type: string; ignoreEvent: boolean; styles: { style: string; color: string } }>;
    expect(on.map((f) => f.type)).toEqual(['circle', 'polygon', 'circle']);
    expect(on.every((f) => f.ignoreEvent)).toBe(true);
    expect(on[0]!.styles).toMatchObject({ style: 'fill', color: '#3366ff' });
    alertBadges.set('a', { on: false });
    const off = alertBadgeFigures(params('a', [{ x: 50, y: 50 }])) as unknown as Array<{ styles: Record<string, unknown> }>;
    expect(off[0]!.styles).toMatchObject({ style: 'stroke_fill', borderColor: '#3366ff' });
    expect(off[1]!.styles).toMatchObject({ color: '#3366ff' });
  });

  it('hidden where alerts are not checked (the web server)', () => {
    alertBadges.set('a', { on: true });
    alertBadgeSettings.enabled = false;
    expect(alertBadgeFigures(params('a', [{ x: 50, y: 50 }]))).toEqual([]);
  });

  it('a wrapped template keeps its own figures and adds the bell after them', () => {
    alertBadges.set('a', { on: true });
    const t = withAlertBadge({ name: 'x', createPointFigures: () => [{ type: 'line', attrs: {} }] } as never) as { createPointFigures: (p: unknown) => Array<{ type: string }> };
    expect(t.createPointFigures(params('a', [{ x: 5, y: 5 }])).map((f) => f.type)).toEqual(['line', 'circle', 'polygon', 'circle']);
    expect(t.createPointFigures(params('b', [{ x: 5, y: 5 }])).map((f) => f.type)).toEqual(['line']);
  });
});
