import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App.tsx';
import './index.css';
import { initOwner } from '../shared/owner';

// installed first: its capture-phase key listener runs before the dashboard's own remote handler
initOwner({ mode: 'home' });

// On the TV the frosted-glass blur behind panels costs more than the GPU of a 2GB TV can redraw per remote step
// (measured ~56 ms vs ~22 ms per arrow press, DECISIONS H-008); the phone admin keeps it.
if (window.tvHub) document.documentElement.classList.add('tv-lite');

// The offline cache (service worker) from the Fully Kiosk days is retired: pages come from the TV itself, and it
// once kept an EMPTY copy of this script, fetched while a deploy was copying it -> blank screen at every start
// (DECISIONS H-019). Remove any registration and its caches.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((regs) => Promise.all(regs.map((r) => r.unregister())))
    .catch(() => {});
}
if ('caches' in window) {
  caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
