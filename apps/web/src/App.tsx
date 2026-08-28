import { useCallback, useEffect, useRef, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { ThemeProvider } from './stores/theme-store'
import { ToastProvider } from './components/ToastProvider'
import { AuthProvider, useAuth } from './stores/auth-store'
import { AppLayout } from './components/layout/AppLayout'
import { Button } from './components/ui'
import { gateOutcome } from './lib/gate'
import { getSettings, settingValue, type SettingDef } from './lib/api'
import ComponentGallery from './pages/dev/ComponentGallery'
import { Login } from './pages/Login'
import { OnboardingWizard } from './pages/onboarding/OnboardingWizard'
import { ChatPage } from './pages/chat/ChatPage'
import { SettingsPage } from './pages/settings/SettingsPage'

function Centred({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-4 bg-surface-root dark:bg-transparent px-4 text-center">
      {children}
    </div>
  )
}

function Starting() {
  return (
    <Centred>
      <Loader2 className="w-6 h-6 text-accent animate-spin" />
      <p className="text-compact text-content-secondary">Starting Nova…</p>
    </Centred>
  )
}

/** Core did not answer. There is no safe guess about where to send someone. */
function Unreachable({ reason, onRetry }: { reason: string; onRetry: () => void }) {
  return (
    <Centred>
      <h1 className="text-h2 text-content-primary">Nova is not answering</h1>
      <p className="text-compact text-content-secondary max-w-md">{reason}</p>
      <Button onClick={onRetry}>Try again</Button>
    </Centred>
  )
}

function AppRoutes({ chatModel }: { chatModel: string }) {
  const location = useLocation()
  // Chat owns the whole viewport so its input can pin to the bottom — on a
  // phone that is the entire screen, since the sidebar is desktop-only.
  const fullWidth = location.pathname === '/chat'
  return (
    <AppLayout fullWidth={fullWidth}>
      <Routes>
        <Route path="/chat" element={<ChatPage initialModel={chatModel} />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/dev/components" element={<ComponentGallery />} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
    </AppLayout>
  )
}

/**
 * The gate, in core's order: does anyone exist, is this browser somebody, is
 * setup finished. Each answer comes from the server on every load — an
 * unknown answer is never optimistically treated as a yes.
 */
function Gate() {
  const { user, hasUsers, ready, unreachable, refresh } = useAuth()
  const [settings, setSettings] = useState<SettingDef[] | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  // Only the FIRST evaluation is allowed to show a loading screen. Registering
  // an owner mid-wizard makes the settings probe re-run, and blanking the
  // screen there would unmount the wizard and restart it.
  const settled = useRef(false)

  const loadSettings = useCallback(async () => {
    setSettingsError(null)
    try {
      setSettings(await getSettings())
    } catch (err) {
      setSettings(null)
      setSettingsError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    if (!user) {
      setSettings(null)
      setSettingsError(null)
      return
    }
    void loadSettings()
  }, [user, loadSettings])

  const retry = useCallback(() => {
    void refresh()
    void loadSettings()
  }, [refresh, loadSettings])

  const onboardingCompleted = useCallback(async () => {
    await refresh()
    await loadSettings()
  }, [refresh, loadSettings])

  if (!ready) return <Starting />
  if (unreachable) return <Unreachable reason={unreachable} onRetry={retry} />
  if (settingsError) {
    return (
      <Unreachable
        reason={`Could not read this instance's settings, so there is no telling whether setup finished: ${settingsError}`}
        onRetry={retry}
      />
    )
  }
  // Signed in but the settings answer has not landed: waiting is honest,
  // guessing "not onboarded" would flash the wizard at people who are done.
  if (user && settings === null && !settled.current) return <Starting />

  const outcome = gateOutcome({
    hasUsers,
    me: user,
    onboardingCompleted: settings ? settingValue(settings, 'onboarding.completed', false) : null,
  })
  settled.current = true

  if (outcome === 'onboarding') {
    return (
      <Routes>
        <Route path="/onboarding" element={<OnboardingWizard onCompleted={onboardingCompleted} />} />
        <Route path="*" element={<Navigate to="/onboarding" replace />} />
      </Routes>
    )
  }

  if (outcome === 'login') {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  return <AppRoutes chatModel={settings ? settingValue(settings, 'chat.model', '') : ''} />
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <BrowserRouter>
          <AuthProvider>
            <Gate />
          </AuthProvider>
        </BrowserRouter>
      </ToastProvider>
    </ThemeProvider>
  )
}
