import type { Basket } from '@altv/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api/client';
import { BasketsPage } from '../src/components/BasketsPage';

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      quotes: vi.fn(),
      bars: vi.fn(),
      search: vi.fn(),
      baskets: { ...actual.api.baskets, list: vi.fn(), remove: vi.fn(), create: vi.fn(), appendVersion: vi.fn(), update: vi.fn() },
    },
  };
});

const BASKETS: Basket[] = [
  {
    id: 'b1', name: 'Tech + BTC', baseValue: 100, createdAt: 0, updatedAt: 0,
    versions: [
      { effectiveFrom: '2024-01-02', weights: { 'stock:AAPL': 0.5, 'crypto:BTC': 0.5 } },
      { effectiveFrom: '2024-06-03', weights: { 'stock:AAPL': 0.4, 'stock:MSFT': 0.3, 'crypto:BTC': 0.3 } },
    ],
  },
  {
    id: 'b2', name: 'Crypto pair', baseValue: 100, createdAt: 0, updatedAt: 0,
    versions: [{ effectiveFrom: '2024-03-01', weights: { 'crypto:BTC': 0.5, 'crypto:ETH': 0.5 } }],
  },
];

beforeEach(() => {
  vi.mocked(api.baskets.list).mockResolvedValue(BASKETS);
  vi.mocked(api.quotes).mockResolvedValue([
    { id: 'basket:b1', price: 123.456, changePct: 1.5, ts: 0 },
    { id: 'basket:b2', price: 87.1, changePct: -2.25, ts: 0 },
  ]);
  vi.mocked(api.bars).mockRejectedValue(new ApiError(503, 'data_unavailable', 'offline'));
});
afterEach(() => vi.restoreAllMocks());

const rowFor = async (name: string) => (await screen.findByText(name)).closest('[data-testid="basket-row"]') as HTMLElement;

describe('BasketsPage', () => {
  it('lists baskets with constituent count, version count and current value', async () => {
    render(<BasketsPage onOpenChart={() => {}} />);
    const r1 = await rowFor('Tech + BTC');
    expect(r1).toHaveTextContent('3 constituents');
    expect(r1).toHaveTextContent('2 versions');
    await waitFor(() => expect(r1).toHaveTextContent('123.46'));
    expect(r1).toHaveTextContent('+1.50%');
    const r2 = await rowFor('Crypto pair');
    expect(r2).toHaveTextContent('2 constituents');
    expect(r2).toHaveTextContent('1 version');
    expect(r2).toHaveTextContent('-2.25%');
    expect(api.quotes).toHaveBeenCalledWith(['basket:b1', 'basket:b2']);
  });

  it('"Open chart" opens basket:<id>', async () => {
    const onOpen = vi.fn();
    render(<BasketsPage onOpenChart={onOpen} />);
    const r1 = await rowFor('Tech + BTC');
    await userEvent.click(within(r1).getByRole('button', { name: 'Open chart' }));
    expect(onOpen).toHaveBeenCalledWith('basket:b1');
  });

  it('deletes after confirmation only', async () => {
    vi.mocked(api.baskets.remove).mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<BasketsPage onOpenChart={() => {}} />);
    const r2 = await rowFor('Crypto pair');
    await userEvent.click(within(r2).getByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(api.baskets.remove).not.toHaveBeenCalled();
    await userEvent.click(within(r2).getByRole('button', { name: 'Delete' }));
    expect(api.baskets.remove).toHaveBeenCalledWith('b2');
    await waitFor(() => expect(screen.queryByText('Crypto pair')).not.toBeInTheDocument());
  });

  it('opens the editor for edit and create', async () => {
    render(<BasketsPage onOpenChart={() => {}} />);
    const r1 = await rowFor('Tech + BTC');
    await userEvent.click(within(r1).getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('list', { name: 'Version history' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back to baskets' }));
    await userEvent.click(await screen.findByRole('button', { name: 'New basket' }));
    expect(screen.getByRole('button', { name: 'Create basket' })).toBeInTheDocument();
  });

  it('shows an empty state and a load error', async () => {
    vi.mocked(api.baskets.list).mockResolvedValueOnce([]);
    const { unmount } = render(<BasketsPage onOpenChart={() => {}} />);
    expect(await screen.findByText(/No baskets yet/)).toBeInTheDocument();
    unmount();
    vi.mocked(api.baskets.list).mockRejectedValueOnce(new ApiError(503, 'data_unavailable', 'DB down'));
    render(<BasketsPage onOpenChart={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('DB down');
  });
});
