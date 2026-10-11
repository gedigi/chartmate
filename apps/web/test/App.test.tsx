import type { Layout } from '@altv/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { App } from '../src/App';

beforeEach(() => {
  window.location.hash = '';
  vi.spyOn(api.layouts, 'get').mockResolvedValue(null);
  vi.spyOn(api.layouts, 'put').mockResolvedValue(undefined);
  vi.spyOn(api, 'symbol').mockImplementation(async (id) => ({
    id, assetClass: id.startsWith('stock:') ? 'stock' : 'crypto', ticker: id.split(':')[1]!, name: `${id} name`, pricePrecision: 2,
  }));
});
afterEach(() => vi.restoreAllMocks());

describe('App', () => {
  it('renders Login when auth is required and the session is not authenticated', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ authRequired: true, authenticated: false });
    render(<App />);
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByTestId('chart-view')).not.toBeInTheDocument();
  });

  it('logs in and reloads the session', async () => {
    const session = vi.spyOn(api, 'session')
      .mockResolvedValueOnce({ authRequired: true, authenticated: false })
      .mockResolvedValueOnce({ authRequired: true, authenticated: true });
    const login = vi.spyOn(api, 'login').mockResolvedValue(undefined);
    render(<App />);
    await userEvent.type(await screen.findByLabelText('Password'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(login).toHaveBeenCalledWith('secret');
    expect(await screen.findByTestId('chart-view')).toBeInTheDocument();
    expect(session).toHaveBeenCalledTimes(2);
  });

  it('renders the chart shell when no auth is required, loading the saved default layout', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ authRequired: false, authenticated: true });
    const saved: Layout = { symbol: 'stock:AAPL', tf: '1h', session: 'eth', chartType: 'line', indicators: [] };
    vi.mocked(api.layouts.get).mockImplementation(async (key) => (key === 'default' ? saved : null));
    render(<App />);
    expect(await screen.findByTestId('chart-view')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '1h' })).toHaveAttribute('aria-pressed', 'true'));
    expect(await screen.findByText('stock:AAPL name')).toBeInTheDocument();
    // AAPL is a stock → session toggle visible.
    expect(screen.getByRole('button', { name: 'ETH' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('hides the session toggle for crypto and switches to the baskets view via tabs and hash', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ authRequired: false, authenticated: true });
    render(<App />);
    await screen.findByTestId('chart-view');
    await screen.findByText('crypto:BTC name');
    expect(screen.queryByRole('button', { name: 'RTH' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Baskets' }));
    expect(screen.getByTestId('baskets-page')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/baskets');
  });

  it('disables the top-bar chart controls until the default layout has loaded', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ authRequired: false, authenticated: true });
    let resolveDefault!: (l: Layout | null) => void;
    vi.mocked(api.layouts.get).mockImplementation((key) =>
      key === 'default' ? new Promise((r) => { resolveDefault = r; }) : Promise.resolve(null));
    render(<App />);
    const bar = await screen.findByRole('banner');
    expect(within(bar).getByRole('combobox', { name: 'Search symbol' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '1h' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Chart type' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Indicators' })).toBeDisabled();
    resolveDefault({ symbol: 'stock:AAPL', tf: '1h', session: 'rth', chartType: 'candle', indicators: [] });
    await waitFor(() => expect(within(bar).getByRole('combobox', { name: 'Search symbol' })).toBeEnabled());
    expect(screen.getByRole('button', { name: '1h' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'RTH' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Chart type' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Indicators' })).toBeEnabled();
  });
});
