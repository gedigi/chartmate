import { expect, test, type Page, type Response } from '@playwright/test';

const BTC = 'crypto:BTC';
const LAYOUT = { symbol: BTC, tf: '1D', session: 'rth', chartType: 'candle', indicators: [] };
const drawingsPath = `/api/drawings/${encodeURIComponent(BTC)}`;

type Point = { timestamp: number; value: number };
type Saved = Array<{ name: string; points: Point[]; lock: boolean; locked?: boolean; styles?: unknown }>;

const isPut = (res: Response) => res.request().method() === 'PUT' && new URL(res.url()).pathname === drawingsPath;
/** The next drawings PUT whose body satisfies `ok`, with that body. */
const drawingsSaved = async (page: Page, ok: (d: Saved) => boolean): Promise<Saved> =>
  (await page.waitForResponse((r) => isPut(r) && ok(r.request().postDataJSON() as Saved))).request().postDataJSON() as Saved;

test('rectangle: draw with ⌥R / Alt+R, resize by an edge handle, still there after a reload, lock prevents moving', async ({ page, request }) => {
  expect((await request.put(drawingsPath, { data: [] })).ok()).toBe(true);
  expect((await request.put('/api/layouts/default', { data: LAYOUT })).ok()).toBe(true);
  await page.goto('/');
  const host = page.getByTestId('chart-host');
  await expect(host.locator('canvas').first()).toBeVisible();
  const box = (await host.boundingBox())!;
  const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

  // Narrow bars, so a corner snapped to its bar's center stays within a pixel or two of where it was clicked.
  await page.mouse.move(at(0.5, 0.5).x, at(0.5, 0.5).y);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 300);
  await page.waitForTimeout(300);

  // 1. Draw: the shortcut starts the tool, two clicks set opposite corners; two corners are saved.
  const tool = page.getByRole('toolbar', { name: 'Drawing tools' }).getByRole('button', { name: 'Rectangle', exact: true });
  await expect(tool).toBeEnabled(); // once this symbol's drawings are loaded
  await page.keyboard.press('Alt+KeyR');
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
  const a = at(0.35, 0.3);
  const b = at(0.6, 0.6);
  const drawn = drawingsSaved(page, (d) => d.length === 1);
  await page.mouse.move(a.x, a.y);
  await page.mouse.click(a.x, a.y);
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.click(b.x, b.y);
  await expect(tool).toHaveAttribute('aria-pressed', 'false');
  const [first] = await drawn;
  expect(first!.name).toBe('rectangle');
  expect(first!.points).toHaveLength(2);
  expect(first!.points[1]!.timestamp).toBeGreaterThan(first!.points[0]!.timestamp);
  expect(first!.points[0]!.value).toBeGreaterThan(first!.points[1]!.value); // the first click was higher

  // 2. Resize: the right edge's midpoint handle moves only that edge (later time, same prices).
  const styleBar = page.getByRole('toolbar', { name: 'Drawing style' });
  await expect(styleBar).toBeVisible();
  await expect(styleBar.getByLabel('Fill')).toBeChecked();
  const handle = { x: b.x, y: (a.y + b.y) / 2 };
  const resized = drawingsSaved(page, (d) => d.length === 1 && d[0]!.points[1]!.timestamp > first!.points[1]!.timestamp);
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(at(0.75, 0.45).x, handle.y, { steps: 6 });
  await page.mouse.up();
  const [second] = await resized;
  expect(second!.points[0]).toEqual(first!.points[0]);
  expect(second!.points[1]!.value).toBe(first!.points[1]!.value);

  // 3. Reload: the rectangle is still there; clicking inside it (the fill) selects it.
  await page.reload();
  await expect(host.locator('canvas').first()).toBeVisible();
  await expect(styleBar).toHaveCount(0);
  await expect.poll(async () => {
    const inside = at(0.42, 0.45);
    await page.mouse.click(inside.x, inside.y);
    return styleBar.isVisible();
  }).toBe(true);
  await expect(styleBar.getByLabel('Fill')).toBeChecked();

  // 4. Lock it: dragging its body no longer moves it.
  const locked = drawingsSaved(page, (d) => d[0]?.locked === true);
  await styleBar.getByRole('button', { name: 'Lock drawing' }).click();
  await locked;
  const inside = at(0.42, 0.45);
  await page.mouse.move(inside.x, inside.y);
  await page.mouse.down();
  await page.mouse.move(inside.x + 120, inside.y + 60, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const stored = (await (await request.get(drawingsPath)).json()) as Saved;
  expect(stored).toHaveLength(1);
  expect(stored[0]!.points).toEqual(second!.points);
  expect(stored[0]!.locked).toBe(true);
  // A locked rectangle's fill toggle is read-only.
  await expect(styleBar.getByLabel('Fill')).toBeDisabled();
});
