import { describe, expect, it } from 'vitest';
import { toKLineData } from '../../src/chart/dataLoader';
import { isExtendedSession, isSimulated, shadeRuns } from '../../src/chart/sessionShade';

const k = (timestamp: number, extra: Record<string, unknown> = {}) => ({ timestamp, open: 1, high: 1, low: 1, close: 1, ...extra });

describe('shade runs', () => {
  it('groups adjacent matching bars into runs (index ranges, end exclusive)', () => {
    const data = [k(1, { simulated: true }), k(2, { simulated: true }), k(3), k(4, { simulated: true }), k(5)];
    expect(shadeRuns(data, 0, data.length, isSimulated)).toEqual([[0, 2], [3, 4]]);
    expect(shadeRuns(data, 1, 3, isSimulated)).toEqual([[1, 2]]);
    expect(shadeRuns(data, 0, 5, isExtendedSession)).toEqual([]);
    const sessions = [k(1, { session: 'pre' }), k(2, { session: 'regular' }), k(3, { session: 'post' })];
    expect(shadeRuns(sessions, 0, 3, isExtendedSession)).toEqual([[0, 1], [2, 3]]);
  });

  it('toKLineData carries the simulated flag of basket bars', () => {
    expect(toKLineData({ ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 0, simulated: true })).toMatchObject({ simulated: true });
    expect(toKLineData({ ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 0 })).not.toHaveProperty('simulated');
  });
});
