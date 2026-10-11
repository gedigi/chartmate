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
  expect((await request.put(`/api/layouts/${encodeURIComponent(`sym:${AAPL}`)}`, { data: { ...layout, symbol: AAPL } })).ok()).toBe(true);
}

/** Picks `ticker` in the symbol-search combobox named `comboboxName` inside `scope`. */
async function pickSymbol(scope: Locator, comboboxName: string, ticker: string): Promise<void> {
  await scope.getByRole('combobox', { name: comboboxName }).fill(ticker);
  await scope.getByRole('option', { name: new RegExp(`^${ticker}\\b`) }).first().click();
}

const errorToast = (page: Page) => page.locator('.chart-toast');

test('happy path: chart, indicators, drawings, baskets', async ({ page, request }) => {
  await resetServerState(request);

  // 1. Open the app, search AAPL and select it.
  await page.goto('/');
  const aaplLayoutLoaded = page.waitForResponse((r) => isApi(r, 'GET', `/api/layouts/${encodeURIComponent(`sym:${AAPL}`)}`));
  const aaplDailyBars = page.waitForResponse((r) => isBars(r, { symbol: AAPL, tf: '1D' }));
  await pickSymbol(page.locator('header.top-bar'), 'Search symbol', 'AAPL');
  await aaplLayoutLoaded;
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
  await expect(errorToast(page)).toHaveCount(0);

  // 3. Indicator picker → RSI → chip.
  await page.getByRole('button', { name: 'Indicators', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Indicators' });
  await picker.getByRole('button', { name: /^RSI\b/ }).click();
  await expect(picker.getByRole('status')).toHaveText(/Added RSI/);
  await picker.getByRole('button', { name: 'Close' }).click();
  await expect(picker).toBeHidden();
  const chips = page.getByRole('list', { name: 'Active indicators' });
  await expect(chips.getByText(/^RSI\b/)).toBeVisible();

  // 4. Horizontal line tool + click on the candle pane → debounced PUT with exactly one drawing.
  await page.getByRole('toolbar', { name: 'Drawing tools' }).getByRole('button', { name: 'Horizontal line', exact: true }).click();
  await expect(page.getByRole('toolbar', { name: 'Drawing tools' }).getByRole('button', { name: 'Horizontal line', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const drawingsPut = page.waitForResponse((r) => isApi(r, 'PUT', `/api/drawings/${encodeURIComponent(AAPL)}`));
  const host = page.getByTestId('chart-host');
  const box = await host.boundingBox();
  if (!box) throw new Error('chart host has no bounding box');
  // Upper third of the chart: inside the candle pane (RSI and VOL panes sit below it), left of the price axis.
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.3);
  const put = await drawingsPut;
  expect(put.ok()).toBe(true);
  const sent = put.request().postDataJSON() as unknown[];
  expect(Array.isArray(sent)).toBe(true);
  expect(sent).toHaveLength(1);

  // 5. Layout (with RSI) is persisted → reload keeps the chip; the drawing is on the server.
  for (const key of ['default', `sym:${AAPL}`]) {
    await expect.poll(async () => {
      const l = (await (await request.get(`/api/layouts/${encodeURIComponent(key)}`)).json()) as { indicators?: Array<{ name: string }> };
      return (l.indicators ?? []).some((i) => i.name === 'RSI');
    }, { message: `layout ${key} saved with RSI` }).toBe(true);
  }
  await page.reload();
  await expect(page.locator('header .symbol-label strong')).toHaveText('AAPL');
  await expect(page.getByRole('list', { name: 'Active indicators' }).getByText(/^RSI\b/)).toBeVisible();
  const drawings = (await (await request.get(`/api/drawings/${encodeURIComponent(AAPL)}`)).json()) as unknown[];
  expect(drawings).toHaveLength(1);

  // 6. Create "E2E Basket" 50% AAPL / 50% BTC from 2024-01-02 and open its chart.
  await page.getByRole('tab', { name: 'Baskets', exact: true }).click();
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
  await expect(errorToast(page)).toHaveCount(0);

  // 7. Append a version (100% BTC from yesterday UTC) → the basket chart's bars carry a version marker.
  const effective = yesterdayUtc();
  await page.getByRole('tab', { name: 'Baskets', exact: true }).click();
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
    const body = (await r.json()) as { markers?: unknown[] };
    return (body.markers?.length ?? 0) >= 1;
  });
  await row.getByRole('button', { name: 'Open chart' }).click();
  const marked = (await (await markedBars).json()) as { bars: unknown[]; markers: Array<{ ts: number }> };
  expect(marked.bars.length).toBeGreaterThan(0);
  expect(marked.markers.some((m) => new Date(m.ts).toISOString().slice(0, 10) === effective)).toBe(true);
  await expect(errorToast(page)).toHaveCount(0);
});
