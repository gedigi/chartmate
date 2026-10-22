import type { CorporateEvent } from '@chartmate/shared';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../src/chart/contrast';
import { eventBadge, eventDetail, eventGroups, eventTitle, eventWhen } from '../../src/chart/events';
import { resolvePaletteColor, themeTokens } from '../../src/chart/theme';

const DAY = 86_400_000;
const D1 = Date.UTC(2026, 6, 6, 13, 30); // Mon 2026-07-06 09:30 New York
const bars = Array.from({ length: 10 }, (_, i) => ({ timestamp: D1 + i * DAY }));

const earnings = (ts: number, epsActual?: number, epsEstimate?: number): CorporateEvent =>
  ({ kind: 'earnings', ts, ...(epsActual !== undefined ? { epsActual } : {}), ...(epsEstimate !== undefined ? { epsEstimate } : {}) });
const dividend = (ts: number, amount = 0.27): CorporateEvent => ({ kind: 'dividend', ts, amount });
const split = (ts: number, ratio = '4:1'): CorporateEvent => ({ kind: 'split', ts, ratio });

describe('eventGroups', () => {
  it('puts each event on the bar that contains it, one group per bar, kinds bottom-up earnings, dividend, split', () => {
    const groups = eventGroups([
      split(D1 + 2 * DAY), dividend(D1 + 2 * DAY + 3600_000), earnings(D1 + 2 * DAY + 7 * 3600_000, 2, 1.9), dividend(D1 + 5 * DAY),
    ], bars, DAY, []);
    expect(groups.map((g) => [g.barTs, g.events.map((e) => e.kind)])).toEqual([
      [D1 + 2 * DAY, ['earnings', 'dividend', 'split']],
      [D1 + 5 * DAY, ['dividend']],
    ]);
  });

  it('leaves out hidden kinds, events before the first bar, and past events after the last bar', () => {
    const groups = eventGroups([dividend(D1 - DAY), split(D1 + DAY), dividend(D1 + 3 * DAY), dividend(D1 + 20 * DAY)], bars, DAY, ['split']);
    expect(groups.map((g) => g.barTs)).toEqual([D1 + 3 * DAY]);
    expect(eventGroups([dividend(D1)], [], DAY, [])).toEqual([]);
  });

  it('an upcoming report after the last bar stays at its own time (drawn in the space right of the bars)', () => {
    const next = { kind: 'earnings', ts: D1 + 30 * DAY, epsEstimate: 2, upcoming: true } as const;
    expect(eventGroups([next], bars, DAY, [])).toEqual([{ barTs: next.ts, events: [next] }]);
  });

  it('several events of one kind in a bar (a monthly bar) share one group', () => {
    const month = [{ timestamp: D1 }, { timestamp: D1 + 31 * DAY }];
    const groups = eventGroups([dividend(D1 + DAY), dividend(D1 + 10 * DAY), earnings(D1 + 12 * DAY)], month, 31 * DAY, []);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.events.map((e) => e.kind)).toEqual(['earnings', 'dividend', 'dividend']);
  });
});

describe('eventBadge', () => {
  for (const theme of ['dark', 'light'] as const) {
    const t = themeTokens(theme);
    it(`${theme}: letters and colors per kind, earnings by result; the letter always readable`, () => {
      expect(eventBadge([earnings(D1, 2, 1.9)], theme)).toMatchObject({ letter: 'E', fill: resolvePaletteColor('up', theme) });
      expect(eventBadge([earnings(D1, 1.8, 1.9)], theme)).toMatchObject({ letter: 'E', fill: resolvePaletteColor('down', theme) });
      expect(eventBadge([earnings(D1)], theme)).toMatchObject({ letter: 'E', fill: t.accent });
      expect(eventBadge([dividend(D1)], theme)).toMatchObject({ letter: 'D', fill: resolvePaletteColor('palette:0', theme) });
      expect(eventBadge([split(D1)], theme)).toMatchObject({ letter: 'S', fill: resolvePaletteColor('palette:1', theme) });
      for (const e of [earnings(D1, 2, 1.9), earnings(D1, 1, 2), earnings(D1), dividend(D1), split(D1)]) {
        const b = eventBadge([e], theme);
        expect(contrastRatio(b.fill, b.text), `${e.kind} ${b.fill}`).toBeGreaterThanOrEqual(3);
      }
    });

    it(`${theme}: an upcoming report is a hollow badge (accent ring on the chart background)`, () => {
      const b = eventBadge([{ kind: 'earnings', ts: D1, upcoming: true }], theme);
      expect(b).toMatchObject({ letter: 'E', fill: t.bg, ring: t.accent, text: t.accent });
    });
  }

  it('follows custom candle colors for beats and misses', () => {
    const appearance = { dark: { upColor: '#33aa55', downColor: '#dd3344' } };
    expect(eventBadge([earnings(D1, 2, 1)], 'dark', appearance).fill).toBe('#33aa55');
    expect(eventBadge([earnings(D1, 1, 2)], 'dark', appearance).fill).toBe('#dd3344');
  });
});

describe('event text', () => {
  it('titles', () => {
    expect(eventTitle(earnings(D1))).toBe('Earnings');
    expect(eventTitle({ kind: 'earnings', ts: D1, upcoming: true })).toBe('Earnings (expected)');
    expect(eventTitle(dividend(D1))).toBe('Dividend');
    expect(eventTitle(split(D1))).toBe('Split');
  });

  it('when: the New York date, and for earnings whether before the open or after the close', () => {
    expect(eventWhen(dividend(D1))).toBe('Jul 6, 2026');
    expect(eventWhen(earnings(Date.UTC(2026, 6, 30, 20, 30)))).toBe('Jul 30, 2026, after the close');
    expect(eventWhen(earnings(Date.UTC(2026, 6, 30, 11)))).toBe('Jul 30, 2026, before the open');
    expect(eventWhen(earnings(Date.UTC(2026, 6, 30, 15)))).toBe('Jul 30, 2026');
  });

  it('details: EPS against the estimate, the dividend per share, the split ratio', () => {
    expect(eventDetail(earnings(D1, 2.02, 1.89243))).toBe('EPS 2.02 vs 1.89 estimated, beat by 6.7%');
    expect(eventDetail(earnings(D1, 1.8, 2))).toBe('EPS 1.80 vs 2.00 estimated, missed by 10.0%');
    expect(eventDetail(earnings(D1, 2, 2))).toBe('EPS 2.00 vs 2.00 estimated, in line');
    expect(eventDetail(earnings(D1, -0.5, -0.4))).toBe('EPS -0.50 vs -0.40 estimated, missed by 25.0%');
    expect(eventDetail(earnings(D1, 2.02))).toBe('EPS 2.02');
    expect(eventDetail({ kind: 'earnings', ts: D1, epsEstimate: 1.98187, upcoming: true })).toBe('EPS estimate 1.98');
    expect(eventDetail(earnings(D1))).toBe('');
    expect(eventDetail(dividend(D1, 0.27))).toBe('$0.27 per share');
    expect(eventDetail(dividend(D1, 0.00375))).toBe('$0.0038 per share');
    expect(eventDetail(split(D1, '4:1'))).toBe('4-for-1');
    expect(eventDetail(split(D1, '1:10'))).toBe('1-for-10 (reverse split)');
    expect(eventDetail(split(D1, 'odd'))).toBe('odd');
  });
});
