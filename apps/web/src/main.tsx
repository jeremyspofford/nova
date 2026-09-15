import { trackSafeArea } from './lib/safeArea'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// The phone's real insets, measured — see src/lib/safeArea.ts.
trackSafeArea()
