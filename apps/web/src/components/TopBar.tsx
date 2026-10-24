import type { ChartAppearance, Layout, SymbolId, SymbolInfo, ThemedAppearance } from '@chartmate/shared';
import { useState, type JSX } from 'react';
import { scrollFade, useScrollEdges } from '../state/useScrollEdges';
import { AboutDialog } from './AboutDialog';
import { ChartAppearanceDialog } from './ChartAppearanceDialog';
import { IndicatorButton } from './IndicatorButton';
import { Modal } from './Modal';
import { SymbolSearch } from './SymbolSearch';
import { TimeframeBar } from './TimeframeBar';

/** The watchlist is a view of its own only at phone width (the bottom tab bar); wider, it is the chart's sidebar. */
export type View = 'chart' | 'watchlist' | 'baskets';
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
  /** The current symbol is a basket that no longer exists: labeled "Deleted basket" instead of its id. */
  symbolDeleted?: boolean;
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
  /**
   * Phone width: the views move to the bottom tab bar; the search fills the bar; the theme, chart appearance and log
   * out move into a "More" sheet; the timeframes get a row of their own.
   */
  compact?: boolean;
}

const THEME_ICON: Record<Theme, JSX.Element> = {
  dark: (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="3.4" />
      <path d="M10 2v1.8M10 16.2V18M2 10h1.8M16.2 10H18M4.3 4.3l1.3 1.3M14.4 14.4l1.3 1.3M4.3 15.7l1.3-1.3M14.4 5.6l1.3-1.3" />
    </svg>
  ),
  light: (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M16.5 12.3A7 7 0 0 1 7.7 3.5a7 7 0 1 0 8.8 8.8z" />
    </svg>
  ),
};

const APPEARANCE_ICON = (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" focusable="false">
    <circle cx="10" cy="10" r="2.6" />
    <path d="M10 1.8v2.4M10 15.8v2.4M1.8 10h2.4M15.8 10h2.4M4.2 4.2l1.7 1.7M14.1 14.1l1.7 1.7M4.2 15.8l1.7-1.7M14.1 5.9l1.7-1.7" />
    <circle cx="10" cy="10" r="5.6" />
  </svg>
);

export function TopBar(p: TopBarProps): JSX.Element {
  const { layout, setLayout, symbolInfo } = p;
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [stripRef, stripEdges] = useScrollEdges();
  const { compact } = p;
  const timeframes = (
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
  );
  const dialogs = (
    <>
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
      {appearanceOpen && (
        <ChartAppearanceDialog
          appearance={layout.appearance?.[p.theme]}
          theme={p.theme}
          chartType={layout.chartType}
          onChange={(a) => setLayout((l) => withThemeAppearance(l, p.theme, a))}
          onClose={() => setAppearanceOpen(false)}
        />
      )}
    </>
  );

  if (compact) {
    // Each sheet action closes the sheet first; a dialog it opens returns the focus to the More button.
    const fromSheet = (fn: () => void) => () => { setMoreOpen(false); fn(); };
    return (
      <header className="top-bar top-bar-compact">
        <button type="button" className="brand" onClick={() => setAboutOpen(true)} aria-label="About Chartmate" title="About Chartmate">
          <img src="/favicon.svg" alt="" width={22} height={22} />
        </button>
        {/* The watchlist has its own add field and the baskets page its own title: no search there. */}
        {p.view === 'chart'
          ? <SymbolSearch onSelect={p.onSelectSymbol} disabled={p.controlsDisabled} />
          : <span className="top-bar-grow" aria-hidden="true" />}
        {p.view === 'chart' && <IndicatorButton layout={layout} setLayout={setLayout} disabled={p.controlsDisabled} iconOnly />}
        <button type="button" className="icon-button" aria-haspopup="dialog" aria-expanded={moreOpen} aria-label="More"
          onClick={() => setMoreOpen(true)}>
          <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" focusable="false">
            <circle cx="4.5" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="15.5" cy="10" r="1.5" />
          </svg>
        </button>
        {p.view === 'chart' && (
          <div className="top-bar-strip edge-fade" ref={stripRef} data-fade={scrollFade(stripEdges)}>{timeframes}</div>
        )}
        {moreOpen && (
          <Modal title="More" onClose={() => setMoreOpen(false)} className="action-sheet">
            <div className="action-list">
              <button type="button" onClick={fromSheet(p.onToggleTheme)}>
                {THEME_ICON[p.theme]}{p.theme === 'dark' ? 'Light theme' : 'Dark theme'}
              </button>
              {p.view === 'chart' && (
                <button type="button" onClick={fromSheet(() => setAppearanceOpen(true))} disabled={p.controlsDisabled}>
                  {APPEARANCE_ICON}Chart appearance
                </button>
              )}
              <button type="button" onClick={fromSheet(() => setAboutOpen(true))}>
                <img src="/favicon.svg" alt="" width={16} height={16} />About Chartmate
              </button>
              {p.onLogout && <button type="button" onClick={fromSheet(p.onLogout)}>Log out</button>}
            </div>
          </Modal>
        )}
        {dialogs}
      </header>
    );
  }

  return (
    <header className="top-bar">
      {/* The brand opens About Chartmate (version, source code, license). */}
      <button type="button" className="brand" onClick={() => setAboutOpen(true)} aria-label="About Chartmate" title="About Chartmate">
        <img src="/favicon.svg" alt="" width={20} height={20} /><span className="brand-name">Chartmate</span>
      </button>
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
          <SymbolSearch onSelect={p.onSelectSymbol} disabled={p.controlsDisabled} shortcut />
          <div className="symbol-label" title={symbolInfo?.name ?? (p.symbolDeleted ? 'Deleted basket' : layout.symbol)}>
            <strong>{symbolInfo?.ticker ?? (p.symbolDeleted ? 'Deleted basket' : layout.symbol)}</strong>
            {/* A basket's ticker is its name: show it once. */}
            {symbolInfo && symbolInfo.assetClass !== 'basket' && symbolInfo.name !== symbolInfo.ticker
              && <span className="symbol-name">{symbolInfo.name}</span>}
          </div>
          <span className="top-bar-grow" aria-hidden="true" />
          {timeframes}
          <IndicatorButton layout={layout} setLayout={setLayout} disabled={p.controlsDisabled} />
        </>
      )}
      {p.view !== 'chart' && <span className="top-bar-grow" aria-hidden="true" />}
      <div className="top-bar-end">
        <span className="top-bar-sep" aria-hidden="true" />
        <button type="button" className="icon-button" onClick={p.onToggleTheme}
          aria-label={p.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
          {THEME_ICON[p.theme]}
        </button>
        {p.view === 'chart' && (
          <button type="button" className="icon-button" onClick={() => setAppearanceOpen(true)} disabled={p.controlsDisabled}
            aria-label="Chart appearance" title="Chart appearance">
            {APPEARANCE_ICON}
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
      {dialogs}
    </header>
  );
}
