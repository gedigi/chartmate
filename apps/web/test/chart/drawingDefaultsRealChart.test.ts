import type { SymbolInfo } from '@chartmate/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/** The style of new drawings (sticky choices) against the real KLineChart (a no-op 2D context stands in for jsdom's missing canvas). */
vi.doUnmock('klinecharts');

function noopContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const target: Record<string | symbol, unknown> = {
    canvas,
    measureText: (s: string) => ({ width: s.length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    getLineDash: () => [],
  };
  return new Proxy(target, {
    get: (t, k) => (k in t ? t[k] : () => {}),
    set: (t, k, v) => { t[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) { return noopContext(this); } as never;
});

const { ChartAdapter } = await import('../../src/chart/ChartAdapter');
const { api } = await import('../../src/api/client');
const { readLine, readText } = await import('../../src/chart/drawingStyles');
const { extendOptions, fillOption, labelOptions } = await import('../../src/chart/drawingTemplates');
type Adapter = InstanceType<typeof ChartAdapter>;

const BTC: SymbolInfo = { id: 'crypto:BTC', assetClass: 'crypto', ticker: 'BTC', name: 'Bitcoin', pricePrecision: 2 };
const DAY = 86_400_000;
const D1 = Date.UTC(2024, 2, 4);

let adapter: Adapter | null = null;
afterEach(() => { adapter?.destroy(); adapter = null; vi.restoreAllMocks(); });

async function chart(): Promise<Adapter> {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: 800 });
  Object.defineProperty(el, 'clientHeight', { value: 500 });
  document.body.appendChild(el);
  const bars = Array.from({ length: 30 }, (_, i) => ({ ts: D1 + i * DAY, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
  vi.spyOn(api, 'bars').mockResolvedValue({ symbol: BTC.id, tf: '1D', session: 'rth', hasMoreBefore: false, stale: false, notices: [], markers: [], bars });
  const a = new ChartAdapter(el, { theme: 'dark' });
  adapter = a;
  await new Promise<void>((resolve) => {
    a.load({ symbol: BTC, tf: '1D', session: 'rth', pollMs: 60_000 }, { onMeta: () => resolve(), onError: () => {}, onConnection: () => {} });
  });
  return a;
}

type Priv = { drawing: { id: string } | null; chart: { getOverlays: (f: { id: string }) => Array<{ name: string; styles: unknown }> } };
/** The styles the drawing being placed starts with. */
function placing(a: Adapter, tool: Parameters<Adapter['startDrawing']>[0]): { name: string; styles: unknown } {
  a.startDrawing(tool);
  const p = a as unknown as Priv;
  const o = p.chart.getOverlays({ id: p.drawing!.id })[0]!;
  a.cancelDrawing();
  return o;
}

describe('new drawings start with the last style set in a style bar', () => {
  it('width and dash stick with the color; without a picked color the default color is kept', async () => {
    const a = await chart();
    a.setNewDrawingDefaults({ size: 3, style: 'dashed' });
    expect(readLine(placing(a, 'segment').styles)).toEqual({ color: 'accent', size: 3, style: 'dashed' });
    a.setNewDrawingColor('palette:2');
    expect(readLine(placing(a, 'rayLine').styles)).toEqual({ color: 'palette:2', size: 3, style: 'dashed' });
    a.setNewDrawingDefaults({ style: 'dotted' });
    expect(readLine(placing(a, 'rectangle').styles)).toEqual({ color: 'palette:2', size: 1, style: 'dotted' });
  });

  it('font size of text, rectangle fill, channel extend and each line tool\'s price labels', async () => {
    const a = await chart();
    a.setNewDrawingColor('palette:1');
    a.setNewDrawingDefaults({
      textSize: 18, fill: false, extend: { left: true, right: false },
      labels: { priceLine: { onLine: false, onAxis: false } },
    });
    expect(readText(placing(a, 'simpleAnnotation').styles)).toEqual({ color: 'palette:1', size: 18 });
    const rect = placing(a, 'rectangle');
    expect(fillOption(rect.name, rect.styles)).toBe(false);
    const channel = placing(a, 'parallelChannel');
    expect(extendOptions(channel.name, channel.styles)).toEqual({ left: true, right: false });
    const price = placing(a, 'priceLine');
    expect(labelOptions(price.name, price.styles)).toEqual({ onLine: false, onAxis: false });
    const horizontal = placing(a, 'horizontalStraightLine');
    expect(labelOptions(horizontal.name, horizontal.styles)).toEqual({ onLine: false, onAxis: true }); // its own default
  });

  it('nothing set: new drawings follow the default drawing style (no styles of their own); positions never take any', async () => {
    const a = await chart();
    expect(placing(a, 'segment').styles ?? null).toBeNull();
    a.setNewDrawingDefaults({ size: 4 });
    a.setNewDrawingColor('palette:3');
    expect(placing(a, 'longPosition').styles ?? null).toBeNull();
  });
});
