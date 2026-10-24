import type { JSX } from 'react';
import type { View } from './TopBar';

const ICON = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true, focusable: false } as const;

const ITEMS: { view: View; label: string; icon: JSX.Element }[] = [
  {
    view: 'chart', label: 'Chart',
    icon: (
      <svg {...ICON} strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 4v3M7 15v5M17 3v4M17 13v4" />
        <rect x="5" y="7" width="4" height="8" rx="1" />
        <rect x="15" y="7" width="4" height="6" rx="1" />
      </svg>
    ),
  },
  {
    view: 'watchlist', label: 'Watchlist',
    icon: (
      <svg {...ICON} strokeLinecap="round">
        <path d="M9 6.5h11M9 12h11M9 17.5h11" />
        <circle cx="4.75" cy="6.5" r="1" fill="currentColor" stroke="none" />
        <circle cx="4.75" cy="12" r="1" fill="currentColor" stroke="none" />
        <circle cx="4.75" cy="17.5" r="1" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    view: 'baskets', label: 'Baskets',
    icon: (
      <svg {...ICON} strokeLinejoin="round">
        <path d="M12 3.5 20 7.75 12 12 4 7.75Z" />
        <path d="m4 12 8 4.25L20 12M4 16.25l8 4.25 8-4.25" strokeLinecap="round" />
      </svg>
    ),
  },
];

/**
 * Phone width only: the views as a tab bar at the bottom of the screen, in thumb reach (page navigation, like the
 * wide top bar's: aria-current marks the open view).
 */
export function BottomNav({ view, onView }: { view: View; onView: (v: View) => void }): JSX.Element {
  return (
    <nav className="bottom-nav" aria-label="View">
      {ITEMS.map((item) => (
        <button key={item.view} type="button" aria-current={view === item.view ? 'page' : undefined} onClick={() => onView(item.view)}>
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
