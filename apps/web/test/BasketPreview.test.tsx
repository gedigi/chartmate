import type { Bar, BarsResponse } from '@altv/shared';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type BarsParams } from '../src/api/client';
import { BasketPreview, fetchDailyRange } from '../src/components/BasketPreview';

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  return { ...actual, api: { ...actual.api, bars: vi.fn() } };
});

const DAY = 86_400_000;

function respond(p: BarsParams, firstTs = Date.UTC(2000, 0, 1)): BarsResponse {
  const bars: Bar[] = [];
  for (let t = Math.max(Math.ceil(p.from / DAY) * DAY, firstTs); t < p.to; t += DAY) {
    const c = p.symbol === 'stock:AAPL' ? 100 + (t / DAY) % 7 : 200;
    bars.push({ ts: t, open: c, high: c, low: c, close: c, volume: 0 });
  }
  return { symbol: p.symbol, tf: '1D', session: 'rth', bars, hasMoreBefore: false, stale: false, notices: [], markers: [] };
}

beforeEach(() => { vi.mocked(api.bars).mockImplementation(async (p) => respond(p)); });
afterEach(() => vi.clearAllMocks());

describe('fetchDailyRange', () => {
  it('splits spans longer than the server cap into chunks and concatenates them', async () => {
    const from = Date.UTC(2010, 0, 1);
    const to = Date.UTC(2026, 0, 1);
    const bars = await fetchDailyRange('stock:AAPL', from, to);
    const calls = vi.mocked(api.bars).mock.calls.map((c) => c[0]);
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c.to - c.from).toBeLessThanOrEqual(4000 * DAY);
    expect(calls[0]!.from).toBe(from);
    expect(calls.at(-1)!.to).toBe(to);
    expect(bars).toHaveLength((to - from) / DAY);
    for (let i = 1; i < bars.length; i++) expect(bars[i]!.ts).toBeGreaterThan(bars[i - 1]!.ts);
  });
});

describe('BasketPreview', () => {
  it('draws the basket line with notices', async () => {
    vi.mocked(api.bars).mockImplementation(async (p) => respond(p, p.symbol === 'crypto:ETH' ? Date.UTC(2024, 1, 1) : 0));
    render(<BasketPreview versions={[{ effectiveFrom: '2024-01-02', weights: { 'stock:AAPL': 0.5, 'crypto:ETH': 0.5 } }]} baseValue={100} />);
    const chart = await screen.findByTestId('basket-preview-chart', {}, { timeout: 3000 });
    expect(chart.querySelector('polyline')).not.toBeNull();
    expect(screen.getByTestId('basket-preview')).toHaveTextContent('Basket starts 2024-02-02: crypto:ETH has no data before that date.');
  });

  it('shows engine errors instead of the chart', async () => {
    vi.mocked(api.bars).mockImplementation(async (p) => ({ ...respond(p), bars: p.symbol === 'crypto:ETH' ? [] : respond(p).bars }));
    render(<BasketPreview versions={[{ effectiveFrom: '2024-01-02', weights: { 'stock:AAPL': 0.5, 'crypto:ETH': 0.5 } }]} baseValue={100} />);
    await waitFor(() => expect(screen.getByTestId('basket-preview')).toHaveTextContent('No data for crypto:ETH'), { timeout: 3000 });
    expect(screen.queryByTestId('basket-preview-chart')).not.toBeInTheDocument();
  });

  it('prompts for valid weights when there is nothing to preview', () => {
    render(<BasketPreview versions={null} baseValue={100} />);
    expect(screen.getByTestId('basket-preview')).toHaveTextContent('Enter a valid basket to see a preview');
    expect(api.bars).not.toHaveBeenCalled();
  });
});
