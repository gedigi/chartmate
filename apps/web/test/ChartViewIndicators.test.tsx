import type { Layout, SymbolInfo } from '@chartmate/shared';
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
    resize = vi.fn(); destroy = vi.fn(); clear = vi.fn();
    setAppearance = vi.fn(); setPositionDefaults = vi.fn(); setNewDrawingColor = vi.fn(); onSelectionChange = vi.fn(() => () => {}); setMagnetOverride = vi.fn(); deselect = vi.fn();
    setSelectedPrice = vi.fn(() => true); setSelectedLabel = vi.fn(); setSelectedExtend = vi.fn(); setShiftConstraint = vi.fn(); onPriceEditRequest = vi.fn(() => () => {});
    clearMeasure = vi.fn(); onMeasureChange = vi.fn(() => () => {});
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
    // A strip above the canvas: first child of the chart area, outside the stage that holds the canvas host.
    const stage = area.querySelector('.chart-stage') as HTMLElement;
    expect(area.firstElementChild).toHaveClass('chart-toprow');
    expect(area.firstElementChild!.firstElementChild).toBe(chips);
    expect(stage.contains(chips)).toBe(false);
    expect(stage.contains(screen.getByTestId('chart-host'))).toBe(true);
    expect(chips).toHaveTextContent('RSI(14)');
    await userEvent.click(within(chips).getByRole('button', { name: 'Remove RSI(14)' }));
    const fn = setLayout.mock.calls[0]![0] as (l: Layout) => Layout;
    expect(fn(LAYOUT).indicators).toEqual([]);
  });

  it('without indicators the top row stays (one strip tall in CSS) so a save note never moves the canvas', async () => {
    render(<ChartView layout={{ ...LAYOUT, indicators: [] }} setLayout={vi.fn()} symbolInfo={AAPL} theme="dark" />);
    await act(async () => { await Promise.resolve(); });
    const area = screen.getByTestId('chart-view').querySelector('.chart-area') as HTMLElement;
    expect(screen.queryByRole('list', { name: /active indicators/i })).not.toBeInTheDocument();
    // The top row holds only the empty save-note stack (`:empty` → display: none); its height is reserved in CSS.
    const row = area.firstElementChild as HTMLElement;
    expect(row).toHaveClass('chart-toprow');
    expect(row.children).toHaveLength(1);
    expect(row.firstElementChild).toHaveClass('chart-save-notes');
    expect(row.firstElementChild!.childNodes).toHaveLength(0);
    expect(area.children[1]).toHaveClass('chart-stage');
  });
});
