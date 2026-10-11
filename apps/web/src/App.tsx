import { parseSymbolId, type SymbolId, type SymbolInfo } from '@altv/shared';
import { useCallback, useEffect, useState, type JSX } from 'react';
import { api, errorMessage } from './api/client';
import { BasketsPage } from './components/BasketsPage';
import { ChartView } from './components/ChartView';
import { Login } from './components/Login';
import { TopBar, type Theme, type View } from './components/TopBar';
import { Watchlist } from './components/Watchlist';
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

/** Info for the current symbol; null while loading or on error. */
function useSymbolInfo(symbol: SymbolId): SymbolInfo | null {
  const [state, setState] = useState<{ id: SymbolId; info: SymbolInfo | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.symbol(symbol).then(
      (info) => { if (!cancelled) setState({ id: symbol, info }); },
      () => { if (!cancelled) setState({ id: symbol, info: null }); },
    );
    return () => { cancelled = true; };
  }, [symbol]);
  return state?.id === symbol ? state.info : null;
}

/** RTH/ETH only matters for stocks and for baskets containing at least one stock. */
function useShowSession(symbol: SymbolId): boolean {
  const [basketHasStock, setBasketHasStock] = useState<{ id: SymbolId; value: boolean } | null>(null);
  let assetClass: string | null = null;
  let code = '';
  try {
    ({ assetClass, code } = parseSymbolId(symbol));
  } catch { /* invalid id → no session toggle */ }

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
  }, [symbol, assetClass, code]);

  if (assetClass === 'stock') return true;
  if (assetClass === 'basket') return basketHasStock?.id === symbol && basketHasStock.value;
  return false;
}

function Shell({ theme, onToggleTheme, onLogout }: { theme: Theme; onToggleTheme: () => void; onLogout?: () => void }): JSX.Element {
  const { layout, setLayout, loaded } = useLayout();
  const [view, setView] = useHashView();
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= SIDEBAR_BREAKPOINT);
  const symbolInfo = useSymbolInfo(layout.symbol);
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
              ? <ChartView layout={layout} setLayout={setLayout} symbolInfo={symbolInfo} theme={theme} />
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

  const loadSession = useCallback(() => {
    api.session().then(
      (s) => setSession({ status: 'ready', ...s }),
      (err: unknown) => setSession({ status: 'error', message: errorMessage(err) }),
    );
  }, []);
  useEffect(loadSession, [loadSession]);

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
