import type { Bar, BarsResponse, SymbolInfo } from '@chartmate/shared';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { BARS_POLL_MS, QUOTE_POLL_MS, SymbolDetails } from '../src/components/SymbolDetails';
import { clearQuotes, publishQuotes } from '../src/state/quoteStore';

const DAY = 86_400_000;
const AAPL: SymbolInfo = { id: 'stock:AAPL', assetClass: 'stock', ticker: 'AAPL', name: 'Apple Inc.', pricePrecision: 2 };
const BTC: SymbolInfo = { id: 'crypto:BTC', assetClass: 'crypto', ticker: 'BTC', name: 'Bitcoin', pricePrecision: 1 };

function bars(n: number): Bar[] {
  const today = Math.floor(Date.now() / DAY) * DAY;
  return Array.from({ length: n }, (_, i) => ({ ts: today - (n - 1 - i) * DAY, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 1_000_000 }));
}
const response = (b: Bar[]): BarsResponse => ({ symbol: 'stock:AAPL', tf: '1D', session: 'rth', bars: b, hasMoreBefore: false, stale: false, notices: [], markers: [] });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearQuotes();
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
});

describe('SymbolDetails', () => {
  it('shows the day range and key stats from daily bars and the live quote', async () => {
    const getBars = vi.spyOn(api, 'bars').mockResolvedValue(response(bars(40)));
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
    // Up vs the previous close (139.00), like the watchlist pill.
    expect(panel.querySelector('.dg-needle')).toHaveClass('up');
  });

  it('reuses a fresh quote the watchlist fetched instead of polling it again', async () => {
    vi.spyOn(api, 'bars').mockResolvedValue(response(bars(3)));
    const quotes = vi.spyOn(api, 'quotes').mockResolvedValue([]);
    publishQuotes([{ id: 'stock:AAPL', price: 50, changePct: -1, ts: Date.now() }]);
    render(<SymbolDetails symbol="stock:AAPL" info={AAPL} />);
    expect(await screen.findByText('50.00', { selector: '.sd-range-label .num' })).toBeInTheDocument();
    expect(quotes).not.toHaveBeenCalled();
    // The panel's needle is down vs the previous close (101.00 → 50.00).
    expect(document.querySelector('.dg-needle')).toHaveClass('down');
  });

  it('a quiet loading line, then an error with Retry when the bars cannot be loaded', async () => {
    let fail = true;
    vi.spyOn(api, 'bars').mockImplementation(async () => { if (fail) throw new Error('boom'); return response(bars(5)); });
    vi.spyOn(api, 'quotes').mockResolvedValue([]);
    render(<SymbolDetails symbol="stock:AAPL" info={AAPL} />);
    expect(screen.getByText('Loading details…')).toBeInTheDocument();
    expect(await screen.findByText(/Couldn.t load details/)).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Day range')).toBeInTheDocument();
    expect(screen.queryByText(/Couldn.t load details/)).not.toBeInTheDocument();
  });

  it('pauses the bars and quote polls while the page is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const getBars = vi.spyOn(api, 'bars').mockResolvedValue(response(bars(3)));
    const quotes = vi.spyOn(api, 'quotes').mockResolvedValue([]);
    render(<SymbolDetails symbol="stock:AAPL" info={AAPL} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getBars).toHaveBeenCalledTimes(1);
    expect(quotes).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(BARS_POLL_MS + QUOTE_POLL_MS); });
    expect(getBars).toHaveBeenCalledTimes(1);
    expect(quotes).toHaveBeenCalledTimes(1);
  });

  it('crypto trades around the clock; nothing renders for another symbol\'s info', async () => {
    vi.spyOn(api, 'bars').mockResolvedValue({ ...response([]), symbol: 'crypto:BTC' });
    vi.spyOn(api, 'quotes').mockResolvedValue([]);
    const { rerender } = render(<SymbolDetails symbol="crypto:BTC" info={BTC} />);
    expect(screen.getByText('Trades around the clock')).toBeInTheDocument();
    expect(screen.queryByText('Day range')).not.toBeInTheDocument();
    rerender(<SymbolDetails symbol="stock:AAPL" info={BTC} />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});
