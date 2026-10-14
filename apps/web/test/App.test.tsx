import type { Basket, Layout } from '@chartmate/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api/client';
import { notifyBasketChanged } from '../src/state/useBaskets';
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
    expect(await within(await screen.findByRole('banner')).findByText('stock:AAPL name')).toBeInTheDocument();
    // AAPL is a stock → session toggle visible.
    expect(screen.getByRole('button', { name: 'ETH' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('hides the session toggle for crypto and switches to the baskets view via the view nav and hash', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ authRequired: false, authenticated: true });
    render(<App />);
    await screen.findByTestId('chart-view');
    await within(await screen.findByRole('banner')).findByText('crypto:BTC name');
    expect(screen.queryByRole('button', { name: 'RTH' })).not.toBeInTheDocument();
    // View switcher: nav buttons with aria-current="page" (not an incomplete tabs pattern).
    const nav = screen.getByRole('navigation', { name: 'View' });
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Chart' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('button', { name: 'Baskets' })).not.toHaveAttribute('aria-current');
    await userEvent.click(within(nav).getByRole('button', { name: 'Baskets' }));
    expect(screen.getByTestId('baskets-page')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/baskets');
    expect(within(nav).getByRole('button', { name: 'Baskets' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('button', { name: 'Chart' })).not.toHaveAttribute('aria-current');
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

  it('re-checks the session and shows Login when an API call returns 401 mid-session', async () => {
    const session = vi.spyOn(api, 'session')
      .mockResolvedValueOnce({ authRequired: true, authenticated: true })
      .mockResolvedValue({ authRequired: true, authenticated: false });
    // Every un-mocked API call (watchlist, quotes, …) now fails as an expired session would.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify({ code: 'unauthorized', message: 'Login required' }), { status: 401 })));
    try {
      render(<App />);
      expect(await screen.findByLabelText('Password')).toBeInTheDocument();
      expect(screen.queryByTestId('chart-view')).not.toBeInTheDocument();
      expect(session.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refreshes the RTH/ETH toggle when the current basket is edited', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ authRequired: false, authenticated: true });
    const layout: Layout = { symbol: 'basket:b1', tf: '1h', session: 'rth', chartType: 'candle', indicators: [] };
    vi.mocked(api.layouts.get).mockImplementation(async (key) => (key === 'default' ? layout : null));
    vi.mocked(api.symbol).mockResolvedValue({ id: 'basket:b1', assetClass: 'basket', ticker: 'B1', name: 'B1', pricePrecision: 2 });
    const cryptoOnly: Basket = { id: 'b1', name: 'B1', baseValue: 100, createdAt: 0, updatedAt: 0,
      versions: [{ effectiveFrom: '2024-01-02', weights: { 'crypto:BTC': 1 } }] };
    const withStock: Basket = { ...cryptoOnly, versions: [...cryptoOnly.versions, { effectiveFrom: '2024-02-01', weights: { 'stock:AAPL': 1 } }] };
    const get = vi.spyOn(api.baskets, 'get').mockResolvedValue(cryptoOnly);
    render(<App />);
    await screen.findByTestId('chart-view');
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'RTH' })).not.toBeInTheDocument();
    get.mockResolvedValue(withStock);
    act(() => notifyBasketChanged('other'));
    act(() => notifyBasketChanged('b1'));
    expect(await screen.findByRole('button', { name: 'RTH' })).toBeInTheDocument();
  });

  it('shows an inline error in the chart when the symbol info fails to load', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ authRequired: false, authenticated: true });
    vi.mocked(api.symbol).mockRejectedValue(new ApiError(404, 'not_found', 'Unknown symbol'));
    render(<App />);
    expect(await screen.findByText("Couldn't load symbol crypto:BTC: Unknown symbol")).toBeInTheDocument();
  });

  it('recovers from a failed symbol info load via the Retry button, by re-selecting the symbol, or automatically', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ authRequired: false, authenticated: true });
    vi.spyOn(api.watchlist, 'get').mockResolvedValue([{ type: 'symbol', id: 'crypto:BTC' }]);
    vi.spyOn(api.watchlist, 'put').mockResolvedValue(undefined);
    const ok = vi.mocked(api.symbol).getMockImplementation()!;
    vi.mocked(api.symbol).mockRejectedValue(new ApiError(0, 'network_error', 'offline'));
    render(<App />);
    expect(await screen.findByText("Couldn't load symbol crypto:BTC: offline")).toBeInTheDocument();
    // Retry button.
    const n = vi.mocked(api.symbol).mock.calls.length;
    await userEvent.click(within(screen.getByTestId('symbol-error')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(vi.mocked(api.symbol).mock.calls.length).toBeGreaterThan(n));
    // Re-selecting the same symbol in the watchlist retries too; this time it works.
    vi.mocked(api.symbol).mockImplementation(ok);
    const row = await screen.findByRole('button', { name: /^BTC/ });
    await userEvent.click(row);
    await waitFor(() => expect(screen.queryByTestId('symbol-error')).not.toBeInTheDocument());
    expect(await within(await screen.findByRole('banner')).findByText('crypto:BTC name')).toBeInTheDocument();
  });

  it('retries a failed symbol info load automatically with backoff', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(api, 'session').mockResolvedValue({ authRequired: false, authenticated: true });
      const ok = vi.mocked(api.symbol).getMockImplementation()!;
      vi.mocked(api.symbol).mockRejectedValueOnce(new ApiError(503, 'unavailable', 'down'));
      vi.mocked(api.symbol).mockImplementation(ok);
      render(<App />);
      expect(await screen.findByText("Couldn't load symbol crypto:BTC: down")).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      await waitFor(() => expect(screen.queryByTestId('symbol-error')).not.toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });

  it('a watchlist click before the default layout loads is applied after it loads (not overwritten)', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ authRequired: false, authenticated: true });
    vi.spyOn(api.watchlist, 'get').mockResolvedValue([{ type: 'symbol', id: 'stock:MSFT' }]);
    vi.spyOn(api.watchlist, 'put').mockResolvedValue(undefined);
    let resolveDefault!: (l: Layout | null) => void;
    vi.mocked(api.layouts.get).mockImplementation((key) =>
      key === 'default' ? new Promise((r) => { resolveDefault = r; }) : Promise.resolve(null));
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /^MSFT/ }));
    resolveDefault({ symbol: 'stock:AAPL', tf: '1h', session: 'rth', chartType: 'candle', indicators: [] });
    expect(await within(await screen.findByRole('banner')).findByText('stock:MSFT name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1h' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a failed default-layout load blocks the chart with Retry (controls stay disabled, nothing saved)', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ authRequired: false, authenticated: true });
    let fail = true;
    vi.mocked(api.layouts.get).mockImplementation(async (key) => {
      if (key === 'default' && fail) throw new ApiError(500, 'internal', 'db down');
      return null;
    });
    render(<App />);
    expect(await screen.findByText("Couldn't load layout: db down")).toBeInTheDocument();
    expect(screen.queryByTestId('chart-view')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1h' })).toBeDisabled();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('chart-view')).toBeInTheDocument();
    expect(api.layouts.put).not.toHaveBeenCalled();
  });

  it('a 401 arriving while a session check is in flight triggers one more check afterwards', async () => {
    let resolveFirst!: (s: { authRequired: boolean; authenticated: boolean }) => void;
    const session = vi.spyOn(api, 'session')
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValue({ authRequired: true, authenticated: false });
    let handler: (() => void) | null = null;
    const setHandler = await import('../src/api/client');
    const spy = vi.spyOn(setHandler, 'setUnauthorizedHandler');
    render(<App />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    handler = spy.mock.calls.find((c) => c[0] !== null)![0];
    act(() => handler!()); // 401 while the first check is in flight
    expect(session).toHaveBeenCalledTimes(1);
    await act(async () => { resolveFirst({ authRequired: true, authenticated: true }); });
    await waitFor(() => expect(session).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
  });

  it('shows a basket\'s name only once in the top-bar symbol label', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ authRequired: false, authenticated: true });
    const layout: Layout = { symbol: 'basket:b1', tf: '1D', session: 'rth', chartType: 'candle', indicators: [] };
    vi.mocked(api.layouts.get).mockImplementation(async (key) => (key === 'default' ? layout : null));
    vi.mocked(api.symbol).mockResolvedValue({ id: 'basket:b1', assetClass: 'basket', ticker: 'Tech Mix', name: 'Tech Mix', pricePrecision: 2 });
    vi.spyOn(api.baskets, 'get').mockRejectedValue(new Error('n/a'));
    render(<App />);
    const label = await waitFor(() => {
      const el = document.querySelector('header .symbol-label');
      expect(el).toHaveTextContent('Tech Mix');
      return el!;
    });
    expect(label.textContent).toBe('Tech Mix');
  });

  it('shows no symbol error while the symbol info is still loading', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ authRequired: false, authenticated: true });
    vi.mocked(api.symbol).mockImplementation(() => new Promise(() => {}));
    render(<App />);
    await screen.findByTestId('chart-view');
    expect(screen.queryByText(/Couldn't load symbol/)).not.toBeInTheDocument();
  });
  it('shows a small "Layout not saved — retrying" status while layout saves fail, gone once a retry succeeds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(api, 'session').mockResolvedValue({ authRequired: false, authenticated: true });
      vi.mocked(api.layouts.put).mockRejectedValueOnce(new ApiError(503, 'unavailable', 'down'));
      render(<App />);
      await screen.findByTestId('chart-view');
      await userEvent.click(screen.getByRole('button', { name: '1h' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
      const status = await screen.findByText('Layout not saved — retrying');
      expect(status).toHaveAttribute('role', 'status');
      expect(status).toHaveAttribute('title', expect.stringContaining('down'));
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
      await waitFor(() => expect(screen.queryByText('Layout not saved — retrying')).not.toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });
  it('resizes the watchlist sidebar with its separator and keeps the width when it is hidden and shown again', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ authRequired: false, authenticated: true });
    const { container } = render(<App />);
    await screen.findByTestId('chart-view');
    const shell = container.querySelector('.app-shell') as HTMLElement;
    const sep = screen.getByRole('separator', { name: 'Resize watchlist' });
    expect(shell.style.getPropertyValue('--sidebar-w')).toBe('320px');
    sep.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(shell.style.getPropertyValue('--sidebar-w')).toBe('336px');
    expect(localStorage.getItem('chartmate.sidebar.width')).toBe('336');

    await userEvent.click(screen.getByRole('button', { name: 'Toggle watchlist' }));
    expect(screen.queryByRole('separator', { name: 'Resize watchlist' })).not.toBeInTheDocument();
    expect(shell).toHaveClass('sidebar-collapsed');
    await userEvent.click(screen.getByRole('button', { name: 'Toggle watchlist' }));
    expect(screen.getByRole('separator', { name: 'Resize watchlist' })).toHaveAttribute('aria-valuenow', '336');
    localStorage.clear();
  });
});
