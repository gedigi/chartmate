import type { Bar, Basket, BarsResponse, SymbolInfo } from '@chartmate/shared';
import { maxEffectiveDate } from '@chartmate/shared';
import type { BarsParams } from '../src/api/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api/client';
import { BasketEditor } from '../src/components/BasketEditor';
import { PREVIEW_HISTORY_MS } from '../src/components/BasketPreview';

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      search: vi.fn(),
      bars: vi.fn(),
      baskets: { ...actual.api.baskets, create: vi.fn(), update: vi.fn(), appendVersion: vi.fn() },
    },
  };
});

const DAY = 86_400_000;
const SYMBOLS: SymbolInfo[] = [
  { id: 'stock:AAPL', assetClass: 'stock', ticker: 'AAPL', name: 'Apple', pricePrecision: 2 },
  { id: 'crypto:BTC', assetClass: 'crypto', ticker: 'BTC', name: 'Bitcoin', pricePrecision: 2 },
];

function dailyBars(p: BarsParams): BarsResponse {
  const bars: Bar[] = [];
  const start = Math.max(p.from, Date.UTC(2020, 0, 1));
  for (let t = Math.ceil(start / DAY) * DAY; t < p.to; t += DAY) {
    const c = p.symbol === 'stock:AAPL' ? 100 + (t - Date.UTC(2020, 0, 1)) / DAY / 10 : 50_000;
    bars.push({ ts: t, open: c, high: c, low: c, close: c, volume: 1 });
  }
  return { symbol: p.symbol, tf: '1D', session: 'rth', bars, hasMoreBefore: false, stale: false, notices: [], markers: [] };
}

beforeEach(() => {
  vi.mocked(api.search).mockImplementation(async (q) => SYMBOLS.filter((s) => s.ticker.toLowerCase().startsWith(q.toLowerCase())));
  vi.mocked(api.bars).mockImplementation(async (p) => dailyBars(p));
});
afterEach(() => { restoreRealTimers(); vi.clearAllMocks(); });

type User = ReturnType<typeof userEvent.setup>;
/** How a test drives the form: real timers, or fake timers advanced explicitly after each search. */
interface Driver { user: User; settle: () => Promise<void> }
const realTimers = (): Driver => ({ user: userEvent.setup(), settle: async () => {} });
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
const fakeTimers = (): Driver => ({ user: userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) }), settle: () => advance(250) });

/**
 * Testing Library's async wrapper (used by user-event) drains with setTimeout(0) and only advances it for *Jest*
 * fake timers; expose a minimal `jest` shim so it advances Vitest's fake clock instead of hanging.
 */
function useFakeTimersWithTestingLibrary() {
  vi.useFakeTimers();
  (globalThis as { jest?: unknown }).jest = { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) };
}
function restoreRealTimers() {
  delete (globalThis as { jest?: unknown }).jest;
  vi.useRealTimers();
}

async function pickSymbol(d: Driver, rowIndex: number, query: string) {
  const row = screen.getAllByTestId('weight-row')[rowIndex]!;
  await d.user.type(within(row).getByRole('combobox'), query);
  await d.settle();
  const option = await screen.findByRole('option');
  await d.user.click(option);
}

async function fillCreateForm(d: Driver = realTimers()) {
  await d.user.type(screen.getByLabelText('Name'), 'Tech + BTC');
  await pickSymbol(d, 0, 'AAPL');
  await d.user.type(screen.getByRole('spinbutton', { name: 'Weight for AAPL' }), '60');
  await d.user.click(screen.getByRole('button', { name: 'Add constituent' }));
  await pickSymbol(d, 1, 'BTC');
  await d.user.type(screen.getByRole('spinbutton', { name: 'Weight for BTC' }), '40');
  fireEvent.change(screen.getByLabelText('Start date (UTC)'), { target: { value: '2024-01-02' } });
}

const BASKET: Basket = {
  id: 'b1',
  name: 'Tech + BTC',
  baseValue: 100,
  createdAt: 0,
  updatedAt: 0,
  versions: [
    { effectiveFrom: '2024-01-02', weights: { 'stock:AAPL': 0.5, 'crypto:BTC': 0.5 } },
    { effectiveFrom: '2024-06-03', weights: { 'stock:AAPL': 0.7, 'crypto:BTC': 0.3 } },
  ],
};

describe('BasketEditor — create', () => {
  it('submits % weights as fractions with the chosen start date', async () => {
    const created: Basket = { ...BASKET, versions: [BASKET.versions[0]!] };
    vi.mocked(api.baskets.create).mockResolvedValue(created);
    const onSaved = vi.fn();
    render(<BasketEditor onSaved={onSaved} onCancel={() => {}} />);
    await fillCreateForm();
    await userEvent.click(screen.getByRole('button', { name: 'Create basket' }));
    expect(api.baskets.create).toHaveBeenCalledWith({
      name: 'Tech + BTC',
      versions: [{ effectiveFrom: '2024-01-02', weights: { 'stock:AAPL': 0.6, 'crypto:BTC': 0.4 } }],
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(created));
  });

  it('shows the server error message inline', async () => {
    vi.mocked(api.baskets.create).mockRejectedValue(new ApiError(400, 'invalid_basket', 'No data for stock:AAPL'));
    const onSaved = vi.fn();
    render(<BasketEditor onSaved={onSaved} onCancel={() => {}} />);
    await fillCreateForm();
    await userEvent.click(screen.getByRole('button', { name: 'Create basket' }));
    expect(await screen.findByText('No data for stock:AAPL')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('bounds the start date to 1970-01-01 … tomorrow (UTC) and rejects pre-1970 dates before any preview fetch', async () => {
    const bars = vi.mocked(api.bars);
    render(<BasketEditor onSaved={() => {}} onCancel={() => {}} />);
    const date = screen.getByLabelText('Start date (UTC)');
    expect(date).toHaveAttribute('min', '1970-01-01');
    expect(date).toHaveAttribute('max', maxEffectiveDate());
    await fillCreateForm();
    bars.mockClear();
    fireEvent.change(date, { target: { value: '1969-12-31' } });
    expect(screen.getByText(`Start date must be between 1970-01-01 and ${maxEffectiveDate()}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create basket' })).toBeDisabled();
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(bars).not.toHaveBeenCalled();
  });

  it('does not submit while the weights are invalid or the name is empty', async () => {
    render(<BasketEditor onSaved={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: 'Create basket' })).toBeDisabled();
    await fillCreateForm();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Weight for BTC' }), { target: { value: '30' } });
    expect(screen.getByRole('button', { name: 'Create basket' })).toBeDisabled();
  });

  it('renders a client-side preview from 1D constituent bars', async () => {
    useFakeTimersWithTestingLibrary();
    try {
      render(<BasketEditor onSaved={() => {}} onCancel={() => {}} />);
      await fillCreateForm(fakeTimers());
      vi.mocked(api.bars).mockClear(); // earlier partial forms may have previewed; check the final one
      await advance(599);
      expect(api.bars).not.toHaveBeenCalled();
      await advance(1);
    } finally {
      restoreRealTimers();
    }
    const preview = screen.getByTestId('basket-preview-chart');
    expect(preview.querySelector('polyline')).not.toBeNull();
    const calls = vi.mocked(api.bars).mock.calls.map((c) => c[0]);
    expect(calls.every((p) => p.tf === '1D' && p.session === 'rth')).toBe(true);
    expect(calls.some((p) => p.symbol === 'stock:AAPL' && p.from === Date.UTC(2024, 0, 2) - PREVIEW_HISTORY_MS)).toBe(true);
    expect(screen.getByTestId('basket-preview')).toHaveTextContent('2024-01-02');
  });
});

describe('BasketEditor — edit', () => {
  it('lists versions newest first with a weights summary', () => {
    render(<BasketEditor basket={BASKET} onSaved={() => {}} onCancel={() => {}} />);
    const items = within(screen.getByRole('list', { name: 'Version history' })).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('2024-06-03');
    expect(items[0]).toHaveTextContent('AAPL 70%');
    expect(items[0]).toHaveTextContent('BTC 30%');
    expect(items[1]).toHaveTextContent('2024-01-02');
    expect(items[1]).toHaveTextContent('AAPL 50%');
  });

  it('renames the basket', async () => {
    const renamed = { ...BASKET, name: 'Renamed' };
    vi.mocked(api.baskets.update).mockResolvedValue(renamed);
    const onSaved = vi.fn();
    render(<BasketEditor basket={BASKET} onSaved={onSaved} onCancel={() => {}} />);
    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(api.baskets.update).toHaveBeenCalledWith('b1', { name: 'Renamed' });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(renamed));
  });

  it('appends a version prefilled from the latest weights, validating the effective date', async () => {
    const updated: Basket = {
      ...BASKET,
      versions: [...BASKET.versions, { effectiveFrom: '2024-07-01', weights: { 'stock:AAPL': 0.8, 'crypto:BTC': 0.2 } }],
    };
    vi.mocked(api.baskets.appendVersion).mockResolvedValue(updated);
    const onSaved = vi.fn();
    render(<BasketEditor basket={BASKET} onSaved={onSaved} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Change weights' }));

    expect(screen.getByText('New weights take effect from the start of this date, sized at the prior close. The chart stays continuous.')).toBeInTheDocument();
    const aapl = screen.getByRole('spinbutton', { name: 'Weight for AAPL' });
    expect(aapl).toHaveValue(70);
    expect(screen.getByRole('spinbutton', { name: 'Weight for BTC' })).toHaveValue(30);
    const date = screen.getByLabelText('Effective date (UTC)');
    expect(date).toHaveAttribute('min', '2024-06-04');

    fireEvent.change(aapl, { target: { value: '80' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Weight for BTC' }), { target: { value: '20' } });
    fireEvent.change(date, { target: { value: '2024-06-03' } });
    await userEvent.click(screen.getByRole('button', { name: 'Add version' }));
    expect(screen.getByText('Effective date must be after 2024-06-03')).toBeInTheDocument();
    expect(api.baskets.appendVersion).not.toHaveBeenCalled();

    fireEvent.change(date, { target: { value: '2024-07-01' } });
    await userEvent.click(screen.getByRole('button', { name: 'Add version' }));
    expect(api.baskets.appendVersion).toHaveBeenCalledWith('b1', {
      effectiveFrom: '2024-07-01',
      weights: { 'stock:AAPL': 0.8, 'crypto:BTC': 0.2 },
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated));
  });

  it('a single-version basket can move its start date (PUT versions), with the create bounds', async () => {
    const single: Basket = { ...BASKET, versions: [BASKET.versions[0]!] };
    const moved: Basket = { ...single, versions: [{ ...single.versions[0]!, effectiveFrom: '2023-06-01' }] };
    vi.mocked(api.baskets.update).mockResolvedValue(moved);
    const onSaved = vi.fn();
    render(<BasketEditor basket={single} onSaved={onSaved} onCancel={() => {}} />);
    const date = screen.getByLabelText('Start date (UTC)');
    expect(date).toHaveValue('2024-01-02');
    expect(date).toHaveAttribute('min', '1970-01-01');
    expect(date).toHaveAttribute('max', maxEffectiveDate());
    const button = screen.getByRole('button', { name: 'Change start date' });
    expect(button).toBeDisabled(); // unchanged
    fireEvent.change(date, { target: { value: '1969-12-31' } });
    expect(screen.getByText(/Start date must be between 1970-01-01/)).toBeInTheDocument();
    expect(button).toBeDisabled();
    fireEvent.change(date, { target: { value: '2023-06-01' } });
    await userEvent.click(button);
    expect(api.baskets.update).toHaveBeenCalledWith('b1', { versions: [{ effectiveFrom: '2023-06-01', weights: single.versions[0]!.weights }] });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(moved));
  });

  it('baskets with several versions cannot move their start date', () => {
    render(<BasketEditor basket={BASKET} onSaved={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Change start date' })).not.toBeInTheDocument();
  });

  it('the create form defaults the start date to today (UTC)', () => {
    render(<BasketEditor onSaved={() => {}} onCancel={() => {}} />);
    expect(screen.getByLabelText('Start date (UTC)')).toHaveValue(new Date().toISOString().slice(0, 10));
  });

  it('the create form explains when the basket starts', () => {
    render(<BasketEditor onSaved={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(
      'The basket starts at 100 on this date (00:00 UTC, or the New York session start on intraday charts of stock-only baskets), sized at the prior close.',
    )).toBeInTheDocument();
  });

  it('shows the server error when appending fails', async () => {
    vi.mocked(api.baskets.appendVersion).mockRejectedValue(new ApiError(400, 'invalid_basket', 'No data for crypto:BTC before 2024-07-01'));
    render(<BasketEditor basket={BASKET} onSaved={() => {}} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Change weights' }));
    fireEvent.change(screen.getByLabelText('Effective date (UTC)'), { target: { value: '2024-07-01' } });
    await userEvent.click(screen.getByRole('button', { name: 'Add version' }));
    expect(await screen.findByText('No data for crypto:BTC before 2024-07-01')).toBeInTheDocument();
  });
});
