import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type SyncStatus } from '../src/api/client';
import { NEW_TOKEN_URL, SyncDialog, syncedAgo } from '../src/components/SyncDialog';
import { startupSync, useRemoteNewer } from '../src/state/sync';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const off: SyncStatus = { source: null, repo: null, auth: null, account: null, lastSyncAt: null, lastError: null };
const on: SyncStatus = { source: 'app', repo: 'me/chartmate-data', auth: 'token', account: null, lastSyncAt: Date.now() - 120_000, lastError: null };
const signedIn: SyncStatus = { ...on, auth: 'app', account: 'octocat', repo: 'octocat/chartmate-data' };
const INSTALL = 'https://github.com/apps/chartmate-sync/installations/new';
const code = { userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: Date.now() + 900_000, interval: 0 };

describe('SyncDialog: sign in with GitHub', () => {
  it('shows the code to enter on GitHub, waits for approval, then connects the only private repository', async () => {
    vi.spyOn(api.sync, 'status').mockResolvedValueOnce(off).mockResolvedValue(signedIn);
    vi.spyOn(api.sync.signIn, 'start').mockResolvedValue(code);
    const poll = vi.spyOn(api.sync.signIn, 'poll')
      .mockResolvedValueOnce({ state: 'pending', interval: 0 })
      .mockResolvedValue({ state: 'ready', account: 'octocat', installUrl: INSTALL, repos: [{ repo: 'octocat/site', private: false }, { repo: 'octocat/chartmate-data', private: true }] });
    const connect = vi.spyOn(api.sync.signIn, 'connect').mockResolvedValue({ ...signedIn, applied: 0 });
    render(<SyncDialog onClose={() => {}} desktop={false} onApplied={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }));
    expect(await screen.findByLabelText('Code')).toHaveTextContent('WDJB-MJHT');
    expect(screen.getByRole('link', { name: 'github.com/login/device' })).toHaveAttribute('href', 'https://github.com/login/device');
    expect(await screen.findByText('@octocat')).toBeInTheDocument();
    expect(poll).toHaveBeenCalledTimes(2);
    // Public repositories are never offered; the only private one is chosen.
    expect(screen.queryByRole('radio', { name: 'octocat/site' })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'octocat/chartmate-data' })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(connect).toHaveBeenCalledWith('octocat/chartmate-data');
    expect(await screen.findByText('octocat/chartmate-data')).toBeInTheDocument();
    expect(screen.getByText('@octocat')).toBeInTheDocument();
  });

  it('no repository yet: how to install the app on one, then check again', async () => {
    vi.spyOn(api.sync, 'status').mockResolvedValue(off);
    vi.spyOn(api.sync.signIn, 'start').mockResolvedValue(code);
    vi.spyOn(api.sync.signIn, 'poll')
      .mockResolvedValueOnce({ state: 'ready', account: 'octocat', installUrl: INSTALL, repos: [] })
      .mockResolvedValueOnce({ state: 'ready', account: 'octocat', installUrl: INSTALL, repos: [{ repo: 'octocat/chartmate-data', private: true }] });
    render(<SyncDialog onClose={() => {}} desktop={false} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }));
    expect(await screen.findByRole('link', { name: 'Chartmate Sync' })).toHaveAttribute('href', INSTALL);
    await userEvent.click(screen.getByRole('button', { name: 'I’ve installed it' }));
    expect(await screen.findByRole('radio', { name: 'octocat/chartmate-data' })).toBeChecked();
  });

  it('a declined sign-in says so; Cancel stops waiting', async () => {
    vi.spyOn(api.sync, 'status').mockResolvedValue(off);
    vi.spyOn(api.sync.signIn, 'start').mockResolvedValue(code);
    const poll = vi.spyOn(api.sync.signIn, 'poll').mockResolvedValueOnce({ state: 'denied' });
    render(<SyncDialog onClose={() => {}} desktop={false} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('declined');
    poll.mockResolvedValue({ state: 'pending', interval: 60 });
    vi.mocked(api.sync.signIn.start).mockResolvedValue({ ...code, interval: 60 });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument();
  });

  it('desktop: GitHub’s addresses are selectable text, not links (the app opens no links)', async () => {
    vi.spyOn(api.sync, 'status').mockResolvedValue(off);
    vi.spyOn(api.sync.signIn, 'start').mockResolvedValue({ ...code, interval: 60 });
    vi.spyOn(api.sync.signIn, 'poll').mockResolvedValue({ state: 'pending', interval: 60 });
    render(<SyncDialog onClose={() => {}} desktop />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }));
    expect(await screen.findByText('github.com/login/device')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
  });

  it('signed out by GitHub: Sign in again instead of Sync now', async () => {
    vi.spyOn(api.sync, 'status').mockResolvedValue({ ...signedIn, lastError: 'GitHub signed this device out; sign in again' });
    render(<SyncDialog onClose={() => {}} desktop={false} />);
    expect(await screen.findByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
  });
});

describe('SyncDialog: token and status', () => {
  it('“Use a token instead”: the steps, the token page, and connecting with the repository and token', async () => {
    vi.spyOn(api.sync, 'status').mockResolvedValueOnce(off).mockResolvedValue(on);
    const configure = vi.spyOn(api.sync, 'configure').mockResolvedValue({ ...on, applied: 0 });
    render(<SyncDialog onClose={() => {}} desktop={false} onApplied={vi.fn()} />);
    expect(await screen.findByText(/private GitHub repository you own/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Use a token instead' }));
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
  });

  it('switching steps keeps the focus in the dialog, so Escape still closes it', async () => {
    vi.spyOn(api.sync, 'status').mockResolvedValue(off);
    const onClose = vi.fn();
    render(<SyncDialog onClose={onClose} desktop={false} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Use a token instead' }));
    expect(screen.getByLabelText('Repository')).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('a first sync that brought data in reloads the page; a failure shows the server’s message', async () => {
    vi.spyOn(api.sync, 'status').mockResolvedValue(off);
    const configure = vi.spyOn(api.sync, 'configure')
      .mockRejectedValueOnce(new ApiError(400, 'sync_failed', 'GitHub refused the token (expired or revoked?)'))
      .mockResolvedValueOnce({ ...on, applied: 3 });
    const onApplied = vi.fn();
    render(<SyncDialog onClose={() => {}} desktop={false} onApplied={onApplied} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Use a token instead' }));
    await userEvent.type(screen.getByLabelText('Repository'), 'me/x');
    await userEvent.type(screen.getByLabelText('Token'), 't');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('refused the token');
    // The form stays, with what was typed, for another try.
    expect(screen.getByLabelText('Repository')).toHaveValue('me/x');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(configure).toHaveBeenCalledTimes(2);
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
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument();
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
