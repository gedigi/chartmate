import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import type { ArrangeAction, ChartAdapter } from '../chart/ChartAdapter';
import { isApplePlatform } from '../keyboard';

export type ArrangeControls = Pick<ChartAdapter, 'arrangeSelected' | 'selectedOrder'>;

/** The arrange actions: their label, and the key ([ or ]) and Shift of their ⌘ / Ctrl shortcut (see DrawingToolbar). */
export const ARRANGE_ITEMS: readonly { action: ArrangeAction; label: string; key: '[' | ']'; shift: boolean }[] = [
  { action: 'front', label: 'Bring to front', key: ']', shift: true },
  { action: 'forward', label: 'Bring forward', key: ']', shift: false },
  { action: 'backward', label: 'Send backward', key: '[', shift: false },
  { action: 'back', label: 'Send to back', key: '[', shift: true },
];

/** "⇧⌘]" / "⌘[" on Apple platforms, "Ctrl+Shift+]" / "Ctrl+[" elsewhere. */
export function arrangeShortcut(key: string, shift: boolean): string {
  if (isApplePlatform()) return `${shift ? '⇧' : ''}⌘${key}`;
  return `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}

const ARRANGE_ICON = (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <rect x="3" y="3" width="9.5" height="9.5" rx="1.6" />
    <rect x="7.5" y="7.5" width="9.5" height="9.5" rx="1.6" fill="currentColor" fillOpacity="0.28" />
  </svg>
);

/**
 * "Arrange" in the selected drawing's style bar: a menu moving the drawing to the front, one step forward, one step
 * backward or to the back of the drawings. Where drawings overlap, the top-most one is the one a click selects or a
 * drag moves. Actions that would change nothing (already at the front / back) are disabled, and so is the whole menu
 * on a locked drawing. Keyboard: Enter / Space / ArrowDown open it, arrows move, Enter picks, Escape closes; the focus
 * returns to the button.
 */
export function ArrangeMenu({ controls, locked }: { controls: ArrangeControls; locked: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  const order = controls.selectedOrder();
  const enabled = ARRANGE_ITEMS.map(({ action }) => !!order && !locked
    && !((action === 'front' || action === 'forward') ? order.atFront : order.atBack));
  const firstEnabled = Math.max(0, enabled.indexOf(true));

  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  };

  useEffect(() => { if (open) itemRefs.current[active]?.focus(); }, [open, active]);
  useEffect(() => { if (locked) setOpen(false); }, [locked]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node && rootRef.current?.contains(e.target))) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const openMenu = () => {
    if (locked || !enabled.includes(true)) return;
    setActive(firstEnabled);
    setOpen(true);
  };
  const pick = (i: number) => {
    if (!enabled[i]) return;
    controls.arrangeSelected(ARRANGE_ITEMS[i]!.action);
    close(true);
  };
  /** The next enabled item from `from` in direction `step` (wrapping), or `from` itself. */
  const move = (from: number, step: 1 | -1) => {
    for (let n = 1; n <= ARRANGE_ITEMS.length; n++) {
      const i = (from + step * n + ARRANGE_ITEMS.length) % ARRANGE_ITEMS.length;
      if (enabled[i]) return i;
    }
    return from;
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive((i) => move(i, 1)); break;
      case 'ArrowUp': e.preventDefault(); setActive((i) => move(i, -1)); break;
      case 'Home': e.preventDefault(); setActive(firstEnabled); break;
      case 'End': e.preventDefault(); setActive(Math.max(0, enabled.lastIndexOf(true))); break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(true); break;
      case 'Tab': close(false); break;
      default: break;
    }
  };

  return (
    <span className="arrange" ref={rootRef}>
      <button
        ref={buttonRef} type="button" className="arrange-button" aria-label="Arrange" title="Arrange"
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        disabled={locked || !enabled.includes(true)}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); openMenu(); } }}
      >{ARRANGE_ICON}</button>
      {open && (
        <div className="arrange-menu" role="menu" id={menuId} aria-label="Arrange" onKeyDown={onMenuKeyDown}>
          {ARRANGE_ITEMS.map((item, i) => (
            <button
              key={item.action} ref={(el) => { itemRefs.current[i] = el; }} type="button" role="menuitem"
              tabIndex={i === active ? 0 : -1} disabled={!enabled[i]} onClick={() => pick(i)}
            >
              <span>{item.label}</span>
              <kbd aria-hidden="true">{arrangeShortcut(item.key, item.shift)}</kbd>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
