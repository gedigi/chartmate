import { useEffect, useRef, useState, type FormEvent, type JSX, type ReactNode } from 'react';
import { api, errorMessage, type SyncSignIn, type SyncStatus } from '../api/client';
import { isDesktopApp } from '../desktopShell';
import { reloadPage } from '../state/sync';
import { Modal } from './Modal';
import './SyncDialog.css';

/** Where GitHub creates a fine-grained token (the "Use a token instead" path). */
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
type Step =
  | { kind: 'intro' }
  | { kind: 'token' }
  | { kind: 'code'; code: SyncSignIn }
  | { kind: 'repos'; account: string; repos: string[]; publicOnly: boolean; installUrl: string };

export interface SyncDialogProps {
  onClose: () => void;
  /** The desktop app opens no links: addresses are selectable text there (default: where the page runs). */
  desktop?: boolean;
  /** Called when a sync brought data in: the page shows it after a reload (default: reloads). */
  onApplied?: () => void;
}

/** A GitHub address: a link on the web, selectable text in the desktop app (which opens no links). */
function Address({ url, desktop, children }: { url: string; desktop: boolean; children?: ReactNode }): JSX.Element {
  if (desktop) return <span className="sync-url">{url.replace(/^https:\/\//, '')}</span>;
  return <a href={url} target="_blank" rel="noopener noreferrer">{children ?? url.replace(/^https:\/\//, '')}</a>;
}

/**
 * Sync settings. Off: sign in with GitHub (the device flow: a code to enter on github.com, then a private repository
 * the Chartmate Sync app may use), or a personal access token. On: the account, the repository, the last sync and
 * its problem, Sync now and Disconnect. Tokens never reach the page.
 */
export function SyncDialog({ onClose, desktop = isDesktopApp(), onApplied = reloadPage }: SyncDialogProps): JSX.Element {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [step, setStep] = useState<Step>({ kind: 'intro' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const [copied, setCopied] = useState(false);
  /** Bumped to stop a sign-in's polling (cancel, close, a new sign-in). */
  const attempt = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  // A new step replaces the focused button: focus its main control (the dialog itself for a text field on a touch
  // screen, as Modal does), so the keyboard and Escape keep working.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const root = bodyRef.current?.closest<HTMLElement>('[role="dialog"]');
    if (!root || root.contains(document.activeElement) && document.activeElement !== document.body) return;
    const target = root.querySelector<HTMLElement>('[data-autofocus]');
    const touch = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    (target && !(touch && target instanceof HTMLInputElement) ? target : root).focus();
  }, [step.kind, load.state === 'ready' && load.status.source]);

  const refresh = () => api.sync.status().then(
    (s) => setLoad(s === null ? { state: 'unsupported' } : { state: 'ready', status: s }),
    (err: unknown) => setLoad({ state: 'error', message: errorMessage(err) }),
  );
  useEffect(() => {
    void refresh();
    return () => { attempt.current++; };
  }, []);

  async function act(kind: string, fn: () => Promise<number | void>) {
    setBusy(kind);
    setError(null);
    try {
      const applied = await fn();
      if (typeof applied === 'number' && applied > 0) {
        onApplied();
        return;
      }
      setStep({ kind: 'intro' });
      setToken('');
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
      await refresh();
    }
    setBusy(null);
  }

  /** The repositories step from a ready poll: private ones to choose from. */
  const showRepos = (r: { account: string; repos: { repo: string; private: boolean }[]; installUrl: string }) => {
    const priv = r.repos.filter((x) => x.private).map((x) => x.repo);
    setStep({ kind: 'repos', account: r.account, repos: priv, publicOnly: priv.length === 0 && r.repos.length > 0, installUrl: r.installUrl });
    setRepo((cur) => (priv.includes(cur) ? cur : priv.length === 1 ? priv[0]! : ''));
  };

  async function signIn() {
    const mine = ++attempt.current;
    setError(null);
    setCopied(false);
    setBusy('start');
    let code: SyncSignIn;
    try {
      code = await api.sync.signIn.start();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
      return;
    }
    setBusy(null);
    setStep({ kind: 'code', code });
    let wait = code.interval;
    while (attempt.current === mine) {
      await new Promise((r) => setTimeout(r, wait * 1000));
      if (attempt.current !== mine) return;
      try {
        const r = await api.sync.signIn.poll();
        if (attempt.current !== mine) return;
        if (r.state === 'pending') { wait = Math.max(r.interval, 1); continue; }
        if (r.state === 'ready') { showRepos(r); return; }
        setError(r.state === 'denied' ? 'The sign-in was declined on GitHub.' : 'The code expired. Sign in again.');
        setStep({ kind: 'intro' });
        return;
      } catch (err) {
        if (attempt.current !== mine) return;
        setError(errorMessage(err));
        setStep({ kind: 'intro' });
        return;
      }
    }
  }

  const cancel = () => { attempt.current++; setStep({ kind: 'intro' }); setError(null); };

  async function checkRepos() {
    setBusy('check');
    setError(null);
    try {
      const r = await api.sync.signIn.poll();
      if (r.state === 'ready') showRepos(r);
      else { setError('Sign in again.'); setStep({ kind: 'intro' }); }
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(null);
  }

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => { /* selectable as text */ });
  };

  const tokenForm = (
    <form className="sync-form" onSubmit={(e: FormEvent) => { e.preventDefault(); void act('connect', async () => (await api.sync.configure(repo, token)).applied); }}>
      <ol className="sync-steps">
        <li>Create a private repository on GitHub.</li>
        <li>
          Create <Address url={NEW_TOKEN_URL} desktop={desktop}>a fine-grained token</Address> for that repository only,
          with <strong>Contents: Read and write</strong>.
        </li>
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
        <button type="button" className="sync-link" onClick={() => { setStep({ kind: 'intro' }); setError(null); }}>Back</button>
      </div>
    </form>
  );

  let body: JSX.Element;
  if (load.state === 'loading') body = <p className="sync-text">Loading…</p>;
  else if (load.state === 'unsupported') body = <p className="sync-text">This server does not support sync yet.</p>;
  else if (load.state === 'error') body = <p className="form-error" role="alert">{load.message}</p>;
  else if (step.kind === 'token') body = tokenForm;
  else if (step.kind === 'code') {
    body = (
      <div className="sync-form">
        <p className="sync-text">
          Open <Address url={step.code.verificationUri} desktop={desktop} /> and enter this code:
        </p>
        <div className="sync-code-row">
          <output className="sync-code" aria-label="Code">{step.code.userCode}</output>
          {!desktop && typeof navigator.clipboard?.writeText === 'function' && (
            <button type="button" onClick={() => copy(step.code.userCode)}>{copied ? 'Copied' : 'Copy'}</button>
          )}
        </div>
        <p className="sync-waiting" role="status"><span className="sync-dot" aria-hidden="true" />Waiting for you to approve on GitHub…</p>
        <div className="sync-actions">
          <button type="button" onClick={cancel}>Cancel</button>
        </div>
      </div>
    );
  } else if (step.kind === 'repos') {
    body = (
      <div className="sync-form">
        <p className="sync-text">Signed in as <strong className="sync-account">@{step.account}</strong>.</p>
        {step.repos.length === 0 ? (
          <>
            <p className="sync-text">
              {step.publicOnly
                ? 'Chartmate Sync can only use a private repository (anyone can read a public one).'
                : 'Now choose the repository Chartmate may use.'}
            </p>
            <ol className="sync-steps">
              <li>Create a private repository on GitHub if you don’t have one.</li>
              <li>
                Install <Address url={step.installUrl} desktop={desktop}>Chartmate Sync</Address> on it: choose
                {' '}<strong>Only select repositories</strong> and pick that one.
              </li>
            </ol>
          </>
        ) : (
          <fieldset className="sync-repos">
            <legend>Repository</legend>
            {step.repos.map((r) => (
              <label key={r}>
                <input type="radio" name="sync-repo" value={r} checked={repo === r} onChange={() => setRepo(r)} />
                <span>{r}</span>
              </label>
            ))}
          </fieldset>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="sync-actions">
          {step.repos.length === 0 ? (
            <button type="button" className="primary" disabled={busy !== null} onClick={() => void checkRepos()} data-autofocus>
              {busy === 'check' ? 'Checking…' : 'I’ve installed it'}
            </button>
          ) : (
            <button type="button" className="primary" disabled={busy !== null || repo === ''} data-autofocus
              onClick={() => void act('connect', async () => (await api.sync.signIn.connect(repo)).applied)}>
              {busy === 'connect' ? 'Connecting…' : 'Connect'}
            </button>
          )}
          <button type="button" onClick={cancel} disabled={busy === 'connect'}>Cancel</button>
        </div>
        {step.repos.length > 0 && (
          <p className="sync-hint">
            Another repository? <Address url={step.installUrl} desktop={desktop}>Add it to Chartmate Sync</Address>, then
            {' '}<button type="button" className="sync-inline" disabled={busy !== null} onClick={() => void checkRepos()}>
              {busy === 'check' ? 'refreshing…' : 'refresh the list'}
            </button>.
          </p>
        )}
      </div>
    );
  } else if (load.status.source === null) {
    body = (
      <div className="sync-form">
        <p className="sync-text">
          Keep your watchlist, layouts, drawings and baskets the same on every device, through a private GitHub
          repository you own. Chartmate keeps one file there.
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="sync-actions">
          <button type="button" className="primary" disabled={busy !== null} onClick={() => void signIn()} data-autofocus>
            {busy === 'start' ? 'Starting…' : 'Sign in with GitHub'}
          </button>
          <button type="button" className="sync-link" onClick={() => { setStep({ kind: 'token' }); setError(null); }}>
            Use a token instead
          </button>
        </div>
      </div>
    );
  } else {
    const s = load.status;
    const signedOut = s.auth === 'app' && s.lastError !== null && /sign in again/i.test(s.lastError);
    body = (
      <>
        <dl className="sync-facts">
          {s.account !== null && <div><dt>Account</dt><dd>@{s.account}</dd></div>}
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
          {signedOut ? (
            <button type="button" className="primary" disabled={busy !== null} onClick={() => void signIn()} data-autofocus>
              {busy === 'start' ? 'Starting…' : 'Sign in again'}
            </button>
          ) : (
            <button type="button" className="primary" disabled={busy !== null} data-autofocus
              onClick={() => void act('sync', async () => (await api.sync.run())?.applied ?? 0)}>
              {busy === 'sync' ? 'Syncing…' : 'Sync now'}
            </button>
          )}
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
      <div ref={bodyRef} className="sync-body">{body}</div>
    </Modal>
  );
}
