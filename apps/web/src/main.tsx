import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@nova/ui/tokens.css';
import './app.css';
import { App } from './App.tsx';
import { createApi } from './api.ts';
import { OfflineRuntime } from './offline/runtime.ts';

// The offline layer (FR-112, FR-129): answers from this device's copy and queues writes while the
// Hub is away.
const offline = new OfflineRuntime();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App api={createApi(undefined, { offline })} offline={offline} />
  </StrictMode>,
);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
