import { useEffect, useRef, useState } from 'react';
import {
  AgentInfo, Automation, AutomationRun, BundledInferenceStatus, CuratedModel, DbToolInfo,
  McpServer, McpTool,
  ModelBudget, ModelInfo, ModelRecommendation, ModelsDirInfo, ProbeResult,
  RecommendationsResponse, Rule, SettingDef, SkillInfo,
  StorageInfo as StorageInfoData, ToolsCatalog,
  approveMcpServer, createAgent, createAutomation, createCuratedModel, createMcpServer,
  createRule, createSkill,
  createTool, deleteAgent, deleteAutomation, deleteCuratedModel, deleteMcpServer, deleteRule,
  deleteSkill, deleteTool, getAgents, getAutomationRuns, getAutomations, getBundledInference,
  getCuratedModels, getMcpServerTools, getMcpServers, getMemoryItem, getModelBudget, getModels,
  getModelsDir, getRecommendations, getRules, getSettings, getSkills, getStorageInfo,
  getTools, getVoiceHealth, patchAgent,
  patchAutomation, patchCuratedModel, patchMcpServer, patchRule, patchSettings, patchTool,
  getNotifyReachability, getNotifyService, notifyServiceAction,
  pullModel, setBundledInference, setModelsDir, synthesizeSpeech, testModel, testNotification,
  uninstallModel, updateSkill,
  Provider, ProviderPreset,
  createProvider, deleteProvider, getProviders, getProviderPresets, patchProvider, testProvider,
} from '../api';
import type { NotifyReachability, NotifyService } from '../api';
import { Markdown } from './Markdown';
import { RecentTurns } from './RecentTurns';
import qrcode from 'qrcode-generator';
import { getAuthToken, getServerToken } from '../api';
import { THEMES } from '../brain/theme';
import { agentDisplayName, displayName } from '../names';
import { fmtDateTime, fmtTime } from '../time';
import { ThemePreview } from './ThemePreview';
import { WAKE_CATALOG } from '../voice/wakeCatalog';

type Tab = 'settings' | 'agents' | 'models' | 'automations' | 'rules' | 'tools' | 'skills';

export function SettingsOverlay({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('settings');

  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center pt-16 bg-black/40" onClick={onClose}>
      <div
        className="w-[46rem] max-w-[calc(100vw-1rem)] md:max-w-[calc(100vw-26rem)] max-h-[82vh] flex flex-col rounded-xl bg-stone-900/95 backdrop-blur border border-stone-700 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-stone-700 flex items-center justify-between">
          <div className="flex gap-1 text-sm">
            {(['settings', 'agents', 'models', 'automations', 'rules', 'tools', 'skills'] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 rounded capitalize ${
                  tab === t ? 'bg-teal-700/50 text-teal-200' : 'text-stone-400 hover:text-stone-200'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="text-stone-500 hover:text-stone-200 text-lg px-1" aria-label="Close">×</button>
        </header>
        <div className="flex-1 overflow-y-auto nice-scroll p-4">
          {tab === 'settings' ? <SettingsTab exclude={['Automations', 'Models']} />
            : tab === 'agents' ? <AgentsTab />
            : tab === 'models' ? <ModelsTab />
            : tab === 'automations' ? <AutomationsTab />
            : tab === 'rules' ? <RulesTab />
            : tab === 'tools' ? <ToolsTab />
            : <SkillsTab />}
        </div>
      </div>
    </div>
  );
}

/** One switch to rule all the tabs — a real toggle with a label that says
 *  what it controls, replacing the ambiguous "enabled" text chips. Disable
 *  is the ONLY off-switch for undeletable system entities, so this control
 *  must exist; it just has to explain itself. */
function Toggle({ on, onChange, label, title }: {
  on: boolean; onChange: () => void; label: string; title: string;
}) {
  return (
    <span title={title} className="flex items-center gap-1.5 shrink-0 select-none">
      <span className={`text-[11px] ${on ? 'text-teal-300' : 'text-stone-500'}`}>{label}</span>
      <button
        type="button"
        onClick={onChange}
        aria-pressed={on}
        aria-label={label}
        className={`w-8 px-0.5 py-0.5 rounded-full transition ${on ? 'bg-teal-600' : 'bg-stone-700'}`}
      >
        <span className={`block w-3 h-3 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : ''}`} />
      </button>
    </span>
  );
}

/** Reserved-height placeholders shown until a tab's data loads, so each panel
 *  renders once (no sparse-frame flash or layout shift on open). */
function CardsSkeleton({ n = 4 }: { n?: number }) {
  return (
    <div className="space-y-2 animate-pulse" aria-hidden>
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="h-14 rounded-lg border border-stone-800 bg-stone-800/30" />
      ))}
    </div>
  );
}

function SettingsTab({ only, exclude }: { only?: string[]; exclude?: string[] }) {
  const [defs, setDefs] = useState<SettingDef[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [status, setStatus] = useState<string>('');
  const [loaded, setLoaded] = useState(false);
  const [notifyTest, setNotifyTest] = useState<{ busy: boolean; msg: string; ok?: boolean }>(
    { busy: false, msg: '' });

  async function runNotifyTest() {
    setNotifyTest({ busy: true, msg: 'Sending…' });
    try {
      const r = await testNotification();
      setNotifyTest({ busy: false, ok: r.ok, msg: r.ok
        ? `Accepted by ${r.provider ?? 'provider'}${r.id ? ` (id ${r.id})` : ''} — check your device. Acceptance isn't proof it arrived.`
        : `Not sent: ${r.error}` });
    } catch (e) {
      setNotifyTest({ busy: false, ok: false, msg: String(e) });
    }
  }

  useEffect(() => {
    getSettings().then(setDefs).catch(e => setStatus(String(e))).finally(() => setLoaded(true));
    getModels().then(setModels).catch(() => {});
    // stay in sync when a setting is changed elsewhere (e.g. the header chip)
    const onExternal = (e: Event) => {
      const { key, value } = (e as CustomEvent).detail as { key: string; value: unknown };
      setDefs(prev => prev.map(d => d.key === key ? { ...d, value } : d));
    };
    window.addEventListener('nova:setting-changed', onExternal);
    return () => window.removeEventListener('nova:setting-changed', onExternal);
  }, []);

  async function save(key: string, value: unknown) {
    try {
      await patchSettings({ [key]: value });
      setDefs(prev => prev.map(d => d.key === key ? { ...d, value } : d));
      // Brain (and anything else) reacts live without a page reload
      window.dispatchEvent(new CustomEvent('nova:setting-changed', { detail: { key, value } }));
      setStatus(`Saved ${key}`);
      setTimeout(() => setStatus(''), 1500);
    } catch (e) {
      setStatus(String(e));
    }
  }

  function field(d: SettingDef) {
    if (d.key === 'brain.view') {
      return (
        <div className="flex gap-3">
          {Object.keys(THEMES).map(k => (
            <ThemePreview key={k} themeKey={k} selected={d.value === k}
              onSelect={() => save(d.key, k)} />
          ))}
        </div>
      );
    }
    if (d.key === 'voice.tts_voice') {
      return <VoiceField value={String(d.value)} onSelect={v => save(d.key, v)} />;
    }
    if (d.key === 'voice.listen_mode') {
      return <ListenModeField value={String(d.value)} onSelect={v => save(d.key, v)} />;
    }
    if (d.key === 'voice.wake_word') {
      return <WakeWordField value={String(d.value)} onSelect={v => save(d.key, v)} />;
    }
    if (d.key === 'notify.ntfy.topic') {
      return <NtfyTopicField value={String(d.value ?? '')} onSave={v => save(d.key, v)} />;
    }
    if (d.type === 'boolean') {
      return (
        <button
          onClick={() => save(d.key, !d.value)}
          className={`shrink-0 w-10 px-0.5 py-0.5 rounded-full transition ${
            d.value ? 'bg-teal-600' : 'bg-stone-700'
          }`}
          aria-label={d.label}
        >
          <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${
            d.value ? 'translate-x-5' : ''
          }`} />
        </button>
      );
    }
    if (d.type === 'enum') {
      return (
        <select
          value={String(d.value)}
          onChange={e => save(d.key, e.target.value)}
          className="shrink-0 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
        >
          {(d.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    }
    if (d.type === 'model') {
      const scoped = d.model_scope === 'ollama'
        ? models.filter(m => m.provider === 'ollama')
        : models;
      return (
        <select
          value={String(d.value)}
          onChange={e => save(d.key, e.target.value)}
          className="shrink-0 max-w-[16rem] bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
        >
          {d.allow_empty && <option value="">(agent's model)</option>}
          {scoped.map(m => (
            <option key={m.id} value={d.model_scope === 'ollama' ? m.name : m.id}>
              {m.name}
            </option>
          ))}
          {/* keep the stored value selectable even if not currently listed */}
          {!!d.value && !scoped.some(m =>
            (d.model_scope === 'ollama' ? m.name : m.id) === d.value) && (
            <option value={String(d.value)}>{String(d.value)} (not detected)</option>
          )}
        </select>
      );
    }
    if (d.type === 'number' && d.min != null && d.max != null && d.max - d.min <= 20) {
      return (
        <span className="shrink-0 flex items-center gap-2">
          <input
            type="range" min={d.min} max={d.max}
            step={(d.max - d.min) / 20}
            value={Number(d.value)}
            onChange={e => save(d.key, Number(e.target.value))}
            className="w-28 accent-teal-500"
          />
          <span className="text-xs font-mono text-stone-400 w-8 text-right">{Number(d.value).toFixed(1)}</span>
        </span>
      );
    }
    return (
      <input
        className="shrink-0 w-40 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200 text-right focus:outline-none focus:ring-1 focus:ring-teal-500"
        defaultValue={String(d.value)}
        onBlur={e => {
          const raw = e.target.value.trim();
          const v = d.type === 'number' ? Number(raw) : raw;
          if (v !== d.value) save(d.key, v);
        }}
      />
    );
  }

  const sections = [...new Set(defs.map(d => d.section))]
    .filter(s => (!only || only.includes(s)) && !(exclude ?? []).includes(s));
  if (!loaded) return <CardsSkeleton n={only ? 1 : 5} />;
  return (
    <div className="space-y-5">
      {!only && <StorageCard />}
      {!only && <PhoneSetupCard defs={defs} />}
      {sections.map(section => (
        <section key={section}>
          <h3 className="text-xs uppercase tracking-wide text-stone-500 mb-2">{section}</h3>
          <div className="space-y-3">
            {section === 'Inference' && (
              <BundledInference onChanged={() => getModels().then(setModels)} />
            )}
            {section === 'Inference' && <ModelStorage />}
            {section === 'Observability' && <RecentTurns />}
            {defs.filter(d => d.section === section)
              // provider-scoped notify settings (notify.<provider>.*) show only
              // for the selected provider — new providers namespace themselves
              // and hide automatically, no code here to touch
              .filter(d => {
                const m = d.key.match(/^notify\.(ntfy|webhook)\./);
                if (m && m[1] !== defs.find(x => x.key === 'notify.provider')?.value) return false;
                // the custom-URL field only matters when the ntfy server is "custom"
                if (d.key === 'notify.ntfy.custom_url'
                    && defs.find(x => x.key === 'notify.ntfy.server_mode')?.value !== 'custom') return false;
                return true;
              })
              .map(d => (
              <div key={d.key}
                className={d.key === 'brain.view'
                  ? 'space-y-2'
                  : 'flex items-start justify-between gap-4'}>
                <div className="min-w-0">
                  <div className="text-sm text-stone-200">{d.label}</div>
                  <div className="text-xs text-stone-500">{d.description}</div>
                </div>
                {field(d)}
              </div>
            ))}
            {section === 'Notifications' && (
              <div className="pt-1 space-y-3">
                <NotifyServiceControl defs={defs} />
                <NotificationsReachability />
                <div>
                  <button
                    onClick={runNotifyTest}
                    disabled={notifyTest.busy}
                    className="text-sm px-3 py-1.5 rounded bg-stone-800 border border-stone-700 text-stone-200 hover:border-teal-600 disabled:opacity-50"
                  >
                    Send test notification
                  </button>
                  {notifyTest.msg && (
                    <div className={`text-xs mt-2 ${
                      notifyTest.ok === false ? 'text-amber-400' : 'text-teal-400'}`}>
                      {notifyTest.msg}
                    </div>
                  )}
                </div>
                <NotificationsHelp defs={defs} />
              </div>
            )}
            {/* model inventory (pull, curated table) lives in the Models tab;
                assignment surfaces (detect & suggest, concurrent load) in Agents */}
          </div>
        </section>
      ))}
      {status && <div className="text-xs text-teal-400">{status}</div>}
    </div>
  );
}

/** ntfy topic input with a Randomize button — on a public/shared server the
 *  topic name is the only secret, so an easy way to mint a long unguessable
 *  one matters. */
function NtfyTopicField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const randomize = () => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const rnd = 'nova-' + Array.from(crypto.getRandomValues(new Uint8Array(14)))
      .map(b => alphabet[b % alphabet.length]).join('');
    setV(rnd);
    onSave(rnd);
  };
  return (
    <span className="shrink-0 flex items-center gap-2">
      <input
        className="w-44 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200 focus:outline-none focus:ring-1 focus:ring-teal-500"
        value={v}
        placeholder="nova-…"
        onChange={e => setV(e.target.value)}
        onBlur={() => { const t = v.trim(); if (t !== value) onSave(t); }}
      />
      <button
        onClick={randomize}
        title="Generate a long, unguessable topic"
        className="text-xs px-2 py-1 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:border-teal-600"
      >
        Randomize
      </button>
    </span>
  );
}

/** Start/stop the self-hosted ntfy server from the UI (no compose commands).
 *  'Start' also derives + applies the correct base URL so the phone stays in
 *  sync. Only shown for the builtin server with the control sidecar present. */
function NotifyServiceControl({ defs }: { defs: SettingDef[] }) {
  const [svc, setSvc] = useState<NotifyService | null>(null);
  const [busy, setBusy] = useState(false);
  const val = (k: string) => String(defs.find(d => d.key === k)?.value ?? '');

  const refresh = () => getNotifyService().then(setSvc).catch(() => setSvc(null));
  useEffect(() => { refresh(); }, []);

  if (val('notify.provider') !== 'ntfy' || val('notify.ntfy.server_mode') !== 'builtin'
      || !svc?.available) return null;

  const running = !!svc.ntfy?.running;
  const act = async (action: 'up' | 'down') => {
    setBusy(true);
    try {
      await notifyServiceAction(action);
      // the sidecar op runs async — poll a few times to reflect the new state
      for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 2500)); await refresh(); }
    } catch { /* leave state; a recheck will catch up */ }
    finally { setBusy(false); }
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-stone-700/70 bg-stone-800/40 p-3">
      <div className="min-w-0">
        <div className="text-sm text-stone-200">Self-hosted ntfy server</div>
        <div className="text-xs text-stone-500">
          {busy ? 'working…' : running ? 'Running' : 'Stopped'} — Nova sets its
          address automatically so your phone stays in sync.
        </div>
      </div>
      <button onClick={() => act(running ? 'down' : 'up')} disabled={busy}
        className="shrink-0 text-sm px-3 py-1.5 rounded bg-stone-800 border border-stone-700 text-stone-200 hover:border-teal-600 disabled:opacity-50">
        {busy ? '…' : running ? 'Stop' : 'Start'}
      </button>
    </div>
  );
}

/** Read-only status of the notification delivery path — turns "is this even
 *  wired?" from invisible into a row of dots, and shows the exact URL + topic
 *  the phone needs. Refreshes when a notify setting changes. */
function NotificationsReachability() {
  const [data, setData] = useState<NotifyReachability | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = () => {
    setLoading(true);
    getNotifyReachability().then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  };
  useEffect(() => {
    refresh();
    const onChange = (e: Event) => {
      const key = (e as CustomEvent).detail?.key as string | undefined;
      if (key && key.startsWith('notify.')) refresh();
    };
    window.addEventListener('nova:setting-changed', onChange);
    return () => window.removeEventListener('nova:setting-changed', onChange);
  }, []);

  const dot = (ok: boolean | null) =>
    ok === true ? 'bg-teal-500' : ok === false ? 'bg-amber-500' : 'bg-stone-500';

  return (
    <div className="rounded-lg border border-stone-700/70 bg-stone-800/40 p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-stone-200">Delivery path</div>
        <button onClick={refresh} disabled={loading}
          className="text-xs text-stone-400 hover:text-stone-200 disabled:opacity-50">
          {loading ? 'checking…' : 'recheck'}
        </button>
      </div>
      {data ? (
        <div className="mt-2 space-y-1.5">
          {data.checks.map((c, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${dot(c.ok)}`} />
              <span className="text-stone-300">{c.label}</span>
              {c.detail && <span className="text-stone-500 min-w-0 break-words">— {c.detail}</span>}
            </div>
          ))}
          {data.phone?.server_url && (
            <div className="mt-2 pt-2 border-t border-stone-700/60 text-xs text-stone-400">
              On your phone, enter server{' '}
              <code className="font-mono text-stone-300 break-all">{data.phone.server_url}</code>
              {data.phone.topic && <> and subscribe to <code className="font-mono text-stone-300">{data.phone.topic}</code></>}.
            </div>
          )}
        </div>
      ) : (
        <div className="mt-2 text-xs text-stone-500">{loading ? 'checking…' : 'unavailable'}</div>
      )}
    </div>
  );
}

/** In-Settings walkthrough for getting notifications onto a phone — adapts to
 *  the chosen provider and ntfy server mode, and fills in the real topic +
 *  server address so there's nothing to look up in a README. */
function NotificationsHelp({ defs }: { defs: SettingDef[] }) {
  const [open, setOpen] = useState(false);
  const val = (k: string) => String(defs.find(d => d.key === k)?.value ?? '').trim();

  const provider = val('notify.provider');
  const mode = val('notify.ntfy.server_mode');
  const topic = val('notify.ntfy.topic');
  const custom = val('notify.ntfy.custom_url');
  // the phone reaches the bundled server over the tailnet, same host as the
  // Phone-setup URL but on ntfy's own https port (tailscale serve :8443)
  const pub = val('ui.public_url').replace(/\/+$/, '').replace(/:\d+$/, '');
  const builtinUrl = pub ? `${pub}:8443` : 'https://<your-nova-tailnet-domain>:8443';

  const mono = 'font-mono text-stone-300';
  const topicEl = topic
    ? <code className={mono}>{topic}</code>
    : <span className="text-amber-400">set a topic above (use Randomize)</span>;

  return (
    <div className="rounded-lg border border-stone-700/70 bg-stone-800/40 p-3">
      <button onClick={() => setOpen(o => !o)}
        className="text-sm text-teal-400 hover:underline">
        {open ? 'Hide phone setup' : 'How do I get these on my phone?'}
      </button>
      {open && (provider === 'webhook' ? (
        <p className="mt-2 text-xs text-stone-400 leading-relaxed">
          Webhook mode doesn't use a phone app — each notification is POSTed as
          JSON to your URL. Set up delivery on the receiving end: a Slack or
          Discord <b>incoming webhook</b>, a Zapier/IFTTT catch hook, or your own
          endpoint. Then hit <b>Send test notification</b> and check that side.
        </p>
      ) : (
        <ol className="mt-2 space-y-2 text-xs text-stone-400 leading-relaxed list-decimal pl-4">
          <li>
            Install the <b>ntfy</b> app — iOS: App&nbsp;Store; Android:
            Play&nbsp;Store or F-Droid (search “ntfy”). It's free, no account.
          </li>
          {mode === 'public' && (
            <li>
              Leave the app on its default server (<code className={mono}>ntfy.sh</code>).
              Nothing to add.
            </li>
          )}
          {mode === 'custom' && (
            <li>
              In the app add your server{' '}
              {custom
                ? <code className={mono}>{custom}</code>
                : <span className="text-amber-400">set the custom URL above</span>}{' '}
              (Settings → Default server, or per subscription).
            </li>
          )}
          {mode === 'builtin' && (
            <li>
              Point the app at your <b>bundled</b> server. Your phone can't use{' '}
              <code className={mono}>http://ntfy:80</code> — that's internal to
              Nova. It reaches it over Tailscale at{' '}
              <code className={mono}>{builtinUrl}</code>. In the app: Settings →
              Default server → enter that URL.
              <div className="mt-1 text-stone-500">
                Needs both the <code className="font-mono">notify</code> and{' '}
                <code className="font-mono">tailscale</code> profiles running,
                and the phone on your tailnet (same as Phone setup above).
              </div>
            </li>
          )}
          <li>
            Tap <b>Subscribe to topic</b> and enter {topicEl} — the exact topic set
            above. (Publisher and phone must use the same server + topic.)
          </li>
          <li>
            Come back here and hit <b>Send test notification</b> — your phone
            should buzz within a second or two.
          </li>
          {mode !== 'public' && (
            <li className="text-stone-500">
              <b>iPhone note:</b> self-hosted servers deliver instantly only if the
              server forwards a wake-up ping through ntfy.sh — the bundled server
              is set up for this by default (message text still stays on your
              server). Android is instant either way.
            </li>
          )}
        </ol>
      ))}
    </div>
  );
}

/** Voice picker fed by the kokoro /health voice list, with an inline
 *  preview so you can hear a candidate before saving. Falls back to a
 *  free-text input when the voice service isn't running. */
function VoiceField({ value, onSelect }: { value: string; onSelect: (v: string) => void }) {
  const [voices, setVoices] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    getVoiceHealth()
      .then(h => {
        setVoices(h.voices);
        if (h.status !== 'ready') {
          setStatus(h.status === 'unreachable'
            ? 'voice service not running (compose profile "voice")'
            : `voice service ${h.status}…`);
        }
      })
      .catch(() => setStatus('voice service unavailable'));
  }, []);

  async function preview() {
    if (previewing) return;
    setPreviewing(true);
    setStatus('');
    try {
      // the click is a user gesture — safe to create/resume the context here
      if (!ctxRef.current) ctxRef.current = new AudioContext();
      await ctxRef.current.resume();
      const wav = await synthesizeSpeech("Hi, I'm Nova — this is how I sound.", value);
      const buf = await ctxRef.current.decodeAudioData(wav);
      const src = ctxRef.current.createBufferSource();
      src.buffer = buf;
      src.connect(ctxRef.current.destination);
      src.onended = () => setPreviewing(false);
      src.start();
    } catch (e) {
      setStatus(String(e));
      setPreviewing(false);
    }
  }

  return (
    <div className="shrink-0 flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {voices.length > 0 ? (
          <select
            value={value}
            onChange={e => onSelect(e.target.value)}
            className="max-w-[12rem] bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
          >
            {voices.map(v => <option key={v} value={v}>{v}</option>)}
            {value && !voices.includes(value) && (
              <option value={value}>{value} (unknown)</option>
            )}
          </select>
        ) : (
          <input
            className="w-40 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200 text-right focus:outline-none focus:ring-1 focus:ring-teal-500"
            defaultValue={value}
            onBlur={e => { const v = e.target.value.trim(); if (v !== value) onSelect(v); }}
          />
        )}
        <button
          onClick={preview}
          disabled={previewing}
          title="Hear this voice"
          className="text-xs px-2 py-1 rounded border border-stone-600 text-stone-300 hover:text-teal-300 hover:border-teal-800 disabled:opacity-50"
        >
          {previewing ? '▶ playing…' : '▶ preview'}
        </button>
      </div>
      {status && <span className="text-[11px] text-amber-400/90 text-right max-w-[16rem]">{status}</span>}
    </div>
  );
}

/** Mic mode with friendly labels and the honest tap-to-talk requirement —
 *  the in-browser speech detector is a one-time download, so say so. */
function ListenModeField({ value, onSelect }: { value: string; onSelect: (v: string) => void }) {
  const LABELS: Record<string, string> = {
    ptt: 'Hold to talk', tap: 'Tap to talk (auto-stop)', wake: 'Wake word (hands-free)',
  };
  const HINTS: Record<string, string> = {
    tap: 'Downloads a ~15 MB on-device speech detector the first time (cached after); needs a modern browser and mic access. Audio never leaves your device.',
    wake: 'Listens hands-free on-device for the wake phrase you pick below (separate from the assistant’s name — a spoken trigger is a trained model). ~4 MB of models; works only while this tab is open and focused; audio never leaves your device until the phrase fires.',
  };
  return (
    <div className="shrink-0 flex flex-col items-end gap-1">
      <select
        value={value}
        onChange={e => onSelect(e.target.value)}
        className="bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
      >
        {Object.entries(LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      {HINTS[value] && (
        <span className="text-[11px] text-stone-500 text-right max-w-[16rem]">{HINTS[value]}</span>
      )}
    </div>
  );
}

/** Wake phrase — a fixed catalog because each phrase is its own trained model.
 *  Deliberately separate from the assistant's name; a matching custom phrase
 *  needs a trained model (roadmap in docs/plans/voice.md). */
function WakeWordField({ value, onSelect }: { value: string; onSelect: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={e => onSelect(e.target.value)}
      className="shrink-0 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
    >
      {Object.entries(WAKE_CATALOG).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
    </select>
  );
}

/** Where memory physically lives — shown and verified in the UI; changing
 *  it is the ONE deployment-time setting (a docker bind mount can't be
 *  remounted from inside the container it serves). */
function StorageCard() {
  const [info, setInfo] = useState<StorageInfoData | null>(null);
  useEffect(() => { getStorageInfo().then(setInfo).catch(() => {}); }, []);
  if (!info) return null;
  const counts = Object.entries(info.counts).filter(([, v]) => typeof v === 'number');
  const models = info.models;
  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-stone-500 mb-2">Storage</h3>
      <div className="space-y-2">
        <div className="rounded-lg border border-stone-700 bg-stone-800/50 p-3 space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-stone-200">Memory home</div>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
              info.writable ? 'border-emerald-800 text-emerald-400' : 'border-red-900 text-red-400'
            }`}>
              {info.writable ? '✓ writable' : '✗ not writable'}
            </span>
          </div>
          <div className="text-xs font-mono text-teal-300">{info.host_path}</div>
          <div className="text-xs text-stone-500">
            Plain markdown — point it at a NAS mount or an Obsidian vault. The
            location is a docker bind mount fixed when the container starts, so
            it's the one setting that lives in <code className="font-mono">.env</code>:
            set <code className="font-mono">NOVA_MEMORY_DIR</code>, then run{' '}
            <code className="font-mono">docker compose up -d backend</code>.
          </div>
          <div className="text-[11px] font-mono text-stone-600">
            {counts.map(([k, v]) => `${v} ${k}`).join(' · ')}
          </div>
        </div>

        <div className="rounded-lg border border-stone-700 bg-stone-800/50 p-3 space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-stone-200">Model weights</div>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
              models.relocated ? 'border-teal-800 text-teal-400' : 'border-stone-600 text-stone-400'
            }`}>
              {models.relocated ? 'custom path' : 'default volumes'}
            </span>
          </div>
          <div className="text-xs font-mono text-teal-300">
            {models.host_path
              ? `${models.host_path}/{ollama,kokoro,whisper}`
              : 'docker-managed volumes'}
          </div>
          <div className="text-xs text-stone-500">
            The bundled model stores (Ollama LLMs + Kokoro/Whisper voice). Move
            them to an external drive or NAS to save space or share between
            machines — change it in{' '}
            <span className="text-stone-400">Settings → Inference → Model storage</span>.
            Nova migrates your models and restarts the services; no files to edit.
          </div>
        </div>
      </div>
    </section>
  );
}

/** Phone onboarding without token typing: a QR encoding the public URL
 *  with the token in the URL FRAGMENT (#token=…) — fragments never cross
 *  the network or reach server logs. Scanning it logs the phone in. Only
 *  renders on an already-authenticated session with a public URL set. */
function PhoneSetupCard({ defs }: { defs: SettingDef[] }) {
  const publicUrl = String(defs.find(d => d.key === 'ui.public_url')?.value ?? '').trim();
  const [token, setToken] = useState(getAuthToken() ?? '');
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    // a trusted (local) desktop has no stored token — the server provides it
    if (!token) getServerToken().then(t => t && setToken(t)).catch(() => {});
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  if (!publicUrl || !token) return null;

  const loginUrl = `${publicUrl.replace(/\/$/, '')}/#token=${encodeURIComponent(token)}`;
  let svg = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(loginUrl);
    qr.make();
    svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch {
    return null; // URL too long for a QR — shouldn't happen with sane URLs
  }

  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-stone-500 mb-2">Phone setup</h3>
      <div className="rounded-lg border border-stone-700 bg-stone-800/50 p-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="text-sm text-stone-200">Scan to sign in</div>
            <div className="text-xs text-stone-500">
              The code opens <span className="font-mono text-stone-400">{publicUrl}</span> with
              the admin token in the URL <b>fragment</b> — it never crosses the
              network and is wiped from the address bar after login. The phone
              must be on the tailnet first (Tailscale app, same account).
              Then: Share → Add to Home Screen.
            </div>
            <button onClick={() => setRevealed(r => !r)}
              className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200">
              {revealed ? 'hide QR' : 'show QR'}
            </button>
          </div>
          {revealed && (
            <div className="shrink-0 w-40 h-40 bg-white rounded p-1 [&>svg]:w-full [&>svg]:h-full"
              dangerouslySetInnerHTML={{ __html: svg }} />
          )}
        </div>
      </div>
    </section>
  );
}

/** Start/stop the bundled Ollama container via the inference-control
 *  sidecar. Hidden entirely when the sidecar isn't running. */
function BundledInference({ onChanged }: { onChanged: () => void }) {
  const [st, setSt] = useState<BundledInferenceStatus | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    const load = () => getBundledInference().then(setSt).catch(() => setSt(null));
    load();
    const iv = setInterval(load, 4000);
    return () => clearInterval(iv);
  }, []);

  if (!st?.available) return null;

  const busy = !!st.op;
  const [dot, text] =
    st.op === 'start' ? ['bg-amber-400 animate-pulse', 'starting…'] :
    st.op === 'stop' ? ['bg-amber-400 animate-pulse', 'stopping…'] :
    st.op === 'relocate' ? ['bg-amber-400 animate-pulse', 'relocating store…'] :
    st.running && st.api_ok ? ['bg-emerald-400', 'running'] :
    st.running ? ['bg-amber-400', 'running — API warming up'] :
    st.present ? ['bg-stone-500', 'stopped'] :
    ['bg-stone-500', 'not installed'];

  async function toggle() {
    if (!st || busy) return;
    setErr('');
    const action = st.running ? 'stop' : 'start';
    try {
      await setBundledInference(action);
      setSt({ ...st, op: action });
      onChanged();
    } catch (e) {
      setErr(String(e));
    }
  }

  return (
    <div className="rounded-lg border border-stone-700 bg-stone-800/50 p-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm text-stone-200 flex items-center gap-2">
            Bundled Ollama
            <span className={`w-2 h-2 rounded-full ${dot}`} />
            <span className="text-xs text-stone-400">{text}</span>
          </div>
          <div className="text-xs text-stone-500">
            The local-inference container. Stop it to free RAM/VRAM — pulled
            models persist across stops.
            {!st.present && ' First start downloads the Ollama image (~1 GB).'}
          </div>
        </div>
        <button
          onClick={toggle}
          disabled={busy}
          className={`shrink-0 text-xs rounded px-3 py-1 text-white disabled:bg-stone-700 ${
            st.running ? 'bg-stone-600 hover:bg-stone-500' : 'bg-teal-700 hover:bg-teal-600'
          }`}
        >
          {busy ? 'working…' : st.running ? 'stop' : 'start'}
        </button>
      </div>
      {(err || st.error) && (
        <div className="mt-1.5 text-xs text-red-400">{err || st.error}</div>
      )}
    </div>
  );
}

/** Relocate the bundled Ollama model store to an external drive / bigger disk
 *  from the UI — no .env or compose edits. Save writes the path; the sidecar
 *  migrates the existing models (non-destructively) and rebinds Ollama. */
function ModelStorage() {
  const [info, setInfo] = useState<ModelsDirInfo | null>(null);
  const [path, setPath] = useState('');
  const [op, setOp] = useState<string | null>(null);   // 'relocate' while running
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);

  const refresh = () =>
    getModelsDir().then(i => { setInfo(i); setPath(i.path ?? ''); }).catch(() => {});
  useEffect(() => { refresh(); }, []);

  // while a relocate runs, poll the sidecar op until it clears, then refresh
  useEffect(() => {
    if (!op) return;
    const iv = setInterval(async () => {
      try {
        const st = await getBundledInference();
        if (st.op !== 'relocate') {
          setOp(null);
          if (st.error) setErr(st.error); else setDone(true);
          refresh();
        }
      } catch { /* keep polling */ }
    }, 3000);
    return () => clearInterval(iv);
  }, [op]);

  if (!info) return null;
  const current = info.path ? `${info.path}/ollama` : 'default docker volume';
  const dirty = path.trim() !== (info.path ?? '');

  async function save() {
    setErr(''); setDone(false);
    try {
      await setModelsDir(path.trim());
      setOp('relocate');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="rounded-lg border border-stone-700 bg-stone-800/50 p-3">
      <div className="text-sm text-stone-200 flex items-center gap-2">
        Model storage
        {op === 'relocate' && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />}
        {op === 'relocate' && <span className="text-xs text-amber-400">relocating — migrating models…</span>}
      </div>
      <div className="text-xs text-stone-500 mt-0.5">
        Where the bundled model weights live — Ollama LLMs plus the Kokoro/Whisper
        voice models when running. Point it at an external SSD, a NAS mount, or a
        bigger disk to save space or share between machines. Save migrates your
        existing models — the old copy is kept until you remove it — and restarts
        the affected services. No files to edit.
      </div>
      <div className="mt-2 flex gap-2">
        <input
          value={path}
          onChange={e => setPath(e.target.value)}
          placeholder="/mnt/ssd/nova-models   (empty = default volume)"
          disabled={op === 'relocate'}
          className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200 disabled:opacity-50" />
        <button onClick={save} disabled={op === 'relocate' || !dirty}
          className="shrink-0 text-xs rounded px-3 py-1 text-white bg-teal-700 hover:bg-teal-600 disabled:bg-stone-700">
          {op === 'relocate' ? 'working…' : 'Save'}
        </button>
      </div>
      <div className="mt-1 text-[11px] font-mono text-stone-500">current: {current}</div>
      {err && <div className="mt-1 text-xs text-red-400">{err}</div>}
      {done && !op && !err && (
        <div className="mt-1 text-xs text-emerald-400">
          relocated — Ollama now uses the new path.
        </div>
      )}
    </div>
  );
}

/** Pull a new Ollama model from inside Nova (streams progress from /api/pull). */
function PullModel({ onPulled }: { onPulled: () => void }) {
  const [name, setName] = useState('');
  const [progress, setProgress] = useState('');
  const [pulling, setPulling] = useState(false);

  async function pull(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || pulling) return;
    setPulling(true);
    setProgress('starting…');
    try {
      for await (const ev of pullModel(name.trim())) {
        if (typeof ev.error === 'string') {
          setProgress(`✗ ${ev.error}`);
          setPulling(false);
          return;
        }
        const status = String(ev.status ?? '');
        if (typeof ev.total === 'number' && typeof ev.completed === 'number' && ev.total > 0) {
          setProgress(`${status} — ${Math.round((ev.completed / ev.total) * 100)}%`);
        } else if (status) {
          setProgress(status);
        }
      }
      setProgress(`✓ ${name.trim()} ready`);
      onPulled();
    } catch (err) {
      setProgress(`✗ ${err}`);
    } finally {
      setPulling(false);
    }
  }

  return (
    <form onSubmit={pull} className="mt-1 rounded-lg border border-dashed border-stone-700 p-3 space-y-2">
      <div className="text-sm text-stone-200">Pull a new local model</div>
      <div className="text-xs text-stone-500">
        Any model from the Ollama library (e.g. <code className="font-mono">qwen2.5:7b</code>,{' '}
        <code className="font-mono">llama3.2:3b</code>). Downloads into the bundled service.
      </div>
      <div className="flex gap-2">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="model:tag"
          disabled={pulling}
          className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm font-mono text-stone-200 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={pulling || !name.trim()}
          className="text-xs bg-teal-700 hover:bg-teal-600 disabled:bg-stone-700 text-white rounded px-3 py-1"
        >
          {pulling ? 'pulling…' : 'pull'}
        </button>
      </div>
      {progress && <div className="text-xs font-mono text-stone-400">{progress}</div>}
    </form>
  );
}

function probeLine(p: ProbeResult | 'running' | undefined) {
  if (!p) return null;
  if (p === 'running') return <span className="text-amber-400">probing… (local models can take a minute)</span>;
  if (p.error) return <span className="text-red-400">✗ {p.error}</span>;
  if (!p.tool_call_ok) return <span className="text-red-400">✗ tool call failed the mechanical check</span>;
  if (p.agentic_ok === false) {
    return (
      <span className="text-amber-400">
        ⚠ calls tools when forced, but NARRATES in agentic context — dispatches
        it describes won't actually happen · {p.tok_s != null && `${p.tok_s} tok/s · `}TTFT {p.ttft_ms} ms
      </span>
    );
  }
  return (
    <span className="text-emerald-400">
      ✓ tool call{p.agentic_ok ? ' + agentic judgment' : ''} verified ·{' '}
      {p.tok_s != null && `${p.tok_s} tok/s · `}
      TTFT {p.ttft_ms} ms · {p.gpu_active ? `GPU (${p.vram_gb ?? '?'} GB VRAM)` : p.gpu_active === false ? 'CPU' : 'cloud'}
    </span>
  );
}

const BAR_COLORS = ['bg-teal-600', 'bg-sky-600', 'bg-violet-600', 'bg-amber-600',
  'bg-rose-600', 'bg-lime-600'];

/** One stacked memory bar: distinct local models as segments vs the pool
 *  total. Many agents on one model = one segment (one load in Ollama). */
function MemoryBar({ label, used, total, over, items }: {
  label: string; used: number; total: number | null; over: boolean;
  items: { model: string; gb: number | null; source: string; pinned: boolean; agents: string[] }[];
}) {
  if (!items.length) return null;
  const denom = total && total > 0 ? Math.max(total, used) : Math.max(used, 1);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[11px] text-stone-400">
        <span>{label}</span>
        <span className={over ? 'text-red-400' : ''}>
          {used} / {total ?? '?'} GB{over && total != null ? ` — over by ${Math.round((used - total) * 10) / 10} GB` : ''}
        </span>
      </div>
      <div className="h-2.5 rounded bg-stone-800 overflow-hidden flex">
        {items.map((it, i) => (
          <div
            key={it.model}
            title={`${it.model} — ${it.gb ?? '?'} GB (${it.source})`}
            className={`${BAR_COLORS[i % BAR_COLORS.length]} ${it.source !== 'probe' ? 'opacity-60' : ''} h-full`}
            style={{ width: `${((it.gb ?? 0) / denom) * 100}%` }}
          />
        ))}
        {total != null && used < total && <div className="flex-1" />}
      </div>
      <div className="space-y-0.5">
        {items.map((it, i) => (
          <div key={it.model} className="flex items-center gap-1.5 text-[11px]">
            <span className={`w-2 h-2 rounded-sm shrink-0 ${BAR_COLORS[i % BAR_COLORS.length]}`} />
            <span className="font-mono text-stone-300 truncate">{it.model}</span>
            <span className="text-stone-500 shrink-0">
              {it.gb != null ? `${it.gb} GB` : '? GB'}
              {it.source === 'estimate' ? ' est.' : it.source === 'unknown' ? ' — probe it' : ''}
              {it.pinned ? ' · 📌 pinned' : ''}
            </span>
            <span className="text-stone-600 truncate">· {it.agents.join(', ')}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Both pools of a budget, plus the cloud models listed at zero. */
function BudgetBars({ budget }: { budget: ModelBudget }) {
  const vramItems = budget.items.filter(i => i.pool === 'vram');
  const ramItems = budget.items.filter(i => i.pool === 'ram');
  const cloudItems = budget.items.filter(i => i.pool === 'cloud');
  return (
    <div className="space-y-2">
      <MemoryBar label="VRAM if all load at once" used={budget.vram_used_gb}
        total={budget.vram_total_gb} over={budget.vram_over} items={vramItems} />
      <MemoryBar label="RAM if all load at once (OS overhead not included)"
        used={budget.ram_used_gb} total={budget.ram_total_gb}
        over={budget.ram_over} items={ramItems} />
      {cloudItems.length > 0 && (
        <div className="text-[11px] text-stone-600">
          cloud (0 GB local): {cloudItems.map(i => `${i.model} (${i.agents.length})`).join(' · ')}
        </div>
      )}
      {(budget.vram_over || budget.ram_over) && (
        <div className="text-[11px] text-amber-400/90">
          Over budget doesn't crash — Ollama evicts or spills to CPU, which
          shows up as multi-second reloads on every agent switch.
        </div>
      )}
    </div>
  );
}

/** Concurrent-load card for the CURRENT assignments. In Nova concurrency is
 *  the common case: a dispatch turn runs main's model and the sub-agent's
 *  within one request. */
function ConcurrentLoad() {
  const [budget, setBudget] = useState<ModelBudget | null>(null);
  const load = () => getModelBudget().then(setBudget).catch(() => setBudget(null));
  useEffect(() => {
    load();
    const onChange = () => load();
    window.addEventListener('nova:setting-changed', onChange);
    return () => window.removeEventListener('nova:setting-changed', onChange);
  }, []);

  if (!budget) return null;
  return (
    <div className="rounded-lg border border-stone-700 bg-stone-800/50 p-3 space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div className="text-sm text-stone-200">Concurrent load — current assignments</div>
        <button onClick={load}
          className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200">
          refresh
        </button>
      </div>
      <BudgetBars budget={budget} />
    </div>
  );
}

/** Detect & suggest — hardware-sized, per-agent model recommendations with
 *  a one-click probe. Detection runs on demand and is timestamped; nothing
 *  is cached or pulled behind the operator's back. */
function DetectSuggest() {
  const [recs, setRecs] = useState<RecommendationsResponse | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [probes, setProbes] = useState<Record<string, ProbeResult | 'running'>>({});
  const [applied, setApplied] = useState<Set<string>>(new Set());

  async function detect() {
    setRunning(true);
    setStatus('');
    setApplied(new Set());
    try {
      const [r, a] = await Promise.all([getRecommendations(), getAgents()]);
      setRecs(r);
      setAgents(a);
    } catch (e) { setStatus(String(e)); }
    setRunning(false);
  }

  async function apply(rec: ModelRecommendation) {
    if (!rec.suggested_model) return;
    try {
      if (rec.agent === 'compaction (setting)') {
        await patchSettings({ 'compaction.model': rec.suggested_model });
      } else {
        const agent = agents.find(a => a.name === rec.agent);
        if (!agent) throw new Error(`agent ${rec.agent} not found`);
        await patchAgent(agent.id, { model: rec.suggested_model });
      }
      setApplied(prev => new Set(prev).add(rec.agent));
    } catch (e) { setStatus(String(e)); }
  }

  async function applyAll() {
    if (!recs) return;
    for (const r of recs.recommendations) {
      if (r.status === 'switch' && !applied.has(r.agent)) await apply(r);
    }
  }

  async function probe(model: string) {
    setProbes(p => ({ ...p, [model]: 'running' }));
    try {
      const res = await testModel(model);
      setProbes(p => ({ ...p, [model]: res }));
    } catch (e) {
      setProbes(p => ({
        ...p,
        [model]: { model, ok: false, error: String(e) } as ProbeResult,
      }));
    }
  }

  const hw = recs?.hardware;
  const switches = recs?.recommendations.filter(r => r.status === 'switch') ?? [];

  return (
    <div className="rounded-lg border border-stone-700 bg-stone-800/50 p-3 space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm text-stone-200">Detect &amp; suggest</div>
          <div className="text-xs text-stone-500">
            Size this machine and suggest a model per agent from the curated
            table below. Suggestions are advice — test them before trusting them.
          </div>
        </div>
        <button
          onClick={detect}
          disabled={running}
          className="shrink-0 text-xs bg-teal-700 hover:bg-teal-600 disabled:bg-stone-700 text-white rounded px-3 py-1"
        >
          {running ? 'detecting…' : recs ? 'refresh' : 'detect & suggest'}
        </button>
      </div>

      {hw && (
        <div className="text-xs font-mono text-stone-400 border-t border-stone-700/60 pt-2">
          {hw.ram_gb ?? '?'} GB RAM
          {hw.memory_override_gb ? ` (sizing vs ${hw.sizing_ram_gb} GB — operator override)` : ''} ·{' '}
          {hw.cpu_cores ?? '?'} cores ·
          {hw.gpu_name
            ? ` ${hw.gpu_name} · ${hw.vram_total_gb} GB VRAM`
            : hw.unified_gpu
            ? ' unified-memory GPU (observed)'
            : hw.nvidia_runtime
            ? ` NVIDIA runtime ✓ · VRAM ${hw.vram_observed_gb != null ? `${hw.vram_observed_gb} GB observed` : 'unmeasured'}`
            : hw.nvidia_runtime === false ? ' no GPU runtime' : ' GPU unknown'} ·
          detected {fmtTime(hw.detected_at)}
          {!recs?.cloud_available && <span className="text-stone-500"> · no cloud key — local only</span>}
        </div>
      )}
      {hw?.memory_note && (
        <div className="text-[11px] text-stone-500">{hw.memory_note}</div>
      )}
      {hw?.nvidia_runtime && hw.vram_total_gb == null && (
        <div className="text-xs text-amber-400/90">
          GPU runtime detected, but the bundled Ollama isn't exposing a GPU —
          it may be stopped, or running without the GPU override
          (docker-compose.gpu.yml, merged automatically by the sidecar).
          Restart it with the toggle above, then re-detect.
        </div>
      )}
      {recs?.catalog_freshness?.stale && (
        <div className="text-xs text-amber-400/90">
          The model catalog's newest entry is {recs.catalog_freshness.age_days} days
          old — models move fast, so these suggestions may trail the frontier.
          Ask the model-manager (chat: "any newer models I should run?") to check
          for current releases and propose additions.
        </div>
      )}

      {recs && (
        <div className="space-y-2">
          {recs.recommendations.map(r => (
            <div key={r.agent} className="rounded border border-stone-700/60 bg-stone-900/40 px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs text-stone-100">{agentDisplayName(r.agent)}</span>
                  <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">{r.profile}</span>
                  {r.current_valid === false && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded border bg-red-950/50 text-red-300 border-red-900"
                      title="Pin guard: the current model is not in the live catalog — requests with it will fail."
                    >
                      current model missing
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {r.status === 'keep' ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-800 text-emerald-400">✓ keep current</span>
                  ) : r.status === 'switch' && r.suggested_model ? (
                    <>
                      <button
                        onClick={() => probe(r.suggested_model!)}
                        disabled={probes[r.suggested_model] === 'running'}
                        className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200 disabled:opacity-50"
                      >
                        test
                      </button>
                      {applied.has(r.agent) ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-800 text-emerald-400">✓ applied</span>
                      ) : (
                        <button
                          onClick={() => apply(r)}
                          className="text-xs px-2 py-0.5 rounded bg-teal-700 hover:bg-teal-600 text-white"
                        >
                          apply
                        </button>
                      )}
                    </>
                  ) : (
                    <span className="text-[10px] text-stone-500">no fit</span>
                  )}
                </div>
              </div>
              <div className="mt-1 text-xs font-mono text-stone-400 truncate">
                {r.current_model}
                {r.status === 'switch' && r.suggested_model && (
                  <> <span className="text-stone-600">→</span> <span className="text-teal-300">{r.suggested_model}</span></>
                )}
              </div>
              <div className="mt-0.5 text-xs text-stone-500">{r.reason}</div>
              {r.alternates.length > 0 && (
                <div className="mt-0.5 text-[11px] text-stone-600">
                  alternates: {r.alternates.map(a => `${a.model} (${a.note})`).join(' · ')}
                </div>
              )}
              {r.suggested_model && probes[r.suggested_model] && (
                <div className="mt-1 text-xs font-mono">{probeLine(probes[r.suggested_model])}</div>
              )}
            </div>
          ))}
          <div className="rounded border border-stone-700/60 bg-stone-900/40 px-2.5 py-2">
            <div className="text-[11px] text-stone-400 mb-1.5">If all SUGGESTED models load at once:</div>
            <BudgetBars budget={recs.budget} />
          </div>
          {switches.length > 1 && (
            <button
              onClick={applyAll}
              className="w-full text-xs bg-teal-800/60 hover:bg-teal-700 text-teal-100 rounded py-1.5"
            >
              apply all {switches.filter(r => !applied.has(r.agent)).length} suggestions
            </button>
          )}
        </div>
      )}
      {status && <div className="text-xs text-red-400">{status}</div>}
    </div>
  );
}

/** The curated model table behind recommendations — seeded knowledge,
 *  operator-editable (system rows toggle-only, like rules/tools). */
function CuratedTable() {
  const [rows, setRows] = useState<CuratedModel[]>([]);
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CuratedModel | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [pulls, setPulls] = useState<Record<string, string>>({});
  const emptyForm = {
    model: '', provider: 'ollama', min_ram_gb: '', min_vram_gb: '',
    tool_tier: 'B', speed: 'medium', roles: '', notes: '',
  };
  const [form, setForm] = useState(emptyForm);

  const load = () => getCuratedModels().then(setRows).catch(e => setStatus(String(e)));
  const loadInstalled = () => getModels()
    .then(ms => setInstalled(new Set(ms.filter(m => m.provider === 'ollama').map(m => m.id))))
    .catch(() => {});
  useEffect(() => { load(); loadInstalled(); }, []);

  async function uninstallRow(m: CuratedModel) {
    const name = m.model.startsWith('ollama:') ? m.model.slice(7) : m.model;
    if (!window.confirm(`Uninstall "${name}"? The download is gone from disk; you can pull it again later.`)) return;
    try {
      await uninstallModel(name);
      setPulls(p => {
        const next = { ...p };
        delete next[m.model];
        return next;
      });
      loadInstalled();
    } catch (e) { setStatus(String(e)); }
  }

  async function pullRow(m: CuratedModel) {
    const name = m.model.startsWith('ollama:') ? m.model.slice(7) : m.model;
    setPulls(p => ({ ...p, [m.model]: 'starting…' }));
    try {
      for await (const ev of pullModel(name)) {
        if (typeof ev.error === 'string') {
          setPulls(p => ({ ...p, [m.model]: `✗ ${ev.error}` }));
          return;
        }
        const st = String(ev.status ?? '');
        if (typeof ev.total === 'number' && typeof ev.completed === 'number' && ev.total > 0) {
          const pct = Math.round((ev.completed / ev.total) * 100);
          setPulls(p => ({ ...p, [m.model]: `${st} — ${pct}%` }));
        } else if (st) {
          setPulls(p => ({ ...p, [m.model]: st }));
        }
      }
      setPulls(p => ({ ...p, [m.model]: '✓ installed' }));
      loadInstalled();
    } catch (err) {
      setPulls(p => ({ ...p, [m.model]: `✗ ${err}` }));
    }
  }

  async function toggle(m: CuratedModel) {
    try { await patchCuratedModel(m.id, { enabled: !m.enabled }); load(); }
    catch (e) { setStatus(String(e)); }
  }

  async function remove(m: CuratedModel) {
    if (!window.confirm(`Remove "${m.model}" from the curated table?`)) return;
    try { await deleteCuratedModel(m.id); load(); } catch (e) { setStatus(String(e)); }
  }

  const parseRoles = (s: string) => s.split(',').map(r => r.trim()).filter(Boolean);
  const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

  function startEdit(m: CuratedModel) {
    setEditing(m);
    setForm({
      model: m.model, provider: m.provider,
      min_ram_gb: m.min_ram_gb == null ? '' : String(m.min_ram_gb),
      min_vram_gb: m.min_vram_gb == null ? '' : String(m.min_vram_gb),
      tool_tier: m.tool_tier, speed: m.speed,
      roles: m.roles.join(', '), notes: m.notes,
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const fields = {
      min_ram_gb: numOrNull(form.min_ram_gb),
      min_vram_gb: numOrNull(form.min_vram_gb),
      tool_tier: form.tool_tier, speed: form.speed,
      roles: parseRoles(form.roles), notes: form.notes,
    };
    try {
      if (editing) {
        await patchCuratedModel(editing.id, fields);
        setEditing(null);
      } else {
        await createCuratedModel({ model: form.model, provider: form.provider as CuratedModel['provider'], ...fields } as Partial<CuratedModel>);
        setCreating(false);
      }
      setForm(emptyForm);
      setStatus('');
      load();
    } catch (err) { setStatus(String(err)); }
  }

  const formFields = (
    <>
      <div className="flex gap-2">
        <input placeholder="min RAM GB (CPU)" value={form.min_ram_gb}
          onChange={e => setForm({ ...form, min_ram_gb: e.target.value })}
          className="w-32 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200" />
        <input placeholder="min VRAM GB (GPU)" value={form.min_vram_gb}
          onChange={e => setForm({ ...form, min_vram_gb: e.target.value })}
          className="w-32 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200" />
        <select value={form.tool_tier} onChange={e => setForm({ ...form, tool_tier: e.target.value })}
          className="bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200" title="tool tier">
          {['A', 'B', 'C'].map(t => <option key={t} value={t}>tier {t}</option>)}
        </select>
        <select value={form.speed} onChange={e => setForm({ ...form, speed: e.target.value })}
          className="bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200" title="speed class">
          {['fast', 'medium', 'slow'].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <input placeholder="roles (comma-sep: chat, tools, guard, compaction)" value={form.roles}
        onChange={e => setForm({ ...form, roles: e.target.value })}
        className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200" />
      <input placeholder="notes" value={form.notes}
        onChange={e => setForm({ ...form, notes: e.target.value })}
        className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200" />
    </>
  );

  return (
    <details className="rounded-lg border border-stone-700 bg-stone-800/30">
      <summary className="px-3 py-2 text-sm text-stone-300 cursor-pointer select-none">
        Curated model table ({rows.length}) — the knowledge behind suggestions
      </summary>
      <div className="px-3 pb-3 space-y-2">
        <p className="text-xs text-stone-500">
          Rough requirements per model; the probe is the truth. <b>Approved</b> =
          feeds suggestions and the model dropdowns; switching it off vetoes the
          model but never deletes the row — flip it back anytime. Seeded rows
          can be toggled but not rewritten; add your own for anything missing.
        </p>
        {rows.map(m => (
          <div key={m.id} className="rounded border border-stone-700/60 bg-stone-900/40 px-2.5 py-2">
            {editing?.id === m.id ? (
              <form onSubmit={submit} className="space-y-2">
                <div className="text-xs font-mono text-stone-100">{m.model}</div>
                {formFields}
                <div className="flex gap-2 justify-end">
                  <button type="button" onClick={() => { setEditing(null); setForm(emptyForm); }} className="text-xs text-stone-400 px-2">cancel</button>
                  <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">save</button>
                </div>
              </form>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-mono text-stone-100 truncate">{m.model}</span>
                    <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">tier {m.tool_tier}</span>
                    {m.is_system && <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">seed</span>}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {m.provider === 'ollama' && (
                      installed.has(m.model) ? (
                        <>
                          <span className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-800 text-emerald-400">✓ installed</span>
                          <button onClick={() => uninstallRow(m)}
                            title="Free the disk space — refuses while an agent or setting still uses this model."
                            className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800">
                            uninstall
                          </button>
                        </>
                      ) : (
                        <button onClick={() => pullRow(m)}
                          disabled={pulls[m.model] !== undefined && !pulls[m.model].startsWith('✗')}
                          className="text-xs px-2 py-0.5 rounded bg-teal-700 hover:bg-teal-600 disabled:bg-stone-700 text-white">
                          pull
                        </button>
                      )
                    )}
                    {!m.is_system && (
                      <>
                        <button onClick={() => startEdit(m)}
                          className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200">
                          edit
                        </button>
                        <button onClick={() => remove(m)}
                          className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800">
                          delete
                        </button>
                      </>
                    )}
                    <Toggle on={m.enabled} onChange={() => toggle(m)} label="approved"
                      title="Approved rows feed suggestions and the model dropdowns; switch off to veto a model without deleting it." />
                  </div>
                </div>
                <div className="mt-0.5 text-[11px] text-stone-500">
                  {m.speed} · {m.roles.join('/') || 'no roles'}
                  {m.min_ram_gb != null && ` · ${m.min_ram_gb} GB RAM`}
                  {m.min_vram_gb != null && ` · ${m.min_vram_gb} GB VRAM`}
                </div>
                {m.notes && <div className="mt-0.5 text-[11px] text-stone-600 line-clamp-2">{m.notes}</div>}
                {pulls[m.model] && (
                  <div className="mt-0.5 text-[11px] font-mono text-stone-400">{pulls[m.model]}</div>
                )}
                {m.last_probe && (
                  <div className="mt-0.5 text-[11px] font-mono">{probeLine(m.last_probe)}
                    {m.probed_at && <span className="text-stone-600"> · {fmtDateTime(m.probed_at)}</span>}
                  </div>
                )}
              </>
            )}
          </div>
        ))}

        {creating ? (
          <form onSubmit={submit} className="rounded border border-teal-800 bg-stone-900/40 px-2.5 py-2 space-y-2">
            <div className="flex gap-2">
              <input required placeholder="model, e.g. ollama:gemma3:12b" value={form.model}
                onChange={e => setForm({ ...form, model: e.target.value })}
                className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200" />
              <select value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })}
                className="bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200">
                <option value="ollama">ollama</option>
                <option value="openrouter">openrouter</option>
              </select>
            </div>
            {formFields}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => { setCreating(false); setForm(emptyForm); }} className="text-xs text-stone-400 px-2">cancel</button>
              <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">add</button>
            </div>
          </form>
        ) : (
          <button onClick={() => { setForm(emptyForm); setCreating(true); }}
            className="w-full text-xs text-stone-400 hover:text-teal-300 border border-dashed border-stone-700 hover:border-teal-800 rounded py-1.5">
            + add a model
          </button>
        )}
        {status && <div className="text-xs text-red-400">{status}</div>}
      </div>
    </details>
  );
}

/** Skills — markdown behaviors Nova retrieves by relevance and follows.
 *  Written from chat by skill-manager; viewable and editable here too
 *  (the memory index rescans on every write). */
function SkillsTab() {
  const [rows, setRows] = useState<SkillInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState('');
  const [expanded, setExpanded] = useState<Record<string, string | null>>({});
  const [editing, setEditing] = useState<SkillInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const emptyForm = { title: '', description: '', content: '' };
  const [form, setForm] = useState(emptyForm);

  const load = () => getSkills().then(setRows).catch(e => setStatus(String(e)))
    .finally(() => setLoaded(true));
  useEffect(() => { load(); }, []);

  async function toggleExpand(id: string) {
    if (expanded[id] !== undefined) {
      setExpanded(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    setExpanded(prev => ({ ...prev, [id]: null }));
    try {
      const item = await getMemoryItem(id);
      setExpanded(prev => ({ ...prev, [id]: item.content }));
    } catch (e) { setStatus(String(e)); }
  }

  async function startEdit(s: SkillInfo) {
    try {
      const item = await getMemoryItem(s.id);
      setEditing(s);
      setForm({ title: s.title, description: s.description, content: item.content });
    } catch (e) { setStatus(String(e)); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (editing) {
        await updateSkill(editing.id, form);
        setEditing(null);
      } else {
        await createSkill(form);
        setCreating(false);
      }
      setForm(emptyForm);
      setExpanded({});
      setStatus('');
      load();
    } catch (err) { setStatus(String(err)); }
  }

  async function remove(s: SkillInfo) {
    if (!window.confirm(`Delete skill "${s.title}"? This cannot be undone.`)) return;
    try { await deleteSkill(s.id); load(); } catch (e) { setStatus(String(e)); }
  }

  const formFields = (
    <>
      <input required placeholder="title" value={form.title}
        onChange={e => setForm({ ...form, title: e.target.value })}
        className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200" />
      <input placeholder="description — when should Nova reach for this skill?" value={form.description}
        onChange={e => setForm({ ...form, description: e.target.value })}
        className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200" />
      <textarea required placeholder="the skill itself, markdown…" value={form.content}
        onChange={e => setForm({ ...form, content: e.target.value })}
        rows={8}
        className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm font-mono text-stone-200" />
    </>
  );

  if (!loaded) return <CardsSkeleton n={3} />;
  return (
    <div className="space-y-3">
      <p className="text-xs text-stone-500">
        Skills are markdown behaviors, retrieved by relevance and injected into
        agent prompts. Nova writes them from chat (skill-manager); files live
        in <code className="font-mono">data/memory/skills/</code> and are safe
        to edit by hand too.
      </p>

      {rows.map(s => (
        <div key={s.id} className="rounded-lg border border-stone-700 bg-stone-800/50 p-3">
          {editing?.id === s.id ? (
            <form onSubmit={submit} className="space-y-2">
              {formFields}
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => { setEditing(null); setForm(emptyForm); }} className="text-xs text-stone-400 px-2">cancel</button>
                <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">save</button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm text-stone-100 truncate">{s.title}</span>
                  {s.category && <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">{s.category}</span>}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {(
                    <>
                      <button onClick={() => startEdit(s)}
                        className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200">
                        edit
                      </button>
                      <button onClick={() => remove(s)}
                        className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800">
                        delete
                      </button>
                    </>
                  )}
                  <button onClick={() => toggleExpand(s.id)}
                    className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200">
                    {expanded[s.id] !== undefined ? 'hide' : 'view'}
                  </button>
                </div>
              </div>
              {s.description && <div className="mt-1 text-xs text-stone-400">{s.description}</div>}
              {s.updated && <div className="mt-0.5 text-[11px] text-stone-600">updated {s.updated} · {s.id}</div>}
              {expanded[s.id] !== undefined && (
                <div className="mt-2 border-t border-stone-700/60 pt-2 text-sm text-stone-300">
                  {expanded[s.id] === null
                    ? <span className="text-xs text-stone-500">loading…</span>
                    : <Markdown>{expanded[s.id]!}</Markdown>}
                </div>
              )}
            </>
          )}
        </div>
      ))}
      {rows.length === 0 && (
        <div className="text-xs text-stone-500 italic">
          No skills yet — ask Nova to learn one, or create it here.
        </div>
      )}

      {creating ? (
        <form onSubmit={submit} className="rounded-lg border border-teal-800 bg-stone-800/50 p-3 space-y-2">
          {formFields}
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => { setCreating(false); setForm(emptyForm); }} className="text-xs text-stone-400 px-2">cancel</button>
            <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">create</button>
          </div>
        </form>
      ) : (
        <button onClick={() => { setForm(emptyForm); setCreating(true); }}
          className="w-full text-xs text-stone-400 hover:text-teal-300 border border-dashed border-stone-700 hover:border-teal-800 rounded-lg py-2">
          + new skill
        </button>
      )}
      {status && <div className="text-xs text-red-400">{status}</div>}
    </div>
  );
}

/** Model inventory & governance: keep-warm, pulls, the curated (approved)
 *  table that feeds dropdowns and recommendations, and the full catalog of
 *  authenticated providers. Machine infra stays in Settings → Inference;
 *  per-agent assignment lives in Agents. */
function ModelsTab() {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-stone-700 bg-stone-800/30 p-3">
        <SettingsTab only={['Models']} />
      </div>
      <PullModel onPulled={() => {}} />
      <ProvidersPanel />
      <CuratedTable />
      <FullCatalog />
    </div>
  );
}

/** LLM providers — bring your own key / endpoint. Any OpenAI-compatible
 *  provider (OpenAI, Anthropic, Gemini, Groq, HuggingFace, a local LM Studio /
 *  vLLM server, or a custom URL) can be added here; its models then show up in
 *  the Full catalog below, ready to approve. Keys are stored server-side and
 *  never sent back — the UI only ever sees "key set" + the last 4 chars. */
function ProvidersPanel() {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [status, setStatus] = useState('');
  const [tests, setTests] = useState<Record<string, string>>({});
  const emptyForm = {
    slug: '', label: '', base_url: '', api_key: '',
    needs_key: true, catalog_path: '/models',
  };
  const [form, setForm] = useState(emptyForm);

  const load = () => getProviders().then(setProviders).catch(e => setStatus(String(e)));
  useEffect(() => {
    load();
    getProviderPresets().then(setPresets).catch(() => {});
    const t = setInterval(load, 30000);  // keep the reachability dots fresh
    return () => clearInterval(t);
  }, []);

  function applyPreset(slug: string) {
    const p = presets.find(x => x.slug === slug);
    if (!p) return;
    const custom = p.slug === 'custom';
    setForm({
      slug: custom ? '' : p.slug,
      label: custom ? '' : p.label,
      base_url: p.base_url, api_key: '',
      needs_key: p.needs_key, catalog_path: '/models',
    });
  }

  function startAdd() { setEditing(null); setForm(emptyForm); setAdding(true); }
  function startEdit(p: Provider) {
    setAdding(false);
    setEditing(p);
    setForm({
      slug: p.slug, label: p.label, base_url: p.base_url, api_key: '',
      needs_key: p.needs_key, catalog_path: p.catalog_path,
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (editing) {
        const body: Record<string, unknown> = {
          label: form.label, base_url: form.base_url,
          needs_key: form.needs_key, catalog_path: form.catalog_path,
        };
        if (form.api_key) body.api_key = form.api_key;  // blank = keep current key
        await patchProvider(editing.id, body);
        setEditing(null);
      } else {
        await createProvider({
          slug: form.slug, label: form.label, base_url: form.base_url,
          api_key: form.api_key || undefined,
          needs_key: form.needs_key, catalog_path: form.catalog_path,
        });
        setAdding(false);
      }
      setForm(emptyForm);
      setStatus('');
      load();
    } catch (err) { setStatus(String(err)); }
  }

  async function toggle(p: Provider) {
    try { await patchProvider(p.id, { enabled: !p.enabled }); load(); }
    catch (e) { setStatus(String(e)); }
  }

  async function remove(p: Provider) {
    if (!window.confirm(`Remove provider "${p.label}"? Models assigned to it will fall back to local until reassigned.`)) return;
    try { await deleteProvider(p.id); load(); } catch (e) { setStatus(String(e)); }
  }

  async function test(p: Provider) {
    setTests(t => ({ ...t, [p.id]: 'testing…' }));
    try {
      const r = await testProvider(p.id);
      const msg = r.ok === true
        ? `✓ reachable${r.model_count != null ? ` — ${r.model_count} models` : ''}`
        : r.ok === null ? `— ${r.error}` : `✗ ${r.error}`;
      setTests(t => ({ ...t, [p.id]: msg }));
    } catch (e) { setTests(t => ({ ...t, [p.id]: `✗ ${e}` })); }
  }

  const formFields = (
    <>
      <div className="flex gap-2">
        <input required placeholder="slug (model-id prefix, e.g. openai)"
          value={form.slug} disabled={!!editing}
          onChange={e => setForm({ ...form, slug: e.target.value })}
          className="w-40 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200 disabled:opacity-50" />
        <input required placeholder="label (e.g. OpenAI)" value={form.label}
          onChange={e => setForm({ ...form, label: e.target.value })}
          className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200" />
      </div>
      <input required placeholder="base URL (…/v1)" value={form.base_url}
        onChange={e => setForm({ ...form, base_url: e.target.value })}
        className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200" />
      <input type="password" autoComplete="off"
        placeholder={editing?.key_set ? `API key (set …${editing.key_hint}; blank keeps it)` : 'API key'}
        value={form.api_key}
        onChange={e => setForm({ ...form, api_key: e.target.value })}
        className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200" />
      <div className="flex items-center gap-3">
        <input placeholder="catalog path (/models, blank = can't list)"
          value={form.catalog_path}
          onChange={e => setForm({ ...form, catalog_path: e.target.value })}
          className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200" />
        <label className="flex items-center gap-1.5 text-[11px] text-stone-400 select-none whitespace-nowrap">
          <input type="checkbox" checked={form.needs_key}
            onChange={e => setForm({ ...form, needs_key: e.target.checked })}
            className="accent-teal-600" />
          requires a key
        </label>
      </div>
    </>
  );

  return (
    <details className="rounded-lg border border-stone-700 bg-stone-800/30">
      <summary className="px-3 py-2 text-sm text-stone-300 cursor-pointer select-none">
        Providers{providers ? ` (${providers.length})` : ''} — bring your own key / endpoint
      </summary>
      <div className="px-3 pb-3 space-y-2">
        <p className="text-xs text-stone-500">
          Add any OpenAI-compatible provider — OpenAI, Anthropic, Gemini, Groq,
          HuggingFace, a local LM Studio / vLLM server, or a custom URL — with
          its own key. Its models then appear in the Full catalog below to
          approve. Keys are stored server-side and never shown again.
        </p>
        {providers === null ? (
          <div className="text-xs text-stone-500">loading…</div>
        ) : providers.map(p => (
          <div key={p.id} className="rounded border border-stone-700/60 bg-stone-900/40 px-2.5 py-2">
            {editing?.id === p.id ? (
              <form onSubmit={submit} className="space-y-2">
                {formFields}
                <div className="flex gap-2 justify-end">
                  <button type="button" onClick={() => { setEditing(null); setForm(emptyForm); }} className="text-xs text-stone-400 px-2">cancel</button>
                  <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">save</button>
                </div>
              </form>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-stone-100 truncate">{p.label}</span>
                    <span className="text-[10px] font-mono px-1 rounded bg-stone-700 text-stone-400">{p.slug}</span>
                    {p.is_system && <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">seed</span>}
                    {!p.configured ? (
                      <span className="text-[10px] px-1 rounded border border-amber-800 text-amber-400">no key</span>
                    ) : p.last_ok === false ? (
                      <span title={p.last_error ?? 'unreachable'}
                        className="flex items-center gap-1 text-[10px] text-red-400 shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />unreachable
                      </span>
                    ) : p.last_ok === true ? (
                      <span title={p.last_checked_at ? `reachable · checked ${fmtDateTime(p.last_checked_at)}` : 'reachable'}
                        className="flex items-center gap-1 text-[10px] text-emerald-400 shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />reachable
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-[10px] text-stone-500 shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-stone-500 animate-pulse" />checking…
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={() => test(p)}
                      className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-teal-300">test</button>
                    <button onClick={() => startEdit(p)}
                      className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200">edit</button>
                    {!p.is_system && (
                      <button onClick={() => remove(p)}
                        className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800">delete</button>
                    )}
                    <Toggle on={p.enabled} onChange={() => toggle(p)} label="enabled"
                      title="Disabled providers contribute no models and their assigned agents fall back to local." />
                  </div>
                </div>
                <div className="mt-0.5 text-[11px] font-mono text-stone-500 truncate">
                  {p.base_url}{p.key_set && ` · key …${p.key_hint}`}
                </div>
                {p.configured && p.last_ok === false && p.last_error && (
                  <div className="mt-0.5 text-[11px] text-red-400/90 truncate" title={p.last_error}>
                    ✗ {p.last_error}
                  </div>
                )}
                {tests[p.id] && <div className="mt-0.5 text-[11px] font-mono text-stone-400">{tests[p.id]}</div>}
              </>
            )}
          </div>
        ))}

        {adding ? (
          <form onSubmit={submit} className="rounded border border-teal-800 bg-stone-900/40 px-2.5 py-2 space-y-2">
            <select defaultValue="" onChange={e => applyPreset(e.target.value)}
              className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200">
              <option value="" disabled>start from a preset…</option>
              {presets.map(p => <option key={p.slug} value={p.slug}>{p.label}</option>)}
            </select>
            {formFields}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => { setAdding(false); setForm(emptyForm); }} className="text-xs text-stone-400 px-2">cancel</button>
              <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">add</button>
            </div>
          </form>
        ) : (
          <button onClick={startAdd}
            className="w-full text-xs text-stone-400 hover:text-teal-300 border border-dashed border-stone-700 hover:border-teal-800 rounded py-1.5">
            + add a provider
          </button>
        )}
        {status && <div className="text-xs text-red-400">{status}</div>}
      </div>
    </details>
  );
}

/** Everything the configured credentials can reach; installed local models
 *  can be uninstalled from here (covers pulls that aren't in the curated
 *  table). Any cloud model can be approved straight from here in one click —
 *  approval just creates (or re-enables) its curated row, which is what puts
 *  it in the agent + chat dropdowns. */
function FullCatalog() {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [curated, setCurated] = useState<CuratedModel[]>([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState('');

  const loadCurated = () => getCuratedModels().then(setCurated).catch(() => {});
  // curated row (if any) for a catalog model id — approval state lives here
  const rowFor = (id: string) => curated.find(c => c.model === id);

  async function uninstall(m: ModelInfo) {
    if (!window.confirm(`Uninstall "${m.name}"? You can pull it again later.`)) return;
    try {
      await uninstallModel(m.name);
      setStatus(`✓ ${m.name} uninstalled`);
      getModels(true).then(setModels).catch(() => {});
    } catch (e) { setStatus(String(e)); }
  }

  async function setApproved(m: ModelInfo, approved: boolean) {
    setBusy(b => ({ ...b, [m.id]: true }));
    try {
      const row = rowFor(m.id);
      if (approved) {
        // re-enable an existing row, or create a fresh (bare) one — metadata
        // like tier/roles can be filled in later from the curated table; it
        // isn't needed just to make the model assignable.
        if (row) await patchCuratedModel(row.id, { enabled: true });
        else await createCuratedModel({ model: m.id, provider: m.provider as CuratedModel['provider'] });
      } else if (row) {
        // seeded rows can't be deleted — veto by disabling; user rows are removed
        if (row.is_system) await patchCuratedModel(row.id, { enabled: false });
        else await deleteCuratedModel(row.id);
      }
      setStatus('');
      await loadCurated();
    } catch (e) { setStatus(String(e)); }
    finally { setBusy(b => ({ ...b, [m.id]: false })); }
  }

  const shown = (models ?? []).filter(
    m => !filter.trim() || m.id.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <details
      className="rounded-lg border border-stone-700 bg-stone-800/30"
      onToggle={e => {
        if ((e.target as HTMLDetailsElement).open && models === null) {
          getModels(true).then(setModels).catch(() => setModels([]));
          loadCurated();
        }
      }}
    >
      <summary className="px-3 py-2 text-sm text-stone-300 cursor-pointer select-none">
        Full catalog — authenticated providers{models ? ` (${models.length})` : ''}
      </summary>
      <div className="px-3 pb-3">
        <p className="text-xs text-stone-500 mb-1.5">
          Everything your credentials can reach. Providers without credentials
          are absent by design. Flip <b>approved</b> on any cloud model to put
          it in the agent and chat dropdowns — no need to type it into the
          curated table by hand.
        </p>
        {models && models.length > 20 && (
          <input
            placeholder="filter…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="w-full mb-1.5 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200"
          />
        )}
        <div className="max-h-64 overflow-y-auto nice-scroll space-y-0.5">
          {models === null ? (
            <div className="text-xs text-stone-500">loading…</div>
          ) : models.length === 0 ? (
            <div className="text-xs text-stone-500 italic">
              nothing reachable — no local models installed and no cloud credentials
            </div>
          ) : shown.length === 0 ? (
            <div className="text-xs text-stone-500 italic">no models match "{filter}"</div>
          ) : (
            shown.map(m => {
              const row = rowFor(m.id);
              const approved = !!row?.enabled;
              return (
                <div key={m.id} className="flex items-center justify-between gap-2">
                  <span className="text-xs font-mono text-stone-400 truncate">{m.id}</span>
                  {m.provider === 'ollama' ? (
                    <button onClick={() => uninstall(m)}
                      className="text-[10px] px-1.5 rounded border border-stone-700 text-stone-500 hover:text-red-400 hover:border-red-800 shrink-0">
                      uninstall
                    </button>
                  ) : (
                    <span className={busy[m.id] ? 'opacity-50 pointer-events-none' : ''}>
                      <Toggle on={approved} onChange={() => setApproved(m, !approved)} label="approved"
                        title="Approved cloud models appear in the agent + chat model dropdowns. Off vetoes the model without losing any curated metadata." />
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
        {status && <div className="mt-1 text-xs text-amber-400">{status}</div>}
      </div>
    </details>
  );
}

/** Per-agent model + status — every agent has its OWN model. */
function AgentsTab() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [showAllModels, setShowAllModels] = useState(false);
  const [allModel, setAllModel] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AgentInfo | null>(null);
  const [expandedPrompt, setExpandedPrompt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const emptyForm = {
    name: '', description: '', system_prompt: '', model: '',
    allowed_tools: '', routing_keywords: '',
  };
  const [form, setForm] = useState(emptyForm);

  const load = () => getAgents().then(setAgents).catch(e => setStatus(String(e)))
    .finally(() => setLoaded(true));
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    getModels(showAllModels).then(setModels).catch(() => {});
  }, [showAllModels]);

  async function setModel(a: AgentInfo, model: string) {
    try {
      await patchAgent(a.id, { model });
      setAgents(prev => prev.map(x => x.id === a.id ? { ...x, model } : x));
    } catch (e) { setStatus(String(e)); }
  }

  async function setAll() {
    if (!allModel) return;
    try {
      await Promise.all(agents.map(a => patchAgent(a.id, { model: allModel })));
      setStatus(`All agents set to ${allModel}`);
      setTimeout(() => setStatus(''), 2000);
      load();
    } catch (e) { setStatus(String(e)); }
  }

  async function toggle(a: AgentInfo) {
    try {
      await patchAgent(a.id, { enabled: !a.enabled });
      load();
    } catch (e) { setStatus(String(e)); }
  }

  // comma-separated → list; empty = null (null allowed_tools = all builtins)
  const parseList = (s: string): string[] | null => {
    const items = s.split(',').map(t => t.trim()).filter(Boolean);
    return items.length ? items : null;
  };

  function startEdit(a: AgentInfo) {
    setEditing(a);
    setForm({
      name: a.name, description: a.description, system_prompt: a.system_prompt,
      model: a.model,
      allowed_tools: a.allowed_tools?.join(', ') ?? '',
      routing_keywords: a.routing_keywords?.join(', ') ?? '',
    });
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    try {
      await patchAgent(editing.id, {
        description: form.description,
        system_prompt: form.system_prompt,
        allowed_tools: parseList(form.allowed_tools),
        routing_keywords: parseList(form.routing_keywords),
      });
      setEditing(null);
      setStatus('');
      load();
    } catch (err) { setStatus(String(err)); }
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    try {
      await createAgent({
        name: form.name, description: form.description,
        system_prompt: form.system_prompt, model: form.model,
        allowed_tools: parseList(form.allowed_tools),
        routing_keywords: parseList(form.routing_keywords),
      });
      setCreating(false);
      setForm(emptyForm);
      setStatus('');
      load();
    } catch (err) { setStatus(String(err)); }
  }

  async function remove(a: AgentInfo) {
    if (!window.confirm(`Delete agent "${agentDisplayName(a.name)}"? This cannot be undone.`)) return;
    try { await deleteAgent(a.id); load(); } catch (err) { setStatus(String(err)); }
  }

  const agentFields = (
    <>
      <label className="block">
        <span className="text-[10px] uppercase tracking-wide text-stone-500">Note — your description (not sent to the agent)</span>
        <textarea
          placeholder="a short note: what this agent is for"
          value={form.description}
          onChange={e => setForm({ ...form, description: e.target.value })}
          rows={2}
          className="w-full mt-0.5 resize-y bg-stone-800 border border-stone-700 rounded px-2 py-1.5 text-sm text-stone-200 leading-relaxed"
        />
      </label>
      <label className="block">
        <span className="text-[10px] uppercase tracking-wide text-stone-500">System prompt — the agent's instructions</span>
        <textarea
          required placeholder="the agent's instructions…"
          value={form.system_prompt}
          onChange={e => setForm({ ...form, system_prompt: e.target.value })}
          rows={8}
          className="w-full mt-0.5 resize-y bg-stone-800 border border-stone-700 rounded px-2 py-1.5 text-sm text-stone-200 leading-relaxed"
        />
      </label>
      <div className="flex gap-2">
        <input
          placeholder="allowed tools (comma-sep, empty = all builtins)"
          value={form.allowed_tools}
          onChange={e => setForm({ ...form, allowed_tools: e.target.value })}
          className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200"
        />
        <input
          placeholder="routing keywords (comma-sep)"
          value={form.routing_keywords}
          onChange={e => setForm({ ...form, routing_keywords: e.target.value })}
          className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200"
        />
      </div>
    </>
  );

  const modelSelect = (value: string, onChange: (v: string) => void, placeholder?: string) => (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="max-w-[14rem] bg-stone-800 border border-stone-700 rounded px-1.5 py-1 text-xs text-stone-300"
    >
      {placeholder && <option value="">{placeholder}</option>}
      {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      {!!value && !models.some(m => m.id === value) && (
        <option value={value}>{value} (not detected)</option>
      )}
    </select>
  );

  if (!loaded) return <CardsSkeleton n={4} />;
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-stone-700 bg-stone-800/50 p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm text-stone-300">Set <b>all</b> agents to</div>
          <div className="flex items-center gap-2">
            {modelSelect(allModel, setAllModel, 'choose a model…')}
            <button
              onClick={setAll}
              disabled={!allModel}
              className="text-xs bg-teal-700 hover:bg-teal-600 disabled:bg-stone-700 text-white rounded px-3 py-1"
            >
              apply
            </button>
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-stone-500 cursor-pointer select-none">
          <input type="checkbox" checked={showAllModels}
            onChange={e => setShowAllModels(e.target.checked)}
            className="accent-teal-600" />
          show the full catalog of authenticated providers — default is
          installed local models + approved (curated) cloud models
        </label>
      </div>

      {/* assignment consequences live where assignment happens */}
      <ConcurrentLoad />
      <DetectSuggest />

      {agents.map(a => (
        <div key={a.id} className="rounded-lg border border-stone-700 bg-stone-800/50 p-3">
          {editing?.id === a.id ? (
            <form onSubmit={saveEdit} className="space-y-2">
              <div className="text-sm text-stone-100">{agentDisplayName(a.name)}</div>
              {agentFields}
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setEditing(null)} className="text-xs text-stone-400 px-2">cancel</button>
                <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">save</button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm text-stone-100">{agentDisplayName(a.name)}</span>
                  {a.is_system && <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">system</span>}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {modelSelect(a.model, v => setModel(a, v))}
                  {(
                    <button
                      onClick={() => startEdit(a)}
                      className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200"
                    >
                      edit
                    </button>
                  )}
                  {!a.is_system && (
                    <button
                      onClick={() => remove(a)}
                      className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800"
                    >
                      delete
                    </button>
                  )}
                  {a.is_system ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded border border-stone-700 text-stone-500 select-none"
                      title="System agents are core infrastructure and always active — constrain them with rules and tool grants.">
                      always active
                    </span>
                  ) : (
                    <Toggle on={a.enabled} onChange={() => toggle(a)} label="active"
                      title="Inactive agents leave the dispatch index and can't run." />
                  )}
                </div>
              </div>
              {a.description && (
                <div className="mt-1">
                  <span className="text-[10px] uppercase tracking-wide text-stone-500">Note (yours)</span>
                  <div className="mt-0.5 text-xs text-stone-400 line-clamp-2">{a.description}</div>
                </div>
              )}
              {a.system_prompt && (
                <div className="mt-1.5">
                  <span className="text-[10px] uppercase tracking-wide text-stone-500">System prompt — its instructions</span>
                  <div className={`mt-0.5 text-xs text-stone-400 whitespace-pre-wrap [overflow-wrap:anywhere] ${
                    expandedPrompt === a.id ? '' : 'line-clamp-3'}`}>{a.system_prompt}</div>
                  {a.system_prompt.length > 180 && (
                    <button onClick={() => setExpandedPrompt(expandedPrompt === a.id ? null : a.id)}
                      className="text-[11px] text-stone-500 hover:text-teal-300 mt-0.5">
                      {expandedPrompt === a.id ? 'show less' : 'show full'}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      ))}

      {creating ? (
        <form onSubmit={submitCreate} className="rounded-lg border border-teal-800 bg-stone-800/50 p-3 space-y-2">
          <div className="flex gap-2">
            <input
              required placeholder="name (kebab-case)"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
            />
            {modelSelect(form.model, v => setForm({ ...form, model: v }), 'model…')}
          </div>
          {agentFields}
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => { setCreating(false); setForm(emptyForm); }} className="text-xs text-stone-400 px-2">cancel</button>
            <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">create</button>
          </div>
        </form>
      ) : (
        <button
          onClick={() => { setForm(emptyForm); setCreating(true); }}
          className="w-full text-xs text-stone-400 hover:text-teal-300 border border-dashed border-stone-700 hover:border-teal-800 rounded-lg py-2"
        >
          + new agent
        </button>
      )}
      {status && <div className="text-xs text-amber-400">{status}</div>}
    </div>
  );
}

function AutomationsTab() {
  const [rows, setRows] = useState<Automation[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState('');
  const [expandedInstr, setExpandedInstr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState({ name: '', instruction: '', agent_name: '', interval_minutes: 60 });

  const load = () => getAutomations().then(setRows).catch(e => setStatus(String(e)))
    .finally(() => setLoaded(true));
  useEffect(() => {
    load();
    getAgents().then(a => setAgents(a.filter(x => x.enabled).map(x => x.name))).catch(() => {});
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, []);

  const [editing, setEditing] = useState<Automation | null>(null);
  const [editForm, setEditForm] = useState({ description: '', instruction: '', agent_name: '', interval_minutes: 60, timeout_seconds: '' });

  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);

  async function toggleHistory(a: Automation) {
    if (historyFor === a.id) { setHistoryFor(null); return; }
    try {
      setRuns(await getAutomationRuns(a.id));
      setHistoryFor(a.id);
    } catch (err) {
      setStatus(String(err));
    }
  }

  async function toggle(a: Automation) {
    await patchAutomation(a.id, { enabled: !a.enabled });
    load();
  }

  function startEdit(a: Automation) {
    setEditing(a);
    setEditForm({
      description: a.description,
      instruction: a.instruction,
      agent_name: a.agent_name,
      interval_minutes: a.interval_minutes,
      timeout_seconds: a.timeout_seconds == null ? '' : String(a.timeout_seconds),
    });
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    try {
      await patchAutomation(editing.id, {
        ...editForm,
        timeout_seconds: editForm.timeout_seconds === '' ? null : Number(editForm.timeout_seconds),
      });
      setEditing(null);
      load();
    } catch (err) {
      setStatus(String(err));
    }
  }

  async function remove(a: Automation) {
    if (!window.confirm(`Delete automation "${a.name}"? This cannot be undone.`)) return;
    try {
      await deleteAutomation(a.id);
      load();
    } catch (err) {
      setStatus(String(err));
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await createAutomation(form);
      setCreating(false);
      setForm({ name: '', instruction: '', agent_name: '', interval_minutes: 60 });
      load();
    } catch (err) {
      setStatus(String(err));
    }
  }

  if (!loaded) return <CardsSkeleton n={4} />;
  return (
    <div className="space-y-3">
      {/* subsystem settings live with the subsystem, not in the Settings tab */}
      <div className="rounded-lg border border-stone-700 bg-stone-800/30 p-3">
        <SettingsTab only={['Automations']} />
      </div>

      {rows.map(a => (
        <div key={a.id} className="rounded-lg border border-stone-700 bg-stone-800/50 p-3">
          {editing?.id === a.id ? (
            <form onSubmit={saveEdit} className="space-y-2">
              <div className="text-sm text-stone-100">{displayName(a.name)}</div>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-stone-500">Note — your description (not sent to the agent)</span>
                <textarea
                  value={editForm.description}
                  onChange={e => setEditForm({ ...editForm, description: e.target.value })}
                  rows={3}
                  placeholder="a short note: what this automation is for"
                  className="w-full mt-0.5 resize-y bg-stone-800 border border-stone-700 rounded px-2 py-1.5 text-sm text-stone-200 leading-relaxed"
                />
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-stone-500">Instructions — the prompt Nova runs each time</span>
                <textarea
                  required
                  value={editForm.instruction}
                  onChange={e => setEditForm({ ...editForm, instruction: e.target.value })}
                  rows={8}
                  className="w-full mt-0.5 resize-y bg-stone-800 border border-stone-700 rounded px-2 py-1.5 text-sm text-stone-200 leading-relaxed"
                />
              </label>
              <div className="flex gap-2">
                <select
                  value={editForm.agent_name}
                  onChange={e => setEditForm({ ...editForm, agent_name: e.target.value })}
                  className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
                >
                  {agents.map(n => <option key={n} value={n}>{agentDisplayName(n)}</option>)}
                </select>
                <input
                  type="number" min={5}
                  value={editForm.interval_minutes}
                  onChange={e => setEditForm({ ...editForm, interval_minutes: parseInt(e.target.value || '60') })}
                  className="w-24 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
                  title="Interval (minutes)"
                />
                <input
                  type="number" min={30}
                  placeholder="timeout"
                  value={editForm.timeout_seconds}
                  onChange={e => setEditForm({ ...editForm, timeout_seconds: e.target.value })}
                  className="w-24 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
                  title="Per-run timeout override in seconds — empty uses the global automations setting"
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setEditing(null)} className="text-xs text-stone-400 px-2">cancel</button>
                <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">save</button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm text-stone-100 truncate">{displayName(a.name)}</span>
                  {a.is_system && <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">system</span>}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {(
                    <button
                      onClick={() => startEdit(a)}
                      className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200"
                    >
                      edit
                    </button>
                  )}
                  {!a.is_system && (
                    <button
                      onClick={() => remove(a)}
                      className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800"
                    >
                      delete
                    </button>
                  )}
                  <Toggle on={a.enabled} onChange={() => toggle(a)} label="active"
                    title="The kill switch — paused automations don't run until switched back on." />
                </div>
              </div>
              <div className="mt-1 text-xs text-stone-500">
                {agentDisplayName(a.agent_name)} · every {a.interval_minutes >= 60 ? `${Math.round(a.interval_minutes / 60)}h` : `${a.interval_minutes}m`}
                {a.timeout_seconds != null && <span> · timeout {a.timeout_seconds}s</span>}
                {a.last_status && (
                  <span className={a.last_status === 'ok' ? ' text-emerald-500' : ' text-red-400'}>
                    {' '}· last: {a.last_status}
                  </span>
                )}
                {a.consecutive_failures > 0 && (
                  <span className="text-amber-400"> · {a.consecutive_failures} fails</span>
                )}
                {a.last_run_at && (
                  <>
                    {' · '}
                    <button
                      onClick={() => toggleHistory(a)}
                      className="text-stone-500 hover:text-teal-300 underline decoration-dotted"
                    >
                      {historyFor === a.id ? 'hide runs' : 'runs'}
                    </button>
                  </>
                )}
              </div>
              {a.description && (
                <div className="mt-1.5">
                  <span className="text-[10px] uppercase tracking-wide text-stone-500">Note (yours)</span>
                  <div className="mt-0.5 text-xs text-stone-300">{a.description}</div>
                </div>
              )}
              {a.instruction && (
                <div className="mt-1.5">
                  <span className="text-[10px] uppercase tracking-wide text-stone-500">Instructions Nova runs</span>
                  <div className={`mt-0.5 text-xs text-stone-400 whitespace-pre-wrap [overflow-wrap:anywhere] ${
                    expandedInstr === a.id ? '' : 'line-clamp-3'}`}>{a.instruction}</div>
                  {a.instruction.length > 180 && (
                    <button onClick={() => setExpandedInstr(expandedInstr === a.id ? null : a.id)}
                      className="text-[11px] text-stone-500 hover:text-teal-300 mt-0.5">
                      {expandedInstr === a.id ? 'show less' : 'show full'}
                    </button>
                  )}
                </div>
              )}
              {a.last_summary && (
                <div className="mt-1.5 text-xs text-stone-400 line-clamp-2">
                  <span className="text-[10px] uppercase tracking-wide text-stone-500">Last run</span>{' '}
                  {a.last_summary}
                </div>
              )}
              {historyFor === a.id && (
                <div className="mt-2 border-t border-stone-700/60 pt-2 space-y-1.5">
                  {runs.length === 0 && (
                    <div className="text-xs text-stone-500">
                      No recorded runs yet — history starts with the next run.
                    </div>
                  )}
                  {runs.map(r => (
                    <div key={r.id} className="text-xs">
                      <span className={r.status === 'ok' ? 'text-emerald-500' : 'text-red-400'}>
                        {r.status}
                      </span>
                      <span className="text-stone-500">
                        {' '}· {fmtDateTime(r.started_at)} · {r.duration_seconds}s
                      </span>
                      {r.summary && (
                        <div className="text-stone-400 line-clamp-2">{r.summary}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      ))}

      {creating ? (
        <form onSubmit={submit} className="rounded-lg border border-teal-800 bg-stone-800/50 p-3 space-y-2">
          <input
            required placeholder="name (kebab-case)"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
          />
          <textarea
            required placeholder="Instructions the agent runs each time… (a note is auto-written for you)"
            value={form.instruction}
            onChange={e => setForm({ ...form, instruction: e.target.value })}
            rows={6}
            className="w-full resize-y bg-stone-800 border border-stone-700 rounded px-2 py-1.5 text-sm text-stone-200 leading-relaxed"
          />
          <div className="flex gap-2">
            <select
              required
              value={form.agent_name}
              onChange={e => setForm({ ...form, agent_name: e.target.value })}
              className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
            >
              <option value="">agent…</option>
              {agents.map(a => <option key={a} value={a}>{agentDisplayName(a)}</option>)}
            </select>
            <input
              type="number" min={5}
              value={form.interval_minutes}
              onChange={e => setForm({ ...form, interval_minutes: parseInt(e.target.value || '60') })}
              className="w-24 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
              title="Interval (minutes)"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setCreating(false)} className="text-xs text-stone-400 px-2">cancel</button>
            <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">create</button>
          </div>
        </form>
      ) : (
        <button
          onClick={() => setCreating(true)}
          className="w-full text-xs text-stone-400 hover:text-teal-300 border border-dashed border-stone-700 hover:border-teal-800 rounded-lg py-2"
        >
          + new automation
        </button>
      )}
      {status && <div className="text-xs text-red-400">{status}</div>}
    </div>
  );
}

function RulesTab() {
  const [rows, setRows] = useState<Rule[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState('');
  const [form, setForm] = useState({ name: '', pattern: '', action: 'block', description: '', target_tools: '' });

  const load = () => getRules().then(setRows).catch(e => setStatus(String(e)))
    .finally(() => setLoaded(true));
  useEffect(() => { load(); }, []);

  async function toggle(r: Rule) {
    try {
      await patchRule(r.id, { enabled: !r.enabled });
      load();
    } catch (e) { setStatus(String(e)); }
  }

  async function remove(r: Rule) {
    if (!window.confirm(`Delete rule "${r.name}"?`)) return;
    try { await deleteRule(r.id); load(); } catch (e) { setStatus(String(e)); }
  }

  const [editing, setEditing] = useState<Rule | null>(null);
  const [editForm, setEditForm] = useState({ description: '', pattern: '', action: 'block', target_tools: '' });

  function startEdit(r: Rule) {
    setEditing(r);
    setEditForm({
      description: r.description,
      pattern: r.pattern,
      action: r.action,
      target_tools: r.target_tools?.join(', ') ?? '',
    });
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    try {
      const tools = editForm.target_tools.split(',').map(s => s.trim()).filter(Boolean);
      await patchRule(editing.id, {
        description: editForm.description,
        pattern: editForm.pattern,
        action: editForm.action,
        target_tools: tools.length ? tools : null,
      });
      setEditing(null);
      setStatus('');
      load();
    } catch (err) { setStatus(String(err)); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const tools = form.target_tools.split(',').map(s => s.trim()).filter(Boolean);
      await createRule({
        name: form.name, pattern: form.pattern, action: form.action,
        description: form.description,
        target_tools: tools.length ? tools : null,
      });
      setCreating(false);
      setForm({ name: '', pattern: '', action: 'block', description: '', target_tools: '' });
      setStatus('');
      load();
    } catch (err) { setStatus(String(err)); }
  }

  if (!loaded) return <CardsSkeleton n={3} />;
  return (
    <div className="space-y-3">
      <p className="text-xs text-stone-500">
        Rules check every tool call before it executes — block stops the call, warn logs it.
        System protections can be toggled but never deleted.
      </p>
      {rows.map(r => (
        <div key={r.id} className="rounded-lg border border-stone-700 bg-stone-800/50 p-3">
          {editing?.id === r.id ? (
            <form onSubmit={saveEdit} className="space-y-2">
              <div className="text-sm text-stone-100">{displayName(r.name)}</div>
              <input required placeholder="regex pattern" value={editForm.pattern}
                onChange={e => setEditForm({ ...editForm, pattern: e.target.value })}
                className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm font-mono text-stone-200" />
              <input placeholder="description" value={editForm.description}
                onChange={e => setEditForm({ ...editForm, description: e.target.value })}
                className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200" />
              <div className="flex gap-2">
                <select value={editForm.action}
                  onChange={e => setEditForm({ ...editForm, action: e.target.value })}
                  className="bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200">
                  <option value="block">block</option>
                  <option value="warn">warn</option>
                </select>
                <input placeholder="target tools (comma-sep, empty = all)" value={editForm.target_tools}
                  onChange={e => setEditForm({ ...editForm, target_tools: e.target.value })}
                  className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200" />
              </div>
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setEditing(null)} className="text-xs text-stone-400 px-2">cancel</button>
                <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">save</button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm text-stone-100 truncate">{displayName(r.name)}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                    r.action === 'block'
                      ? 'bg-red-950/50 text-red-300 border-red-900'
                      : 'bg-amber-950/50 text-amber-300 border-amber-900'
                  }`}>{r.action}</span>
                  {r.is_system && <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">system</span>}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {(
                    <button onClick={() => startEdit(r)}
                      className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200">
                      edit
                    </button>
                  )}
                  {!r.is_system && (
                    <button onClick={() => remove(r)}
                      className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800">
                      delete
                    </button>
                  )}
                  <Toggle on={r.enabled} onChange={() => toggle(r)} label="enforcing"
                    title="Switched-off rules don't check tool calls — the off switch for system protections, which can't be deleted." />
                </div>
              </div>
              {r.description && <div className="mt-1 text-xs text-stone-400">{r.description}</div>}
              <div className="mt-1 text-xs text-stone-500 font-mono truncate">
                /{r.pattern}/ · {r.target_tools?.join(', ') ?? 'all tools'}
                {r.hit_count > 0 && <span className="text-amber-400"> · {r.hit_count} hits</span>}
              </div>
            </>
          )}
        </div>
      ))}

      {creating ? (
        <form onSubmit={submit} className="rounded-lg border border-teal-800 bg-stone-800/50 p-3 space-y-2">
          <input required placeholder="name (kebab-case)" value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200" />
          <input required placeholder="regex pattern (matched against tool name + args)" value={form.pattern}
            onChange={e => setForm({ ...form, pattern: e.target.value })}
            className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm font-mono text-stone-200" />
          <input placeholder="description — what does this protect against?" value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200" />
          <div className="flex gap-2">
            <select value={form.action} onChange={e => setForm({ ...form, action: e.target.value })}
              className="bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200">
              <option value="block">block</option>
              <option value="warn">warn</option>
            </select>
            <input placeholder="target tools (comma-sep, empty = all)" value={form.target_tools}
              onChange={e => setForm({ ...form, target_tools: e.target.value })}
              className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200" />
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setCreating(false)} className="text-xs text-stone-400 px-2">cancel</button>
            <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">create</button>
          </div>
        </form>
      ) : (
        <button onClick={() => setCreating(true)}
          className="w-full text-xs text-stone-400 hover:text-teal-300 border border-dashed border-stone-700 hover:border-teal-800 rounded-lg py-2">
          + new rule
        </button>
      )}
      {status && <div className="text-xs text-red-400">{status}</div>}
    </div>
  );
}

/** DB-created HTTP tools (toggleable, creatable, editable) + read-only builtins. */
function ToolsTab() {
  const [catalog, setCatalog] = useState<ToolsCatalog | null>(null);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState('');
  const [form, setForm] = useState({ name: '', description: '', method: 'GET', url_template: '' });

  const load = () => getTools().then(setCatalog).catch(e => setStatus(String(e)));
  useEffect(() => { load(); }, []);

  async function toggle(t: DbToolInfo) {
    try { await patchTool(t.id, !t.enabled); load(); } catch (e) { setStatus(String(e)); }
  }

  async function remove(t: DbToolInfo) {
    if (!window.confirm(`Delete tool "${displayName(t.name)}"? This cannot be undone.`)) return;
    try { await deleteTool(t.id); load(); } catch (e) { setStatus(String(e)); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await createTool(form);
      setCreating(false);
      setForm({ name: '', description: '', method: 'GET', url_template: '' });
      setStatus('');
      load();
    } catch (err) { setStatus(String(err)); }
  }

  if (!catalog) return <CardsSkeleton n={4} />;

  return (
    <div className="space-y-3">
      <McpServersSection />

      <p className="text-xs text-stone-500">
        Created tools are declarative HTTP calls against operator-allowlisted hosts
        ({catalog.allowed_hosts.join(', ') || 'none yet'}). Builtins are code and
        always present; which agent may use what lives on each agent's grants.
      </p>

      {catalog.db_tools.map(t => (
        <div key={t.id} className="rounded-lg border border-stone-700 bg-stone-800/50 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm text-stone-100 truncate">{displayName(t.name)}</span>
              <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">{t.execution_type}</span>
              {t.is_system && <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">system</span>}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {!t.is_system && (
                <button
                  onClick={() => remove(t)}
                  className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800"
                >
                  delete
                </button>
              )}
              <Toggle on={t.enabled} onChange={() => toggle(t)} label="active"
                title="Inactive tools can't be called by any agent — the off switch, since system tools can't be deleted." />
            </div>
          </div>
          {t.description && <div className="mt-1 text-xs text-stone-400 line-clamp-2">{t.description}</div>}
          {t.url_template && (
            <div className="mt-1 text-xs text-stone-500 font-mono truncate">
              {t.method} {t.url_template}
            </div>
          )}
        </div>
      ))}
      {catalog.db_tools.length === 0 && (
        <div className="text-xs text-stone-500 italic">No created tools yet.</div>
      )}

      {creating ? (
        <form onSubmit={submit} className="rounded-lg border border-teal-800 bg-stone-800/50 p-3 space-y-2">
          <input
            required placeholder="name (kebab-case)"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
          />
          <input
            required placeholder="description — when should an agent reach for this?"
            value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
          />
          <div className="flex gap-2">
            <select
              value={form.method}
              onChange={e => setForm({ ...form, method: e.target.value })}
              className="bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
            >
              <option value="GET">GET</option>
              <option value="POST">POST</option>
            </select>
            <input
              required placeholder="url template, e.g. https://api.example.com/{q}"
              value={form.url_template}
              onChange={e => setForm({ ...form, url_template: e.target.value })}
              className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm font-mono text-stone-200"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setCreating(false)} className="text-xs text-stone-400 px-2">cancel</button>
            <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">create</button>
          </div>
        </form>
      ) : (
        <button
          onClick={() => setCreating(true)}
          className="w-full text-xs text-stone-400 hover:text-teal-300 border border-dashed border-stone-700 hover:border-teal-800 rounded-lg py-2"
        >
          + new tool
        </button>
      )}

      <details className="rounded-lg border border-stone-700 bg-stone-800/30">
        <summary className="px-3 py-2 text-sm text-stone-300 cursor-pointer select-none">
          Builtins ({catalog.builtins.length}) — read-only
        </summary>
        <div className="px-3 pb-2 space-y-1.5">
          {catalog.builtins.map(b => (
            <div key={b.name} className="text-xs">
              <span className="text-stone-200">{displayName(b.name)}</span>
              <span className="text-stone-500"> — {b.description}</span>
            </div>
          ))}
        </div>
      </details>
      {status && <div className="text-xs text-red-400">{status}</div>}
    </div>
  );
}

/** MCP servers — operator registry (docs/plans/mcp-client.md). No agent-facing
 *  equivalent exists on purpose: registering a server is a trust decision only
 *  the operator makes. Lives above the tools list in this same tab — one
 *  callable-capability surface, not a separate one. */
function McpServersSection() {
  const [rows, setRows] = useState<McpServer[]>([]);
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [expanded, setExpanded] = useState<Record<string, McpTool[] | null>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const emptyForm = { name: '', transport: 'http', url: '', command: '', args: '', headers: '{}' };
  const [form, setForm] = useState(emptyForm);

  const load = () => getMcpServers().then(setRows).catch(e => setStatus(String(e)));
  useEffect(() => { load(); }, []);

  async function toggleExpand(s: McpServer) {
    if (expanded[s.id] !== undefined) {
      setExpanded(prev => { const next = { ...prev }; delete next[s.id]; return next; });
      return;
    }
    setExpanded(prev => ({ ...prev, [s.id]: null }));
    try {
      const tools = await getMcpServerTools(s.id);
      setExpanded(prev => ({ ...prev, [s.id]: tools }));
    } catch (e) { setStatus(String(e)); }
  }

  async function toggleEnabled(s: McpServer) {
    setBusy(b => ({ ...b, [s.id]: true }));
    try { await patchMcpServer(s.id, { enabled: !s.enabled }); await load(); }
    catch (e) { setStatus(String(e)); }
    finally { setBusy(b => ({ ...b, [s.id]: false })); }
  }

  async function toggleAlwaysInject(s: McpServer) {
    try { await patchMcpServer(s.id, { always_inject: !s.always_inject }); load(); }
    catch (e) { setStatus(String(e)); }
  }

  async function approve(s: McpServer) {
    setBusy(b => ({ ...b, [s.id]: true }));
    try {
      await approveMcpServer(s.id);
      setExpanded(prev => { const next = { ...prev }; delete next[s.id]; return next; });
      await load();
    } catch (e) { setStatus(String(e)); }
    finally { setBusy(b => ({ ...b, [s.id]: false })); }
  }

  async function remove(s: McpServer) {
    if (!window.confirm(`Remove MCP server "${s.name}"? Every agent grant naming it stops working.`)) return;
    try { await deleteMcpServer(s.id); load(); } catch (e) { setStatus(String(e)); }
  }

  function startEdit(s: McpServer) {
    setEditing(s);
    setForm({
      name: s.name, transport: s.transport,
      url: s.url ?? '', command: s.command ?? '',
      args: (s.args ?? []).join(', '),
      headers: JSON.stringify(s.headers ?? {}),
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    let headers: Record<string, string>;
    try { headers = JSON.parse(form.headers || '{}'); }
    catch { setStatus('headers must be valid JSON, e.g. {"Authorization": "Bearer ..."}'); return; }
    const args = form.args.split(',').map(a => a.trim()).filter(Boolean);
    try {
      if (editing) {
        await patchMcpServer(editing.id, {
          url: form.url || null, command: form.command || null, args, headers,
        });
        setEditing(null);
      } else {
        await createMcpServer({
          name: form.name, transport: form.transport as McpServer['transport'],
          url: form.url || null, command: form.command || null, args, headers,
        });
        setCreating(false);
      }
      setForm(emptyForm);
      setStatus('');
      load();
    } catch (err) { setStatus(String(err)); }
  }

  const formFields = (
    <>
      <div className="flex gap-2">
        <input required disabled={!!editing} placeholder="name (slug, e.g. github)"
          value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
          className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200 disabled:opacity-50" />
        <select disabled={!!editing} value={form.transport}
          onChange={e => setForm({ ...form, transport: e.target.value })}
          className="bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200 disabled:opacity-50">
          <option value="http">http</option>
          <option value="stdio">stdio (later phase)</option>
        </select>
      </div>
      {form.transport === 'http' ? (
        <input required placeholder="url, e.g. https://mcp.example.com/mcp"
          value={form.url} onChange={e => setForm({ ...form, url: e.target.value })}
          className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200" />
      ) : (
        <div className="flex gap-2">
          <input required placeholder="command, e.g. npx"
            value={form.command} onChange={e => setForm({ ...form, command: e.target.value })}
            className="w-40 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200" />
          <input placeholder="args (comma-sep)" value={form.args}
            onChange={e => setForm({ ...form, args: e.target.value })}
            className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200" />
        </div>
      )}
      <input placeholder='headers JSON, e.g. {"Authorization": "Bearer ..."}' value={form.headers}
        onChange={e => setForm({ ...form, headers: e.target.value })}
        className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200" />
    </>
  );

  const statusDot = (s: McpServer): [string, string] =>
    s.status === 'connected' ? ['bg-emerald-400', 'connected'] :
    s.status === 'error' ? ['bg-red-400', s.status_detail || 'error'] :
    ['bg-stone-500', 'disabled'];

  return (
    <details className="rounded-lg border border-stone-700 bg-stone-800/30" open>
      <summary className="px-3 py-2 text-sm text-stone-300 cursor-pointer select-none">
        MCP servers ({rows.length})
      </summary>
      <div className="px-3 pb-3 space-y-2">
        <p className="text-xs text-stone-500">
          Third-party tool servers (Model Context Protocol). Registering one is a
          trust decision — no agent can do it, only you here. Grant a server's
          tools to an agent from its allowed-tools field:{' '}
          <code className="text-stone-400">mcp:&lt;name&gt;/&lt;tool&gt;</code>{' '}
          for one tool or <code className="text-stone-400">mcp:&lt;name&gt;:*</code> for all of
          them — nothing is granted automatically. If a server's tool list changes
          after approval it flips to <b>error</b> and stops serving until reviewed
          below.
        </p>

        {rows.map(s => {
          const [dot, dotText] = statusDot(s);
          return (
            <div key={s.id} className="rounded border border-stone-700/60 bg-stone-900/40 px-2.5 py-2">
              {editing?.id === s.id ? (
                <form onSubmit={submit} className="space-y-2">
                  <div className="text-xs font-mono text-stone-100">{s.name}</div>
                  {formFields}
                  <div className="flex gap-2 justify-end">
                    <button type="button" onClick={() => { setEditing(null); setForm(emptyForm); }} className="text-xs text-stone-400 px-2">cancel</button>
                    <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">save</button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} title={dotText} />
                      <span className="text-xs font-mono text-stone-100 truncate">{s.name}</span>
                      <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">{s.transport}</span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {s.status === 'error' && (
                        <button onClick={() => approve(s)} disabled={busy[s.id]}
                          title="Re-run the connection, accept whatever tool list comes back as the new approved baseline."
                          className="text-xs px-2 py-0.5 rounded bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white">
                          review &amp; re-approve
                        </button>
                      )}
                      {(
                        <>
                          <button onClick={() => startEdit(s)}
                            className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200">
                            edit
                          </button>
                          <button onClick={() => remove(s)}
                            className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800">
                            delete
                          </button>
                        </>
                      )}
                      <Toggle on={s.always_inject} onChange={() => toggleAlwaysInject(s)}
                        label="always inject"
                        title="On: this server's tools are always fully loaded into agent prompts. Off (default): agents see one index line and pull tools in on demand via find_mcp_tools." />
                      <Toggle on={s.enabled} onChange={() => toggleEnabled(s)} label="enabled"
                        title="Disabled servers grant nothing, regardless of any agent's allowed_tools." />
                    </div>
                  </div>
                  <div className="mt-0.5 text-[11px] text-stone-500 font-mono truncate">
                    {s.transport === 'http' ? s.url : `${s.command} ${(s.args ?? []).join(' ')}`}
                  </div>
                  {s.status === 'error' && s.status_detail && (
                    <div className="mt-0.5 text-[11px] text-red-400">{s.status_detail}</div>
                  )}
                  <button onClick={() => toggleExpand(s)} className="mt-1 text-[11px] text-stone-500 hover:text-teal-300">
                    {expanded[s.id] !== undefined ? 'hide tools' : 'review tools'}
                  </button>
                  {expanded[s.id] !== undefined && (
                    <div className="mt-1 pl-2 border-l border-stone-700 space-y-1">
                      {expanded[s.id] === null ? (
                        <div className="text-[11px] text-stone-600">loading…</div>
                      ) : expanded[s.id]!.length === 0 ? (
                        <div className="text-[11px] text-stone-600 italic">no tools cached — not connected yet</div>
                      ) : expanded[s.id]!.map(t => (
                        <div key={t.name} className="text-[11px]">
                          <span className="font-mono text-stone-300">mcp:{s.name}/{t.name}</span>
                          <span className="text-stone-500"> — {t.description}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
        {rows.length === 0 && (
          <div className="text-xs text-stone-500 italic">No MCP servers registered yet.</div>
        )}

        {creating ? (
          <form onSubmit={submit} className="rounded border border-teal-800 bg-stone-900/40 px-2.5 py-2 space-y-2">
            {formFields}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => { setCreating(false); setForm(emptyForm); }} className="text-xs text-stone-400 px-2">cancel</button>
              <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">add</button>
            </div>
          </form>
        ) : (
          <button onClick={() => { setForm(emptyForm); setCreating(true); }}
            className="w-full text-xs text-stone-400 hover:text-teal-300 border border-dashed border-stone-700 hover:border-teal-800 rounded py-1.5">
            + add a server
          </button>
        )}
        {status && <div className="text-xs text-red-400">{status}</div>}
      </div>
    </details>
  );
}
