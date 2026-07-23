import { useState, useEffect } from 'react';
import {
  ModelInfo, SettingDef, getModels, getSettings, patchSettings, testNotification,
} from '../../api';
import { THEMES } from '../../brain/theme';
import { ThemePreview } from '../ThemePreview';
import { CardsSkeleton } from '../ui';
import { NtfyTopicField, NotifyServiceControl, NotificationsReachability, NotificationsHelp } from './notifications';
import { VoiceField, ListenModeField, WakeWordField } from './voice';
import { StorageCard, PhoneSetupCard } from './cards';
import { BundledInference, ModelStorage } from './inference';

export function SettingsTab({ only, exclude }: { only?: string[]; exclude?: string[] }) {
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
        // wrap on narrow screens — four preview cards overflow a phone card
        <div className="flex flex-wrap gap-3">
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
            {section === 'Observability' && (
              <button
                onClick={() => window.dispatchEvent(new Event('nova:open-observability'))}
                className="w-full text-left rounded-lg border border-stone-700/70 bg-stone-800/40 px-3 py-2 hover:border-teal-700"
              >
                <span className="text-sm text-stone-200">Open the Observability board →</span>
                <span className="block text-xs text-stone-500">
                  Live resources (CPU, RAM, VRAM, disk), service health, and turn/cost
                  rollups — plus recent turns. The chart icon (top-left) opens it too.
                </span>
              </button>
            )}
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
                  // stacked on phones — side-by-side starves the label column
                  : 'flex flex-col md:flex-row md:items-start md:justify-between gap-2 md:gap-4'}>
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
