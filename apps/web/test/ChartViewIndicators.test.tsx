import type { Layout, SymbolInfo } from '@altv/shared';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';

vi.mock('../src/chart/ChartAdapter', () => ({
  ChartAdapter: class {
    seq = 0;
    load = vi.fn(); setTheme = vi.fn(); setChartType = vi.fn(); setSessionShading = vi.fn(); setMarkers = vi.fn();
    addIndicator = vi.fn(() => `ind_${++this.seq}`); updateIndicator = vi.fn(); removeIndicator = vi.fn();
    restoreDrawings = vi.fn(); serializeDrawings = vi.fn(() => []); onDrawingsChange = vi.fn(() => () => {}); onLockAllChange = vi.fn(() => () => {});
    resize = vi.fn(); destroy = vi.fn();
  },
}));

const { ChartView } = await import('../src/components/ChartView');

const AAPL: SymbolInfo = { id: 'stock:AAPL', assetClass: 'stock', ticker: 'AAPL', name: 'Apple', pricePrecision: 2 };
const LAYOUT: Layout = {
  symbol: 'stock:AAPL', tf: '5m', session: 'rth', chartType: 'candle',
  indicators: [{ name: 'RSI', pane: 'sub', calcParams: [14], visible: true }],
};

beforeEach(() => {
  vi.spyOn(api.drawings, 'get').mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe('ChartView indicator chips', () => {
  it('renders the active-indicator chips inside the chart area and wires them to setLayout', async () => {
    const setLayout = vi.fn();
    render(<ChartView layout={LAYOUT} setLayout={setLayout} symbolInfo={AAPL} theme="dark" />);
    await act(async () => { await Promise.resolve(); });
    const area = screen.getByTestId('chart-view').querySelector('.chart-area') as HTMLElement;
    const chips = within(area).getByRole('list', { name: /active indicators/i });
    expect(chips).toHaveTextContent('RSI(14)');
    await userEvent.click(within(chips).getByRole('button', { name: 'Remove RSI(14)' }));
    const fn = setLayout.mock.calls[0]![0] as (l: Layout) => Layout;
    expect(fn(LAYOUT).indicators).toEqual([]);
  });
});
