import { useState, type FormEvent, type JSX } from 'react';
import { api, ApiError, errorMessage } from '../api/client';

export function Login({ onSuccess }: { onSuccess: () => void }): JSX.Element {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError('Wrong password');
      else if (err instanceof ApiError && (err.status === 429 || err.code === 'rate_limited')) setError('Too many attempts — try again later');
      else setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-brand"><img src="/favicon.svg" alt="" width={28} height={28} />Chartmate</h1>
        <label htmlFor="login-password">Password</label>
        <input id="login-password" type="password" autoFocus autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="form-error" role="alert">{error}</div>}
        <button type="submit" className="primary" disabled={busy || password === ''}>Sign in</button>
      </form>
    </div>
  );
}
