import { describe, expect, it, vi } from 'vitest';
import { GitHubFile, SyncRemoteError } from '../../src/sync/github.js';

const URL_ = 'https://api.github.com/repos/me/chartmate-data/contents/chartmate-sync.json';
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('GitHubFile', () => {
  it('reads the file with its sha, sending the token only to api.github.com', async () => {
    const f = vi.fn<typeof fetch>(async () => json(200, { sha: 's1', encoding: 'base64', content: b64('{"x":1}'), size: 7 }));
    const file = new GitHubFile({ repo: 'me/chartmate-data', token: 'tok' }, f);
    expect(await file.read()).toEqual({ text: '{"x":1}', sha: 's1' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(URL_);
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('a missing file reads as null; a large file is read raw', async () => {
    expect(await new GitHubFile({ repo: 'me/chartmate-data', token: 't' }, async () => json(404, {})).read()).toBeNull();
    const f = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, { sha: 's2', encoding: 'none', content: '', size: 2_000_000 }))
      .mockResolvedValueOnce(new Response('BIG', { status: 200 }));
    expect(await new GitHubFile({ repo: 'me/chartmate-data', token: 't' }, f).read()).toEqual({ text: 'BIG', sha: 's2' });
    expect((f.mock.calls[1]![1]!.headers as Record<string, string>).Accept).toBe('application/vnd.github.raw+json');
  });

  it('writes over the sha it read; a changed file is a conflict', async () => {
    const f = vi.fn<typeof fetch>(async () => json(200, { content: { sha: 's3' } }));
    const file = new GitHubFile({ repo: 'me/chartmate-data', token: 't' }, f);
    expect(await file.write('{"a":1}', 's2')).toEqual({ sha: 's3' });
    expect(JSON.parse(f.mock.calls[0]![1]!.body as string)).toEqual({ message: 'Chartmate sync', content: b64('{"a":1}'), sha: 's2' });
    expect(await new GitHubFile({ repo: 'me/chartmate-data', token: 't' }, async () => json(409, {})).write('x', 'old')).toBe('conflict');
    expect(await new GitHubFile({ repo: 'me/chartmate-data', token: 't' }, async () => json(422, {})).write('x', null)).toBe('conflict');
  });

  it('turns failures into short messages, never echoing the token', async () => {
    const msg = async (status: number, headers: Record<string, string> = {}) => {
      const file = new GitHubFile({ repo: 'me/chartmate-data', token: 'secret-token' }, async () => json(status, { message: 'x' }, headers));
      return file.read().then(() => '', (e: unknown) => (e as SyncRemoteError).message);
    };
    expect(await msg(401)).toMatch(/refused the token/);
    expect(await msg(403)).toMatch(/Contents: read and write/);
    expect(await msg(403, { 'x-ratelimit-remaining': '0' })).toMatch(/rate limit/);
    expect(await msg(500)).toBe('GitHub answered 500');
    const down = new GitHubFile({ repo: 'me/chartmate-data', token: 'secret-token' }, async () => { throw new TypeError('fetch failed'); });
    await expect(down.read()).rejects.toThrow('Could not reach GitHub');
    for (const s of [401, 403, 500]) expect(await msg(s)).not.toContain('secret-token');
  });

  it('refuses a malformed repository name', () => {
    expect(() => new GitHubFile({ repo: 'not a repo', token: 't' })).toThrow(SyncRemoteError);
    for (const repo of ['me/../x', 'me/..', 'me/.', '../x', 'me/x/y', '-me/x']) {
      expect(() => new GitHubFile({ repo, token: 't' }), repo).toThrow(SyncRemoteError);
    }
    expect(() => new GitHubFile({ repo: 'me/chartmate.data_1', token: 't' })).not.toThrow();
  });
});
