import { expect, test, type Page } from '@playwright/test';

// The web server does not check alerts (the desktop app does, and notifies): the bell is hidden there. Here
// /api/alerts answers as the desktop app would, to check the controls and that the alert is saved with the drawing.
const BTC = 'crypto:BTC';
const drawingsPath = `/api/drawings/${encodeURIComponent(BTC)}`;

async function drawTrendLine(page: Page): Promise<void> {
  const tool = page.getByRole('toolbar', { name: 'Drawing tools' }).getByRole('button', { name: 'Trend line', exact: true });
  await tool.click();
  const box = (await page.getByTestId('chart-host').boundingBox())!;
  const a = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.6 };
  const b = { x: box.x + box.width * 0.55, y: box.y + box.height * 0.35 };
  await page.mouse.move(a.x, a.y);
  await page.mouse.click(a.x, a.y);
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.click(b.x, b.y);
  await expect(tool).toHaveAttribute('aria-pressed', 'false');
}

test('the web server hides the alert bell', async ({ page, request }) => {
  expect(await (await request.get('/api/alerts')).json()).toEqual({ supported: false, alerts: {}, list: [] });
  expect((await request.put(drawingsPath, { data: [] })).ok()).toBe(true);
  expect((await request.put('/api/layouts/default', { data: { symbol: BTC, tf: '1D', session: 'rth', chartType: 'candle', indicators: [] } })).ok()).toBe(true);
  await page.goto('/');
  await drawTrendLine(page);
  const bar = page.getByRole('toolbar', { name: 'Drawing style' });
  await expect(bar.getByRole('button', { name: 'Arrange' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Alert' })).toHaveCount(0);
});

test('where alerts are checked: a trend line\'s alert is set from its bell and saved with it', async ({ page, request }) => {
  expect((await request.put(drawingsPath, { data: [] })).ok()).toBe(true);
  expect((await request.put('/api/layouts/default', { data: { symbol: BTC, tf: '1h', session: 'rth', chartType: 'candle', indicators: [] } })).ok()).toBe(true);
  await page.route('**/api/alerts', (r) => r.fulfill({ json: { supported: true, alerts: {} } }));
  await page.goto('/');
  await drawTrendLine(page);
  const bell = page.getByRole('toolbar', { name: 'Drawing style' }).getByRole('button', { name: 'Alert' });
  await bell.click();
  const panel = page.getByRole('dialog', { name: 'Alert' });
  const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === drawingsPath
    && (r.request().postDataJSON() as Array<{ alert?: { cross?: string[] } }>)[0]?.alert?.cross?.length === 1);
  await panel.getByRole('checkbox', { name: 'Notify me' }).check();
  await panel.getByRole('checkbox', { name: 'Crosses down' }).uncheck();
  await saved;
  await expect(bell).toHaveAttribute('data-armed', 'true');
  const stored = await (await request.get(drawingsPath)).json() as Array<{ alert?: Record<string, unknown> }>;
  expect(stored[0]!.alert).toMatchObject({ on: true, tf: '1h', session: 'rth', cross: ['up'], extend: true });
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});
