import { useEffect, useId, useRef, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './Modal.css';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const focusables = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

/**
 * Accessible modal dialog rendered into document.body: role=dialog + aria-modal, labelled by its title,
 * Escape and backdrop click close it, Tab is trapped inside, and focus returns to the previously focused
 * element when it unmounts. Initial focus goes to the first element marked `data-autofocus`, else the
 * first focusable element.
 */
export function Modal({ title, onClose, children, className }: ModalProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = ref.current;
    if (el) (el.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(el)[0] ?? el).focus();
    return () => { if (prev?.isConnected) prev.focus(); };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = focusables(ref.current);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      e.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !ref.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !ref.current.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref}
        className={`modal${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="modal-header">
          <h2 id={titleId} className="modal-title">{title}</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
