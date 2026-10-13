import type { ChartAppearance, Layout, SymbolId, SymbolInfo, ThemedAppearance } from '@chartmate/shared';
import { useState, type JSX } from 'react';
import { ChartAppearanceDialog } from './ChartAppearanceDialog';
import { IndicatorButton } from './IndicatorButton';
import { SymbolSearch } from './SymbolSearch';
import { TimeframeBar } from './TimeframeBar';

export type View = 'chart' | 'baskets';
export type Theme = 'dark' | 'light';

/** `l` with `theme`'s appearance replaced (undefined = that theme's defaults); the other theme is kept. */
function withThemeAppearance(l: Layout, theme: Theme, a: ChartAppearance | undefined): Layout {
  const { appearance: old, ...rest } = l;
  const { [theme]: _replaced, ...others } = old ?? {};
  const next: ThemedAppearance = a ? { ...others, [theme]: a } : others;
  return Object.keys(next).length > 0 ? { ...rest, appearance: next } : rest;
}

export interface TopBarProps {
  view: View;
  onView: (v: View) => void;
  layout: Layout;
  setLayout: (fn: (l: Layout) => Layout) => void;
  symbolInfo: SymbolInfo | null;
  showSession: boolean;
  onSelectSymbol: (id: SymbolId) => void;
  theme: Theme;
  onToggleTheme: () => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** Disables symbol search, timeframe/session/chart-type and indicator controls (e.g. until the layout loaded). */
  controlsDisabled?: boolean;
  /** Shown only when the server requires a password. */
  onLogout?: () => void;
}

export function TopBar(p: TopBarProps): JSX.Element {
  const { layout, setLayout, symbolInfo } = p;
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  return (
    <header className="top-bar">
      <span className="brand"><img src="/favicon.svg" alt="" width={20} height={20} />Chartmate</span>
      {/* Page navigation (not tabs): each button switches the whole view; aria-current marks the open one. */}
      <nav className="tabs" aria-label="View">
        {(['chart', 'baskets'] as const).map((v) => (
          <button key={v} type="button" aria-current={p.view === v ? 'page' : undefined} onClick={() => p.onView(v)}>
            {v === 'chart' ? 'Chart' : 'Baskets'}
          </button>
        ))}
      </nav>
      {p.view === 'chart' && (
        <>
          <SymbolSearch onSelect={p.onSelectSymbol} disabled={p.controlsDisabled} />
          <div className="symbol-label" title={symbolInfo?.name ?? layout.symbol}>
            <strong>{symbolInfo?.ticker ?? layout.symbol}</strong>
            {/* A basket's ticker is its name: show it once. */}
            {symbolInfo && symbolInfo.assetClass !== 'basket' && symbolInfo.name !== symbolInfo.ticker
              && <span className="symbol-name">{symbolInfo.name}</span>}
          </div>
          <TimeframeBar
            tf={layout.tf}
            onTf={(tf) => setLayout((l) => ({ ...l, tf }))}
            session={layout.session}
            onSession={(session) => setLayout((l) => ({ ...l, session }))}
            showSession={p.showSession}
            chartType={layout.chartType}
            onChartType={(chartType) => setLayout((l) => ({ ...l, chartType }))}
            disabled={p.controlsDisabled}
          />
          <IndicatorButton layout={layout} setLayout={setLayout} disabled={p.controlsDisabled} />
        </>
      )}
      <div className="top-bar-end">
        <button type="button" className="icon-button" onClick={p.onToggleTheme}
          aria-label={p.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
          {p.theme === 'dark' ? (
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" focusable="false">
              <circle cx="10" cy="10" r="3.4" />
              <path d="M10 2v1.8M10 16.2V18M2 10h1.8M16.2 10H18M4.3 4.3l1.3 1.3M14.4 14.4l1.3 1.3M4.3 15.7l1.3-1.3M14.4 5.6l1.3-1.3" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <path d="M16.5 12.3A7 7 0 0 1 7.7 3.5a7 7 0 1 0 8.8 8.8z" />
            </svg>
          )}
        </button>
        {p.view === 'chart' && (
          <button type="button" className="icon-button" onClick={() => setAppearanceOpen(true)} disabled={p.controlsDisabled}
            aria-label="Chart appearance" title="Chart appearance">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" focusable="false">
              <circle cx="10" cy="10" r="2.6" />
              <path d="M10 1.8v2.4M10 15.8v2.4M1.8 10h2.4M15.8 10h2.4M4.2 4.2l1.7 1.7M14.1 14.1l1.7 1.7M4.2 15.8l1.7-1.7M14.1 5.9l1.7-1.7" />
              <circle cx="10" cy="10" r="5.6" />
            </svg>
          </button>
        )}
        {p.view === 'chart' && (
          <button type="button" className="icon-button" onClick={p.onToggleSidebar} aria-pressed={p.sidebarOpen}
            aria-label="Toggle watchlist">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" focusable="false">
              <rect x="2.8" y="3.8" width="14.4" height="12.4" rx="2" />
              <path d="M12.4 3.8v12.4" />
            </svg>
          </button>
        )}
        {p.onLogout && <button type="button" onClick={p.onLogout}>Log out</button>}
      </div>
      {appearanceOpen && (
        <ChartAppearanceDialog
          appearance={layout.appearance?.[p.theme]}
          theme={p.theme}
          chartType={layout.chartType}
          onChange={(a) => setLayout((l) => withThemeAppearance(l, p.theme, a))}
          onClose={() => setAppearanceOpen(false)}
        />
      )}
    </header>
  );
}
