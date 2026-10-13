import { expect, test, type APIRequestContext, type Locator, type Page, type Response } from '@playwright/test';

const AAPL = 'stock:AAPL';
const DAY = 86_400_000;
const BASKET_NAME = 'E2E Basket';

/** Yesterday as a UTC `YYYY-MM-DD` string. */
const yesterdayUtc = () => new Date(Date.now() - DAY).toISOString().slice(0, 10);

/** True for a successful `GET /api/bars` response whose query matches `params`. */
function isBars(res: Response, params: Record<string, string | ((v: string) => boolean)>): boolean {
  const url = new URL(res.url());
  if (url.pathname !== '/api/bars' || res.request().method() !== 'GET' || !res.ok()) return false;
  return Object.entries(params).every(([k, want]) => {
    const v = url.searchParams.get(k);
    if (v === null) return false;
    return typeof want === 'string' ? v === want : want(v);
  });
}

const isApi = (res: Response, method: string, path: string) =>
  res.request().method() === method && new URL(res.url()).pathname === path;

/**
 * Puts the server into a known state so the test is repeatable against the same database
 * (`--repeat-each`): no baskets, no AAPL drawings, default layout on BTC, AAPL layout without indicators.
 */
async function resetServerState(request: APIRequestContext): Promise<void> {
  const baskets = (await (await request.get('/api/baskets')).json()) as Array<{ id: string }>;
  for (const b of baskets) expect((await request.delete(`/api/baskets/${b.id}`)).ok()).toBe(true);
  expect((await request.put(`/api/drawings/${encodeURIComponent(AAPL)}`, { data: [] })).ok()).toBe(true);
  const layout = { symbol: 'crypto:BTC', tf: '1D', session: 'rth', chartType: 'candle', indicators: [] };
  expect((await request.put('/api/layouts/default', { data: layout })).ok()).toBe(true);
}

/** Picks `ticker` in the symbol-search combobox named `comboboxName` inside `scope`. */
async function pickSymbol(scope: Locator, comboboxName: string, ticker: string): Promise<void> {
  await scope.getByRole('combobox', { name: comboboxName }).fill(ticker);
  await scope.getByRole('option', { name: new RegExp(`^${ticker}\\b`) }).first().click();
}

const errorToast = (page: Page) => page.locator('.chart-toast');

/** Asserts that no error toast or connection banner appears over `ms` (checked repeatedly, not just once). */
async function expectNoErrorsFor(page: Page, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  do {
    expect(await errorToast(page).count(), 'error toast').toBe(0);
    expect(await page.locator('.chart-banner').count(), 'connection banner').toBe(0);
    await page.waitForTimeout(200);
  } while (Date.now() < until);
}

test('happy path: chart, indicators, drawings, baskets', async ({ page, request }) => {
  await resetServerState(request);

  // 1. Open the app, search AAPL and select it.
  await page.goto('/');
  // Indicators are one global set: no per-symbol layout is ever requested.
  const symLayoutRequests: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith('/api/layouts/') && path !== '/api/layouts/default') symLayoutRequests.push(`${r.method()} ${path}`);
  });
  const aaplDailyBars = page.waitForResponse((r) => isBars(r, { symbol: AAPL, tf: '1D' }));
  await pickSymbol(page.locator('header.top-bar'), 'Search symbol', 'AAPL');
  await aaplDailyBars;
  await expect(page.getByTestId('chart-host').locator('canvas').first()).toBeVisible();
  await expect(page.locator('header .symbol-label strong')).toHaveText('AAPL');

  // 2. 1h, then ETH → bars for that combination load without an error toast.
  const timeframes = page.getByRole('group', { name: 'Timeframe' });
  const hourlyRth = page.waitForResponse((r) => isBars(r, { symbol: AAPL, tf: '1h', session: 'rth' }));
  await timeframes.getByRole('button', { name: '1h', exact: true }).click();
  await hourlyRth;
  const hourlyEth = page.waitForResponse((r) => isBars(r, { symbol: AAPL, tf: '1h', session: 'eth' }));
  const sessions = page.getByRole('group', { name: 'Session' });
  await sessions.getByRole('button', { name: 'ETH', exact: true }).click();
  await hourlyEth;
  await expect(timeframes.getByRole('button', { name: '1h', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sessions.getByRole('button', { name: 'ETH', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expectNoErrorsFor(page);

  // 3. Indicator picker → RSI → chip.
  await page.getByRole('button', { name: 'Indicators', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Indicators' });
  await picker.getByRole('button', { name: /^RSI\b/ }).click();
  await expect(picker.getByRole('status')).toHaveText(/Added RSI/);
  await picker.getByRole('button', { name: 'Close' }).click();
  await expect(picker).toBeHidden();
  const chips = page.getByRole('list', { name: 'Active indicators' });
  await expect(chips.getByText(/^RSI\b/)).toBeVisible();

  // 4. Trend line (segment: two clicks) on the candle pane → debounced PUT with exactly one 2-point drawing.
  const tools = page.getByRole('toolbar', { name: 'Drawing tools' });
  const trendLine = tools.getByRole('button', { name: 'Trend line', exact: true });
  await trendLine.click(); // waits until enabled (this symbol's drawings and first data are in)
  await expect(trendLine).toHaveAttribute('aria-pressed', 'true');
  const drawingsPut = page.waitForResponse((r) => isApi(r, 'PUT', `/api/drawings/${encodeURIComponent(AAPL)}`));
  const host = page.getByTestId('chart-host');
  const box = await host.boundingBox();
  if (!box) throw new Error('chart host has no bounding box');
  // Upper third of the chart: inside the candle pane (RSI and VOL panes sit below it), left of the price axis.
  // These fractions depend on the pinned 1440x900 viewport (playwright.config.ts) and on the pane layout at
  // this point (candle pane + VOL + RSI sub-panes, chip strip above the canvas). If either changes — a
  // different viewport, another default sub-pane, taller toolbars — re-check that these points still land in
  // the candle pane, otherwise the clicks create no drawing and the PUT below never happens.
  const p1 = { x: box.x + box.width * 0.35, y: box.y + box.height * 0.32 };
  const p2 = { x: box.x + box.width * 0.55, y: box.y + box.height * 0.22 };
  await page.mouse.move(p1.x, p1.y);
  await page.mouse.click(p1.x, p1.y);
  // A quick second click (inside KLineChart's 500 ms double-click window) must still place the second point.
  await page.mouse.move(p2.x, p2.y, { steps: 4 });
  await page.mouse.click(p2.x, p2.y);
  const put = await drawingsPut;
  expect(put.ok()).toBe(true);
  const sent = put.request().postDataJSON() as Array<{ name: string; points: unknown[] }>;
  expect(Array.isArray(sent)).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.name).toBe('segment');
  expect(sent[0]!.points).toHaveLength(2);
  await expect(trendLine).toHaveAttribute('aria-pressed', 'false');

  // 5. Layout (with RSI) is persisted → reload keeps the chip; the drawing is on the server.
  await expect.poll(async () => {
    const l = (await (await request.get('/api/layouts/default')).json()) as { indicators?: Array<{ name: string }> };
    return (l.indicators ?? []).some((i) => i.name === 'RSI');
  }, { message: 'default layout saved with RSI' }).toBe(true);
  await page.reload();
  await expect(page.locator('header .symbol-label strong')).toHaveText('AAPL');
  await expect(page.getByRole('list', { name: 'Active indicators' }).getByText(/^RSI\b/)).toBeVisible();
  // The same (global) indicator set shows on another ticker.
  await pickSymbol(page.locator('header.top-bar'), 'Search symbol', 'BTC');
  await expect(page.locator('header .symbol-label strong')).toHaveText('BTC');
  await expect(page.getByRole('list', { name: 'Active indicators' }).getByText(/^RSI\b/)).toBeVisible();
  expect(symLayoutRequests).toEqual([]);
  await pickSymbol(page.locator('header.top-bar'), 'Search symbol', 'AAPL');
  await expect(page.locator('header .symbol-label strong')).toHaveText('AAPL');
  const drawings = (await (await request.get(`/api/drawings/${encodeURIComponent(AAPL)}`)).json()) as unknown[];
  expect(drawings).toHaveLength(1);

  // 6. Create "E2E Basket" 50% AAPL / 50% BTC from 2024-01-02 and open its chart.
  await page.getByRole('navigation', { name: 'View' }).getByRole('button', { name: 'Baskets', exact: true }).click();
  await page.getByRole('button', { name: 'New basket' }).click();
  const create = page.getByRole('form', { name: 'Create basket' });
  await create.getByLabel('Name').fill(BASKET_NAME);
  await pickSymbol(create, 'Symbol for row 1', 'AAPL');
  await create.getByLabel('Weight for AAPL').fill('50');
  await create.getByRole('button', { name: 'Add constituent' }).click();
  await pickSymbol(create, 'Symbol for row 2', 'BTC');
  await create.getByLabel('Weight for BTC').fill('50');
  await create.getByLabel('Start date (UTC)').fill('2024-01-02');
  await expect(create.getByTestId('weights-total')).toHaveText('100.00%');
  await create.getByRole('button', { name: 'Create basket' }).click();

  const row = page.getByTestId('basket-row').filter({ hasText: BASKET_NAME });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('since 2024-01-02');
  const basketBars = page.waitForResponse((r) => isBars(r, { symbol: (s) => s.startsWith('basket:') }));
  await row.getByRole('button', { name: 'Open chart' }).click();
  const first = (await (await basketBars).json()) as { bars: unknown[] };
  expect(first.bars.length).toBeGreaterThan(0);
  await expect(page.locator('header .symbol-label strong')).toHaveText(BASKET_NAME);
  await expectNoErrorsFor(page);

  // 7. Append a version (100% BTC from yesterday UTC) → the basket chart's bars carry a version marker.
  const effective = yesterdayUtc();
  await page.getByRole('navigation', { name: 'View' }).getByRole('button', { name: 'Baskets', exact: true }).click();
  await row.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('button', { name: 'Change weights' }).click();
  const change = page.getByRole('form', { name: 'Change weights' });
  await change.getByRole('button', { name: 'Remove AAPL' }).click();
  await change.getByLabel('Weight for BTC').fill('100');
  await change.getByLabel('Effective date (UTC)').fill(effective);
  await expect(change.getByTestId('weights-total')).toHaveText('100.00%');
  await change.getByRole('button', { name: 'Add version' }).click();
  const history = page.getByRole('list', { name: 'Version history' });
  await expect(history.getByRole('listitem')).toHaveCount(2);
  await expect(history.getByRole('listitem').first()).toContainText(effective);

  await page.getByRole('button', { name: 'Back to baskets' }).click();
  const markedBars = page.waitForResponse(async (r) => {
    if (!isBars(r, { symbol: (s) => s.startsWith('basket:') })) return false;
    const body = (await r.json()) as { markers?: Array<{ ts: number }> };
    return (body.markers ?? []).some((m) => new Date(m.ts).toISOString().slice(0, 10) === effective);
  });
  await row.getByRole('button', { name: 'Open chart' }).click();
  const marked = (await (await markedBars).json()) as { bars: unknown[]; markers: Array<{ ts: number }> };
  expect(marked.bars.length).toBeGreaterThan(0);
  expect(marked.markers.some((m) => new Date(m.ts).toISOString().slice(0, 10) === effective)).toBe(true);
  await expectNoErrorsFor(page);
});

test('chart appearance persists; a basket starting today shows simulated history', async ({ page, request }) => {
  await resetServerState(request);
  await page.goto('/');
  await expect(page.getByTestId('chart-host').locator('canvas').first()).toBeVisible();

  // Chart appearance: change the up colour → saved in the default layout → still there after a reload.
  await page.getByRole('button', { name: 'Chart appearance' }).click();
  const dialog = page.getByRole('dialog', { name: 'Chart appearance' });
  await dialog.getByLabel('Up colour').fill('#00ff00');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => {
    const l = (await (await request.get('/api/layouts/default')).json()) as { appearance?: { dark?: { upColor?: string } } };
    return l.appearance?.dark?.upColor;
  }, { message: 'default layout saved with appearance' }).toBe('#00ff00');
  await page.reload();
  await page.getByRole('button', { name: 'Chart appearance' }).click();
  await expect(page.getByRole('dialog', { name: 'Chart appearance' }).getByLabel('Up colour')).toHaveValue('#00ff00');
  await page.getByRole('dialog', { name: 'Chart appearance' }).getByRole('button', { name: 'Done' }).click();
  // Appearance is per theme: the light theme keeps its own (default) colours.
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await page.getByRole('button', { name: 'Chart appearance' }).click();
  await expect(dialog.getByText('Light theme')).toBeVisible();
  await expect(dialog.getByLabel('Up colour')).toHaveValue('#089981');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();

  // A basket created with the default start date (today) has bars: simulated history before its start.
  await page.getByRole('navigation', { name: 'View' }).getByRole('button', { name: 'Baskets', exact: true }).click();
  await page.getByRole('button', { name: 'New basket' }).click();
  const create = page.getByRole('form', { name: 'Create basket' });
  await expect(create.getByLabel('Start date (UTC)')).toHaveValue(new Date().toISOString().slice(0, 10));
  await create.getByLabel('Name').fill('E2E Today');
  await pickSymbol(create, 'Symbol for row 1', 'AAPL');
  await create.getByLabel('Weight for AAPL').fill('50');
  await create.getByRole('button', { name: 'Add constituent' }).click();
  await pickSymbol(create, 'Symbol for row 2', 'BTC');
  await create.getByLabel('Weight for BTC').fill('50');
  await create.getByRole('button', { name: 'Create basket' }).click();
  const row = page.getByTestId('basket-row').filter({ hasText: 'E2E Today' });
  await expect(row).toHaveCount(1);
  const basketBars = page.waitForResponse((r) => isBars(r, { symbol: (s) => s.startsWith('basket:') }));
  await row.getByRole('button', { name: 'Open chart' }).click();
  const body = (await (await basketBars).json()) as { bars: Array<{ simulated?: boolean }>; notices: string[] };
  expect(body.bars.length).toBeGreaterThan(0);
  expect(body.bars.some((b) => b.simulated === true)).toBe(true);
  await expect(page.getByText(/simulated with the starting holdings/)).toBeVisible();
  await expectNoErrorsFor(page);
});
