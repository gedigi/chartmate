import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type SyncStatus } from '../src/api/client';
import { NEW_TOKEN_URL, SyncDialog, syncedAgo } from '../src/components/SyncDialog';
import { startupSync, useRemoteNewer } from '../src/state/sync';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const off: SyncStatus = { source: null, repo: null, lastSyncAt: null, lastError: null };
const on: SyncStatus = { source: 'app', repo: 'me/chartmate-data', lastSyncAt: Date.now() - 120_000, lastError: null };

describe('SyncDialog', () => {
  it('off: explains the steps, links the token page, and connects with the repository and token', async () => {
    vi.spyOn(api.sync, 'status').mockResolvedValueOnce(off).mockResolvedValue(on);
    const configure = vi.spyOn(api.sync, 'configure').mockResolvedValue({ ...on, applied: 0 });
    const onApplied = vi.fn();
    render(<SyncDialog onClose={() => {}} desktop={false} onApplied={onApplied} />);
    expect(await screen.findByText(/private GitHub repository you own/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'a fine-grained token' })).toHaveAttribute('href', NEW_TOKEN_URL);
    const connect = screen.getByRole('button', { name: 'Connect' });
    expect(connect).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Repository'), 'me/chartmate-data');
    await userEvent.type(screen.getByLabelText('Token'), 'github_pat_x');
    expect(screen.getByLabelText('Token')).toHaveAttribute('type', 'password');
    await userEvent.click(connect);
    expect(configure).toHaveBeenCalledWith('me/chartmate-data', 'github_pat_x');
    expect(await screen.findByText('me/chartmate-data')).toBeInTheDocument();
    expect(screen.getByText('2 min ago')).toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('a first sync that brought data in reloads the page; a failure shows the server’s message', async () => {
    vi.spyOn(api.sync, 'status').mockResolvedValue(off);
    const configure = vi.spyOn(api.sync, 'configure')
      .mockRejectedValueOnce(new ApiError(400, 'sync_failed', 'GitHub refused the token (expired or revoked?)'))
      .mockResolvedValueOnce({ ...on, applied: 3 });
    const onApplied = vi.fn();
    render(<SyncDialog onClose={() => {}} desktop={false} onApplied={onApplied} />);
    await userEvent.type(await screen.findByLabelText('Repository'), 'me/x');
    await userEvent.type(screen.getByLabelText('Token'), 't');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('refused the token');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(configure).toHaveBeenCalledTimes(2);
  });

  it('desktop: the token page is selectable text, not a link (the app opens no links)', async () => {
    vi.spyOn(api.sync, 'status').mockResolvedValue(off);
    render(<SyncDialog onClose={() => {}} desktop />);
    expect(await screen.findByText('github.com/settings/personal-access-tokens/new')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('on: shows the last error, syncs now, and disconnects', async () => {
    vi.spyOn(api.sync, 'status').mockResolvedValueOnce({ ...on, lastError: 'Could not reach GitHub' }).mockResolvedValueOnce(on).mockResolvedValue(off);
    const run = vi.spyOn(api.sync, 'run').mockResolvedValue({ applied: 0, pushed: true });
    const disconnect = vi.spyOn(api.sync, 'disconnect').mockResolvedValue(undefined);
    render(<SyncDialog onClose={() => {}} desktop={false} onApplied={vi.fn()} />);
    expect(await screen.findByText('Could not reach GitHub')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(run).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('Could not reach GitHub')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(disconnect).toHaveBeenCalled();
    expect(await screen.findByLabelText('Repository')).toBeInTheDocument();
  });

  it('set by the server: no Disconnect; an older server says sync is not supported', async () => {
    vi.spyOn(api.sync, 'status').mockResolvedValueOnce({ ...on, source: 'env' }).mockResolvedValueOnce(null);
    const { unmount } = render(<SyncDialog onClose={() => {}} desktop={false} />);
    expect(await screen.findByText(/Set by the server/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
    unmount();
    render(<SyncDialog onClose={() => {}} desktop={false} />);
    expect(await screen.findByText(/does not support sync/)).toBeInTheDocument();
  });
});

describe('syncedAgo', () => {
  it('reads as a short relative time', () => {
    const now = 1_700_000_000_000;
    expect(syncedAgo(now - 10_000, now)).toBe('just now');
    expect(syncedAgo(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(syncedAgo(now - 3 * 3_600_000, now)).toBe('3 h ago');
  });
});

describe('startupSync', () => {
  it('waits for the sync, but not forever; a late sync that brought data in raises the reload offer', async () => {
    vi.useFakeTimers();
    let finish: (v: { applied: number; pushed: boolean }) => void = () => {};
    vi.spyOn(api.sync, 'run').mockReturnValue(new Promise((r) => { finish = r; }));
    const seen: boolean[] = [];
    function Probe() { seen.push(useRemoteNewer().newer); return null; }
    render(<Probe />);
    let done = false;
    void startupSync(1_000).then(() => { done = true; });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(done).toBe(true);
    expect(seen.at(-1)).toBe(false);
    await act(async () => { finish({ applied: 2, pushed: false }); await Promise.resolve(); });
    expect(seen.at(-1)).toBe(true);
  });

  it('never rejects (sync off, unreachable, or an older server)', async () => {
    vi.spyOn(api.sync, 'run').mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    await expect(startupSync(1_000)).resolves.toBeUndefined();
  });
});

describe('useRemoteNewer', () => {
  it('checks when the window comes back (at most once a minute) and offers a reload when another device saved newer data', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const check = vi.spyOn(api.sync, 'check').mockResolvedValue({ remoteNewer: true });
    const seen: boolean[] = [];
    let dismiss = () => {};
    function Probe() { const r = useRemoteNewer(); seen.push(r.newer); dismiss = r.dismiss; return null; }
    render(<Probe />);
    window.dispatchEvent(new Event('focus'));
    expect(check).not.toHaveBeenCalled(); // the load-time sync just ran
    vi.setSystemTime(Date.now() + 61_000);
    await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); });
    window.dispatchEvent(new Event('focus'));
    expect(check).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(seen.at(-1)).toBe(true));
    act(() => dismiss());
    expect(seen.at(-1)).toBe(false);
  });
});
