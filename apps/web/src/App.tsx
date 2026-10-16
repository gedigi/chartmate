import { parseSymbolId, type SymbolId, type SymbolInfo } from '@chartmate/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type RefObject } from 'react';
import { api, ApiError, errorMessage, isPermanentError, setUnauthorizedHandler } from './api/client';
import { BasketsPage } from './components/BasketsPage';
import { ChartView } from './components/ChartView';
import { Login } from './components/Login';
import { DrawingsNote, DrawingsSavers } from './components/DrawingsSave';
import { SaveNote, type SaveNoteState } from './components/SaveNote';
import { TopBar, type Theme, type View } from './components/TopBar';
import { SidebarResizer } from './components/SidebarResizer';
import { SymbolDetails } from './components/SymbolDetails';
import { Watchlist } from './components/Watchlist';
import { syncShellThemeColor } from './desktopShell';
import { onBasketChanged, onBasketDeleted } from './state/useBaskets';
import { DEFAULT_LAYOUT, useLayout } from './state/useLayout';
import { loadWithRetry, retryDelayMs } from './state/retry';
import { useSidebarWidth } from './state/sidebarWidth';
import { readStored, writeStored } from './state/storage';

/** Stored as `chartmate.theme` (see state/storage.ts; public/theme-init.js reads the same key before first paint). */
const THEME_KEY = 'theme';
const SIDEBAR_BREAKPOINT = 900;

function readTheme(): Theme {
  return readStored(THEME_KEY) === 'light' ? 'light' : 'dark';
}

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  // A layout effect: data-theme must be current before the chart's (passive) effects read the CSS tokens.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    writeStored(THEME_KEY, theme);
    syncShellThemeColor(theme);
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
  | { status: 'error'; message: string; deleted: boolean };

/**
 * Info for the current symbol, distinguishing loading from a failed load. A failed load is retried with
 * backoff (2 s, 5 s, 10 s, then every 30 s), except a permanent failure (e.g. 404: an unknown symbol or a
 * deleted basket, `deleted`), which cannot succeed later; `retry()` retries at once.
 */
function useSymbolInfo(symbol: SymbolId): { state: SymbolInfoState; retry: () => void } {
  const [state, setState] = useState<{ id: SymbolId; value: SymbolInfoState } | null>(null);
  const [attemptKey, setAttemptKey] = useState(0);
  useEffect(() => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) => {
      api.symbol(symbol).then(
        (info) => { if (!canceled) setState({ id: symbol, value: { status: 'ready', info } }); },
        (err: unknown) => {
          if (canceled) return;
          const deleted = symbol.startsWith('basket:') && err instanceof ApiError && err.status === 404;
          setState({ id: symbol, value: { status: 'error', message: errorMessage(err), deleted } });
          if (!isPermanentError(err)) timer = setTimeout(() => load(attempt + 1), retryDelayMs(attempt));
        },
      );
    };
    load(0);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [symbol, attemptKey]);
  // Back to "loading" at once, so the error panel does not linger while the new attempt runs.
  const retry = useCallback(() => {
    setState(null);
    setAttemptKey((k) => k + 1);
  }, []);
  return { state: state?.id === symbol ? state.value : { status: 'loading' }, retry };
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
    // A failed lookup hides the toggle for now and is retried unless permanent (e.g. a deleted basket).
    return loadWithRetry(
      () => api.baskets.get(code),
      (b) => setBasketHasStock({ id: symbol, value: b.versions.some((v) => Object.keys(v.weights).some((id) => id.startsWith('stock:'))) }),
      () => setBasketHasStock((prev) => (prev?.id === symbol ? prev : { id: symbol, value: false })),
    );
  }, [symbol, assetClass, code, basketRev]);

  if (assetClass === 'stock') return true;
  if (assetClass === 'basket') return basketHasStock?.id === symbol && basketHasStock.value;
  return false;
}

function Shell({ theme, onToggleTheme, onLogout }: { theme: Theme; onToggleTheme: () => void; onLogout?: () => void }): JSX.Element {
  const { layout, setLayout, selectSymbol: selectLayoutSymbol, loaded, loadError, retry: retryLayout, saveError: layoutSaveError, saveStalled: layoutSaveStalled, savePermanent: layoutSavePermanent, retrySave: retryLayoutSave } = useLayout();
  const [view, setView] = useHashView();
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= SIDEBAR_BREAKPOINT);
  const sidebar = useSidebarWidth();
  const { state: symbolInfoState, retry: retrySymbolInfo } = useSymbolInfo(layout.symbol);
  const symbolInfo = symbolInfoState.status === 'ready' ? symbolInfoState.info : null;
  const symbolError = symbolInfoState.status === 'error' ? symbolInfoState.message : null;
  const symbolDeleted = symbolInfoState.status === 'error' && symbolInfoState.deleted;
  const showSession = useShowSession(layout.symbol);

  const current = useRef({ symbol: layout.symbol, failed: symbolError !== null });
  current.current = { symbol: layout.symbol, failed: symbolError !== null };
  // Re-selecting the current symbol after its info failed retries the info load.
  const selectSymbol = useCallback((id: SymbolId) => {
    if (id === current.current.symbol && current.current.failed) retrySymbolInfo();
    selectLayoutSymbol(id);
  }, [selectLayoutSymbol, retrySymbolInfo]);

  // The charted basket was deleted: switch to the first other watchlist symbol (or the default symbol).
  useEffect(() => onBasketDeleted((id) => {
    const gone: SymbolId = `basket:${id}`;
    if (current.current.symbol !== gone) return;
    const fallback = (ids: SymbolId[]) => ids.find((s) => s !== gone) ?? DEFAULT_LAYOUT.symbol;
    api.watchlist.get().then(
      (list) => fallback(list.flatMap((e) => (e.type === 'symbol' ? [e.id] : []))),
      () => fallback([]),
    ).then((next) => { if (current.current.symbol === gone) selectLayoutSymbol(next); });
  }), [selectLayoutSymbol]);
  const openChart = useCallback((id: SymbolId) => { selectSymbol(id); setView('chart'); }, [selectSymbol, setView]);

  const layoutBlocked = !loaded && loadError !== null;
  // Memoized: ChartView is memoized and must not re-render on every shell render.
  const layoutSaveNote = useMemo(() => (layoutSaveError === null ? null : {
    state: (layoutSavePermanent ? 'failed' : layoutSaveStalled ? 'stalled' : 'retrying') as SaveNoteState,
    detail: layoutSaveError, onRetry: retryLayoutSave,
  }), [layoutSaveError, layoutSavePermanent, layoutSaveStalled, retryLayoutSave]);

  return (
    <div className={`app-shell view-${view}${sidebarOpen && view === 'chart' ? '' : ' sidebar-collapsed'}`}
      ref={sidebar.shellRef as RefObject<HTMLDivElement | null>} style={{ '--sidebar-w': `${sidebar.width}px` } as CSSProperties}>
      <TopBar
        view={view}
        onView={setView}
        layout={layout}
        setLayout={setLayout}
        symbolInfo={symbolInfo}
        symbolDeleted={symbolDeleted}
        showSession={showSession}
        onSelectSymbol={selectSymbol}
        theme={theme}
        onToggleTheme={onToggleTheme}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
        onLogout={onLogout}
        controlsDisabled={!loaded}
      />
      {/* Retried with backoff; once the retries give up (a tab left open must not keep writing an old layout over
          newer changes) a manual Retry. In the chart view the note sits in the chart's note stack; elsewhere here. */}
      {view !== 'chart' && (
        <div className="save-status">
          {layoutSaveError !== null && (
            <SaveNote thing="Layout" state={layoutSavePermanent ? 'failed' : layoutSaveStalled ? 'stalled' : 'retrying'}
              detail={layoutSaveError} retryLabel="Retry saving the layout" onRetry={retryLayoutSave} />
          )}
          <DrawingsNote />
        </div>
      )}
      {/* Drawings savers live here, above the view switch: unsaved drawings keep being retried on the Baskets page. */}
      <DrawingsSavers />
      {view === 'chart' ? (
        <>
          <main className="chart-main">
            {loaded && (
              <ChartView layout={layout} setLayout={setLayout} symbolInfo={symbolInfo} symbolError={symbolError}
                symbolDeleted={symbolDeleted} onRetrySymbol={retrySymbolInfo} theme={theme}
                layoutSaveNote={layoutSaveNote} />
            )}
            {layoutBlocked && (
              <div className="center-message">
                <p role="alert">Couldn&apos;t load layout: {loadError}</p>
                <button type="button" onClick={retryLayout}>Retry</button>
              </div>
            )}
            {!loaded && !layoutBlocked && <div className="center-message">Loading layout…</div>}
          </main>
          {sidebarOpen && !layoutBlocked && (
            <>
              <SidebarResizer width={sidebar.width} min={sidebar.min} max={sidebar.max}
                onPreview={sidebar.preview} onCommit={sidebar.commit} onReset={sidebar.reset} />
              <aside className="right-sidebar" id="right-sidebar">
                <Watchlist currentSymbol={layout.symbol} onSelect={selectSymbol} />
                {loaded && <SymbolDetails symbol={layout.symbol} info={symbolInfo} />}
              </aside>
            </>
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
  /** A check was requested while one was in flight (e.g. a 401 arrived meanwhile): run one more afterwards. */
  const recheck = useRef(false);
  const loadSession = useCallback(() => {
    if (checking.current) { // coalesce bursts (e.g. several 401s at once) into one follow-up check
      recheck.current = true;
      return;
    }
    checking.current = true;
    recheck.current = false;
    api.session().then(
      (s) => setSession({ status: 'ready', ...s }),
      (err: unknown) => setSession({ status: 'error', message: errorMessage(err) }),
    ).finally(() => {
      checking.current = false;
      if (recheck.current) loadSession();
    });
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
