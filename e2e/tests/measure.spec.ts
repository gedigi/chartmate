import { expect, test, type Page } from '@playwright/test';

const BTC = 'crypto:BTC';
const drawingsPath = `/api/drawings/${encodeURIComponent(BTC)}`;

/** A point of the candle pane, as fractions of the chart host. */
async function at(page: Page, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const box = (await page.getByTestId('chart-host').boundingBox())!;
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

test('Shift measures on the chart without creating a drawing', async ({ page, request }) => {
  expect((await request.put(drawingsPath, { data: [] })).ok()).toBe(true);
  expect((await request.put('/api/layouts/default', { data: { symbol: BTC, tf: '1D', session: 'rth', chartType: 'candle', indicators: [] } })).ok()).toBe(true);
  const drawingPuts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PUT' && new URL(r.url()).pathname === drawingsPath) drawingPuts.push(r.url()); });
  await page.goto('/');
  await expect(page.getByTestId('chart-host').locator('canvas').first()).toBeVisible();
  await expect(page.getByTestId('chart-loading')).toHaveCount(0);
  const readout = page.getByTestId('measure-readout');

  // 1. Shift-drag: the measure label shows the price change, bars and time span.
  const a = await at(page, 0.35, 0.6);
  const b = await at(page, 0.6, 0.3);
  await page.mouse.move(a.x, a.y);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(readout).toHaveText(/^Measure: \+[\d.]+ \(\+[\d.]+%\), \d+ bars, \d+d/);

  // 2. A click without Shift removes it.
  await page.mouse.click(b.x, b.y);
  await expect(readout).toHaveText('');

  // 3. Shift-click starts, a click finishes (downward this time); Escape removes it.
  await page.keyboard.down('Shift');
  await page.mouse.click(b.x, b.y);
  await page.keyboard.up('Shift');
  await page.mouse.move(a.x, a.y, { steps: 4 });
  await page.mouse.click(a.x, a.y);
  await expect(readout).toHaveText(/^Measure: −[\d.]+ \(−[\d.]+%\), −\d+ bars/);
  await page.keyboard.press('Escape');
  await expect(readout).toHaveText('');

  // Never saved as a drawing.
  expect(drawingPuts).toEqual([]);
  expect(await (await request.get(drawingsPath)).json()).toEqual([]);
});
