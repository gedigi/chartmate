import { useEffect, useState, type FormEvent, type JSX } from 'react';
import { api, errorMessage, type SyncStatus } from '../api/client';
import { isDesktopApp } from '../desktopShell';
import { reloadPage } from '../state/sync';
import { Modal } from './Modal';
import './SyncDialog.css';

/** Where GitHub creates a fine-grained token (the user limits it to the one repository). */
export const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

/** "just now", "5 min ago", "3 h ago", else the date and time. */
export function syncedAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 24 * 3600) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

type Load = { state: 'loading' } | { state: 'unsupported' } | { state: 'error'; message: string } | { state: 'ready'; status: SyncStatus };

export interface SyncDialogProps {
  onClose: () => void;
  /** The desktop app opens no links: the token address is selectable text there (default: where the page runs). */
  desktop?: boolean;
  /** Called when a sync brought data in: the page shows it after a reload (default: reloads). */
  onApplied?: () => void;
}

/**
 * Sync settings: connect a private GitHub repository (a first sync runs before anything is saved), then the
 * repository, the last sync and its error, Sync now and Disconnect. The token goes in once and is never shown again.
 */
export function SyncDialog({ onClose, desktop = isDesktopApp(), onApplied = reloadPage }: SyncDialogProps): JSX.Element {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [busy, setBusy] = useState<'connect' | 'sync' | 'disconnect' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');

  const refresh = () => api.sync.status().then(
    (s) => setLoad(s === null ? { state: 'unsupported' } : { state: 'ready', status: s }),
    (err: unknown) => setLoad({ state: 'error', message: errorMessage(err) }),
  );
  useEffect(() => { void refresh(); }, []);

  async function act(kind: 'connect' | 'sync' | 'disconnect', fn: () => Promise<number | void>) {
    setBusy(kind);
    setError(null);
    try {
      const applied = await fn();
      if (typeof applied === 'number' && applied > 0) {
        onApplied();
        return;
      }
      if (kind === 'connect') setToken('');
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
      await refresh();
    }
    setBusy(null);
  }

  const connect = (e: FormEvent) => {
    e.preventDefault();
    void act('connect', async () => (await api.sync.configure(repo, token)).applied);
  };

  let body: JSX.Element;
  if (load.state === 'loading') body = <p className="sync-text">Loading…</p>;
  else if (load.state === 'unsupported') body = <p className="sync-text">This server does not support sync yet.</p>;
  else if (load.state === 'error') body = <p className="form-error" role="alert">{load.message}</p>;
  else if (load.status.source === null) {
    const tokenPage = desktop
      ? <span className="sync-url">{NEW_TOKEN_URL.replace(/^https:\/\//, '')}</span>
      : <a href={NEW_TOKEN_URL} target="_blank" rel="noopener noreferrer">a fine-grained token</a>;
    body = (
      <form className="sync-form" onSubmit={connect}>
        <p className="sync-text">
          Keep your watchlist, layouts, drawings and baskets the same on every device, through a private GitHub
          repository you own. Chartmate keeps one file there.
        </p>
        <ol className="sync-steps">
          <li>Create a private repository on GitHub.</li>
          <li>
            Create {desktop ? 'a fine-grained token' : tokenPage} for that repository only, with
            {' '}<strong>Contents: Read and write</strong>.{desktop && <> Go to {tokenPage}</>}
          </li>
          <li>Enter both here, then do the same on your other devices.</li>
        </ol>
        <label className="field">
          <span>Repository</span>
          <input type="text" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name"
            autoComplete="off" autoCapitalize="off" spellCheck={false} data-autofocus />
        </label>
        <label className="field">
          <span>Token</span>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…"
            autoComplete="off" spellCheck={false} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="sync-actions">
          <button type="submit" className="primary" disabled={busy !== null || repo.trim() === '' || token.trim() === ''}>
            {busy === 'connect' ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </form>
    );
  } else {
    const s = load.status;
    body = (
      <>
        <dl className="sync-facts">
          <div><dt>Repository</dt><dd>{s.repo}</dd></div>
          <div>
            <dt>Last sync</dt>
            <dd>{s.lastSyncAt === null ? 'Not yet' : syncedAgo(s.lastSyncAt)}</dd>
          </div>
          {s.lastError !== null && <div><dt>Problem</dt><dd className="sync-error">{s.lastError}</dd></div>}
        </dl>
        <p className="sync-text">
          {s.source === 'env'
            ? 'Set by the server (CHARTMATE_SYNC_REPO). Changes are sent a few seconds after you make them.'
            : 'Changes are sent a few seconds after you make them, and other devices’ changes come in when Chartmate opens.'}
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="sync-actions">
          <button type="button" className="primary" disabled={busy !== null} data-autofocus
            onClick={() => void act('sync', async () => (await api.sync.run())?.applied ?? 0)}>
            {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </button>
          {s.source === 'app' && (
            <button type="button" disabled={busy !== null} onClick={() => void act('disconnect', () => api.sync.disconnect())}>
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </button>
          )}
        </div>
        {s.source === 'app' && (
          <p className="sync-hint">Disconnecting stops syncing on this device only. Your data stays here and in the repository.</p>
        )}
      </>
    );
  }

  return (
    <Modal title="Sync" onClose={onClose} className="sync-dialog">
      {body}
    </Modal>
  );
}
