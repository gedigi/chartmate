import type { SymbolId, SymbolInfo, WatchlistEntry } from '@altv/shared';
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

const sym = (id: SymbolId): WatchlistEntry => ({ type: 'symbol', id });
const syms = (ids: SymbolId[]): WatchlistEntry[] => ids.map(sym);

function setup(list: Array<SymbolId | WatchlistEntry>) {
  vi.spyOn(api.watchlist, 'get').mockResolvedValue(list.map((e) => (typeof e === 'string' ? sym(e) : e)));
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
    expect(rows()[1]).toHaveAttribute('aria-current', 'true');
    expect(rows()[0]).not.toHaveAttribute('aria-current');
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
    await waitFor(() => expect(put).toHaveBeenCalledWith(syms(['stock:AAPL', 'stock:MSFT'])), { timeout: 2000 });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('remove saves list minus item', async () => {
    setup(['stock:AAPL', 'crypto:BTC']);
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('BTC');
    await userEvent.click(screen.getByRole('button', { name: 'Remove BTC' }));
    expect(rows()).toHaveLength(1);
    await waitFor(() => expect(put).toHaveBeenCalledWith(syms(['stock:AAPL'])), { timeout: 2000 });
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
    await waitFor(() => expect(put).toHaveBeenCalledWith(syms(['stock:SPY', 'stock:AAPL', 'crypto:BTC', 'crypto:ETH'])));
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

  describe('extended-hours line', () => {
    const PRE_TS = Date.parse('2026-10-12T12:14:55Z'); // 08:14 EDT
    const POST_TS = Date.parse('2026-10-12T21:29:40Z'); // 17:29 EDT
    const extOf = (id: SymbolId) => document.querySelector(`[data-symbol="${id}"] .wl-ext`);

    function setupExt() {
      setup(['stock:AAPL', 'stock:MSFT', 'crypto:BTC']);
      quotes.mockResolvedValue([
        { id: 'stock:AAPL', price: 229.52, changePct: -1.1, ts: 1, ext: { session: 'pre', price: 231.4, changePct: 0.8191, ts: PRE_TS } },
        { id: 'stock:MSFT', price: 400, changePct: 0.5, ts: 1, ext: { session: 'post', price: 398.123, changePct: -0.4693, ts: POST_TS } },
        { id: 'crypto:BTC', price: 100, changePct: -2, ts: 1 },
      ]);
    }

    it('keeps the main row on the regular price and day change, and adds "Pre/Post price change" below', async () => {
      setupExt();
      render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
      await waitFor(() => expect(extOf('stock:AAPL')).not.toBeNull());
      const aapl = rows()[0]!;
      expect(aapl.querySelector('.wl-price')).toHaveTextContent('229.52');
      expect(aapl.querySelector('.wl-change')).toHaveTextContent('-1.10%');
      expect(aapl.querySelector('.wl-change')).toHaveClass('down');
      const pre = extOf('stock:AAPL')!;
      expect(pre.querySelector('.wl-ext-label')).toHaveTextContent('Pre');
      expect(pre.querySelector('.wl-ext-price')).toHaveTextContent('231.40');
      expect(pre.querySelector('.wl-ext-change')).toHaveTextContent('+0.82%');
      expect(pre.querySelector('.wl-ext-change')).toHaveClass('up');
      const post = await waitFor(() => extOf('stock:MSFT')!);
      expect(post.querySelector('.wl-ext-label')).toHaveTextContent('Post');
      expect(post.querySelector('.wl-ext-price')).toHaveTextContent('398.12'); // same precision rules
      expect(post.querySelector('.wl-ext-change')).toHaveTextContent('-0.47%');
      expect(post.querySelector('.wl-ext-change')).toHaveClass('down');
      expect(rows()[1]!.querySelector('.wl-price')).toHaveTextContent('400.00');
    });

    it('no extended line without ext (crypto, regular hours) or before symbol info loads', async () => {
      setupExt();
      let resolve!: (i: SymbolInfo) => void;
      vi.mocked(api.symbol).mockImplementation((id) => (id === 'stock:AAPL' ? new Promise((r) => { resolve = r; }) : Promise.resolve(INFO[id]!)));
      render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
      await waitFor(() => expect(extOf('stock:MSFT')).not.toBeNull());
      expect(extOf('crypto:BTC')).toBeNull();
      expect(extOf('stock:AAPL')).toBeNull();
      await act(async () => { resolve(INFO['stock:AAPL']!); });
      expect(extOf('stock:AAPL')).not.toBeNull();
    });

    it('every row reserves the second line (stable height across 09:30/16:00); an empty slot is hidden from AT', async () => {
      setupExt();
      render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
      await waitFor(() => expect(extOf('stock:AAPL')).not.toBeNull());
      for (const r of rows()) expect(r.querySelectorAll(':scope > .wl-ext-slot')).toHaveLength(1);
      const btcSlot = rows()[2]!.querySelector('.wl-ext-slot')!;
      expect(btcSlot).toBeEmptyDOMElement();
      expect(btcSlot).toHaveAttribute('aria-hidden', 'true');
      expect(rows()[0]!.querySelector('.wl-ext-slot')).not.toHaveAttribute('aria-hidden');
      expect(rows()[0]!.querySelector('.wl-ext-slot > .wl-ext')).not.toBeNull();
    });

    it('a neutral extended change is uncolored "0.00%"', async () => {
      setup(['stock:AAPL']);
      quotes.mockResolvedValue([{ id: 'stock:AAPL', price: 10, changePct: 1, ts: 1, ext: { session: 'post', price: 10, changePct: 0.001, ts: POST_TS } }]);
      render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
      const chg = await waitFor(() => extOf('stock:AAPL')!.querySelector('.wl-ext-change')!);
      expect(chg).toHaveTextContent('0.00%');
      expect(chg).not.toHaveClass('up');
      expect(chg).not.toHaveClass('down');
    });

    it('is accessible: spelled-out session in the row name and a tooltip with the extended time (ET)', async () => {
      setupExt();
      render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
      await waitFor(() => expect(extOf('stock:AAPL')).not.toBeNull());
      expect(screen.getByRole('button', { name: /AAPL.*229\.52.*-1\.10%.*Pre-market 231\.40 \+0\.82%/ })).toBe(rows()[0]);
      expect(screen.getByRole('button', { name: /MSFT.*Post-market 398\.12 -0\.47%/ })).toBe(rows()[1]);
      expect(extOf('stock:AAPL')!.querySelector('.wl-ext-label')).toHaveAttribute('aria-hidden', 'true');
      const title = extOf('stock:AAPL')!.getAttribute('title')!;
      expect(title).toMatch(/^Pre-market/);
      expect(title).toContain('8:14 AM ET');
      expect(extOf('stock:MSFT')!.getAttribute('title')).toContain('5:29 PM ET');
    });

    it('drops the extended line when a later poll has no ext', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      setupExt();
      render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
      await waitFor(() => expect(extOf('stock:AAPL')).not.toBeNull());
      quotes.mockResolvedValue([{ id: 'stock:AAPL', price: 231, changePct: 0.6, ts: 2 }]);
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(extOf('stock:AAPL')).toBeNull();
      expect(rows()[0]!.querySelector('.wl-price')).toHaveTextContent('231.00');
    });
  });

  it('is a list of rows: a focusable select control (aria-current) and a sibling remove button; no nested interactives', async () => {
    setup(['stock:AAPL', 'crypto:BTC']);
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('BTC');
    const list = screen.getByRole('list', { name: 'Watchlist symbols' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    for (const row of rows()) {
      expect(row).toHaveAttribute('role', 'button');
      expect(row).toHaveAttribute('tabindex', '0');
      expect(row.querySelector('button, [role="button"], a, input, [tabindex]')).toBeNull();
    }
    expect(rows()[0]).toHaveAttribute('aria-current', 'true');
    expect(rows()[1]).not.toHaveAttribute('aria-current');
    const remove = screen.getByRole('button', { name: 'Remove BTC' });
    expect(rows()[1]!.contains(remove)).toBe(false);
    expect(rows()[1]!.parentElement!.contains(remove)).toBe(true);
    expect(rows()[1]).toHaveAccessibleDescription(/Delete removes, Alt\+Arrow keys reorder/);
  });

  it('Enter and Space on a row select it', async () => {
    setup(['stock:AAPL', 'crypto:BTC']);
    const onSelect = vi.fn();
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={onSelect} />);
    await screen.findByText('BTC');
    fireEvent.keyDown(rows()[1]!, { key: 'Enter' });
    fireEvent.keyDown(rows()[0]!, { key: ' ' });
    expect(onSelect.mock.calls).toEqual([['crypto:BTC'], ['stock:AAPL']]);
  });

  it('Delete on a row does not reach document-level shortcuts', async () => {
    setup(['stock:AAPL', 'crypto:BTC']);
    const onDoc = vi.fn();
    document.addEventListener('keydown', onDoc);
    try {
      render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
      await screen.findByText('BTC');
      fireEvent.keyDown(rows()[1]!, { key: 'Delete' });
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

const SEC_X = '0b6f7c1e-3f1a-4c1e-9a7b-2a1d3c4e5f60';
const SEC_Y = '1b6f7c1e-3f1a-4c1e-9a7b-2a1d3c4e5f61';
const section = (id: string, title: string, collapsed = false): WatchlistEntry => ({ type: 'section', id, title, collapsed });
/** Visible rows in order: symbol ids, and section headers as `#Title`. */
const visible = () => Array.from(document.querySelectorAll<HTMLElement>('[data-symbol], [data-section]'))
  .map((el) => el.dataset['symbol'] ?? `#${el.closest('li')!.querySelector('.wl-section-title')!.textContent}`);
const header = (title: string) => screen.getByRole('button', { name: new RegExp(`^${title}`) });
const lastPut = () => put.mock.calls.at(-1)![0] as WatchlistEntry[];
const dt = () => ({ setData: vi.fn(), getData: vi.fn(), effectAllowed: '', dropEffect: '' });
function drag(from: HTMLElement, to: HTMLElement) {
  const d = dt();
  fireEvent.dragStart(from, { dataTransfer: d });
  fireEvent.dragOver(to, { dataTransfer: d });
  fireEvent.drop(to, { dataTransfer: d });
  fireEvent.dragEnd(from, { dataTransfer: d });
}

describe('Watchlist sections', () => {
  const LIST = (): WatchlistEntry[] => [
    sym('stock:SPY'), section(SEC_X, 'Tech'), sym('stock:AAPL'), sym('stock:MSFT'), section(SEC_Y, 'Crypto'), sym('crypto:BTC'),
  ];

  it('renders section headers as headings with a toggle; quotes and sparklines exclude headers', async () => {
    setup(LIST());
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('BTC');
    expect(visible()).toEqual(['stock:SPY', '#Tech', 'stock:AAPL', 'stock:MSFT', '#Crypto', 'crypto:BTC']);
    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings.map((x) => x.textContent)).toEqual([expect.stringContaining('Tech'), expect.stringContaining('Crypto')]);
    expect(within(headings[0]!).getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(quotes).toHaveBeenCalled());
    const requested = (quotes.mock.calls[0]![0] as string[]).slice().sort();
    expect(requested).toEqual(['crypto:BTC', 'stock:AAPL', 'stock:MSFT', 'stock:SPY']);
    expect((vi.mocked(api.sparklines).mock.calls[0]![0]).slice().sort()).toEqual(requested);
    expect(vi.mocked(api.symbol).mock.calls.map((c) => c[0]).sort()).toEqual(requested);
  });

  it('"+ Section" adds a section at the end in rename mode; Enter saves the title', async () => {
    setup(['stock:AAPL']);
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('AAPL');
    await userEvent.click(screen.getByRole('button', { name: 'Add section' }));
    const input = screen.getByRole('textbox', { name: 'Section title' });
    expect(input).toHaveFocus();
    expect(input).toHaveValue('New section');
    expect(input).toHaveAttribute('maxlength', '40');
    await userEvent.clear(input);
    await userEvent.type(input, '  Energy {Enter}');
    expect(screen.queryByRole('textbox', { name: 'Section title' })).not.toBeInTheDocument();
    expect(visible()).toEqual(['stock:AAPL', '#Energy']);
    expect(header('Energy')).toHaveFocus();
    await waitFor(() => expect(put).toHaveBeenCalled(), { timeout: 2000 });
    const saved = lastPut();
    expect(saved[0]).toEqual(sym('stock:AAPL'));
    expect(saved[1]).toMatchObject({ type: 'section', title: 'Energy', collapsed: false });
    expect((saved[1] as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('double-click renames inline: Escape cancels, empty reverts, Enter saves', async () => {
    setup(LIST());
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('BTC');
    const title = () => screen.getAllByText('Tech').find((el) => el.classList.contains('wl-section-title'))!;
    await userEvent.dblClick(title());
    let input = screen.getByRole('textbox', { name: 'Section title' });
    expect(input).toHaveValue('Tech');
    await userEvent.type(input, 'nology{Escape}');
    expect(visible()).toContain('#Tech');
    await userEvent.dblClick(title());
    input = screen.getByRole('textbox', { name: 'Section title' });
    await userEvent.clear(input);
    await userEvent.type(input, '   {Enter}');
    expect(visible()).toContain('#Tech');
    await userEvent.dblClick(title());
    input = screen.getByRole('textbox', { name: 'Section title' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Semis{Enter}');
    expect(visible()).toEqual(['stock:SPY', '#Semis', 'stock:AAPL', 'stock:MSFT', '#Crypto', 'crypto:BTC']);
    // Double-clicking the title does not leave the section toggled.
    expect(header('Semis')).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(put).toHaveBeenCalled(), { timeout: 2000 });
    expect(lastPut()[1]).toEqual(section(SEC_X, 'Semis'));
  });

  it('double-clicking the title renames without toggling the section (no flicker, no save)', async () => {
    setup(LIST());
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('BTC');
    const toggle = header('Tech');
    const changes: string[] = [];
    const observer = new MutationObserver(() => changes.push(toggle.getAttribute('aria-expanded')!));
    observer.observe(toggle, { attributes: true, attributeFilter: ['aria-expanded'] });
    const title = screen.getAllByText('Tech').find((el) => el.classList.contains('wl-section-title'))!;
    await userEvent.dblClick(title);
    observer.disconnect();
    expect(changes).toEqual([]);
    await userEvent.keyboard('{Escape}');
    expect(header('Tech')).toHaveAttribute('aria-expanded', 'true');
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
    expect(put).not.toHaveBeenCalled();
  });

  it('actions menu: Rename, Add section above, Delete section (symbols move to the previous section)', async () => {
    setup(LIST());
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('BTC');
    await userEvent.click(screen.getByRole('button', { name: 'Section actions: Crypto' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Rename', 'Add section above', 'Delete section']);
    expect(within(menu).getByRole('menuitem', { name: /Delete section/ })).toHaveAccessibleDescription(/previous section/);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Add section above' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Section title' }), '{Enter}');
    expect(visible()).toEqual(['stock:SPY', '#Tech', 'stock:AAPL', 'stock:MSFT', '#New section', '#Crypto', 'crypto:BTC']);

    await userEvent.click(screen.getByRole('button', { name: 'Section actions: Tech' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Delete section/ }));
    expect(visible()).toEqual(['stock:SPY', 'stock:AAPL', 'stock:MSFT', '#New section', '#Crypto', 'crypto:BTC']);

    await userEvent.click(screen.getByRole('button', { name: 'Section actions: Crypto' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Section title' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Coins{Enter}');
    expect(visible()).toContain('#Coins');
    await waitFor(() => expect(lastPut().filter((e) => e.type === 'section').map((e) => (e as { title: string }).title))
      .toEqual(['New section', 'Coins']), { timeout: 2000 });
    expect(lastPut().filter((e) => e.type === 'symbol')).toHaveLength(4);
  });

  it('Escape closes the actions menu', async () => {
    setup(LIST());
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('BTC');
    await userEvent.click(screen.getByRole('button', { name: 'Section actions: Tech' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('collapse hides the section symbols, shows their count and persists', async () => {
    setup(LIST());
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('BTC');
    await userEvent.click(header('Tech'));
    expect(header('Tech')).toHaveAttribute('aria-expanded', 'false');
    expect(header('Tech')).toHaveAccessibleName('Tech 2 symbols');
    expect(visible()).toEqual(['stock:SPY', '#Tech', '#Crypto', 'crypto:BTC']);
    await waitFor(() => expect(put).toHaveBeenCalled(), { timeout: 2000 });
    expect(lastPut()[1]).toEqual(section(SEC_X, 'Tech', true));
    await userEvent.click(header('Tech'));
    expect(visible()).toHaveLength(6);
  });

  it('a collapsed section loads collapsed; its symbols are still quoted', async () => {
    setup([section(SEC_X, 'Tech', true), sym('stock:AAPL'), sym('stock:MSFT')]);
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await waitFor(() => expect(visible()).toEqual(['#Tech']));
    await waitFor(() => expect(quotes).toHaveBeenCalledWith(expect.arrayContaining(['stock:AAPL', 'stock:MSFT'])));
  });

  it('adds a symbol to the end of the active section (last clicked header or symbol), else to the end', async () => {
    setup(LIST());
    vi.mocked(api.search).mockResolvedValue([INFO['crypto:ETH']!, INFO['basket:1']!]);
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('BTC');
    const box = screen.getByRole('combobox');
    // No active section yet → end of the list.
    await userEvent.type(box, 'e');
    await userEvent.click(await screen.findByRole('option', { name: /Ethereum/ }));
    expect(visible().at(-1)).toBe('crypto:ETH');
    // Clicking a symbol in "Tech" makes Tech active.
    await userEvent.click(screen.getByText('AAPL'));
    await userEvent.type(box, 'b');
    await userEvent.click(await screen.findByRole('option', { name: /My Basket/ }));
    expect(visible()).toEqual(['stock:SPY', '#Tech', 'stock:AAPL', 'stock:MSFT', 'basket:1', '#Crypto', 'crypto:BTC', 'crypto:ETH']);
  });

  it('a clicked header becomes the active section; a top-group symbol clears it', async () => {
    setup(LIST());
    vi.mocked(api.search).mockResolvedValue([INFO['crypto:ETH']!, INFO['basket:1']!]);
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('BTC');
    await userEvent.click(header('Tech'));
    await userEvent.click(header('Tech')); // collapse + expand again: Tech is active
    const box = screen.getByRole('combobox');
    await userEvent.type(box, 'e');
    await userEvent.click(await screen.findByRole('option', { name: /Ethereum/ }));
    expect(visible()).toEqual(['stock:SPY', '#Tech', 'stock:AAPL', 'stock:MSFT', 'crypto:ETH', '#Crypto', 'crypto:BTC']);
    await userEvent.click(screen.getByText('SPY'));
    await userEvent.type(box, 'b');
    await userEvent.click(await screen.findByRole('option', { name: /My Basket/ }));
    expect(visible().at(-1)).toBe('basket:1');
  });

  it('Alt+Arrow moves symbols across sections and header rows, keeping focus', async () => {
    setup(LIST());
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('BTC');
    const aapl = () => document.querySelector<HTMLElement>('[data-symbol="stock:AAPL"]')!;
    aapl().focus();
    fireEvent.keyDown(aapl(), { key: 'ArrowUp', altKey: true });
    expect(visible()).toEqual(['stock:SPY', 'stock:AAPL', '#Tech', 'stock:MSFT', '#Crypto', 'crypto:BTC']);
    expect(aapl()).toHaveFocus();
    const crypto = header('Crypto');
    crypto.focus();
    fireEvent.keyDown(crypto, { key: 'ArrowUp', altKey: true });
    expect(visible()).toEqual(['stock:SPY', 'stock:AAPL', '#Tech', '#Crypto', 'stock:MSFT', 'crypto:BTC']);
    expect(header('Crypto')).toHaveFocus();
    fireEvent.keyDown(header('Crypto'), { key: 'ArrowDown', altKey: true });
    expect(visible()).toEqual(['stock:SPY', 'stock:AAPL', '#Tech', 'stock:MSFT', '#Crypto', 'crypto:BTC']);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(lastPut()).toEqual([sym('stock:SPY'), sym('stock:AAPL'), section(SEC_X, 'Tech'), sym('stock:MSFT'), section(SEC_Y, 'Crypto'), sym('crypto:BTC')]);
  });

  it('Alt+Arrow into a collapsed section expands it so the moved row stays visible and focused', async () => {
    setup([sym('stock:SPY'), section(SEC_X, 'Tech', true), sym('stock:AAPL')]);
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('SPY');
    const spy = () => document.querySelector<HTMLElement>('[data-symbol="stock:SPY"]')!;
    spy().focus();
    fireEvent.keyDown(spy(), { key: 'ArrowDown', altKey: true });
    expect(visible()).toEqual(['#Tech', 'stock:SPY', 'stock:AAPL']);
    expect(spy()).toHaveFocus();
  });

  it('drag and drop moves symbols and headers across sections', async () => {
    setup(LIST());
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('BTC');
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-symbol="${id}"]`)!;
    drag(row('crypto:BTC'), row('stock:AAPL'));
    expect(visible()).toEqual(['stock:SPY', '#Tech', 'crypto:BTC', 'stock:AAPL', 'stock:MSFT', '#Crypto']);
    drag(header('Crypto'), row('stock:AAPL'));
    expect(visible()).toEqual(['stock:SPY', '#Tech', 'crypto:BTC', '#Crypto', 'stock:AAPL', 'stock:MSFT']);
    await waitFor(() => expect(put).toHaveBeenCalled(), { timeout: 2000 });
    expect(lastPut().map((e) => e.id)).toEqual(['stock:SPY', SEC_X, 'crypto:BTC', SEC_Y, 'stock:AAPL', 'stock:MSFT']);
  });

  it('dropping a symbol onto a collapsed header appends it into that section', async () => {
    setup([sym('stock:SPY'), section(SEC_X, 'Tech', true), sym('stock:AAPL'), section(SEC_Y, 'Crypto'), sym('crypto:BTC')]);
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('BTC');
    drag(document.querySelector<HTMLElement>('[data-symbol="crypto:BTC"]')!, header('Tech'));
    expect(visible()).toEqual(['stock:SPY', '#Tech', '#Crypto']);
    expect(header('Tech')).toHaveAccessibleName('Tech 2 symbols');
    await waitFor(() => expect(put).toHaveBeenCalled(), { timeout: 2000 });
    expect(lastPut().map((e) => e.id)).toEqual(['stock:SPY', SEC_X, 'stock:AAPL', 'crypto:BTC', SEC_Y]);
  });

  it('"+ Section" is disabled at the 50-section limit', async () => {
    setup(Array.from({ length: 50 }, (_, i) => section(`${String(i).padStart(8, '0')}-3f1a-4c1e-9a7b-2a1d3c4e5f60`, `S${i}`)));
    render(<Watchlist currentSymbol="stock:AAPL" onSelect={() => {}} />);
    await screen.findByText('S49');
    expect(screen.getByRole('button', { name: 'Add section' })).toBeDisabled();
  });
});
