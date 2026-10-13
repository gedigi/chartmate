// Applies the saved theme before first paint; App's effect keeps it in sync afterwards (same key as App.tsx
// THEME_KEY, see src/state/storage.ts). A theme saved before the rename to Chartmate ('altv.theme') is moved to
// 'chartmate.theme'. A separate file (not an inline <script>) so a strict CSP (script-src 'self') can be used.
(function () {
  try {
    var theme = localStorage.getItem('chartmate.theme');
    if (theme === null) {
      theme = localStorage.getItem('altv.theme');
      if (theme !== null) {
        localStorage.setItem('chartmate.theme', theme);
        localStorage.removeItem('altv.theme');
      }
    }
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  } catch (e) { /* storage unavailable: keep the default */ }
})();
