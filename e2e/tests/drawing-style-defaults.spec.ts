import { expect, test, type Page, type Response } from '@playwright/test';

const BTC = 'crypto:BTC';
const LAYOUT = { symbol: BTC, tf: '1D', session: 'rth', chartType: 'candle', indicators: [] };
const drawingsPath = `/api/drawings/${encodeURIComponent(BTC)}`;

type Saved = Array<{ styles?: { line?: { color: string; size: number; style: string } } }>;
const isPut = (res: Response, path: string) => res.request().method() === 'PUT' && new URL(res.url()).pathname === path;
const drawingsSaved = async (page: Page, ok: (d: Saved) => boolean): Promise<Saved> =>
  (await page.waitForResponse((r) => isPut(r, drawingsPath) && ok(r.request().postDataJSON() as Saved))).request().postDataJSON() as Saved;
const layoutSaved = (page: Page, ok: (l: { drawingDefaults?: { size?: number; style?: string } }) => boolean) =>
  page.waitForResponse((r) => isPut(r, '/api/layouts/default') && ok(r.request().postDataJSON() as { drawingDefaults?: { size?: number; style?: string } }));

async function drawTrendLine(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const trendLine = page.getByRole('toolbar', { name: 'Drawing tools' }).getByRole('button', { name: 'Trend line', exact: true });
  await trendLine.click();
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

test('drawing style sticks: the width and dash set in the style bar are those of the next drawing, also after a reload', async ({ page, request }) => {
  expect((await request.put(drawingsPath, { data: [] })).ok()).toBe(true);
  expect((await request.put('/api/layouts/default', { data: LAYOUT })).ok()).toBe(true);
  await page.goto('/');
  const styleBar = page.getByRole('toolbar', { name: 'Drawing style' });

  const first = drawingsSaved(page, (d) => d.length === 1);
  await drawTrendLine(page, [0.3, 0.3], [0.5, 0.2]);
  await first;
  await expect(styleBar).toBeVisible();
  const sticky = layoutSaved(page, (l) => l.drawingDefaults?.size === 3 && l.drawingDefaults.style === 'dashed');
  await styleBar.getByLabel('Line width').selectOption('3');
  await styleBar.getByLabel('Line style').selectOption('dashed');
  await sticky;

  await page.reload();
  const second = drawingsSaved(page, (d) => d.length === 2);
  await drawTrendLine(page, [0.3, 0.6], [0.5, 0.5]);
  const saved = await second;
  expect(saved[1]!.styles?.line).toMatchObject({ size: 3, style: 'dashed' });
  await expect(styleBar.getByLabel('Line width')).toHaveValue('3');
  await expect(styleBar.getByLabel('Line style')).toHaveValue('dashed');
});
