import type { SymbolInfo } from '@altv/shared';
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
    expect(options[0]).toHaveTextContent('STOCK');
    expect(options[1]).toHaveTextContent('CRYPTO');
    expect(options[2]).toHaveTextContent('BASKET');
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'true');
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
