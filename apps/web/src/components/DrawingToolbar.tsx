import { useEffect, useRef, useState, type FormEvent, type JSX, type ReactNode } from 'react';
import type { ChartAdapter, DrawingTool } from '../chart/ChartAdapter';
import './DrawingToolbar.css';

/** The slice of ChartAdapter the toolbar drives. */
export type DrawingControls = Pick<
  ChartAdapter,
  'startDrawing' | 'cancelDrawing' | 'clearDrawings' | 'removeSelected' | 'setMagnet' | 'setLockAll' | 'onLockAllChange'
>;

export interface DrawingToolbarProps {
  /** Null until the chart exists; all buttons are disabled meanwhile. */
  controls: DrawingControls | null;
  /** Shown in the "clear all" confirmation. */
  ticker: string;
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
  { tool: 'parallelStraightLine', label: 'Parallel channel', icon: <Icon><path d="M2 13L13 2M7 18L18 7" /></Icon> },
  { tool: 'fibonacciLine', label: 'Fibonacci retracement', icon: <Icon><path d="M2 3h16M2 8h16M2 12h16M2 17h16" /><path d="M4 17L16 3" strokeDasharray="2 2" /></Icon> },
];

const TEXT_ICON = <Icon><path d="M4 4h12M10 4v12M7.5 16h5" /></Icon>;
const MAGNET_ICON = <Icon><path d="M5 3v7a5 5 0 0 0 10 0V3h-3v7a2 2 0 0 1-4 0V3z" /><path d="M5 6h3M12 6h3" /></Icon>;
const LOCK_ICON = <Icon><rect x="4" y="9" width="12" height="8" rx="1.5" /><path d="M7 9V6.5a3 3 0 0 1 6 0V9" /></Icon>;
const UNLOCK_ICON = <Icon><rect x="4" y="9" width="12" height="8" rx="1.5" /><path d="M7 9V6.5a3 3 0 0 1 5.8-1.1" /></Icon>;
const DELETE_ICON = <Icon><path d="M5 5l10 10M15 5L5 15" /></Icon>;
const CLEAR_ICON = <Icon><path d="M3 5h14M8 5V3h4v2M5 5l1 12h8l1-12M8.5 8.5v5.5M11.5 8.5v5.5" /></Icon>;

type Active = DrawingTool | null;

/** True when keyboard input is going to a text field (shortcuts must not fire then). */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Vertical drawing toolbar (left column of the chart): drawing tools, magnet, lock all, delete selected, clear all.
 * Keyboard: Delete/Backspace removes the selected drawing, Escape cancels the active tool.
 */
export function DrawingToolbar({ controls, ticker }: DrawingToolbarProps): JSX.Element {
  const [active, setActiveState] = useState<Active>(null);
  const activeRef = useRef<Active>(null);
  const setActive = (a: Active) => { activeRef.current = a; setActiveState(a); };
  const [magnet, setMagnet] = useState(false);
  const [locked, setLocked] = useState(false);
  const [textPrompt, setTextPrompt] = useState<{ top: number } | null>(null);
  const [text, setText] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef(controls);
  controlsRef.current = controls;

  // The chart (re)creates with default modes; reset local toggles when it changes.
  useEffect(() => { setActive(null); setMagnet(false); setLocked(false); }, [controls]);
  // "Lock all" mirrors the adapter: it is re-derived whenever drawings are restored (reload, symbol switch).
  useEffect(() => controls?.onLockAllChange(setLocked), [controls]);

  const start = (tool: DrawingTool, opts?: { text?: string }) => {
    if (!controls) return;
    setActive(tool);
    controls.startDrawing(tool, { ...opts, onEnd: () => { if (activeRef.current === tool) setActive(null); } });
  };

  const cancel = () => {
    setTextPrompt(null);
    if (activeRef.current) controlsRef.current?.cancelDrawing();
    setActive(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!isTyping(e.target)) cancel();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !isTyping(e.target)) {
        if (controlsRef.current?.removeSelected()) e.preventDefault();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

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

  const disabled = !controls;
  const toolButton = (tool: DrawingTool, label: string, icon: JSX.Element, onClick: (btn: HTMLElement) => void) => (
    <button
      key={tool}
      type="button"
      className="dt-btn"
      title={label}
      aria-label={label}
      aria-pressed={active === tool}
      disabled={disabled}
      onClick={(e) => onClick(e.currentTarget)}
    >{icon}</button>
  );

  return (
    <div className="drawing-toolbar" ref={rootRef}>
      <div className="dt-scroll" role="toolbar" aria-orientation="vertical" aria-label="Drawing tools">
        {TOOLS.map(({ tool, label, icon }) => toolButton(tool, label, icon, () => {
          setTextPrompt(null);
          if (active === tool) cancel();
          else start(tool);
        }))}
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
          type="button" className="dt-btn" title="Delete selected drawing (Del)" aria-label="Delete selected drawing" disabled={disabled}
          onClick={() => controls?.removeSelected()}
        >{DELETE_ICON}</button>
        <button
          type="button" className="dt-btn" title="Clear all drawings" aria-label="Clear all drawings" disabled={disabled}
          onClick={() => {
            if (!controls) return;
            if (!window.confirm(`Remove all drawings on ${ticker}?`)) return;
            cancel();
            controls.clearDrawings();
          }}
        >{CLEAR_ICON}</button>
      </div>
      {textPrompt && (
        <form className="dt-popover" style={{ top: textPrompt.top }} onSubmit={submitText}
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
