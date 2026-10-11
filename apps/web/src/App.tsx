import { parseSymbolId, type SymbolId, type SymbolInfo } from '@altv/shared';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { api, errorMessage, setUnauthorizedHandler } from './api/client';
import { BasketsPage } from './components/BasketsPage';
import { ChartView } from './components/ChartView';
import { Login } from './components/Login';
import { TopBar, type Theme, type View } from './components/TopBar';
import { Watchlist } from './components/Watchlist';
import { onBasketChanged } from './state/useBaskets';
import { useLayout } from './state/useLayout';

const THEME_KEY = 'altv.theme';
const SIDEBAR_BREAKPOINT = 900;

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage unavailable */ }
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return [theme, toggle];
}

const viewFromHash = (): View => (window.location.hash === '#/baskets' ? 'baskets' : 'chart');

function useHashView(): [View, (v: View) => void] {
  const [view, setViewState] = useState<View>(viewFromHash);
  useEffect(() => {
    const onHash = () => setViewState(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const setView = useCallback((v: View) => {
    setViewState(v);
    const hash = v === 'baskets' ? '#/baskets' : '#/';
    if (window.location.hash !== hash) window.location.hash = hash;
  }, []);
  return [view, setView];
}

type SymbolInfoState =
  | { status: 'loading' }
  | { status: 'ready'; info: SymbolInfo }
  | { status: 'error'; message: string };

/** Info for the current symbol, distinguishing loading from a failed load. */
function useSymbolInfo(symbol: SymbolId): SymbolInfoState {
  const [state, setState] = useState<{ id: SymbolId; value: SymbolInfoState } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.symbol(symbol).then(
      (info) => { if (!cancelled) setState({ id: symbol, value: { status: 'ready', info } }); },
      (err: unknown) => { if (!cancelled) setState({ id: symbol, value: { status: 'error', message: errorMessage(err) } }); },
    );
    return () => { cancelled = true; };
  }, [symbol]);
  return state?.id === symbol ? state.value : { status: 'loading' };
}

/** RTH/ETH only matters for stocks and for baskets containing at least one stock (re-checked when the basket is edited). */
function useShowSession(symbol: SymbolId): boolean {
  const [basketHasStock, setBasketHasStock] = useState<{ id: SymbolId; value: boolean } | null>(null);
  const [basketRev, setBasketRev] = useState(0);
  let assetClass: string | null = null;
  let code = '';
  try {
    ({ assetClass, code } = parseSymbolId(symbol));
  } catch { /* invalid id → no session toggle */ }

  useEffect(() => {
    if (assetClass !== 'basket') return;
    return onBasketChanged((id) => { if (id === code) setBasketRev((r) => r + 1); });
  }, [assetClass, code]);

  useEffect(() => {
    if (assetClass !== 'basket') return;
    let cancelled = false;
    api.baskets.get(code).then(
      (b) => {
        const hasStock = b.versions.some((v) => Object.keys(v.weights).some((id) => id.startsWith('stock:')));
        if (!cancelled) setBasketHasStock({ id: symbol, value: hasStock });
      },
      () => { if (!cancelled) setBasketHasStock({ id: symbol, value: false }); },
    );
    return () => { cancelled = true; };
  }, [symbol, assetClass, code, basketRev]);

  if (assetClass === 'stock') return true;
  if (assetClass === 'basket') return basketHasStock?.id === symbol && basketHasStock.value;
  return false;
}

function Shell({ theme, onToggleTheme, onLogout }: { theme: Theme; onToggleTheme: () => void; onLogout?: () => void }): JSX.Element {
  const { layout, setLayout, loaded } = useLayout();
  const [view, setView] = useHashView();
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= SIDEBAR_BREAKPOINT);
  const symbolInfoState = useSymbolInfo(layout.symbol);
  const symbolInfo = symbolInfoState.status === 'ready' ? symbolInfoState.info : null;
  const symbolError = symbolInfoState.status === 'error' ? symbolInfoState.message : null;
  const showSession = useShowSession(layout.symbol);

  const selectSymbol = useCallback((id: SymbolId) => setLayout((l) => (l.symbol === id ? l : { ...l, symbol: id })), [setLayout]);
  const openChart = useCallback((id: SymbolId) => { selectSymbol(id); setView('chart'); }, [selectSymbol, setView]);

  return (
    <div className={`app-shell view-${view}${sidebarOpen && view === 'chart' ? '' : ' sidebar-collapsed'}`}>
      <TopBar
        view={view}
        onView={setView}
        layout={layout}
        setLayout={setLayout}
        symbolInfo={symbolInfo}
        showSession={showSession}
        onSelectSymbol={selectSymbol}
        theme={theme}
        onToggleTheme={onToggleTheme}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
        onLogout={onLogout}
        controlsDisabled={!loaded}
      />
      {view === 'chart' ? (
        <>
          <main className="chart-main">
            {loaded
              ? <ChartView layout={layout} setLayout={setLayout} symbolInfo={symbolInfo} symbolError={symbolError} theme={theme} />
              : <div className="center-message">Loading layout…</div>}
          </main>
          {sidebarOpen && (
            <aside className="right-sidebar">
              <Watchlist currentSymbol={layout.symbol} onSelect={selectSymbol} />
            </aside>
          )}
        </>
      ) : (
        <main className="baskets-main">
          <BasketsPage onOpenChart={openChart} />
        </main>
      )}
    </div>
  );
}

type SessionState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; authRequired: boolean; authenticated: boolean };

export function App(): JSX.Element {
  const [theme, toggleTheme] = useTheme();
  const [session, setSession] = useState<SessionState>({ status: 'loading' });

  const checking = useRef(false);
  const loadSession = useCallback(() => {
    if (checking.current) return; // coalesce bursts (e.g. several 401s at once)
    checking.current = true;
    api.session().then(
      (s) => setSession({ status: 'ready', ...s }),
      (err: unknown) => setSession({ status: 'error', message: errorMessage(err) }),
    ).finally(() => { checking.current = false; });
  }, []);
  useEffect(loadSession, [loadSession]);
  // Session expired mid-use: any API 401 re-checks the session, which shows Login if needed.
  useEffect(() => {
    setUnauthorizedHandler(loadSession);
    return () => setUnauthorizedHandler(null);
  }, [loadSession]);

  const logout = useCallback(() => {
    api.logout().catch(() => { /* reload session regardless */ }).finally(loadSession);
  }, [loadSession]);

  if (session.status === 'loading') return <div className="center-message">Loading…</div>;
  if (session.status === 'error') {
    return (
      <div className="center-message">
        <p role="alert">Cannot reach the server: {session.message}</p>
        <button type="button" onClick={() => { setSession({ status: 'loading' }); loadSession(); }}>Retry</button>
      </div>
    );
  }
  if (session.authRequired && !session.authenticated) return <Login onSuccess={loadSession} />;
  return <Shell theme={theme} onToggleTheme={toggleTheme} onLogout={session.authRequired ? logout : undefined} />;
}
