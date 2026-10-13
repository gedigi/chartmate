// Applies the saved theme before first paint; App's effect keeps it in sync afterwards (same key as App.tsx
// THEME_KEY). A separate file (not an inline <script>) so a strict CSP (script-src 'self') can be used.
(function () {
  try {
    document.documentElement.dataset.theme = localStorage.getItem('altv.theme') === 'light' ? 'light' : 'dark';
  } catch (e) { /* storage unavailable: keep the default */ }
})();
