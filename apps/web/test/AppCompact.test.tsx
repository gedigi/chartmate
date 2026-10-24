import type { Layout } from '@chartmate/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { App } from '../src/App';
import { drawingsStore } from '../src/state/drawingsStore';

// Phone width: every media query matches (the app only asks for COMPACT_QUERY).
beforeEach(() => {
  vi.stubGlobal('matchMedia', (media: string) => ({ matches: true, media, addEventListener() {}, removeEventListener() {} }));
  drawingsStore.reset();
  window.location.hash = '';
  vi.spyOn(api, 'session').mockResolvedValue({ authRequired: false, authenticated: true });
  vi.spyOn(api.layouts, 'get').mockResolvedValue(null);
  vi.spyOn(api.layouts, 'put').mockResolvedValue(undefined);
  vi.spyOn(api, 'symbol').mockImplementation(async (id) => ({
    id, assetClass: id.startsWith('stock:') ? 'stock' : 'crypto', ticker: id.split(':')[1]!, name: `${id} name`, pricePrecision: 2,
  }));
  vi.spyOn(api.watchlist, 'get').mockResolvedValue([{ type: 'symbol', id: 'crypto:BTC' }, { type: 'symbol', id: 'stock:MSFT' }]);
  vi.spyOn(api.watchlist, 'load').mockResolvedValue({
    entries: [{ type: 'symbol', id: 'crypto:BTC' }, { type: 'symbol', id: 'stock:MSFT' }], stored: true,
  });
  vi.spyOn(api.watchlist, 'put').mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.dataset.theme = 'dark';
  localStorage.clear();
});

describe('App at phone width', () => {
  it('switches views from a bottom tab bar; the watchlist is its own view and picking a symbol charts it', async () => {
    const saved: Layout = { symbol: 'crypto:BTC', tf: '1D', session: 'rth', chartType: 'candle', indicators: [] };
    vi.mocked(api.layouts.get).mockImplementation(async (key) => (key === 'default' ? saved : null));
    render(<App />);
    const chart = await screen.findByTestId('chart-view');
    // One view nav (the tab bar), none in the top bar; no sidebar next to the chart.
    const nav = screen.getByRole('navigation', { name: 'View' });
    expect(within(screen.getByRole('banner')).queryByRole('navigation')).not.toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Chart' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Toggle watchlist' })).not.toBeInTheDocument();

    await userEvent.click(within(nav).getByRole('button', { name: 'Watchlist' }));
    expect(window.location.hash).toBe('#/watchlist');
    expect(within(nav).getByRole('button', { name: 'Watchlist' })).toHaveAttribute('aria-current', 'page');
    // The chart stays mounted (no reload when coming back), just hidden.
    expect(chart).toBeInTheDocument();
    expect(screen.getByTestId('chart-main')).not.toBeVisible();
    await userEvent.click(await screen.findByRole('button', { name: /^MSFT/ }));
    expect(window.location.hash).toBe('#/');
    expect(screen.getByTestId('chart-main')).toBeVisible();
    await waitFor(() => expect(api.layouts.put).toHaveBeenCalledWith('default', expect.objectContaining({ symbol: 'stock:MSFT' })));

    await userEvent.click(within(nav).getByRole('button', { name: 'Baskets' }));
    expect(screen.getByTestId('baskets-page')).toBeInTheDocument();
  });

  it('opens the watchlist view from its hash', async () => {
    window.location.hash = '#/watchlist';
    render(<App />);
    expect(await screen.findByRole('button', { name: /^MSFT/ })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'View' })).getByRole('button', { name: 'Watchlist' }))
      .toHaveAttribute('aria-current', 'page');
  });
});

describe('the More sheet at phone width', () => {
  it('holds the theme switch, chart appearance, About and Log out', async () => {
    vi.mocked(api.session).mockResolvedValue({ authRequired: true, authenticated: true });
    const logout = vi.spyOn(api, 'logout').mockResolvedValue(undefined);
    render(<App />);
    await screen.findByTestId('chart-view');
    const bar = screen.getByRole('banner');
    // Not in the bar itself at phone width.
    expect(within(bar).queryByRole('button', { name: /Switch to (light|dark) theme/ })).not.toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Indicators' })).toBeInTheDocument();

    await userEvent.click(within(bar).getByRole('button', { name: 'More' }));
    let sheet = screen.getByRole('dialog', { name: 'More' });
    expect(within(sheet).getAllByRole('button').map((b) => b.textContent)).toEqual(['×', 'Light theme', 'Chart appearance', 'About Chartmate', 'Log out']);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Light theme' }));
    expect(screen.queryByRole('dialog', { name: 'More' })).not.toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe('light');

    await userEvent.click(within(bar).getByRole('button', { name: 'More' }));
    sheet = screen.getByRole('dialog', { name: 'More' });
    expect(within(sheet).getByRole('button', { name: 'Dark theme' })).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Chart appearance' }));
    expect(await screen.findByRole('dialog', { name: 'Chart appearance' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(within(bar).getByRole('button', { name: 'More' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'More' })).getByRole('button', { name: 'Log out' }));
    expect(logout).toHaveBeenCalled();
  });

  it('the top bar searches only on the chart view; the baskets view has no second title', async () => {
    window.location.hash = '#/baskets';
    render(<App />);
    expect(await screen.findByTestId('baskets-page')).toBeInTheDocument();
    const bar = screen.getByRole('banner');
    expect(within(bar).queryByRole('combobox', { name: 'Search symbol' })).not.toBeInTheDocument();
    expect(within(bar).queryByRole('heading')).not.toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'More' })).toBeInTheDocument();
  });
});
