import type { Layout, SymbolId, SymbolInfo } from '@altv/shared';
import type { JSX } from 'react';
import { IndicatorButton } from './IndicatorButton';
import { SymbolSearch } from './SymbolSearch';
import { TimeframeBar } from './TimeframeBar';

export type View = 'chart' | 'baskets';
export type Theme = 'dark' | 'light';

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
  return (
    <header className="top-bar">
      <span className="brand">altv</span>
      <div className="tabs" role="tablist" aria-label="View">
        {(['chart', 'baskets'] as const).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={p.view === v} onClick={() => p.onView(v)}>
            {v === 'chart' ? 'Chart' : 'Baskets'}
          </button>
        ))}
      </div>
      {p.view === 'chart' && (
        <>
          <SymbolSearch onSelect={p.onSelectSymbol} disabled={p.controlsDisabled} />
          <div className="symbol-label" title={symbolInfo?.name ?? layout.symbol}>
            <strong>{symbolInfo?.ticker ?? layout.symbol}</strong>
            {symbolInfo && <span className="symbol-name">{symbolInfo.name}</span>}
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
          {p.theme === 'dark' ? '☀' : '☾'}
        </button>
        {p.view === 'chart' && (
          <button type="button" className="icon-button" onClick={p.onToggleSidebar} aria-pressed={p.sidebarOpen}
            aria-label="Toggle watchlist">☰</button>
        )}
        {p.onLogout && <button type="button" onClick={p.onLogout}>Log out</button>}
      </div>
    </header>
  );
}
