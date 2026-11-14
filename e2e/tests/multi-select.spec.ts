import { expect, test, type Page, type Response } from '@playwright/test';

const BTC = 'crypto:BTC';
const LAYOUT = { symbol: BTC, tf: '1D', session: 'rth', chartType: 'candle', indicators: [] };
const drawingsPath = `/api/drawings/${encodeURIComponent(BTC)}`;

type Saved = Array<{ name: string; points: Array<{ value: number }> }>;
const isPut = (res: Response) => res.request().method() === 'PUT' && new URL(res.url()).pathname === drawingsPath;
const drawingsSaved = async (page: Page, ok: (d: Saved) => boolean): Promise<Saved> =>
  (await page.waitForResponse((r) => isPut(r) && ok(r.request().postDataJSON() as Saved))).request().postDataJSON() as Saved;

test('Shift-click selects several drawings: dragging one moves them all, Delete removes them together', async ({ page, request }) => {
  expect((await request.put(drawingsPath, { data: [] })).ok()).toBe(true);
  expect((await request.put('/api/layouts/default', { data: LAYOUT })).ok()).toBe(true);
  await page.goto('/');
  const host = page.getByTestId('chart-host');
  await expect(host.locator('canvas').first()).toBeVisible();
  const tools = page.getByRole('toolbar', { name: 'Drawing tools' });
  await expect(tools.getByRole('button', { name: 'Trend line', exact: true })).toBeEnabled();
  const box = (await host.boundingBox())!;
  const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  const click = async (fx: number, fy: number, shift = false) => {
    const p = at(fx, fy);
    await page.mouse.move(p.x, p.y);
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.click(p.x, p.y);
    if (shift) await page.keyboard.up('Shift');
  };
  const draw = async (fy: number, count: number) => {
    await tools.getByRole('button', { name: 'Trend line', exact: true }).click();
    const saved = drawingsSaved(page, (d) => d.length === count);
    await click(0.3, fy);
    const b = at(0.6, fy);
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.click(b.x, b.y);
    await saved;
  };

  await draw(0.3, 1);
  await draw(0.5, 2);
  await draw(0.7, 3);
  await page.keyboard.press('Escape');

  // The first line, then Shift-click the second: both selected.
  await click(0.45, 0.3);
  await expect(page.getByRole('toolbar', { name: 'Drawing style' })).toBeVisible();
  await click(0.45, 0.5, true);

  // Dragging the second moves the first too (the third stays): one save with two lines moved alike.
  const before = await (await request.get(drawingsPath)).json() as Saved;
  const moved = drawingsSaved(page, (d) => d.length === 3 && d[2]!.points[0]!.value === before[2]!.points[0]!.value
    && d[0]!.points[0]!.value !== before[0]!.points[0]!.value);
  const from = at(0.45, 0.5);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y + box.height * 0.1, { steps: 6 });
  await page.mouse.up();
  const after = await moved;
  const shift = (i: number) => after[i]!.points[0]!.value - before[i]!.points[0]!.value;
  expect(shift(1)).not.toBe(0);
  expect(Math.abs(shift(0) - shift(1))).toBeLessThan(1e-6 * Math.max(1, Math.abs(shift(1))));

  // Delete removes both (one edit: one undo brings both back).
  const deleted = drawingsSaved(page, (d) => d.length === 1);
  await page.keyboard.press('Delete');
  await deleted;
  const undone = drawingsSaved(page, (d) => d.length === 3);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await undone;
});
