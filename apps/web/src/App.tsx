import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ThemeProvider } from './stores/theme-store'
import { ToastProvider } from './components/ToastProvider'
import { AppLayout } from './components/layout/AppLayout'
import ComponentGallery from './pages/dev/ComponentGallery'

function ChatPlaceholder() {
  return <div className="text-body text-content-secondary">Chat arrives in Task 6</div>
}

function SettingsPlaceholder() {
  return <div className="text-body text-content-secondary">Settings arrives in Task 6</div>
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <BrowserRouter>
          <AppLayout>
            <Routes>
              <Route path="/" element={<Navigate to="/dev/components" replace />} />
              <Route path="/chat" element={<ChatPlaceholder />} />
              <Route path="/settings" element={<SettingsPlaceholder />} />
              <Route path="/dev/components" element={<ComponentGallery />} />
            </Routes>
          </AppLayout>
        </BrowserRouter>
      </ToastProvider>
    </ThemeProvider>
  )
}
