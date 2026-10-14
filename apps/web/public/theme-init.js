// Applies the saved theme before first paint; App's effect keeps it in sync afterwards (same key as App.tsx
// THEME_KEY, see src/state/storage.ts). A separate file (not an inline <script>) so a strict CSP (script-src 'self')
// can be used.
(function () {
  try {
    var theme = localStorage.getItem('chartmate.theme');
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  } catch (e) { /* storage unavailable: keep the default */ }
})();
