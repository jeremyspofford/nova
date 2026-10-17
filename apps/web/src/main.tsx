import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@nova/ui/tokens.css';
import './app.css';
import { App } from './App.tsx';
import { createApi } from './api.ts';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App api={createApi()} />
  </StrictMode>,
);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
