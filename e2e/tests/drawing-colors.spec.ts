import { expect, test, type Page, type Response } from '@playwright/test';

const BTC = 'crypto:BTC';
const LAYOUT = { symbol: BTC, tf: '1D', session: 'rth', chartType: 'candle', indicators: [] };

const isPut = (res: Response, path: string) => res.request().method() === 'PUT' && new URL(res.url()).pathname === path;
const drawingsPath = `/api/drawings/${encodeURIComponent(BTC)}`;

/** The next drawings PUT whose body satisfies `ok`. */
const drawingsSaved = (page: Page, ok: (d: Array<{ styles?: unknown }>) => boolean) =>
  page.waitForResponse((r) => isPut(r, drawingsPath) && ok(r.request().postDataJSON() as Array<{ styles?: unknown }>));
/** The next default layout PUT whose body satisfies `ok`. */
const layoutSaved = (page: Page, ok: (l: { drawingColor?: string }) => boolean) =>
  page.waitForResponse((r) => isPut(r, '/api/layouts/default') && ok(r.request().postDataJSON() as { drawingColor?: string }));

/** Draws a trend line between two points of the candle pane (fractions of the chart host). */
async function drawTrendLine(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const trendLine = page.getByRole('toolbar', { name: 'Drawing tools' }).getByRole('button', { name: 'Trend line', exact: true });
  await trendLine.click();
  await expect(trendLine).toHaveAttribute('aria-pressed', 'true');
  const box = (await page.getByTestId('chart-host').boundingBox())!;
  const at = ([fx, fy]: [number, number]) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  const a = at(from);
  const b = at(to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.click(a.x, a.y);
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.click(b.x, b.y);
  await expect(trendLine).toHaveAttribute('aria-pressed', 'false');
}

test('drawing colors: swatches, the picked color is the default of new drawings (kept on reload) until reset', async ({ page, request }) => {
  expect((await request.put(drawingsPath, { data: [] })).ok()).toBe(true);
  expect((await request.put('/api/layouts/default', { data: LAYOUT })).ok()).toBe(true);
  await page.goto('/');

  const styleBar = page.getByRole('toolbar', { name: 'Drawing style' });
  const colorButton = styleBar.getByRole('button', { name: 'Drawing color' });
  const swatch = (name: string) => page.getByRole('listbox', { name: 'Drawing color' }).getByRole('option', { name, exact: true });

  // 1. A new trend line is selected: pick Violet. The drawing stores the reference, the layout the sticky color.
  const firstSaved = drawingsSaved(page, (d) => d.length === 1);
  await drawTrendLine(page, [0.3, 0.3], [0.5, 0.2]);
  await firstSaved;
  await expect(styleBar).toBeVisible();
  await colorButton.click();
  await expect(swatch('Sky')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('input[type="color"]')).toHaveCount(0);
  const colored = drawingsSaved(page, (d) => JSON.stringify(d[0]?.styles) === JSON.stringify({ color: 'palette:1' }));
  const sticky = layoutSaved(page, (l) => l.drawingColor === 'palette:1');
  await swatch('Violet').click();
  await Promise.all([colored, sticky]);

  // 2. After a reload, a new drawing starts in Violet (only the color: width / dash follow the default).
  await page.reload();
  const secondSaved = drawingsSaved(page, (d) => d.length === 2);
  await drawTrendLine(page, [0.3, 0.6], [0.5, 0.5]);
  const saved = (await secondSaved).request().postDataJSON() as Array<{ styles?: unknown }>;
  expect(saved[1]!.styles).toEqual({ color: 'palette:1' });

  // 3. Reset to default: the drawing follows the default color again and new drawings no longer get Violet.
  await expect(styleBar).toBeVisible();
  await colorButton.click();
  await expect(swatch('Violet')).toHaveAttribute('aria-selected', 'true');
  const reset = drawingsSaved(page, (d) => d.length === 2 && d[1]!.styles === undefined);
  const unset = layoutSaved(page, (l) => l.drawingColor === undefined);
  await page.getByRole('button', { name: 'Reset to default' }).click();
  await Promise.all([reset, unset]);

  // 4. Re-picking the swatch the drawing already has (Sky, the default) still makes it the default of new drawings.
  await colorButton.click();
  await expect(swatch('Sky')).toHaveAttribute('aria-selected', 'true');
  const repicked = layoutSaved(page, (l) => l.drawingColor === 'accent');
  await swatch('Sky').click();
  await repicked;
  expect(((await (await request.get('/api/layouts/default')).json()) as { drawingColor?: string }).drawingColor).toBe('accent');

  // 5. Keyboard: Escape closes the popover and leaves the drawing selected.
  await colorButton.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Drawing color' })).toHaveCount(0);
  await expect(styleBar).toBeVisible();
  await expect(colorButton).toBeFocused();
});
