import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import './index.css'

// autoUpdate swaps in a new build and reloads once its worker takes over.
// The explicit checks are for the installed PWA: Android keeps it alive in
// the background, so the browser's own sw.js re-check ("on navigation")
// roughly never fires and updates only landed after a full force-close.
// Foregrounding the app — or an hourly tick while it stays open — forces
// the check instead.
registerSW({
  onRegisteredSW(_url, reg) {
    if (!reg) return
    setInterval(() => void reg.update(), 60 * 60 * 1000)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void reg.update()
    })
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
