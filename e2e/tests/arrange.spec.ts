import { expect, test, type Page, type Response } from '@playwright/test';

const BTC = 'crypto:BTC';
const LAYOUT = { symbol: BTC, tf: '1D', session: 'rth', chartType: 'candle', indicators: [] };
const drawingsPath = `/api/drawings/${encodeURIComponent(BTC)}`;

type Saved = Array<{ name: string }>;
const isPut = (res: Response) => res.request().method() === 'PUT' && new URL(res.url()).pathname === drawingsPath;
const drawingsSaved = async (page: Page, ok: (d: Saved) => boolean): Promise<Saved> =>
  (await page.waitForResponse((r) => isPut(r) && ok(r.request().postDataJSON() as Saved))).request().postDataJSON() as Saved;
const names = (d: Saved) => d.map((x) => x.name).join(',');

test('arrange: the top-most drawing takes the click; Send to back (menu) and ⌘[ / Ctrl+[ change which, saved', async ({ page, request }) => {
  expect((await request.put(drawingsPath, { data: [] })).ok()).toBe(true);
  expect((await request.put('/api/layouts/default', { data: LAYOUT })).ok()).toBe(true);
  await page.goto('/');
  const host = page.getByTestId('chart-host');
  await expect(host.locator('canvas').first()).toBeVisible();
  const tools = page.getByRole('toolbar', { name: 'Drawing tools' });
  await expect(tools.getByRole('button', { name: 'Trend line', exact: true })).toBeEnabled();
  const box = (await host.boundingBox())!;
  const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  const click = async (fx: number, fy: number) => { const p = at(fx, fy); await page.mouse.click(p.x, p.y); };
  const draw = async (tool: string, from: [number, number], to: [number, number], count: number) => {
    await tools.getByRole('button', { name: tool, exact: true }).click();
    const saved = drawingsSaved(page, (d) => d.length === count);
    const a = at(...from);
    const b = at(...to);
    await page.mouse.move(a.x, a.y);
    await page.mouse.click(a.x, a.y);
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.click(b.x, b.y);
    await saved;
  };

  // A trend line, then a filled rectangle drawn over it (on top).
  await draw('Trend line', [0.3, 0.5], [0.6, 0.5], 1);
  await draw('Rectangle', [0.2, 0.3], [0.7, 0.7], 2);
  const bar = page.getByRole('toolbar', { name: 'Drawing style' });
  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();

  // A click on the line inside the rectangle takes the rectangle (on top): its bar has Fill.
  await click(0.45, 0.5);
  await expect(bar.getByRole('checkbox', { name: 'Fill' })).toBeVisible();
  const toBack = drawingsSaved(page, (d) => names(d) === 'rectangle,segment');
  await bar.getByRole('button', { name: 'Arrange' }).click();
  await page.getByRole('menuitem', { name: /Send to back/ }).click();
  await toBack;

  // Now the same click takes the line.
  await page.keyboard.press('Escape');
  await click(0.45, 0.5);
  await expect(bar.getByLabel('Line width')).toBeVisible();
  await expect(bar.getByRole('checkbox', { name: 'Fill' })).toHaveCount(0);

  // Ctrl+[ (⌘[ on macOS) sends the line backward again: the rectangle is back on top, also after a reload.
  const backward = drawingsSaved(page, (d) => names(d) === 'segment,rectangle');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+BracketLeft' : 'Control+BracketLeft');
  await backward;
  await page.reload();
  await expect(host.locator('canvas').first()).toBeVisible();
  await expect(tools.getByRole('button', { name: 'Trend line', exact: true })).toBeEnabled();
  await click(0.45, 0.5);
  await expect(bar.getByRole('checkbox', { name: 'Fill' })).toBeVisible();
});
