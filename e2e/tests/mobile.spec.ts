import { expect, test, type Page, type Response } from '@playwright/test';

// A phone: 390 × 844 CSS px, touch, a mobile viewport (the compact layout, COMPACT_QUERY in apps/web).
test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

const BTC = 'crypto:BTC';
const LAYOUT = { symbol: BTC, tf: '1D', session: 'rth', chartType: 'candle', indicators: [] };
const drawingsPath = `/api/drawings/${encodeURIComponent(BTC)}`;

type Saved = Array<{ name: string }>;
const isPut = (res: Response, path: string) => res.request().method() === 'PUT' && new URL(res.url()).pathname === path;
const drawingsSaved = async (page: Page, ok: (d: Saved) => boolean): Promise<Saved> =>
  (await page.waitForResponse((r) => isPut(r, drawingsPath) && ok(r.request().postDataJSON() as Saved))).request().postDataJSON() as Saved;

test('phone: fits the screen, switches views from the tab bar, charts a watchlist symbol', async ({ page, request }) => {
  expect((await request.put('/api/layouts/default', { data: LAYOUT })).ok()).toBe(true);
  expect((await request.put('/api/watchlist', { data: [{ type: 'symbol', id: BTC }, { type: 'symbol', id: 'stock:MSFT' }] })).ok()).toBe(true);
  await page.goto('/');
  await expect(page.getByTestId('chart-host').locator('canvas').first()).toBeVisible();
  // Nothing wider than the screen.
  expect(await page.evaluate('document.documentElement.scrollWidth')).toBe(390);

  const tabs = page.getByRole('navigation', { name: 'View' });
  await tabs.getByRole('button', { name: 'Watchlist' }).tap();
  await expect(page).toHaveURL(/#\/watchlist$/);
  const charted = page.waitForResponse((r) => isPut(r, '/api/layouts/default')
    && (r.request().postDataJSON() as { symbol?: string }).symbol === 'stock:MSFT');
  await page.getByRole('button', { name: /^MSFT/ }).tap();
  await charted;
  await expect(page).toHaveURL(/#\/$/);
  await expect(tabs.getByRole('button', { name: 'Chart' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('chart-main')).toBeVisible();
});

test('phone: draws a trend line with two taps; the strip\'s Undo and Redo take it away and back', async ({ page, request }) => {
  expect((await request.put(drawingsPath, { data: [] })).ok()).toBe(true);
  expect((await request.put('/api/layouts/default', { data: LAYOUT })).ok()).toBe(true);
  await page.goto('/');
  const host = page.getByTestId('chart-host');
  await expect(host.locator('canvas').first()).toBeVisible();
  const tools = page.getByRole('toolbar', { name: 'Drawing tools' });
  await expect(tools).toHaveAttribute('aria-orientation', 'horizontal');
  const trend = tools.getByRole('button', { name: 'Trend line', exact: true });
  await expect(trend).toBeEnabled();

  const box = (await host.boundingBox())!;
  const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  await trend.tap();
  const drawn = drawingsSaved(page, (d) => d.length === 1);
  const a = at(0.2, 0.55);
  const b = at(0.6, 0.4);
  await page.touchscreen.tap(a.x, a.y);
  await page.touchscreen.tap(b.x, b.y);
  expect((await drawn)[0]!.name).toBe('segment');
  await expect(trend).toHaveAttribute('aria-pressed', 'false');

  const undone = drawingsSaved(page, (d) => d.length === 0);
  await tools.getByRole('button', { name: 'Undo' }).tap();
  await undone;
  const redone = drawingsSaved(page, (d) => d.length === 1);
  await tools.getByRole('button', { name: 'Redo' }).tap();
  await redone;
});
