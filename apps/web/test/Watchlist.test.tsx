import type { SymbolId, SymbolInfo } from '@altv/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { Watchlist } from '../src/components/Watchlist';

const INFO: Record<string, SymbolInfo> = {
  'stock:AAPL': { id: 'stock:AAPL', assetClass: 'stock', ticker: 'AAPL', name: 'Apple Inc.', pricePrecision: 2 },
  'stock:MSFT': { id: 'stock:MSFT', assetClass: 'stock', ticker: 'MSFT', name: 'Microsoft', pricePrecision: 2 },
  'crypto:BTC': { id: 'crypto:BTC', assetClass: 'crypto', ticker: 'BTC', name: 'Bitcoin', pricePrecision: 1 },
  'basket:1': { id: 'basket:1', assetClass: 'basket', ticker: 'b1', name: 'My Basket', pricePrecision: 2 },
  'stock:SPY': { id: 'stock:SPY', assetClass: 'stock', ticker: 'SPY', name: 'SPDR', pricePrecision: 2 },
  'crypto:ETH': { id: 'crypto:ETH', assetClass: 'crypto', ticker: 'ETH', name: 'Ethereum', pricePrecision: 2 },
};

let put: ReturnType<typeof vi.spyOn>;
let quotes: ReturnType<typeof vi.spyOn>;

function setup(list: SymbolId[]) {
  vi.spyOn(api.watchlist, 'get').mockResolvedValue(list);
  put = vi.spyOn(api.watchlist, 'put').mockResolvedValue(undefined);
  quotes = vi.spyOn(api, 'quotes').mockResolvedValue([
    { id: 'stock:AAPL', price: 1234.5, changePct: 1.234, ts: 1 },
    { id: 'crypto:BTC', price: 100, changePct: -2, ts: 1 },
    { id: 'stock:MSFT', price: 5, changePct: null, ts: 1 },
  ]);
  vi.spyOn(api, 'sparklines').mockResolvedValue({ 'stock:AAPL': [1, 2, 3], 'crypto:BTC': [3, 2, 1] });
  vi.spyOn(api, 'symbol').mockImplementation(async (id) => INFO[id]!);
  vi.spyOn(api, 'search').mockResolvedValue([INFO['stock:MSFT']!]);
}

beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-symbol]'));
const order = () => rows().map((r) => r.getAttribute('data-symbol'));

describe('Watchlist', () => {
  it('renders rows with formatted price, colored change, basket name, highlight', async () => {
    setup(['stock:AAPL', 'crypto:BTC', 'basket:1']);
    render(<Watchlist currentSymbol="crypto:BTC" onSelect={vi.fn()} />);
    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    expect(await screen.findByText('1,234.50')).toBeInTheDocument();
    expect(screen.getByText('100.0')).toBeInTheDocument();
    expect(screen.getByText('+1.23%')).toHaveClass('up');
    expect(screen.getByText('-2.00%')).toHaveClass('down');
    expect(await screen.findByText('My Basket')).toBeInTheDocument();
    expect(rows()[2]!.textContent).toContain('—');
    expect(rows()[1]).toHaveAttribute('aria-selected', 'true');
    expect(rows()[0]).toHaveAttribute('aria-selected', 'false');
    await waitFor(() => expect(document.querySelectorAll('polyline')).toHaveLength(2));
  });

  it('click selects a symbol', async () => {
    setup(['stock:AAPL', 'crypto:BTC']);
    const onSelect = vi.fn();
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={onSelect} />);
    await userEvent.click(await screen.findByText('BTC'));
    expect(onSelect).toHaveBeenCalledWith('crypto:BTC');
  });

  it('ignores duplicate adds, saves new ones (debounced)', async () => {
    setup(['stock:AAPL']);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('AAPL');
    vi.mocked(api.search).mockResolvedValue([INFO['stock:AAPL']!, INFO['stock:MSFT']!]);
    const box = screen.getByRole('combobox');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.type(box, 'a');
    await user.click(await screen.findByRole('option', { name: /Apple/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(put).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
    await user.type(box, 'm');
    await user.click(await screen.findByRole('option', { name: /Microsoft/ }));
    expect(rows()).toHaveLength(2);
    await waitFor(() => expect(put).toHaveBeenCalledWith(['stock:AAPL', 'stock:MSFT']), { timeout: 2000 });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('remove saves list minus item', async () => {
    setup(['stock:AAPL', 'crypto:BTC']);
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('BTC');
    await userEvent.click(screen.getByRole('button', { name: 'Remove BTC' }));
    expect(rows()).toHaveLength(1);
    await waitFor(() => expect(put).toHaveBeenCalledWith(['stock:AAPL']), { timeout: 2000 });
  });

  it('Alt+Arrow reorders and keeps focus', async () => {
    setup(['stock:AAPL', 'crypto:BTC', 'stock:MSFT']);
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('MSFT');
    rows()[2]!.focus();
    fireEvent.keyDown(rows()[2]!, { key: 'ArrowUp', altKey: true });
    expect(order()).toEqual(['stock:AAPL', 'stock:MSFT', 'crypto:BTC']);
    expect(rows()[1]).toHaveFocus();
    fireEvent.keyDown(rows()[1]!, { key: 'ArrowDown', altKey: true });
    fireEvent.keyDown(rows()[2]!, { key: 'ArrowDown', altKey: true });
    expect(order()).toEqual(['stock:AAPL', 'crypto:BTC', 'stock:MSFT']);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it('drag and drop reorders', async () => {
    setup(['stock:AAPL', 'crypto:BTC', 'stock:MSFT']);
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('MSFT');
    const dt = { setData: vi.fn(), getData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(rows()[0]!, { dataTransfer: dt });
    fireEvent.dragOver(rows()[2]!, { dataTransfer: dt });
    fireEvent.drop(rows()[2]!, { dataTransfer: dt });
    expect(order()).toEqual(['crypto:BTC', 'stock:MSFT', 'stock:AAPL']);
  });

  it('seeds defaults when server list empty and never saved; sets flag', async () => {
    setup([]);
    render(<Watchlist currentSymbol="stock:SPY" onSelect={() => {}} />);
    await screen.findByText('SPY');
    expect(order()).toEqual(['stock:SPY', 'stock:AAPL', 'crypto:BTC', 'crypto:ETH']);
    await waitFor(() => expect(put).toHaveBeenCalledWith(['stock:SPY', 'stock:AAPL', 'crypto:BTC', 'crypto:ETH']));
    await waitFor(() => expect(localStorage.getItem('altv.watchlist.initialized')).toBe('1'));
  });

  it('does not seed when flag is set (user emptied list)', async () => {
    localStorage.setItem('altv.watchlist.initialized', '1');
    setup([]);
    render(<Watchlist currentSymbol="stock:SPY" onSelect={() => {}} />);
    await waitFor(() => expect(api.watchlist.get).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(rows()).toHaveLength(0);
    expect(put).not.toHaveBeenCalled();
  });

  it('polls quotes every 15s, skipping when document is hidden', async () => {
    setup(['stock:AAPL']);
    vi.useFakeTimers();
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(quotes).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(quotes).toHaveBeenCalledTimes(2);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(quotes).toHaveBeenCalledTimes(2);
    hidden.mockReturnValue(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(quotes).toHaveBeenCalledTimes(3);
    const before = vi.mocked(api.sparklines).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(vi.mocked(api.sparklines).mock.calls.length).toBeGreaterThan(before);
  });

  it('a failed watchlist.get never calls put', async () => {
    setup(['stock:AAPL']);
    vi.mocked(api.watchlist.get).mockRejectedValue(new Error('boom'));
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/boom/);
    await act(async () => { await new Promise((r) => setTimeout(r, 800)); });
    expect(put).not.toHaveBeenCalled();
  });

  it('polling stops on unmount, restarts on set change, not on reorder', async () => {
    setup(['stock:AAPL', 'crypto:BTC']);
    vi.useFakeTimers();
    const { unmount } = render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(quotes).toHaveBeenCalledTimes(1);
    const first = rows()[0]!;
    fireEvent.keyDown(first, { key: 'ArrowDown', altKey: true });
    expect(order()).toEqual(['crypto:BTC', 'stock:AAPL']);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(quotes).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove BTC' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(quotes).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(quotes).toHaveBeenCalledTimes(2);
  });

  it('sparkline poll respects hidden and fetches when becoming visible', async () => {
    setup(['stock:AAPL']);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    vi.useFakeTimers();
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.sparklines).not.toHaveBeenCalled();
    expect(quotes).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(api.sparklines).toHaveBeenCalledTimes(1);
    expect(quotes).toHaveBeenCalledTimes(1);
  });

  it('tiny negative change is neutral "0.00%"; price shows em dash until info loads', async () => {
    setup(['stock:AAPL']);
    quotes.mockResolvedValue([{ id: 'stock:AAPL', price: 10, changePct: -0.001, ts: 1 }]);
    let resolve!: (i: SymbolInfo) => void;
    vi.mocked(api.symbol).mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    const chg = await screen.findByText('0.00%');
    expect(chg).not.toHaveClass('down');
    expect(rows()[0]!.querySelector('.wl-price')).toHaveTextContent('—');
    await act(async () => { resolve(INFO['stock:AAPL']!); });
    expect(rows()[0]!.querySelector('.wl-price')).toHaveTextContent('10.00');
  });

  it('is a listbox of options; Delete on a row does not reach document-level shortcuts', async () => {
    setup(['stock:AAPL', 'crypto:BTC']);
    const onDoc = vi.fn();
    document.addEventListener('keydown', onDoc);
    try {
      render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
      await screen.findByText('BTC');
      const list = screen.getByRole('listbox', { name: 'Watchlist symbols' });
      const opts = within(list).getAllByRole('option');
      expect(opts).toHaveLength(2);
      expect(within(list).getByRole('option', { selected: true })).toHaveAttribute('data-symbol', 'stock:AAPL');
      fireEvent.keyDown(opts[1]!, { key: 'Delete' });
      expect(order()).toEqual(['stock:AAPL']);
      expect(onDoc).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onDoc);
    }
  });

  it('retries a failed symbol info load with backoff', async () => {
    setup(['stock:AAPL']);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.symbol).mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down'));
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.symbol).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.symbol).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.symbol).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(rows()[0]!.querySelector('.wl-symbol')).toHaveAttribute('title', 'Apple Inc.'));
  });

  it('stops retrying symbol info after unmount (incl. a request in flight at unmount)', async () => {
    setup(['stock:AAPL', 'crypto:BTC']);
    vi.useFakeTimers();
    let rejectInFlight!: (e: Error) => void;
    vi.mocked(api.symbol).mockImplementation((id) => (id === 'crypto:BTC'
      ? new Promise<SymbolInfo>((_, rej) => { rejectInFlight = rej; })
      : Promise.reject(new Error('down'))));
    const { unmount } = render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.symbol).toHaveBeenCalledTimes(2);
    unmount();
    rejectInFlight(new Error('down'));
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(api.symbol).toHaveBeenCalledTimes(2);
  });

  it('remounting does not add a second retry chain for the same id', async () => {
    setup(['stock:AAPL']);
    vi.useFakeTimers();
    vi.mocked(api.symbol).mockRejectedValue(new Error('down'));
    const first = render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    first.unmount();
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    vi.mocked(api.symbol).mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.symbol).toHaveBeenCalledTimes(1);
  });

  it('stops retrying symbol info for ids removed from the list', async () => {
    setup(['stock:AAPL', 'crypto:BTC']);
    vi.useFakeTimers();
    vi.mocked(api.symbol).mockImplementation(async (id) => {
      if (id === 'crypto:BTC') throw new Error('down');
      return INFO[id]!;
    });
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole('button', { name: 'Remove BTC' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    vi.mocked(api.symbol).mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(api.symbol).not.toHaveBeenCalled();
  });

  it('Delete removes the row and focuses the neighbor (previous if last)', async () => {
    setup(['stock:AAPL', 'crypto:BTC', 'stock:MSFT']);
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('MSFT');
    rows()[1]!.focus();
    fireEvent.keyDown(rows()[1]!, { key: 'Delete' });
    expect(order()).toEqual(['stock:AAPL', 'stock:MSFT']);
    expect(rows()[1]).toHaveFocus();
    fireEvent.keyDown(rows()[1]!, { key: 'Delete' });
    expect(rows()[0]).toHaveFocus();
  });
});
