import { expect, test } from '@playwright/test';

const DAY = 86_400_000;

test('date range buttons switch the interval and show the period; zooming deselects', async ({ page, request }) => {
  expect((await request.put('/api/layouts/default', {
    data: { symbol: 'stock:AAPL', tf: '5m', session: 'rth', chartType: 'candle', indicators: [] },
  })).ok()).toBe(true);
  await page.goto('/');
  await expect(page.getByTestId('chart-host').locator('canvas').first()).toBeVisible();
  await expect(page.getByTestId('chart-loading')).toHaveCount(0);

  const ranges = page.getByRole('group', { name: 'Date range' });
  const timeframes = page.getByRole('group', { name: 'Timeframe' });
  const span = page.getByTestId('range-span');
  await expect(ranges.getByRole('button', { name: 'All', exact: true })).toBeVisible();

  // 1Y: daily bars, about one year ending at the latest session.
  await ranges.getByRole('button', { name: '1Y', exact: true }).click();
  await expect(timeframes.getByRole('button', { name: '1D', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(ranges.getByRole('button', { name: '1Y', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(span).toHaveText(/^\w{3} \d{1,2}, \d{4} – \w{3} \d{1,2}, \d{4}$/);
  const [from, to] = (await span.textContent())!.split(' – ').map((d) => Date.parse(`${d} UTC`));
  expect((to! - from!) / DAY).toBeGreaterThanOrEqual(360);
  expect((to! - from!) / DAY).toBeLessThanOrEqual(366);
  expect(Date.now() - to!).toBeLessThan(5 * DAY); // ends at the latest session

  // 1D on a stock: 5m bars of the latest regular session, from its 09:30 open (in the first minutes after the open,
  // from the previous session's: e.g. "Oct 27, 09:30 – Oct 28, 09:50").
  await ranges.getByRole('button', { name: '1D', exact: true }).click();
  await expect(timeframes.getByRole('button', { name: '5m', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(ranges.getByRole('button', { name: '1D', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(span).toHaveText(/^\w{3} \d{1,2}, 09:30 – (\w{3} \d{1,2}, )?\d{2}:\d{2}$/);

  // Zooming the chart (mouse wheel) deselects the range.
  const box = (await page.getByTestId('chart-host').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
  await page.mouse.wheel(0, -240);
  await expect(ranges.getByRole('button', { name: '1D', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(span).toHaveText('');
  await expect(timeframes.getByRole('button', { name: '5m', exact: true })).toHaveAttribute('aria-pressed', 'true'); // the interval stays
});
