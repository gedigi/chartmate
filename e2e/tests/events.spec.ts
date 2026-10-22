import { expect, test } from '@playwright/test';

const LAYOUT = { symbol: 'stock:MSFT', tf: '1D', session: 'rth', chartType: 'candle', indicators: [] };

test('events: a stock shows its earnings and dividends; the picker hides a kind, kept after a reload', async ({ page, request }) => {
  expect((await request.put('/api/layouts/default', { data: LAYOUT })).ok()).toBe(true);
  await page.goto('/');
  const readout = page.getByTestId('events-readout');
  await expect(readout.getByText(/^Dividend, .*: \$0\.60 per share$/).first()).toBeAttached();
  await expect(readout.getByText(/^Earnings \(expected\), .*after the close: EPS estimate/)).toBeAttached();
  await expect(readout.getByText(/^Earnings, .*: EPS .* estimated, (beat|missed) by/).first()).toBeAttached();

  // Hide dividends from the picker's Events group: gone from the chart, saved with the layout.
  await page.getByRole('button', { name: 'Indicators' }).click();
  const dividends = page.getByRole('dialog').getByRole('button', { name: /^Dividends/ });
  await expect(dividends).toHaveAttribute('aria-pressed', 'true');
  const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith('/api/layouts/default')
    && (r.request().postDataJSON() as { hiddenEvents?: string[] }).hiddenEvents?.[0] === 'dividend');
  await dividends.click();
  await saved;
  await expect(dividends).toHaveAttribute('aria-pressed', 'false');
  await expect(readout.getByText(/^Dividend,/)).toHaveCount(0);
  await expect(readout.getByText(/^Earnings/).first()).toBeAttached();
  await page.keyboard.press('Escape');

  await page.reload();
  await expect(readout.getByText(/^Earnings \(expected\)/)).toBeAttached();
  await expect(readout.getByText(/^Dividend,/)).toHaveCount(0);

  // Crypto has no events.
  expect((await request.put('/api/layouts/default', { data: { ...LAYOUT, symbol: 'crypto:BTC' } })).ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId('chart-host').locator('canvas').first()).toBeVisible();
  await expect(readout.locator('li')).toHaveCount(0);
});
