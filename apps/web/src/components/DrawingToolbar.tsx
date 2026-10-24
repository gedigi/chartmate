import { useEffect, useRef, useState, type FormEvent, type JSX, type ReactNode } from 'react';
import type { ChartAdapter, DrawingTool } from '../chart/ChartAdapter';
import { clipboardShortcut, hasTextSelection, isApplePlatform, isInPopup, isModalOpen, undoShortcut } from '../keyboard';
import { scrollFade, useScrollEdges } from '../state/useScrollEdges';
import { LockIcon } from './LockIcon';
import './DrawingToolbar.css';

/** The slice of ChartAdapter the toolbar drives. */
export type DrawingControls = Pick<
  ChartAdapter,
  'startDrawing' | 'cancelDrawing' | 'clearDrawings' | 'drawingCount' | 'removeSelected' | 'copySelected' | 'pasteDrawing' | 'canPaste' | 'getSelectedDrawing' | 'setMagnet' | 'setLockAll' | 'onLockAllChange'
  | 'setMagnetOverride' | 'setShiftConstraint' | 'deselect' | 'onSelectionChange' | 'clearMeasure' | 'undo' | 'redo'
>;

export interface DrawingToolbarProps {
  /** Null until the chart exists; all buttons are disabled meanwhile. */
  controls: DrawingControls | null;
  /** Disables every button (e.g. until the current symbol's drawings are loaded) without resetting the toggles. */
  disabled?: boolean;
  /** Shown in the "clear all" confirmation. */
  ticker: string;
  /** Phone width: a horizontal strip under the chart, led by undo and redo buttons (touch has no ⌘Z). */
  compact?: boolean;
}

function Icon({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

const dot = (cx: number, cy: number) => <circle cx={cx} cy={cy} r="1.6" fill="currentColor" stroke="none" />;

const TOOLS: ReadonlyArray<{ tool: DrawingTool; label: string; icon: JSX.Element }> = [
  { tool: 'segment', label: 'Trend line', icon: <Icon><path d="M4 16L16 4" />{dot(4, 16)}{dot(16, 4)}</Icon> },
  { tool: 'rayLine', label: 'Ray', icon: <Icon><path d="M4 16L19 1" />{dot(4, 16)}{dot(11, 9)}</Icon> },
  { tool: 'straightLine', label: 'Extended line', icon: <Icon><path d="M1 19L19 1" />{dot(7, 13)}{dot(13, 7)}</Icon> },
  { tool: 'horizontalStraightLine', label: 'Horizontal line', icon: <Icon><path d="M1 10h18" />{dot(10, 10)}</Icon> },
  { tool: 'verticalStraightLine', label: 'Vertical line', icon: <Icon><path d="M10 1v18" />{dot(10, 10)}</Icon> },
  { tool: 'priceLine', label: 'Price line', icon: <Icon><path d="M3 12h11" />{dot(3, 12)}<path d="M13 8h5v4h-5z" strokeWidth="1.2" /></Icon> },
  { tool: 'parallelChannel', label: 'Parallel channel', icon: <Icon><path d="M2 13L13 2M7 18L18 7" /></Icon> },
  { tool: 'rectangle', label: 'Rectangle', icon: <Icon><rect x="3" y="5" width="14" height="10" rx="0.5" />{dot(3, 5)}{dot(17, 15)}</Icon> },
  { tool: 'fibonacciLine', label: 'Fibonacci retracement', icon: <Icon><path d="M2 3h16M2 8h16M2 12h16M2 17h16" /><path d="M4 17L16 3" strokeDasharray="2 2" /></Icon> },
  // Positions: a box split at the entry line, the arrow in the profit zone.
  { tool: 'longPosition', label: 'Long position', icon: <Icon><rect x="3" y="3" width="14" height="14" rx="1" /><path d="M3 11h14M10 9V5M8 7l2-2 2 2" /></Icon> },
  { tool: 'shortPosition', label: 'Short position', icon: <Icon><rect x="3" y="3" width="14" height="14" rx="1" /><path d="M3 9h14M10 11v4M8 13l2 2 2-2" /></Icon> },
];

const TEXT_ICON = <Icon><path d="M4 4h12M10 4v12M7.5 16h5" /></Icon>;
const MAGNET_ICON = <Icon><path d="M5 3v7a5 5 0 0 0 10 0V3h-3v7a2 2 0 0 1-4 0V3z" /><path d="M5 6h3M12 6h3" /></Icon>;
const LOCK_ICON = <LockIcon locked />;
const UNLOCK_ICON = <LockIcon locked={false} />;
const DELETE_ICON = <Icon><path d="M5 5l10 10M15 5L5 15" /></Icon>;
const UNDO_ICON = <Icon><path d="M7.5 5.5 4 9l3.5 3.5" /><path d="M4.5 9H12a4 4 0 0 1 0 8h-2" /></Icon>;
const REDO_ICON = <Icon><path d="M12.5 5.5 16 9l-3.5 3.5" /><path d="M15.5 9H8a4 4 0 0 0 0 8h2" /></Icon>;
const CLEAR_ICON = <Icon><path d="M3 5h14M8 5V3h4v2M5 5l1 12h8l1-12M8.5 8.5v5.5M11.5 8.5v5.5" /></Icon>;

type Active = DrawingTool | null;

const drawingsWord = (n: number) => (n === 1 ? 'drawing' : 'drawings');

/**
 * Confirmation of "Clear all drawings": locked drawings (own lock or "Lock all") are kept, and the question says
 * so. Null when every drawing is locked (nothing to remove).
 */
function clearQuestion({ total, locked }: { total: number; locked: number }, ticker: string): string | null {
  if (locked === 0) return `Remove all drawings on ${ticker}?`;
  const removable = total - locked;
  if (removable <= 0) return null;
  const kept = locked === 1 ? '1 locked drawing is kept' : `${locked} locked drawings are kept`;
  return `Remove ${removable} unlocked ${drawingsWord(removable)} on ${ticker}? ${kept}.`;
}

/**
 * Tool shortcuts: Option (macOS) / Alt + the physical key. Matched by `event.code`: on macOS Option+T types
 * '†', so `event.key` would never be 'T'. Add an entry here to give another tool a shortcut.
 */
export const TOOL_SHORTCUTS: Readonly<Partial<Record<DrawingTool, { code: string; key: string }>>> = {
  segment: { code: 'KeyT', key: 'T' },
  horizontalStraightLine: { code: 'KeyH', key: 'H' },
  rectangle: { code: 'KeyR', key: 'R' },
};

/** The tool whose shortcut `e` is (Alt alone + its key), or null. */
function shortcutTool(e: KeyboardEvent): DrawingTool | null {
  if (!e.altKey || e.metaKey || e.ctrlKey) return null;
  for (const [tool, s] of Object.entries(TOOL_SHORTCUTS)) if (s.code === e.code) return tool as DrawingTool;
  return null;
}

/** "⌥T" on Apple platforms, "Alt+T" elsewhere. */
function shortcutLabel(key: string): string {
  return isApplePlatform() ? `⌥${key}` : `Alt+${key}`;
}

/** A copy / paste event this soon after the key press that caused it belongs to that press. */
const KEY_EVENT_MS = 1000;

/** Inputs that take no typed text (Escape on them still deselects the drawing, e.g. a style-bar checkbox). */
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'range']);

/** True when keyboard input is going to a text field (Escape and the snap modifiers are left to it). */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((target as HTMLInputElement).type);
  return tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
    || target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/**
 * True when the focus is on any form control (inputs of every type, selects, textareas, buttons, editable
 * content): Delete/Backspace and the tool shortcuts belong to that control then, never to the drawings.
 */
function isFormControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest('input, select, textarea, button, [contenteditable]:not([contenteditable="false"])') !== null;
}

/**
 * True when the key event belongs to another widget (a region marked `data-keyboard-owner`, such as the watchlist; a
 * dialog, button, listbox / option): Delete there means something else (or nothing) and must not remove the selected
 * drawing.
 */
function isOtherWidget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest('button, [role="listbox"], [role="option"], [role="dialog"], dialog, [data-keyboard-owner]') !== null;
}

/**
 * Vertical drawing toolbar (left column of the chart): drawing tools, magnet, lock all, delete selected, clear all
 * (locked drawings are kept).
 * Keyboard: ⌘Z / ⌘⇧Z (Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y elsewhere) undoes / redoes drawing edits (text fields keep their
 * own undo), Delete/Backspace removes the selected drawing, ⌘C / ⌘V (Ctrl+C / Ctrl+V elsewhere) copies it / pastes
 * the copy (in-app clipboard), Escape cancels the active tool, holding ⌘ (macOS) / Ctrl
 * snaps the drawing being placed or dragged to OHLC values, Option/Alt+T starts a trend line, Option/Alt+H a
 * horizontal line and Option/Alt+R a rectangle (see TOOL_SHORTCUTS), holding Shift keeps trend lines / rays / extended lines / channels horizontal.
 * With no tool active, a Shift press on the chart measures (handled by the adapter); Escape removes the measure.
 */
export function DrawingToolbar({ controls, disabled: disabledProp = false, ticker, compact = false }: DrawingToolbarProps): JSX.Element {
  const [active, setActiveState] = useState<Active>(null);
  const activeRef = useRef<Active>(null);
  const setActive = (a: Active) => { activeRef.current = a; setActiveState(a); };
  const [magnet, setMagnet] = useState(false);
  const [locked, setLocked] = useState(false);
  /** The selected drawing is locked (own lock or "Lock all"): "Delete selected drawing" is disabled. */
  const [selectionLocked, setSelectionLocked] = useState(false);
  const [textPrompt, setTextPrompt] = useState<{ top: number } | null>(null);
  const [text, setText] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const [stripRef, stripEdges] = useScrollEdges();
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const disabled = !controls || disabledProp;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  // The chart (re)creates with default modes; reset local toggles when it changes.
  useEffect(() => { setActive(null); setMagnet(false); setLocked(false); }, [controls]);
  // "Lock all" mirrors the adapter: it is re-derived whenever drawings are restored (reload, symbol switch).
  useEffect(() => controls?.onLockAllChange(setLocked), [controls]);
  useEffect(() => {
    setSelectionLocked(false);
    return controls?.onSelectionChange((s) => setSelectionLocked(s?.locked === true));
  }, [controls]);

  const start = (tool: DrawingTool, opts?: { text?: string }) => {
    const c = controlsRef.current;
    if (!c) return;
    setActive(tool);
    c.startDrawing(tool, { ...opts, onEnd: () => { if (activeRef.current === tool) setActive(null); } });
  };

  /** What a click on a line tool's button does: start it, or cancel it when it is the active tool. */
  const toggleTool = (tool: DrawingTool) => {
    setTextPrompt(null);
    if (activeRef.current === tool) cancel();
    else start(tool);
  };
  const toggleToolRef = useRef(toggleTool);
  toggleToolRef.current = toggleTool;

  const cancel = () => {
    setTextPrompt(null);
    if (activeRef.current) controlsRef.current?.cancelDrawing();
    setActive(null);
  };

  // Copy / paste of drawings (in-app clipboard; the system clipboard is never read or written): ⌘C / ⌘V (Ctrl
  // elsewhere) and the 'copy' / 'paste' events, which the desktop app's Edit menu fires (on macOS its accelerators
  // may take the keys before the page sees them). One press acts once: the event a handled key causes is skipped.
  // Text fields, editable content, dialogs, popups and modals keep them, a held (repeating) key does nothing, and
  // with nothing to copy / paste (or page text selected, for copy) the browser's own action goes ahead.
  useEffect(() => {
    let lastKey: { kind: 'copy' | 'paste'; at: number; acted: boolean } | null = null;
    const blocked = (e: Event) => e.defaultPrevented || isTyping(e.target) || isInPopup(e.target) || isModalOpen();
    const run = (kind: 'copy' | 'paste'): boolean => {
      const c = controlsRef.current;
      return kind === 'copy'
        ? !hasTextSelection() && c?.copySelected() === true
        : !disabledRef.current && c?.pasteDrawing() === true;
    };
    // Chromium enables Copy / Paste with no text selected or field focused (the Edit menu's commands) only when
    // beforecopy / beforepaste is prevented: done when there is a drawing to copy / a copy to paste.
    const onBefore = (e: Event) => {
      const c = controlsRef.current;
      const can = e.type === 'beforecopy'
        ? !hasTextSelection() && c?.getSelectedDrawing() != null
        : !disabledRef.current && c?.canPaste() === true;
      if (can && !blocked(e)) e.preventDefault();
    };
    const onKey = (e: KeyboardEvent) => {
      const kind = clipboardShortcut(e);
      if (!kind || blocked(e)) return;
      const acted = !e.repeat && run(kind);
      if (acted) e.preventDefault();
      lastKey = { kind, at: performance.now(), acted };
    };
    const onClipboard = (e: Event) => {
      const kind = e.type === 'copy' ? 'copy' : 'paste';
      const k = lastKey;
      lastKey = null;
      if (k && k.kind === kind && performance.now() - k.at < KEY_EVENT_MS) {
        if (k.acted) e.preventDefault();
        return;
      }
      if (!blocked(e) && run(kind)) e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('copy', onClipboard);
    document.addEventListener('paste', onClipboard);
    document.addEventListener('beforecopy', onBefore);
    document.addEventListener('beforepaste', onBefore);
    return () => {
      document.removeEventListener('beforecopy', onBefore);
      document.removeEventListener('beforepaste', onBefore);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('copy', onClipboard);
      document.removeEventListener('paste', onClipboard);
    };
  }, []);

  // Undo / redo of drawing edits. Text fields keep their own undo; dialogs, popups and modals keep the keys. With
  // nothing to undo the browser's own action goes ahead. In the desktop app the Edit menu's accelerator only gets the
  // key when the page leaves it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const kind = undoShortcut(e);
      if (!kind || e.defaultPrevented || isTyping(e.target) || isInPopup(e.target) || isModalOpen() || disabledRef.current) return;
      const c = controlsRef.current;
      if (kind === 'undo' ? c?.undo() : c?.redo()) e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tool = shortcutTool(e);
      if (tool) {
        if (isFormControl(e.target) || isInPopup(e.target) || disabledRef.current || e.defaultPrevented) return;
        e.preventDefault();
        toggleToolRef.current(tool);
        return;
      }
      if (e.key === 'Escape') {
        if (!isTyping(e.target) && !isInPopup(e.target) && !e.defaultPrevented) {
          cancel();
          controlsRef.current?.deselect(); // closes the drawing style bar
          controlsRef.current?.clearMeasure(); // removes the Shift measure
        }
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !isFormControl(e.target) && !isOtherWidget(e.target) && !disabledRef.current) {
        if (controlsRef.current?.removeSelected()) e.preventDefault();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // ⌘ (macOS) / Ctrl held: the drawing being placed or dragged snaps to OHLC values (strong magnet).
  useEffect(() => {
    if (!controls) return;
    const modifier = isApplePlatform() ? 'Meta' : 'Control';
    let held = false;
    const set = (v: boolean) => {
      if (held === v) return;
      held = v;
      controls.setMagnetOverride(v);
    };
    const onDown = (e: KeyboardEvent) => { if (e.key === modifier && !isTyping(e.target)) set(true); };
    const onUp = (e: KeyboardEvent) => { if (e.key === modifier) set(false); };
    const onBlur = () => set(false); // e.g. ⌘-Tab away: the keyup never arrives
    const onVisibility = () => { if (document.hidden) set(false); };
    // A pointer event without the modifier means it was released where we did not see the keyup.
    const onPointer = (e: PointerEvent) => {
      if (held && !(modifier === 'Meta' ? e.metaKey : e.ctrlKey)) set(false);
    };
    document.addEventListener('keydown', onDown);
    document.addEventListener('keyup', onUp);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('pointermove', onPointer, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onDown);
      document.removeEventListener('keyup', onUp);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('pointermove', onPointer, true);
      window.removeEventListener('blur', onBlur);
      set(false);
    };
  }, [controls]);

  // Shift held: trend lines, rays, extended lines and channels being placed or dragged stay horizontal.
  useEffect(() => {
    if (!controls) return;
    let held = false;
    const set = (v: boolean) => {
      if (held === v) return;
      held = v;
      controls.setShiftConstraint(v);
    };
    const onDown = (e: KeyboardEvent) => { if (e.key === 'Shift' && !isTyping(e.target)) set(true); };
    const onUp = (e: KeyboardEvent) => { if (e.key === 'Shift') set(false); };
    const onBlur = () => set(false);
    const onVisibility = () => { if (document.hidden) set(false); };
    // Pointer events carry the real modifier state (Shift may have been pressed / released unseen).
    const onPointer = (e: PointerEvent) => set(e.shiftKey);
    document.addEventListener('keydown', onDown);
    document.addEventListener('keyup', onUp);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('pointermove', onPointer, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onDown);
      document.removeEventListener('keyup', onUp);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('pointermove', onPointer, true);
      window.removeEventListener('blur', onBlur);
      set(false);
    };
  }, [controls]);

  const openTextPrompt = (btn: HTMLElement) => {
    const root = rootRef.current;
    const top = root ? btn.getBoundingClientRect().top - root.getBoundingClientRect().top : 0;
    setText('');
    setTextPrompt({ top });
  };

  const submitText = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setTextPrompt(null);
    start('simpleAnnotation', { text: t });
  };

  const toolButton = (tool: DrawingTool, label: string, icon: JSX.Element, onClick: (btn: HTMLElement) => void) => {
    const shortcut = TOOL_SHORTCUTS[tool];
    return (
    <button
      key={tool}
      type="button"
      className="dt-btn"
      title={shortcut ? `${label} (${shortcutLabel(shortcut.key)})` : label}
      aria-label={label}
      aria-keyshortcuts={shortcut ? `Alt+${shortcut.key}` : undefined}
      aria-pressed={active === tool}
      disabled={disabled}
      onClick={(e) => onClick(e.currentTarget)}
    >{icon}</button>
    );
  };

  return (
    <div className={`drawing-toolbar${compact ? ' drawing-toolbar-compact' : ''}`} ref={rootRef}>
      <div className={`dt-scroll${compact ? ' edge-fade' : ''}`} ref={compact ? stripRef : undefined} data-fade={compact ? scrollFade(stripEdges) : undefined}
        role="toolbar" aria-orientation={compact ? 'horizontal' : 'vertical'} aria-label="Drawing tools">
        {compact && (
          <>
            <button type="button" className="dt-btn" aria-label="Undo" title="Undo" disabled={disabled} onClick={() => controls?.undo()}>{UNDO_ICON}</button>
            <button type="button" className="dt-btn" aria-label="Redo" title="Redo" disabled={disabled} onClick={() => controls?.redo()}>{REDO_ICON}</button>
            <div className="dt-sep" role="separator" />
          </>
        )}
        {TOOLS.map(({ tool, label, icon }) => toolButton(tool, label, icon, () => toggleTool(tool)))}
        {toolButton('simpleAnnotation', 'Text', TEXT_ICON, (btn) => {
          if (active === 'simpleAnnotation') cancel();
          else if (textPrompt) setTextPrompt(null);
          else openTextPrompt(btn);
        })}
        <div className="dt-sep" role="separator" />
        <button
          type="button" className="dt-btn" title="Magnet" aria-label="Magnet" aria-pressed={magnet} disabled={disabled}
          onClick={() => { const v = !magnet; setMagnet(v); controls?.setMagnet(v); }}
        >{MAGNET_ICON}</button>
        <button
          type="button" className="dt-btn" title={locked ? 'Unlock all drawings' : 'Lock all drawings'} aria-label="Lock all drawings"
          aria-pressed={locked} disabled={disabled}
          onClick={() => { const v = !locked; setLocked(v); controls?.setLockAll(v); }}
        >{locked ? LOCK_ICON : UNLOCK_ICON}</button>
        <button
          type="button" className="dt-btn" title={selectionLocked ? 'Drawing is locked' : 'Delete selected drawing (Del)'}
          aria-label="Delete selected drawing" disabled={disabled || selectionLocked}
          onClick={() => controls?.removeSelected()}
        >{DELETE_ICON}</button>
        <button
          type="button" className="dt-btn" title="Clear all drawings" aria-label="Clear all drawings" disabled={disabled}
          onClick={() => {
            if (!controls) return;
            const count = controls.drawingCount();
            if (count.total === 0) return; // nothing to remove ("Lock all" stays as it is)
            const question = clearQuestion(count, ticker);
            if (question === null) {
              window.alert(`All drawings on ${ticker} are locked. Unlock them to remove them.`);
              return;
            }
            if (!window.confirm(question)) return;
            cancel();
            controls.clearDrawings({ keepLocked: true });
          }}
        >{CLEAR_ICON}</button>
      </div>
      {textPrompt && (
        <form className="dt-popover" style={compact ? undefined : { top: textPrompt.top }} onSubmit={submitText}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setTextPrompt(null); } }}>
          <input
            autoFocus type="text" aria-label="Annotation text" placeholder="Text" maxLength={200}
            value={text} onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="dt-ok">OK</button>
          <button type="button" onClick={() => setTextPrompt(null)}>Cancel</button>
        </form>
      )}
    </div>
  );
}
