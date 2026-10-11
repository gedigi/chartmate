import { describe, expect, it } from 'vitest';
import { getJson } from '../../src/providers/http.js';
import { ProviderError } from '../../src/errors.js';

const fetchReturning = (res: Response) => (async () => res) as typeof fetch;

describe('getJson', () => {
  it('a body read that rejects (timeout/reset mid-body) → retryable ProviderError', async () => {
    const res = new Response('{"ok":true}', { status: 200 });
    Object.defineProperty(res, 'text', { value: () => Promise.reject(new DOMException('aborted', 'TimeoutError')) });
    const err = await getJson('binance', fetchReturning(res), 'https://x.test/a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).message).toMatch(/^request failed: /);
    expect((err as ProviderError).provider).toBe('binance');
  });

  it('an empty 2xx body → retryable ProviderError (invalid response)', async () => {
    const err = await getJson('coinbase', fetchReturning(new Response('', { status: 200 })), 'https://x.test/a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).message).toMatch(/invalid response/);
  });

  it('a JSON null 2xx body → retryable ProviderError (invalid response)', async () => {
    const err = await getJson('coinbase', fetchReturning(new Response('null', { status: 200 })), 'https://x.test/a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).message).toMatch(/invalid response/);
  });

  it('a fetch timeout → retryable ProviderError', async () => {
    const f = (async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }) as typeof fetch;
    const err = await getJson('binance', f, 'https://x.test/a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
  });

  it('valid JSON passes through', async () => {
    expect(await getJson('binance', fetchReturning(new Response('[1,2]')), 'https://x.test/a')).toEqual([1, 2]);
  });
});
