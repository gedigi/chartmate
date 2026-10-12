import type { Layout, SymbolId, SymbolInfo } from '@altv/shared';
import { useState, type JSX } from 'react';
import { ChartAppearanceDialog } from './ChartAppearanceDialog';
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
  const [appearanceOpen, setAppearanceOpen] = useState(false);
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
          {p.theme === 'dark' ? '☀' : '☾'}
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
            aria-label="Toggle watchlist">☰</button>
        )}
        {p.onLogout && <button type="button" onClick={p.onLogout}>Log out</button>}
      </div>
      {appearanceOpen && (
        <ChartAppearanceDialog
          appearance={layout.appearance}
          theme={p.theme}
          chartType={layout.chartType}
          onChange={(a) => setLayout((l) => {
            const { appearance: _old, ...rest } = l;
            return a ? { ...rest, appearance: a } : rest;
          })}
          onClose={() => setAppearanceOpen(false)}
        />
      )}
    </header>
  );
}
