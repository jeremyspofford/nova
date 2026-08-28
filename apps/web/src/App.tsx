import { useCallback, useEffect, useRef, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { ThemeProvider } from './stores/theme-store'
import { ChatProvider } from './stores/chat-store'
import { ToastProvider } from './components/ToastProvider'
import { AuthProvider, useAuth } from './stores/auth-store'
import { AppLayout } from './components/layout/AppLayout'
import { Button } from './components/ui'
import { gateOutcome, type GateOutcome } from './lib/gate'
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
  // Keyed by person: "loaded" has to mean loaded FOR THIS PERSON, not loaded
  // at some point. Whoever the settings were read for is the only browser
  // they describe.
  const [settings, setSettings] = useState<{ personId: string; defs: SettingDef[] } | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  // What is on screen right now. Only used to answer one question: is the
  // wizard already up? If it is, waiting for a settings re-probe would tear
  // it down mid-run; anywhere else, waiting is the honest thing to do.
  const showing = useRef<GateOutcome | null>(null)

  const loadSettings = useCallback(async (personId: string) => {
    setSettingsError(null)
    try {
      const defs = await getSettings()
      setSettings({ personId, defs })
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
    void loadSettings(user.id)
  }, [user, loadSettings])

  const retry = useCallback(() => {
    void refresh()
    if (user) void loadSettings(user.id)
  }, [refresh, loadSettings, user])

  const onboardingCompleted = useCallback(async () => {
    await refresh()
    if (user) await loadSettings(user.id)
  }, [refresh, loadSettings, user])

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

  const defs = user !== null && settings?.personId === user.id ? settings.defs : null

  let outcome: GateOutcome
  if (user !== null && defs === null) {
    // Signed in, but this person's setup state has not landed. Guessing
    // "unfinished" here put a returning owner in the wizard on every single
    // login, hardware probe and all, on the way to /chat.
    //
    // The one exception is a wizard that is already running: an owner who has
    // just registered triggers this same re-probe, and blanking the screen
    // would unmount the wizard and restart it from the top.
    if (showing.current !== 'onboarding') return <Starting />
    outcome = 'onboarding'
  } else {
    outcome = gateOutcome({
      hasUsers,
      me: user,
      onboardingCompleted: defs ? settingValue(defs, 'onboarding.completed', false) : null,
    })
  }
  showing.current = outcome

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

  return <AppRoutes chatModel={defs ? settingValue(defs, 'chat.model', '') : ''} />
}

export default function App() {
  return (
    <ThemeProvider>
      {/* Above the router, deliberately: a turn survives navigating between
          routes (S1 carries #9, ruling S2-R4) only because this provider's
          lifecycle is not tied to which route is mounted beneath it. */}
      <ChatProvider>
        <ToastProvider>
          <BrowserRouter>
            <AuthProvider>
              <Gate />
            </AuthProvider>
          </BrowserRouter>
        </ToastProvider>
      </ChatProvider>
    </ThemeProvider>
  )
}
