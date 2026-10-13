import type { Bar, SymbolInfo } from '@chartmate/shared';
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { SymbolDetails } from '../src/components/SymbolDetails';

const DAY = 86_400_000;
const AAPL: SymbolInfo = { id: 'stock:AAPL', assetClass: 'stock', ticker: 'AAPL', name: 'Apple Inc.', pricePrecision: 2 };
const BTC: SymbolInfo = { id: 'crypto:BTC', assetClass: 'crypto', ticker: 'BTC', name: 'Bitcoin', pricePrecision: 1 };

function bars(n: number): Bar[] {
  const today = Math.floor(Date.now() / DAY) * DAY;
  return Array.from({ length: n }, (_, i) => ({ ts: today - (n - 1 - i) * DAY, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 1_000_000 }));
}

afterEach(() => vi.restoreAllMocks());

describe('SymbolDetails', () => {
  it('shows the day range and key stats from daily bars and the live quote', async () => {
    const getBars = vi.spyOn(api, 'bars').mockResolvedValue({ symbol: 'stock:AAPL', tf: '1D', session: 'rth', bars: bars(40), hasMoreBefore: false, stale: false, notices: [], markers: [] });
    vi.spyOn(api, 'quotes').mockResolvedValue([{ id: 'stock:AAPL', price: 141.5, changePct: 0.5, ts: Date.now() }]);
    render(<SymbolDetails symbol="stock:AAPL" info={AAPL} />);
    const panel = await screen.findByRole('region', { name: 'AAPL details' });
    expect(within(panel).getByText('Apple Inc.')).toBeInTheDocument();
    expect(await within(panel).findByText('Day range')).toBeInTheDocument();
    expect(getBars).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'stock:AAPL', tf: '1D' }), expect.anything());
    const stat = (label: string) => within(panel).getByText(label).nextElementSibling;
    expect(stat('Open')).toHaveTextContent('139.00');
    expect(stat('Prev close')).toHaveTextContent('139.00');
    expect(stat('Volume')).toHaveTextContent('1.00M');
    expect(await within(panel).findByText('141.50', { selector: '.sd-stat dd' })).toBeInTheDocument(); // 52w high = live price
    expect(stat('52w low')).toHaveTextContent('99.00');
  });

  it('crypto trades around the clock; nothing renders for another symbol\'s info', async () => {
    vi.spyOn(api, 'bars').mockResolvedValue({ symbol: 'crypto:BTC', tf: '1D', session: 'rth', bars: [], hasMoreBefore: false, stale: false, notices: [], markers: [] });
    vi.spyOn(api, 'quotes').mockResolvedValue([]);
    const { rerender } = render(<SymbolDetails symbol="crypto:BTC" info={BTC} />);
    expect(screen.getByText('Trades around the clock')).toBeInTheDocument();
    expect(screen.queryByText('Day range')).not.toBeInTheDocument();
    rerender(<SymbolDetails symbol="stock:AAPL" info={BTC} />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});
