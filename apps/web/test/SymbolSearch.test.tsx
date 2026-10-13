import type { SymbolInfo } from '@chartmate/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api/client';
import { SymbolSearch } from '../src/components/SymbolSearch';

const RESULTS: SymbolInfo[] = [
  { id: 'stock:AAPL', assetClass: 'stock', ticker: 'AAPL', name: 'Apple Inc.', exchange: 'NMS', pricePrecision: 2 },
  { id: 'crypto:AAVE', assetClass: 'crypto', ticker: 'AAVE', name: 'Aave', pricePrecision: 2 },
  { id: 'basket:123', assetClass: 'basket', ticker: 'AA basket', name: 'AA basket', pricePrecision: 2 },
];

afterEach(() => vi.restoreAllMocks());

describe('SymbolSearch', () => {
  it('debounces typing into a single search call and renders results with badges', async () => {
    const search = vi.spyOn(api, 'search').mockResolvedValue(RESULTS);
    render(<SymbolSearch onSelect={() => {}} />);
    await userEvent.type(screen.getByRole('combobox'), 'aapl');
    const options = await screen.findAllByRole('option');
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]![0]).toBe('aapl');
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveTextContent('AAPL');
    expect(options[0]).toHaveTextContent('Apple Inc.');
    expect(options[0]).toHaveTextContent('Stock');
    expect(options[1]).toHaveTextContent('Crypto');
    expect(options[2]).toHaveTextContent('Basket');
    // Sentence case, no all-caps labels.
    expect(options[0]).not.toHaveTextContent('STOCK');
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'true');
  });

  describe('Cmd/Ctrl+K shortcut', () => {
    const setPlatform = (p: string) => Object.defineProperty(navigator, 'platform', { value: p, configurable: true });
    afterEach(() => setPlatform(''));

    it('Apple platforms: ⌘K focuses the field from anywhere; Ctrl+K is left alone (e.g. a text field\'s own Ctrl+K)', () => {
      setPlatform('MacIntel');
      render(<SymbolSearch onSelect={() => {}} shortcut />);
      const input = screen.getByRole('combobox');
      expect(screen.getByText('⌘K')).toHaveAttribute('aria-hidden', 'true');
      fireEvent.keyDown(document.body, { key: 'K', ctrlKey: true });
      expect(input).not.toHaveFocus();
      fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
      expect(input).toHaveFocus();
    });

    it('other platforms: Ctrl+K; ⌘ does nothing', () => {
      setPlatform('Win32');
      render(<SymbolSearch onSelect={() => {}} shortcut />);
      const input = screen.getByRole('combobox');
      expect(screen.getByText('Ctrl K')).toBeInTheDocument();
      fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
      expect(input).not.toHaveFocus();
      fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
      expect(input).toHaveFocus();
    });

    it('does nothing behind a modal dialog, from inside a popup, when already handled, or without the prop', () => {
      setPlatform('Win32');
      const { unmount } = render(
        <>
          <SymbolSearch onSelect={() => {}} shortcut />
          <div role="menu"><button type="button">Item</button></div>
        </>,
      );
      const input = screen.getByRole('combobox');
      fireEvent.keyDown(screen.getByRole('button', { name: 'Item' }), { key: 'k', ctrlKey: true });
      expect(input).not.toHaveFocus();
      const handled = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
      handled.preventDefault();
      document.body.dispatchEvent(handled);
      expect(input).not.toHaveFocus();
      const modal = document.createElement('div');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      document.body.append(modal);
      fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
      expect(input).not.toHaveFocus();
      modal.remove();
      unmount();
      render(<SymbolSearch onSelect={() => {}} />);
      fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
      expect(screen.getByRole('combobox')).not.toHaveFocus();
    });
  });

  it('ArrowDown + Enter selects the highlighted result', async () => {
    vi.spyOn(api, 'search').mockResolvedValue(RESULTS);
    const onSelect = vi.fn();
    render(<SymbolSearch onSelect={onSelect} />);
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'aa');
    await screen.findAllByRole('option');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('crypto:AAVE');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('Escape closes the dropdown', async () => {
    vi.spyOn(api, 'search').mockResolvedValue(RESULTS);
    render(<SymbolSearch onSelect={() => {}} />);
    await userEvent.type(screen.getByRole('combobox'), 'aa');
    await screen.findAllByRole('option');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows an inline error when the search fails', async () => {
    vi.spyOn(api, 'search').mockRejectedValue(new ApiError(503, 'provider_unavailable', 'Search provider down'));
    render(<SymbolSearch onSelect={() => {}} />);
    await userEvent.type(screen.getByRole('combobox'), 'aa');
    expect(await screen.findByRole('alert')).toHaveTextContent('Search provider down');
  });

  it('shows a "No results" state', async () => {
    vi.spyOn(api, 'search').mockResolvedValue([]);
    render(<SymbolSearch onSelect={() => {}} />);
    await userEvent.type(screen.getByRole('combobox'), 'zzz');
    expect(await screen.findByText('No results')).toBeInTheDocument();
  });

  it('aborts the stale request when the query changes', async () => {
    const signals: AbortSignal[] = [];
    vi.spyOn(api, 'search').mockImplementation((q, signal) => {
      if (signal) signals.push(signal);
      return new Promise((resolve) => setTimeout(() => resolve(q === 'ab' ? RESULTS : []), 300));
    });
    render(<SymbolSearch onSelect={() => {}} />);
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'a');
    await waitFor(() => expect(signals).toHaveLength(1));
    await userEvent.type(input, 'b');
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]!.aborted).toBe(true);
    expect(await screen.findAllByRole('option')).toHaveLength(3);
  });

  it('sets aria-controls only while the listbox is rendered', async () => {
    vi.spyOn(api, 'search').mockResolvedValue(RESULTS);
    render(<SymbolSearch onSelect={() => {}} />);
    const input = screen.getByRole('combobox');
    expect(input).not.toHaveAttribute('aria-controls');
    await userEvent.type(input, 'aa');
    const listbox = await screen.findByRole('listbox');
    expect(input).toHaveAttribute('aria-controls', listbox.id);
    await userEvent.keyboard('{Escape}');
    expect(input).not.toHaveAttribute('aria-controls');
  });

  it('Enter with results and nothing highlighted selects the first result', async () => {
    vi.spyOn(api, 'search').mockResolvedValue(RESULTS);
    const onSelect = vi.fn();
    render(<SymbolSearch onSelect={onSelect} />);
    await userEvent.type(screen.getByRole('combobox'), 'aa');
    await screen.findAllByRole('option');
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('stock:AAPL');
  });

  it('Enter does not auto-pick a stale first result while the typed query has not been searched yet', async () => {
    let resolveSecond!: (v: SymbolInfo[]) => void;
    vi.spyOn(api, 'search')
      .mockResolvedValueOnce(RESULTS)
      .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));
    const onSelect = vi.fn();
    render(<SymbolSearch onSelect={onSelect} />);
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'aa');
    await screen.findAllByRole('option');
    await userEvent.type(input, 'v');
    await userEvent.keyboard('{Enter}'); // within the debounce: results are for "aa"
    expect(onSelect).not.toHaveBeenCalled();
    await waitFor(() => expect(api.search).toHaveBeenCalledTimes(2));
    await userEvent.keyboard('{Enter}'); // loading
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => { resolveSecond([RESULTS[1]!]); });
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('crypto:AAVE');
  });

  it('sets aria-activedescendant only while the listbox is rendered', async () => {
    vi.spyOn(api, 'search').mockResolvedValueOnce(RESULTS).mockResolvedValueOnce([]);
    render(<SymbolSearch onSelect={() => {}} />);
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'aa');
    await screen.findAllByRole('option');
    await userEvent.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant');
    await userEvent.type(input, 'zzz');
    await screen.findByText('No results');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });

  it('re-focusing before the blur timeout keeps the dropdown open', async () => {
    vi.spyOn(api, 'search').mockResolvedValue(RESULTS);
    render(<SymbolSearch onSelect={() => {}} />);
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'aa');
    await screen.findAllByRole('option');
    vi.useFakeTimers();
    try {
      fireEvent.blur(input);
      act(() => { vi.advanceTimersByTime(50); });
      fireEvent.focus(input);
      act(() => { vi.advanceTimersByTime(500); });
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps previous results visible (with a loading indicator) while a new search is in flight', async () => {
    let resolveSecond!: (v: SymbolInfo[]) => void;
    vi.spyOn(api, 'search')
      .mockResolvedValueOnce(RESULTS)
      .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));
    render(<SymbolSearch onSelect={() => {}} />);
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'aa');
    expect(await screen.findAllByRole('option')).toHaveLength(3);
    await userEvent.type(input, 'p');
    await waitFor(() => expect(api.search).toHaveBeenCalledTimes(2));
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Searching…')).toBeInTheDocument();
    await act(async () => { resolveSecond([RESULTS[0]!]); await Promise.resolve(); });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.queryByText('Searching…')).not.toBeInTheDocument();
  });
});
