import { expect, test, type Page } from '@playwright/test';

const sidebarWidth = (page: Page) =>
  page.locator('.app-shell').evaluate((el) => getComputedStyle(el).getPropertyValue('--sidebar-w').trim());

test('the watchlist sidebar resizes by dragging its edge, keeps the width after a reload, and resets on double-click', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('chartmate.sidebar.width'));
  await page.reload();

  const separator = page.getByRole('separator', { name: 'Resize watchlist' });
  const sidebar = page.locator('.right-sidebar');
  await expect(separator).toHaveAttribute('aria-valuenow', '320');
  const before = (await sidebar.boundingBox())!.width;

  // Drag the edge 120 px to the left: the sidebar widens by as much, live.
  const box = (await separator.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 60, y, { steps: 4 });
  await page.mouse.move(x - 120, y, { steps: 4 });
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeCloseTo(before + 120, 0);
  await page.mouse.up();

  await expect(separator).toHaveAttribute('aria-valuenow', '440');
  expect(await sidebarWidth(page)).toBe('440px');
  expect(await page.evaluate(() => localStorage.getItem('chartmate.sidebar.width'))).toBe('440');

  await page.reload();
  await expect(separator).toHaveAttribute('aria-valuenow', '440');
  expect((await sidebar.boundingBox())!.width).toBeCloseTo(before + 120, 0);

  await separator.dblclick();
  await expect(separator).toHaveAttribute('aria-valuenow', '320');
  expect(await sidebarWidth(page)).toBe('320px');
  expect((await sidebar.boundingBox())!.width).toBeCloseTo(before, 0);
  expect(await page.evaluate(() => localStorage.getItem('chartmate.sidebar.width'))).toBe('320');
});
