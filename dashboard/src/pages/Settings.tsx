import { useState, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Bot, Wrench, Palette, Users, Bug, Database, Lock, Code,
  CircleUser, Shield, Radio as RadioIcon, Globe,
  FileCode, Layers, Gauge, Activity, RotateCcw, HeartPulse, Bell, Mic,
  Brain, GitMerge, Wand2, ShieldAlert, Key, Target, GitPullRequest,
  Link2, Bookmark, Monitor, Settings2, ToggleRight,
} from 'lucide-react'
import { getPlatformConfig, updatePlatformConfig, type PlatformConfigEntry } from '../api'
import { PageHeader } from '../components/layout/PageHeader'
import { Section, Button, ConfirmDialog, Toast, SearchInput } from '../components/ui'
import { Tabs } from '../components/ui/Tabs'
import { useTabHash } from '../hooks/useTabHash'
import { ConfigField, useConfigValue } from './settings/shared'
import { LLMRoutingSection } from './settings/LLMRoutingSection'
import { ProviderStatusSection } from './settings/ProviderStatusSection'
import { ContextBudgetSection } from './settings/ContextBudgetSection'
import { RemoteAccessSection } from './settings/RemoteAccessSection'
import { ScreenpipeConnectionSection } from './settings/ScreenpipeConnectionSection'
import { CapturePrivacySection } from './settings/CapturePrivacySection'
import { CaptureAdvancedSection } from './settings/CaptureAdvancedSection'
import { ConnectedServicesSection } from './settings/ConnectedServicesSection'
import { AutoApproveRulesSection } from './settings/AutoApproveRulesSection'
import { RecoverySection } from './settings/RecoverySection'
import { AppearanceSection } from './settings/AppearanceSection'
import { PipelineModelsSection } from './settings/PipelineModelsSection'
import { NotificationsSection } from './settings/NotificationsSection'
import { TrustedNetworksSection } from './settings/TrustedNetworksSection'
import { DeveloperResourcesSection } from './settings/DeveloperResourcesSection'
import { AccountSection } from './settings/AccountSection'
import { GuestAccessSection } from './settings/GuestAccessSection'
import { ToolPermissionsSection } from './settings/ToolPermissionsSection'
import { SandboxSection } from './settings/SandboxSection'
import { DebugSection } from './settings/DebugSection'
import { UsersSection } from './settings/UsersSection'
import { SkillsSection } from './settings/SkillsSection'
import { RulesSection } from './settings/RulesSection'
import { KeysSection } from './settings/KeysSection'
import { AdminSecretSection } from './settings/AdminSecretSection'
import { VaultwardenSection } from './settings/VaultwardenSection'
import { SelfModSection } from './settings/SelfModSection'
import { GoalCreationSection } from './settings/GoalCreationSection'
import { MaintenanceSection } from './settings/MaintenanceSection'
import { MemoryProviderSection } from './settings/MemoryProviderSection'
import { BrainSection } from './settings/BrainSection'
import EditorSection from './settings/EditorSection'
import { FeatureFlagsSection } from './settings/FeatureFlagsSection'
import { useNovaIdentity } from '../hooks/useNovaIdentity'
import { useAuth } from '../stores/auth-store'
import { Skeleton } from '../components/ui'

// ── Tab / navigation structure ──────────────────────────────────────────────

interface NavItem {
  id: string
  label: string
  icon: React.ElementType
}

interface NavGroup {
  id: string
  label: string
  icon: React.ElementType
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'general',
    label: 'General',
    icon: Bot,
    items: [
      { id: 'identity', label: 'Nova Identity', icon: Bot },
      { id: 'appearance', label: 'Appearance', icon: Palette },
      // "How Nova reaches you" belongs on the landing tab, not buried in
      // Connections — phone push is core to the autonomy story.
      { id: 'notifications', label: 'Notifications', icon: Bell },
      { id: 'account', label: 'Account', icon: CircleUser },
    ],
  },
  {
    id: 'security',
    label: 'Security',
    icon: Lock,
    items: [
      { id: 'users', label: 'Users', icon: Users },
      { id: 'trusted-networks', label: 'Trusted Networks', icon: Lock },
      { id: 'guest-access', label: 'Guest Access', icon: Shield },
      { id: 'sandbox', label: 'Agent Sandbox', icon: Shield },
      { id: 'auto-approve-rules', label: 'Auto-Approve Rules', icon: Bookmark },
      { id: 'keys', label: 'API Keys', icon: Key },
      { id: 'admin-secret', label: 'Admin Secret', icon: ShieldAlert },
      { id: 'vault', label: 'Secrets Manager', icon: Shield },
      { id: 'selfmod', label: 'Self-Modification', icon: GitPullRequest },
    ],
  },
  {
    id: 'behavior',
    label: 'Behavior',
    icon: Wand2,
    items: [
      { id: 'skills', label: 'Skills', icon: Wand2 },
      { id: 'rules', label: 'Rules', icon: ShieldAlert },
      { id: 'goal-creation', label: 'Goal & Task Creation', icon: Target },
    ],
  },
  {
    id: 'ai',
    label: 'AI & Pipeline',
    icon: RadioIcon,
    items: [
      { id: 'llm-routing', label: 'LLM Routing', icon: RadioIcon },
      { id: 'provider-status', label: 'Provider Status', icon: Activity },
      { id: 'pipeline-models', label: 'Pipeline Models', icon: Layers },
      { id: 'context-budgets', label: 'Context Budgets', icon: Gauge },
      { id: 'tool-permissions', label: 'Tool Permissions', icon: Wrench },
      { id: 'voice', label: 'Voice', icon: Mic },
    ],
  },
  {
    id: 'memory',
    label: 'Memory',
    icon: Brain,
    items: [
      { id: 'brain', label: 'Brain', icon: Brain },
      { id: 'memory-provider', label: 'Memory', icon: Database },
      { id: 'maintenance', label: 'Maintenance', icon: Wrench },
    ],
  },
  {
    id: 'connections',
    label: 'Connections',
    icon: Globe,
    items: [
      { id: 'connected-services', label: 'Connected Services', icon: Link2 },
      { id: 'remote-access', label: 'Remote Access', icon: Globe },
      { id: 'screenpipe', label: 'Screenpipe', icon: Monitor },
      { id: 'capture-privacy', label: 'Capture Privacy', icon: ShieldAlert },
      { id: 'capture-advanced', label: 'Capture Advanced', icon: Settings2 },
      { id: 'editor', label: 'Editor', icon: Code },
    ],
  },
  {
    id: 'system',
    label: 'System',
    icon: Wrench,
    items: [
      { id: 'setup-wizard', label: 'Setup Wizard', icon: RotateCcw },
      { id: 'developer-tools', label: 'Developer Tools', icon: FileCode },
      { id: 'feature-flags', label: 'Feature Flags', icon: ToggleRight },
      { id: 'debug', label: 'Debug', icon: Bug },
      { id: 'data', label: 'Data', icon: Database },
      { id: 'recovery', label: 'Recovery', icon: HeartPulse },
    ],
  },
]

const TAB_IDS = NAV_GROUPS.map(g => g.id) as readonly string[]

const TABS = NAV_GROUPS.map(g => ({ id: g.id, label: g.label, icon: g.icon }))

/** Map every section id to its parent tab id for deep-link resolution. */
const SECTION_TO_TAB: Record<string, string> = {}
for (const group of NAV_GROUPS) {
  for (const item of group.items) {
    SECTION_TO_TAB[item.id] = group.id
  }
}

/**
 * Resolve the initial tab from the URL hash.
 * Supports both `#tab=ai` (new format) and legacy `#llm-routing` (bare section id).
 */
function resolveInitialTab(): string {
  const hash = window.location.hash.slice(1)
  if (!hash) return 'general'

  // New format: #tab=ai
  const params = new URLSearchParams(hash)
  const tabVal = params.get('tab')
  if (tabVal && TAB_IDS.includes(tabVal)) return tabVal

  // Legacy format: #llm-routing (bare section id)
  if (SECTION_TO_TAB[hash]) return SECTION_TO_TAB[hash]

  return 'general'
}

// ── Setup Wizard re-run ──────────────────────────────────────────────────────

function SetupWizardSection({ onSave }: { onSave: (key: string, value: string) => void }) {
  const [launching, setLaunching] = useState(false)

  return (
    <Section
      icon={RotateCcw}
      title="Setup Wizard"
      description="Re-run the guided setup to change your inference engine, model selection, or other initial configuration."
    >
      <div className="flex items-center gap-4">
        <Button
          variant="outline"
          size="sm"
          loading={launching}
          onClick={() => {
            setLaunching(true)
            onSave('onboarding.completed', 'false')
            // Brief delay so the config write lands before navigation
            setTimeout(() => {
              window.location.href = '/onboarding'
            }, 300)
          }}
        >
          Re-run Setup Wizard
        </Button>
        <span className="text-caption text-content-tertiary">
          Opens the onboarding flow to reconfigure hardware detection, engine, and model.
        </span>
      </div>
    </Section>
  )
}

// ── Local number setting (localStorage-backed) ──────────────────────────────

function LocalNumberField({ label, storageKey, defaultValue, min, max, step, description }: {
  label: string
  storageKey: string
  defaultValue: number
  min: number
  max: number
  step: number
  description: string
}) {
  const [value, setValue] = useState(() => {
    const stored = localStorage.getItem(storageKey)
    return stored ? Number(stored) : defaultValue
  })
  const handleChange = (v: number) => {
    const clamped = Math.min(max, Math.max(min, v))
    setValue(clamped)
    localStorage.setItem(storageKey, String(clamped))
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <label className="text-compact font-medium text-content-primary">{label}</label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={e => handleChange(Number(e.target.value))}
            className="w-28 accent-teal-500"
          />
          <span className="text-compact text-content-secondary w-14 text-right tabular-nums">{value}</span>
        </div>
      </div>
      <p className="text-micro text-content-tertiary">{description}</p>
    </div>
  )
}

// ── Data management ─────────────────────────────────────────────────────────

function DataManagementSection() {
  const qc = useQueryClient()
  const [confirmTarget, setConfirmTarget] = useState<'friction' | 'tasks' | null>(null)
  const [toast, setToast] = useState<{ variant: 'success' | 'error'; message: string } | null>(null)

  const clearFriction = useMutation({
    mutationFn: async () => {
      const { bulkDeleteFrictionEntries } = await import('../api')
      return bulkDeleteFrictionEntries()
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['friction'] })
      qc.invalidateQueries({ queryKey: ['friction-stats'] })
      setConfirmTarget(null)
      setToast({ variant: 'success', message: `Cleared ${data.deleted} friction entries` })
    },
    onError: (e) => { setConfirmTarget(null); setToast({ variant: 'error', message: String(e) }) },
  })

  const clearTasks = useMutation({
    mutationFn: async () => {
      const { bulkDeletePipelineTasks } = await import('../api')
      return bulkDeletePipelineTasks()
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['pipeline-tasks'] })
      setConfirmTarget(null)
      setToast({ variant: 'success', message: `Cleared ${data.deleted} pipeline tasks` })
    },
    onError: (e) => { setConfirmTarget(null); setToast({ variant: 'error', message: String(e) }) },
  })

  return (
    <Section icon={Database} title="Data" description="Clear accumulated data. Active/queued tasks are never deleted.">
      <div className="space-y-3">
        <div className="flex items-center justify-between py-2">
          <div>
            <p className="text-compact text-content-primary">Friction Logs</p>
            <p className="text-caption text-content-tertiary">Delete all friction log entries and screenshots.</p>
          </div>
          <Button variant="danger" size="sm" onClick={() => setConfirmTarget('friction')}>Clear All</Button>
        </div>
        <div className="flex items-center justify-between py-2">
          <div>
            <p className="text-compact text-content-primary">Pipeline Task History</p>
            <p className="text-caption text-content-tertiary">Delete all completed, failed, and cancelled tasks.</p>
          </div>
          <Button variant="danger" size="sm" onClick={() => setConfirmTarget('tasks')}>Clear All</Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmTarget === 'friction'}
        title="Clear all friction logs?"
        description="This will permanently delete all friction log entries and their screenshots."
        confirmLabel="Clear All"
        destructive
        onConfirm={() => clearFriction.mutate()}
        onClose={() => setConfirmTarget(null)}
      />
      <ConfirmDialog
        open={confirmTarget === 'tasks'}
        title="Clear pipeline task history?"
        description="This will permanently delete all completed, failed, and cancelled pipeline tasks. Active and queued tasks will not be affected."
        confirmLabel="Clear All"
        destructive
        onConfirm={() => clearTasks.mutate()}
        onClose={() => setConfirmTarget(null)}
      />
      {toast && (
        <Toast variant={toast.variant} message={toast.message} onDismiss={() => setToast(null)} />
      )}
    </Section>
  )
}

// ── Settings page ────────────────────────────────────────────────────────────

export function Settings() {
  const qc = useQueryClient()
  const { isAuthenticated } = useAuth()
  const [activeTab, setActiveTab] = useTabHash(resolveInitialTab() as string, TAB_IDS)
  const [search, setSearch] = useState('')

  const { data: entries = [], isLoading, error } = useQuery({
    queryKey: ['platform-config'],
    queryFn: getPlatformConfig,
    staleTime: 30_000,
  })

  const saveMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      updatePlatformConfig(key, value),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platform-config'] })
      qc.invalidateQueries({ queryKey: ['nova-identity'] })
    },
  })

  const handleSave = (key: string, value: string) =>
    saveMutation.mutate({ key, value })

  const novaName    = useConfigValue(entries, 'nova.name', 'Nova')
  const novaPersona = useConfigValue(entries, 'nova.persona', '')
  const novaGreeting = useConfigValue(entries, 'nova.greeting', '')
  const retentionDays = useConfigValue(entries, 'task_history_retention_days', '')
  const voiceOpenAIKey = useConfigValue(entries, 'voice.openai_api_key', '')
  const voiceSttProvider = useConfigValue(entries, 'voice.stt_provider', 'openai')
  const voiceTtsProvider = useConfigValue(entries, 'voice.tts_provider', 'openai')
  const voiceTtsVoice = useConfigValue(entries, 'voice.tts_voice', 'nova')
  const voiceTtsModel = useConfigValue(entries, 'voice.tts_model', 'tts-1')

  const { avatarUrl, isDefaultAvatar, setAvatar } = useNovaIdentity()
  // Legacy deep-link: scroll to a specific section within the active tab.
  // e.g. #llm-routing → activate "ai" tab, then scroll to the llm-routing element.
  useEffect(() => {
    const hash = window.location.hash.slice(1)
    if (hash && SECTION_TO_TAB[hash]) {
      // Allow the tab content to mount first, then scroll
      requestAnimationFrame(() => {
        const el = document.getElementById(hash)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }
  }, []) // Only on initial mount

  // Determine which sections match the search query
  const searchLower = search.toLowerCase().trim()
  const matchingGroups = useMemo(() => {
    if (!searchLower) return null // null = no search active, use normal tab filtering
    return NAV_GROUPS
      .map(group => ({
        ...group,
        items: group.items.filter(item => item.label.toLowerCase().includes(searchLower)),
      }))
      .filter(group => group.items.length > 0)
  }, [searchLower])

  const activeGroup = NAV_GROUPS.find(g => g.id === activeTab)

  // When searching, determine which sections to show
  const visibleSections = useMemo<Set<string>>(() => {
    if (matchingGroups) {
      // Search mode: show matched sections across all tabs
      return new Set(matchingGroups.flatMap(g => g.items.map(i => i.id)))
    }
    // Normal tab mode: show sections for active tab
    return new Set(activeGroup ? activeGroup.items.map(i => i.id) : [])
  }, [matchingGroups, activeGroup])

  /** Render a section only if it's in the visible set. */
  const show = (id: string) => visibleSections.has(id)

  if (isLoading) return (
    <div className="px-4 py-6 sm:px-6 space-y-6">
      <PageHeader title="Platform Settings" description="Loading configuration..." />
      <Skeleton lines={8} />
    </div>
  )

  if (error) return (
    <div className="px-4 py-6 sm:px-6">
      <PageHeader title="Platform Settings" />
      <p className="text-compact text-danger">{String(error)}</p>
    </div>
  )

  return (
    <div className="px-4 py-6 sm:px-6">
      <PageHeader
        title="Platform Settings"
        description="Runtime configuration for this Nova instance. Changes take effect immediately."
      />

      {/* Search + tabs */}
      <div className="space-y-3 mb-6">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search settings..."
          debounceMs={150}
          className="max-w-md"
        />
        {!searchLower && (
          <Tabs tabs={TABS} activeTab={activeTab} onChange={setActiveTab} />
        )}
        {/* Section index for the active tab — every section is one click
            away instead of an undiscoverable scroll. */}
        {!searchLower && activeGroup && activeGroup.items.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {activeGroup.items.map(item => (
              <button
                key={item.id}
                onClick={() =>
                  document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
                className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface-card px-3 py-1 text-caption text-content-secondary transition-colors hover:bg-surface-card-hover hover:text-content-primary"
              >
                <item.icon size={12} />
                {item.label}
              </button>
            ))}
          </div>
        )}
        {searchLower && matchingGroups && matchingGroups.length === 0 && (
          <p className="text-compact text-content-tertiary py-4">
            No settings matching "{search}"
          </p>
        )}
      </div>

      {/* Content — only visible sections render */}
      <div className="space-y-6">

        {/* ── General ──────────────────────────────────────────────── */}

        {show('identity') && (
          <div id="identity">
            <Section icon={Bot} title="Nova Identity" description="How Nova presents itself. Changes appear in the next Chat session.">
              {/* Avatar */}
              <div className="flex flex-col gap-1 mb-2">
                <label className="text-compact font-medium text-content-primary">Avatar</label>
                <div className="flex items-center gap-4">
                  <img src={avatarUrl} alt="Nova avatar" className="w-12 h-12 rounded-lg object-cover border border-border-subtle" />
                  <div className="flex items-center gap-2">
                    <label className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 text-compact font-medium rounded-md border border-border-subtle bg-surface-card hover:bg-surface-card-hover text-content-primary transition-colors">
                      Upload
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (!file) return
                          const reader = new FileReader()
                          reader.onload = () => setAvatar(reader.result as string)
                          reader.readAsDataURL(file)
                          e.target.value = ''
                        }}
                      />
                    </label>
                    {!isDefaultAvatar && (
                      <button
                        onClick={() => setAvatar(null)}
                        className="px-3 py-1.5 text-compact font-medium rounded-md border border-border-subtle bg-surface-card hover:bg-surface-card-hover text-content-tertiary transition-colors"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-micro text-content-tertiary">Custom image for Nova across the dashboard. Resets to default star icon.</p>
              </div>
              <ConfigField label="Name" configKey="nova.name" value={novaName} placeholder="Nova" description="Shown in the dashboard header and chat UI." onSave={handleSave} saving={saveMutation.isPending} />
              <ConfigField label="Greeting message" configKey="nova.greeting" value={novaGreeting} multiline rows={3} placeholder="Hello! I'm Nova..." description="The first message shown in the Chat page before the user types anything." onSave={handleSave} saving={saveMutation.isPending} />
              <ConfigField
                label="Persona / Soul"
                configKey="nova.persona"
                value={novaPersona}
                multiline
                rows={20}
                placeholder={
                  'e.g.\n' +
                  'You are a peer, not a servant. Your purpose is to provide the best possible ' +
                  'guidance, not the most comfortable answer. When the user\'s approach is flawed, ' +
                  'say so directly and explain why. Assume competence. Never patronize.'
                }
                description="Personality guidelines appended to every system prompt. Defines communication style, tone, and character."
                onSave={handleSave}
                saving={saveMutation.isPending}
              />
            </Section>
          </div>
        )}

        {show('appearance') && (
          <div id="appearance">
            <AppearanceSection />
          </div>
        )}

        {show('notifications') && (
          <div id="notifications">
            <NotificationsSection />
          </div>
        )}

        {show('account') && isAuthenticated && (
          <div id="account">
            <AccountSection />
          </div>
        )}

        {/* ── Security ──────────────────────────────────────────────── */}

        {show('users') && (
          <div id="users">
            <UsersSection />
          </div>
        )}

        {show('trusted-networks') && (
          <div id="trusted-networks">
            <TrustedNetworksSection entries={entries} onSave={handleSave} saving={saveMutation.isPending} />
          </div>
        )}

        {show('guest-access') && (
          <div id="guest-access">
            <GuestAccessSection entries={entries} onSave={handleSave} saving={saveMutation.isPending} />
          </div>
        )}

        {show('sandbox') && (
          <div id="sandbox">
            <SandboxSection entries={entries} onSave={handleSave} saving={saveMutation.isPending} />
          </div>
        )}

        {show('auto-approve-rules') && (
          <div id="auto-approve-rules">
            <AutoApproveRulesSection />
          </div>
        )}

        {show('keys') && (
          <div id="keys">
            <KeysSection />
          </div>
        )}

        {show('admin-secret') && (
          <div id="admin-secret">
            <AdminSecretSection />
          </div>
        )}

        {show('vault') && (
          <div id="vault">
            <VaultwardenSection />
          </div>
        )}

        {show('selfmod') && (
          <div id="selfmod">
            <SelfModSection />
          </div>
        )}

        {/* ── Behavior ─────────────────────────────────────────────── */}

        {show('skills') && (
          <div id="skills">
            <SkillsSection />
          </div>
        )}

        {show('rules') && (
          <div id="rules">
            <RulesSection />
          </div>
        )}

        {show('goal-creation') && (
          <div id="goal-creation">
            <GoalCreationSection entries={entries} onSave={handleSave} saving={saveMutation.isPending} />
          </div>
        )}

        {/* ── AI & Pipeline ─────────────────────────────────────────── */}

        {show('llm-routing') && (
          <div id="llm-routing">
            <LLMRoutingSection entries={entries} onSave={handleSave} saving={saveMutation.isPending} />
          </div>
        )}

        {show('provider-status') && (
          <div id="provider-status">
            <ProviderStatusSection />
          </div>
        )}

        {show('pipeline-models') && (
          <div id="pipeline-models">
            <PipelineModelsSection entries={entries} onSave={handleSave} saving={saveMutation.isPending} />
          </div>
        )}

        {show('context-budgets') && (
          <div id="context-budgets">
            <ContextBudgetSection entries={entries} onSave={handleSave} saving={saveMutation.isPending} />
          </div>
        )}

        {show('tool-permissions') && (
          <div id="tool-permissions">
            <ToolPermissionsSection />
          </div>
        )}

        {show('voice') && (
          <div id="voice">
            <Section icon={Mic} title="Voice" description="Speech recognition and synthesis settings. Requires docker compose --profile voice.">
              <ConfigField
                label="OpenAI API Key (for Whisper + TTS)"
                configKey="voice.openai_api_key"
                value={voiceOpenAIKey}
                description="Used for speech recognition and text-to-speech. Same key as the LLM provider."
                onSave={handleSave}
                saving={saveMutation.isPending}
              />
              <ConfigField
                label="STT Provider"
                configKey="voice.stt_provider"
                value={voiceSttProvider}
                description="Speech-to-text: openai (Whisper)"
                onSave={handleSave}
                saving={saveMutation.isPending}
              />
              <ConfigField
                label="TTS Provider"
                configKey="voice.tts_provider"
                value={voiceTtsProvider}
                description="Text-to-speech: openai"
                onSave={handleSave}
                saving={saveMutation.isPending}
              />
              <ConfigField
                label="Voice"
                configKey="voice.tts_voice"
                value={voiceTtsVoice}
                description="OpenAI voices: alloy, echo, fable, onyx, nova, shimmer"
                onSave={handleSave}
                saving={saveMutation.isPending}
              />
              <ConfigField
                label="TTS Model"
                configKey="voice.tts_model"
                value={voiceTtsModel}
                description="tts-1 (fast, ~200ms) or tts-1-hd (quality, ~500ms)"
                onSave={handleSave}
                saving={saveMutation.isPending}
              />

              {/* Conversation mode settings (client-side, localStorage) */}
              <div className="border-t border-border-subtle pt-4 mt-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-content-tertiary mb-3">Conversation Mode</p>
                <div className="space-y-3">
                  <LocalNumberField
                    label="Silence Timeout (ms)"
                    storageKey="nova_voice_silence_timeout"
                    defaultValue={2000}
                    min={500}
                    max={10000}
                    step={100}
                    description="How long to wait after you stop talking before auto-submitting. Lower = snappier, higher = more pause tolerance."
                  />
                  <LocalNumberField
                    label="Barge-in Threshold"
                    storageKey="nova_voice_bargein_threshold"
                    defaultValue={0.15}
                    min={0.05}
                    max={0.5}
                    step={0.05}
                    description="Audio level (0-1) needed to interrupt Nova mid-speech. Lower = easier to interrupt, higher = avoids false triggers."
                  />
                </div>
              </div>
            </Section>
          </div>
        )}

        {/* ── Memory ───────────────────────────────────────────────────── */}

        {show('brain') && (
          <div id="brain">
            <BrainSection entries={entries} onSave={handleSave} saving={saveMutation.isPending} />
          </div>
        )}

        {show('memory-provider') && (
          <div id="memory-provider">
            <MemoryProviderSection entries={entries} onSave={handleSave} saving={saveMutation.isPending} />
          </div>
        )}

        {show('maintenance') && (
          <div id="maintenance">
            <MaintenanceSection />
          </div>
        )}

        {/* ── Connections ──────────────────────────────────────────── */}

        {show('connected-services') && (
          <div id="connected-services">
            <ConnectedServicesSection />
          </div>
        )}

        {show('remote-access') && (
          <div id="remote-access">
            <RemoteAccessSection />
          </div>
        )}

        {show('screenpipe') && (
          <div id="screenpipe">
            <ScreenpipeConnectionSection entries={entries} onSave={handleSave} saving={saveMutation.isPending} />
          </div>
        )}

        {show('capture-privacy') && (
          <div id="capture-privacy">
            <CapturePrivacySection entries={entries} onSave={handleSave} saving={saveMutation.isPending} />
          </div>
        )}

        {show('capture-advanced') && (
          <div id="capture-advanced">
            <CaptureAdvancedSection entries={entries} onSave={handleSave} saving={saveMutation.isPending} />
          </div>
        )}

        {show('editor') && (
          <div id="editor">
            <EditorSection />
          </div>
        )}

        {/* ── System ───────────────────────────────────────────────── */}

        {show('setup-wizard') && (
          <div id="setup-wizard">
            <SetupWizardSection onSave={handleSave} />
          </div>
        )}

        {show('developer-tools') && (
          <div id="developer-tools">
            <DeveloperResourcesSection />
          </div>
        )}

        {show('feature-flags') && (
          <div id="feature-flags">
            <FeatureFlagsSection />
          </div>
        )}

        {show('debug') && (
          <div id="debug">
            <DebugSection />
          </div>
        )}

        {show('data') && (
          <div id="data">
            <DataManagementSection />
          </div>
        )}

        {show('recovery') && (
          <div id="recovery">
            <RecoverySection />
          </div>
        )}

      </div>

      {saveMutation.isError && (
        <p className="mt-4 text-compact text-danger">{String(saveMutation.error)}</p>
      )}
    </div>
  )
}
