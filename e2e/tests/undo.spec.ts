import { expect, test, type Page, type Response } from '@playwright/test';

const BTC = 'crypto:BTC';
const LAYOUT = { symbol: BTC, tf: '1D', session: 'rth', chartType: 'candle', indicators: [] };
const drawingsPath = `/api/drawings/${encodeURIComponent(BTC)}`;

type Saved = Array<{ name: string }>;

const isPut = (res: Response) => res.request().method() === 'PUT' && new URL(res.url()).pathname === drawingsPath;
/** The next drawings PUT whose body satisfies `ok`, with that body. */
const drawingsSaved = async (page: Page, ok: (d: Saved) => boolean): Promise<Saved> =>
  (await page.waitForResponse((r) => isPut(r) && ok(r.request().postDataJSON() as Saved))).request().postDataJSON() as Saved;

test('undo / redo: ⌘Z / Ctrl+Z removes a new drawing, ⌘⇧Z / Ctrl+Shift+Z brings it back, each saved', async ({ page, request }) => {
  expect((await request.put(drawingsPath, { data: [] })).ok()).toBe(true);
  expect((await request.put('/api/layouts/default', { data: LAYOUT })).ok()).toBe(true);
  await page.goto('/');
  const host = page.getByTestId('chart-host');
  await expect(host.locator('canvas').first()).toBeVisible();
  const box = (await host.boundingBox())!;
  const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

  const tool = page.getByRole('toolbar', { name: 'Drawing tools' }).getByRole('button', { name: 'Rectangle', exact: true });
  await expect(tool).toBeEnabled();
  await page.keyboard.press('Alt+KeyR');
  const drawn = drawingsSaved(page, (d) => d.length === 1);
  const a = at(0.35, 0.3);
  const b = at(0.6, 0.6);
  await page.mouse.click(a.x, a.y);
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.click(b.x, b.y);
  expect((await drawn)[0]!.name).toBe('rectangle');

  const undone = drawingsSaved(page, (d) => d.length === 0);
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await undone;
  await expect(page.getByRole('toolbar', { name: 'Drawing style' })).toHaveCount(0);

  const redone = drawingsSaved(page, (d) => d.length === 1);
  await page.keyboard.press('ControlOrMeta+Shift+KeyZ');
  expect((await redone)[0]!.name).toBe('rectangle');
  await expect.poll(async () => ((await (await request.get(drawingsPath)).json()) as Saved).length).toBe(1);
});
