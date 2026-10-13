import { describe, it, expect } from 'vitest';
import { basketQuoteExt, pctChange, type Quote } from '../src/index.js';

const q = (id: string, price: number, ext?: Quote['ext']): Quote => ({ id, price, changePct: 0, ts: 1, ...(ext ? { ext } : {}) });

describe('pctChange', () => {
  it('is the percent move from base to price', () => {
    expect(pctChange(231.4, 229.52)).toBeCloseTo(((231.4 - 229.52) / 229.52) * 100, 12);
    expect(pctChange(90, 100)).toBeCloseTo(-10, 12);
  });
  it('is null for a zero or non-finite base or price', () => {
    expect(pctChange(1, 0)).toBeNull();
    expect(pctChange(1, Number.NaN)).toBeNull();
    expect(pctChange(Number.POSITIVE_INFINITY, 1)).toBeNull();
  });
});

describe('basketQuoteExt', () => {
  it('is undefined when no constituent has an extended price', () => {
    const byId = new Map([['stock:A', q('stock:A', 10)], ['crypto:B', q('crypto:B', 5)]]);
    expect(basketQuoteExt({ 'stock:A': 2, 'crypto:B': 1 }, byId, 25)).toBeUndefined();
  });

  it('sums units × (ext price if present else regular price), change vs the basket regular value', () => {
    const byId = new Map([
      ['stock:A', q('stock:A', 10, { session: 'pre', price: 11, changePct: 10, ts: 100 })],
      ['stock:B', q('stock:B', 20)], // no pre-market print yet: its regular price counts
      ['crypto:C', q('crypto:C', 5)],
    ]);
    const units = { 'stock:A': 2, 'stock:B': 1, 'crypto:C': 4 };
    const regular = 2 * 10 + 20 + 4 * 5; // 60
    const ext = basketQuoteExt(units, byId, regular)!;
    expect(ext.session).toBe('pre');
    expect(ext.price).toBeCloseTo(2 * 11 + 20 + 4 * 5, 12); // 62
    expect(ext.changePct).toBeCloseTo((62 / 60 - 1) * 100, 12);
    expect(ext.ts).toBe(100);
  });

  it('labels post and stamps the latest extended print', () => {
    const byId = new Map([
      ['stock:A', q('stock:A', 10, { session: 'post', price: 9, changePct: -10, ts: 300 })],
      ['stock:B', q('stock:B', 20, { session: 'post', price: 21, changePct: 5, ts: 500 })],
    ]);
    expect(basketQuoteExt({ 'stock:A': 1, 'stock:B': 1 }, byId, 30)).toEqual({ session: 'post', price: 30, changePct: 0, ts: 500 });
  });

  it('is undefined when a constituent quote is missing or the regular value is not positive', () => {
    const byId = new Map([['stock:A', q('stock:A', 10, { session: 'pre', price: 11, changePct: 10, ts: 1 })]]);
    expect(basketQuoteExt({ 'stock:A': 1, 'stock:B': 1 }, byId, 10)).toBeUndefined();
    expect(basketQuoteExt({ 'stock:A': 1 }, byId, 0)).toBeUndefined();
  });
});
