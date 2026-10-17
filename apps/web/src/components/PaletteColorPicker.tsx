import { isDrawingColorToken } from '@chartmate/shared';
import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type JSX, type KeyboardEvent } from 'react';
import type { DrawingSwatch } from '../chart/drawingColors';

/** A swatch as the picker lays it out: a palette reference, or the drawing's own (custom) hex. */
interface Option { key: string; color: string; name: string; token: string | null }

/** Swatches before this index are the theme colors (accent, neutrals, up / down); the rest are the palette hues. */
const THEME_ROW = 5;

/** Bottom and top edges the popover must stay within: the nearest scrolling ancestor (which clips it), else the window. */
function visibleBounds(el: HTMLElement): { top: number; bottom: number } {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden') {
      const r = p.getBoundingClientRect();
      return { top: Math.max(r.top, 0), bottom: Math.min(r.bottom, window.innerHeight) };
    }
  }
  return { top: 0, bottom: window.innerHeight };
}

/**
 * Drawing and indicator colors: a swatch button opening a small popover of theme palette swatches (accent, white /
 * black, gray, the candle up / down colors and the six indicator hues), never a free color wheel. A plain hex (saved
 * before palette references) shows as a marked "Custom" swatch, untouched until another swatch is picked.
 * Keyboard: the button opens with Enter / Space / ArrowDown; arrows move between swatches (up / down between rows),
 * Home / End, Enter / Space pick; Escape closes; the focus returns to the button.
 */
export function PaletteColorPicker({ value, swatches, disabled = false, onPick, onReset, label = 'Drawing color', id }: {
  /** The current color: a palette reference or a hex. */
  value: string;
  swatches: DrawingSwatch[];
  disabled?: boolean;
  /** A swatch was picked, also the current one (a drawing's pick still becomes the default of new drawings). */
  onPick: (token: string) => void;
  /** "Reset to default": back to the default color. */
  onReset: () => void;
  /** Accessible name of the button and the swatch list. */
  label?: string;
  /** Id of the button, for an outside <label htmlFor>. */
  id?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const popoverRef = useRef<HTMLDivElement>(null);
  /** Opens upward when the popover would be cut off below (e.g. the last rows of a scrolling dialog). */
  const [above, setAbove] = useState(false);
  /** A pointer is down inside the picker (a click there may move the focus to nothing first, see onFocusOut). */
  const pressedInside = useRef(false);
  const listId = useId();

  const custom = !isDrawingColorToken(value);
  const theme: Option[] = swatches.slice(0, THEME_ROW).map((s) => ({ key: s.token, color: s.color, name: s.name, token: s.token }));
  if (custom) theme.push({ key: 'custom', color: value, name: `Custom ${value}`, token: null });
  const palette: Option[] = swatches.slice(THEME_ROW).map((s) => ({ key: s.token, color: s.color, name: s.name, token: s.token }));
  const rows = [theme, palette];
  const flat = [...theme, ...palette];
  const selectedIndex = Math.max(0, flat.findIndex((o) => (o.token === null ? custom : o.token === value)));
  const current = flat[selectedIndex];

  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  };
  const openList = () => {
    if (disabled) return;
    setActive(selectedIndex);
    setOpen(true);
  };

  useLayoutEffect(() => {
    const pop = popoverRef.current;
    const root = rootRef.current;
    if (!open || !pop || !root) { setAbove(false); return; }
    const bounds = visibleBounds(root);
    const button = root.getBoundingClientRect();
    const height = pop.getBoundingClientRect().height;
    const gap = 11;
    setAbove(button.bottom + gap + height > bounds.bottom && button.top - gap - height >= bounds.top);
  }, [open]);
  useEffect(() => { if (open) optionRefs.current[active]?.focus(); }, [open, active]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  // A press outside closes it (the focus stays where the press put it).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const inside = e.target instanceof Node && rootRef.current?.contains(e.target) === true;
      pressedInside.current = inside;
      if (!inside) setOpen(false);
    };
    const onUp = () => { pressedInside.current = false; };
    document.addEventListener('pointerdown', onDown, true);
    // After the click handlers (bubble phase, deferred): the press is over.
    const onUpLater = () => setTimeout(onUp, 0);
    document.addEventListener('pointerup', onUpLater, true);
    document.addEventListener('pointercancel', onUp, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUpLater, true);
      document.removeEventListener('pointercancel', onUp, true);
      pressedInside.current = false;
    };
  }, [open]);

  const pick = (o: Option) => {
    if (o.token !== null) onPick(o.token);
    close(true);
  };

  /**
   * The focus left a part of the picker: close when it went outside. Focus moves within the picker are ignored, and so
   * is a move to nothing while a pointer is down inside: Safari and Firefox on macOS do not focus a clicked button, so
   * the swatch loses the focus to nothing before the click on Reset (or another swatch) arrives.
   */
  const onFocusOut = (e: FocusEvent<HTMLSpanElement>) => {
    if (!open) return;
    const to = e.relatedTarget;
    if (to instanceof Node && rootRef.current?.contains(to)) return;
    if (to === null && pressedInside.current) return;
    setOpen(false);
  };

  const rowOf = (i: number) => (i < theme.length ? 0 : 1);
  const colOf = (i: number) => (i < theme.length ? i : i - theme.length);
  const indexAt = (row: number, col: number) => (row === 0 ? 0 : theme.length) + Math.min(col, rows[row]!.length - 1);

  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowRight': next = (active + 1) % flat.length; break;
      case 'ArrowLeft': next = (active - 1 + flat.length) % flat.length; break;
      case 'ArrowDown': next = rowOf(active) === 0 ? indexAt(1, colOf(active)) : active; break;
      case 'ArrowUp': next = rowOf(active) === 1 ? indexAt(0, colOf(active)) : active; break;
      case 'Home': next = 0; break;
      case 'End': next = flat.length - 1; break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        pick(flat[active]!);
        return;
      default: return;
    }
    e.preventDefault();
    setActive(next);
  };

  const onRootKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation(); // closes the popover only: the drawing stays selected
      close(true);
    }
  };

  return (
    <span className="color-picker" ref={rootRef} onKeyDown={onRootKeyDown} onBlur={onFocusOut}>
      <button
        ref={buttonRef} id={id} type="button" className="color-picker-button" aria-label={label}
        title={`Color: ${current?.name ?? value}`} disabled={disabled}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); openList(); } }}
      >
        <span className="color-picker-chip" style={{ backgroundColor: current?.color ?? value }} />
      </button>
      {open && (
        <div ref={popoverRef} className={`color-picker-popover${above ? ' above' : ''}`}>
          <div id={listId} role="listbox" aria-label={label} className="color-picker-list" onKeyDown={onListKeyDown}>
            {rows.map((row, r) => (
              <div key={r} role="group" aria-label={r === 0 ? 'Theme colors' : 'Palette'} className="color-picker-row">
                {row.map((o) => {
                  const i = flat.indexOf(o);
                  const selected = i === selectedIndex;
                  return (
                    <div
                      key={o.key} ref={(el) => { optionRefs.current[i] = el; }}
                      role="option" aria-selected={selected} aria-label={o.name} title={o.name}
                      tabIndex={i === active ? 0 : -1}
                      className={`color-swatch${selected ? ' selected' : ''}${o.token === null ? ' custom' : ''}`}
                      style={{ color: o.color }}
                      onClick={() => pick(o)}
                      onFocus={() => setActive(i)}
                    >
                      <span className="color-swatch-fill" />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <button type="button" className="color-picker-reset" onClick={() => { onReset(); close(true); }}>Reset to default</button>
        </div>
      )}
    </span>
  );
}
