/**
 * Native notifications for alerts on drawings, shown from the main process (Electron `Notification`): plain title and
 * body text, built by the embedded server from the user's own drawings and the market data, never HTML and never
 * anything from the renderer. No IPC: the server calls this directly. A click brings the window to the front.
 */

export interface NotificationLike {
  on(event: 'click', listener: () => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  show(): void;
}

export interface NotificationApi {
  isSupported(): boolean;
  new (options: { title: string; body: string; silent: boolean }): NotificationLike;
}

const MAX_TITLE = 120;
const MAX_BODY = 240;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function createAlertNotifier(deps: {
  Notification: NotificationApi;
  /** Shows and focuses the main window (creating it if it was closed). */
  focus: () => void;
  onError?: (err: unknown) => void;
}): (n: { title: string; body: string }) => void {
  // Kept until closed: a notification collected too early loses its click handler.
  const live = new Set<NotificationLike>();
  return (n) => {
    try {
      if (!deps.Notification.isSupported()) return;
      const note = new deps.Notification({ title: clip(n.title, MAX_TITLE), body: clip(n.body, MAX_BODY), silent: false });
      live.add(note);
      note.on('click', () => { live.delete(note); deps.focus(); });
      note.on('close', () => { live.delete(note); });
      note.show();
    } catch (err) {
      deps.onError?.(err);
    }
  };
}
