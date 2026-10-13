import type { IndicatorFigure } from 'klinecharts';
import { describe, expect, it, vi } from 'vitest';
import { solidBarFigures } from '../../src/chart/solidBars';

type Params = Parameters<NonNullable<IndicatorFigure['styles']>>[0];
const params = {} as Params;

describe('solidBarFigures', () => {
  it('turns outline-only (stroke) bars into filled ones, keeping the template colour; fill stays fill', () => {
    let rising = true;
    const styles = vi.fn(() => ({ style: rising ? 'stroke' as const : 'fill' as const, color: rising ? '#00ff00' : '#ff0000', borderColor: '#00ff00' }));
    const line: IndicatorFigure = { key: 'dif', title: 'DIF: ', type: 'line' };
    const bar: IndicatorFigure = { key: 'macd', title: 'MACD: ', type: 'bar', baseValue: 0, styles };
    const out = solidBarFigures([line, bar])!;
    expect(out[0]).toBe(line);
    expect(out[1]).toMatchObject({ key: 'macd', title: 'MACD: ', type: 'bar', baseValue: 0 });
    expect(out[1]!.styles!(params)).toEqual({ style: 'fill', color: '#00ff00', borderColor: '#00ff00' });
    rising = false;
    expect(out[1]!.styles!(params)).toEqual({ style: 'fill', color: '#ff0000', borderColor: '#00ff00' });
  });

  it('returns null when nothing changes: no bar callback, nothing given, or already wrapped', () => {
    expect(solidBarFigures(undefined)).toBeNull();
    expect(solidBarFigures([{ key: 'v', type: 'bar' }, { key: 'l', type: 'line', styles: () => ({ color: '#fff' }) }])).toBeNull();
    const once = solidBarFigures([{ key: 'ao', type: 'bar', styles: () => ({ style: 'stroke' }) }])!;
    expect(solidBarFigures(once)).toBeNull();
  });
});
