/** Keyboard helpers shared by global shortcuts (drawing toolbar, symbol search). */

/** True when the event comes from inside a dialog / modal / popup: its keys belong to that, nothing else. */
export function isInPopup(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest('[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"], [role="listbox"], [role="menu"], [role="tooltip"]') !== null;
}

/** True while a modal dialog is open anywhere in the page (global shortcuts must not act behind it). */
export function isModalOpen(doc: Document = document): boolean {
  return doc.querySelector('[aria-modal="true"], dialog[open]') !== null;
}

/** macOS (and iOS) use Meta (⌘) as the command modifier; other platforms Ctrl. */
export function isApplePlatform(): boolean {
  const uaPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  return /Mac|iPhone|iPad|iPod/i.test(uaPlatform || navigator.platform);
}

/** The platform's command modifier is held (⌘ on Apple platforms, Ctrl elsewhere) — and not the other one. */
export function hasCommandModifier(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isApplePlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}
