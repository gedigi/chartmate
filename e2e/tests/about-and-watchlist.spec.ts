import { expect, test } from '@playwright/test';

test('About Chartmate opens from the brand mark and shows the version, the source code and the license', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'About Chartmate' }).click();
  const dialog = page.getByRole('dialog', { name: 'About Chartmate' });
  await expect(dialog).toContainText(/Version \d+\.\d+\.\d+/);
  await expect(dialog).toContainText('GNU Affero General Public License');
  await expect(dialog.getByText('Source code', { exact: true })).toBeVisible();
  // The server is the same build as the page: no separate server version.
  await expect(dialog.getByText('Server version', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('an emptied watchlist stays empty in a new browser (no defaults seeded over it)', async ({ page, browser, request }) => {
  await page.goto('/');
  const saved = await (await request.get('/api/watchlist')).json();
  try {
    expect((await request.put('/api/watchlist', { data: [] })).ok()).toBe(true);
    // A fresh context: no localStorage from earlier visits, as on another device.
    const other = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    try {
      const fresh = await other.newPage();
      await fresh.goto('/');
      const list = fresh.getByRole('list', { name: 'Watchlist symbols' });
      await expect(list).not.toHaveAttribute('aria-busy', 'true');
      await expect(fresh.getByTestId('watchlist').getByRole('combobox', { name: 'Search symbol' })).toBeEnabled();
      await expect(list.locator('[data-symbol]')).toHaveCount(0);
      await fresh.waitForTimeout(1000); // a seeding save would have gone out by now
      expect(await (await request.get('/api/watchlist')).json()).toEqual([]);
    } finally {
      await other.close();
    }
  } finally {
    await request.put('/api/watchlist', { data: saved });
  }
});
