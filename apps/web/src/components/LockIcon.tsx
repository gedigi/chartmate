import type { JSX } from 'react';

/** Padlock, closed or open (shackle released on the right): the drawing toolbar's "Lock all" and a drawing's own lock. */
export function LockIcon({ locked, size = 20 }: { locked: boolean; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="4" y="9" width="12" height="8" rx="1.5" />
      <path d={locked ? 'M7 9V6.5a3 3 0 0 1 6 0V9' : 'M7 9V6.5a3 3 0 0 1 5.8-1.1'} />
    </svg>
  );
}

/**
 * The selected drawing's own lock toggle (style bars). Always enabled: a locked drawing stays selectable so it can
 * be unlocked. "Lock all drawings" locks it as well; then a short note says why it is read-only.
 */
export function DrawingLockToggle({ locked, ownLock, onToggle }: {
  locked: boolean; ownLock: boolean; onToggle: (locked: boolean) => void;
}): JSX.Element {
  return (
    <>
      {locked && !ownLock && <span className="drawing-style-locked" role="status">All drawings locked</span>}
      <button
        type="button" className="drawing-style-lock" aria-label="Lock drawing" aria-pressed={ownLock}
        title={ownLock ? 'Unlock drawing' : 'Lock drawing'} onClick={() => onToggle(!ownLock)}
      ><LockIcon locked={ownLock} size={16} /></button>
    </>
  );
}
