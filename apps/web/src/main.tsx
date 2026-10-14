import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyDesktopShell } from './desktopShell';
import './styles.css';

// Frameless desktop window (app://chartmate only): before the first render, so the top bar never jumps.
applyDesktopShell();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
