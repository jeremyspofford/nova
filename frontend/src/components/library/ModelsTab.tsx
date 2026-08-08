import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AgentInfo, ChainLink, CuratedModel, ModelInfo, createCuratedModel, deleteCuratedModel, getAgentModelChains, getAgents, getCuratedModels, getModels, patchCuratedModel, pullModel, uninstallModel, Provider, ProviderPreset, createProvider, deleteProvider, getProviders, getProviderPresets, patchProvider, testProvider, USE_CASES,
  EvalSuite, EvalVerdict, EvalRun, EvalRunTask, EvalTask, getEvalSuites,
  getEvalRuns, getEvalRunDetail, getEvalTasks, startEvalRun, EvalStandings,
  getEvalStandings, getAuthToken,
} from '../../api';
import { censusLine } from '../../observability';
import { fmtDateTime } from '../../time';
import { Toggle } from '../ui';
import { probeLine } from './models-shared';
import { SettingsTab } from '../settings/SettingsTab';

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

/** The curated model table behind recommendations — seeded knowledge,
 *  operator-editable (system rows toggle-only, like rules/tools). */
function CuratedTable() {
  const [rows, setRows] = useState<CuratedModel[]>([]);
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CuratedModel | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [pulls, setPulls] = useState<Record<string, string>>({});
  const [useCaseFilter, setUseCaseFilter] = useState('');       // '' = any
  const [locFilter, setLocFilter] = useState<'all' | 'local' | 'cloud'>('all');
  const emptyForm = {
    model: '', provider: 'ollama', min_ram_gb: '', min_vram_gb: '',
    tool_tier: 'B', speed: 'medium', roles: '', use_cases: [] as string[], notes: '',
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
      roles: m.roles.join(', '), use_cases: m.use_cases, notes: m.notes,
    });
  }

  const toggleUseCase = (u: string) => setForm(f => ({
    ...f,
    use_cases: f.use_cases.includes(u)
      ? f.use_cases.filter(x => x !== u)
      : [...f.use_cases, u],
  }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const fields = {
      min_ram_gb: numOrNull(form.min_ram_gb),
      min_vram_gb: numOrNull(form.min_vram_gb),
      tool_tier: form.tool_tier, speed: form.speed,
      roles: parseRoles(form.roles), use_cases: form.use_cases, notes: form.notes,
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
      <div>
        <div className="text-[11px] text-stone-500 mb-1">good for (use-cases)</div>
        <div className="flex flex-wrap gap-1">
          {USE_CASES.map(u => (
            <button key={u} type="button" onClick={() => toggleUseCase(u)}
              className={`text-[11px] px-1.5 py-0.5 rounded border ${form.use_cases.includes(u)
                ? 'bg-teal-800/60 border-teal-700 text-teal-100'
                : 'bg-stone-800 border-stone-700 text-stone-400 hover:text-stone-200'}`}>
              {u}
            </button>
          ))}
        </div>
      </div>
      <input placeholder="notes" value={form.notes}
        onChange={e => setForm({ ...form, notes: e.target.value })}
        className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200" />
    </>
  );

  const isLocal = (m: CuratedModel) => m.provider === 'ollama';
  // Only offer use-case options that some row actually carries.
  const useCaseOptions = USE_CASES.filter(u => rows.some(m => m.use_cases.includes(u)));
  const visible = rows.filter(m =>
    (locFilter === 'all'
      || (locFilter === 'local' && isLocal(m))
      || (locFilter === 'cloud' && !isLocal(m)))
    && (!useCaseFilter || m.use_cases.includes(useCaseFilter)));

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
        <div className="flex flex-wrap items-center gap-2 border-y border-stone-700/60 py-2">
          <span className="text-[11px] text-stone-500">filter</span>
          <div className="inline-flex rounded border border-stone-700 overflow-hidden">
            {(['all', 'local', 'cloud'] as const).map(loc => (
              <button key={loc} onClick={() => setLocFilter(loc)}
                className={`text-[11px] px-2 py-0.5 ${locFilter === loc
                  ? 'bg-teal-800/70 text-teal-100' : 'text-stone-400 hover:text-stone-200'}`}>
                {loc}
              </button>
            ))}
          </div>
          <select value={useCaseFilter} onChange={e => setUseCaseFilter(e.target.value)}
            className="bg-stone-800 border border-stone-700 rounded px-2 py-0.5 text-[11px] text-stone-300"
            title="best for use-case">
            <option value="">any use-case</option>
            {useCaseOptions.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
          {(useCaseFilter || locFilter !== 'all') && (
            <button onClick={() => { setUseCaseFilter(''); setLocFilter('all'); }}
              className="text-[11px] text-stone-500 hover:text-stone-300 underline">
              clear
            </button>
          )}
          <span className="text-[11px] text-stone-600 ml-auto">
            {visible.length} of {rows.length}
          </span>
        </div>
        {visible.length === 0 && rows.length > 0 && (
          <div className="text-[11px] text-stone-500 py-2 text-center">
            no models match this filter.
          </div>
        )}
        {visible.map(m => (
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
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-mono text-stone-100 truncate">{m.model}</span>
                    <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400 shrink-0">tier {m.tool_tier}</span>
                    {m.is_system && <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400 shrink-0">seed</span>}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap justify-end min-w-0">
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
                  <span className={isLocal(m) ? 'text-sky-400/80' : 'text-violet-400/80'}>
                    {isLocal(m) ? 'local' : 'cloud'}
                  </span>
                  {' · '}{m.speed} · {m.roles.join('/') || 'no roles'}
                  {m.min_ram_gb != null && ` · ${m.min_ram_gb} GB RAM`}
                  {m.min_vram_gb != null && ` · ${m.min_vram_gb} GB VRAM`}
                </div>
                {m.use_cases.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {m.use_cases.map(u => (
                      <button key={u} onClick={() => setUseCaseFilter(u)}
                        title={`filter to "${u}"`}
                        className={`text-[10px] px-1.5 py-0.5 rounded border ${useCaseFilter === u
                          ? 'bg-teal-800/60 border-teal-700 text-teal-100'
                          : 'bg-stone-800/60 border-stone-700 text-stone-400 hover:text-stone-200'}`}>
                        {u}
                      </button>
                    ))}
                  </div>
                )}
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

/** Model inventory & governance: keep-warm, pulls, the curated (approved)
 *  table that feeds dropdowns and recommendations, and the full catalog of
 *  authenticated providers. Machine infra stays in Settings → Inference;
 *  per-agent assignment lives in Agents. */
export function ModelsTab() {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-stone-700 bg-stone-800/30 p-3">
        <SettingsTab only={['Models']} />
      </div>
      <RolesPanel />
      <EvalsPanel />
      <PullModel onPulled={() => {}} />
      <ProvidersPanel />
      <CuratedTable />
      <FullCatalog />
    </div>
  );
}

/** Test a model against a suite of recorded incidents.
 *
 *  This existed as an API route and a CLI for weeks and had no button, so the
 *  answer to "how do I test a model" was a curl command — which is how the
 *  operator came to ask. It sits under Models because that is where the
 *  question is asked, one panel below the bindings it should inform.
 *
 *  Three things are deliberately on the face of it rather than behind a
 *  tooltip, because each one is a way a score gets over-read:
 *
 *    the cost      a suite is minutes and real tokens. Measured from previous
 *                  runs, never estimated — "unknown" beats a made-up number
 *                  in the sentence someone reads before spending.
 *    the repeats   1 is a draw, not a measurement. A suite that scored 2/7
 *                  and 3/7 on consecutive runs of the SAME model is why.
 *    the version   a verdict against an older suite grades a different set of
 *                  tasks, and says so instead of showing a bare fraction.
 *
 *  One run at a time is the backend's rule (a single `_running` guard), so the
 *  button disables itself while anything is going rather than collecting a
 *  409 the operator has to interpret. */
/** Backend fields not yet in api.ts's types (that file belongs to another
 *  lane); they ride along on the same JSON responses. Follow-up: fold these
 *  into EvalStandings / EvalRun in api.ts and add a getEvalComparisons(). */
type CoverageReset = {
  suite: string;
  version: number;
  measured_versions: number[];
  runs_voided: number;
  last_measured: string | null;
};
type StandingsExtras = {
  coverage_reset?: CoverageReset[];
  rotation_enabled?: boolean;
};
/** Why an error run died — eval_runs writes detail->failure so a
 *  VRAM-refused night stops rendering identically to a bad model. */
type RunFailure = {
  type: string;
  message: string;
  resource_refusal: boolean;
  error_classes?: string[];
} | null;
/** The DERIVED reading of a run (migration 127), computed by
 *  `eval_runs.outcome()` from how many of the suite's tasks were actually
 *  graded — never from the status string.
 *
 *  It is not restated here on purpose. `failed` was worn both by a run that
 *  graded all seven tasks and scored two (a measurement) and by one that died
 *  at task 0 with no heartbeat (the harness), and this panel rendered both as
 *  "did not finish". A TypeScript copy of the rule would start lying the day
 *  the backend grows a case, and nothing would fail when it did — the same
 *  argument that keeps `grades` server-side. */
type RunOutcome = {
  code: 'running' | 'measured' | 'partial' | 'unmeasured' | 'unknown';
  measurement: boolean;
  stalled: boolean;
  label: string;
  headline: string;
  basis: string;
  graded: number | null;
  total: number;
  passed: number;
  resumes?: number;
  failure_type?: string | null;
  why?: string | null;
  resource_refusal?: boolean;
};
/** Whether the operator was actually told this run finished, in notify.send's
 *  own words. `confirmed` is the only key that means a device rendered it;
 *  `state: 'accepted'` means a relay took the bytes and nothing more. */
type RunAnnouncement = {
  how: string;
  confirmed: boolean;
  state?: string | null;
  in_chat?: boolean | null;
  deduped?: boolean;
  notification_id?: string | null;
  backfilled?: boolean;
} | null;
/** Fields the backend sends that api.ts's EvalRun does not declare yet (that
 *  file belongs to another lane). Same workaround as `failure` above. */
type RunExtras = EvalRun & {
  failure?: RunFailure;
  outcome?: RunOutcome;
  announcement?: RunAnnouncement;
  task_index?: number | null;
  resumes?: number | null;
  stalled_for_s?: number | null;
};
type EvalComparison = {
  id: string;
  at: string;
  suite: string;
  suite_version: number;
  current_suite_version: number | null;
  repeat_count: number;
  champion: string;
  challenger: string;
  tasks_total: number;
  tasks_gradeable: number;
  tasks_invalid: number;
  champion_passed: number;
  challenger_passed: number;
  regressions: string[];
  improvements: string[];
};

const failureOf = (r: EvalRun): RunFailure => (r as RunExtras).failure ?? null;
const outcomeOf = (r: EvalRun): RunOutcome | null =>
  (r as RunExtras).outcome ?? null;
const announcementOf = (r: EvalRun): RunAnnouncement =>
  (r as RunExtras).announcement ?? null;

/** Colour by what the run MEANS, not by its status word. A measurement is a
 *  result at any score; everything else is the harness, and amber is the
 *  colour this panel already uses for "this is not about the model". */
const outcomeTone = (o: RunOutcome): string =>
  o.code === 'running' ? (o.stalled ? 'text-amber-400/90' : 'text-teal-400')
    : !o.measurement ? 'text-amber-400/90'
      : o.passed === o.total ? 'text-emerald-400'
        : 'text-stone-300';

/** The hover line: the sentence, what it rests on, and why it stopped. */
const outcomeTitle = (o: RunOutcome): string =>
  `${o.headline}. Basis: ${o.basis}.`
  + (o.why ? ` Reason: ${o.why}${o.failure_type ? ` (${o.failure_type})` : ''}.` : '');

/** Was the operator told, in the row's own words — never a tick. "accepted by
 *  a relay" is not "he saw it", which is the whole of migration 125's
 *  delivery contract and the reason nothing here renders a checkmark for it. */
function DeliveryNote({ run }: { run: EvalRun }) {
  const a = announcementOf(run);
  if (run.status === 'running') return null;
  if (!a) {
    return (
      <span className="text-amber-400/90"
        title="This run reached a terminal state and no announcement has been recorded against it yet. eval_runs' backlog sweep retries these every 60s.">
        not announced yet
      </span>
    );
  }
  if (a.backfilled) return null;   // predates the feature; says so on hover
  return (
    <span className={a.confirmed ? 'text-stone-500' : 'text-stone-600'}
      title={`Told you: ${a.how}${a.in_chat === false ? ' — and it did NOT land in the conversation' : ''}`}>
      {a.confirmed ? 'you opened it'
        : a.state === 'failed' ? 'not delivered'
          : a.in_chat ? 'in your chat' : 'told — receipt unproven'}
    </span>
  );
}

/** Same-origin authed fetch for the comparisons route. api.ts's apiFetch is
 *  module-private and that file is another lane's; this duplicates only the
 *  Authorization header. */
async function fetchComparisons(): Promise<EvalComparison[]> {
  const token = getAuthToken();
  const r = await fetch('/api/v1/evals/comparisons', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!r.ok) {
    const detail = await r.json().then(b => b?.detail).catch(() => null);
    throw new Error(typeof detail === 'string' && detail
      ? detail : `Failed to load comparisons (${r.status})`);
  }
  return (await r.json()).comparisons;
}

function EvalsPanel() {
  const [suites, setSuites] = useState<EvalSuite[] | null>(null);
  const [verdicts, setVerdicts] = useState<EvalVerdict[]>([]);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [suite, setSuite] = useState('');
  const [model, setModel] = useState('');
  const [repeat, setRepeat] = useState(3);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [tasks, setTasks] = useState<EvalTask[] | null>(null);
  // null is "not answered" and never "no winner" — the same distinction the
  // standby order got wrong, where a dropped fetch rendered as twelve agents
  // with no fallback. An unreachable endpoint must not read as a verdict.
  const [standings, setStandings] = useState<EvalStandings | null>(null);
  const [standingsError, setStandingsError] = useState('');
  // null is "not answered"; an empty array is "answered: none recorded".
  const [comparisons, setComparisons] = useState<EvalComparison[] | null>(null);
  const [comparisonsError, setComparisonsError] = useState('');

  // The run the operator arrived here to look at: the finished-run
  // notification's "Open" link is /library/models?run=<id>. Without this the
  // link would drop him on the tab with the history collapsed, which is the
  // same "it brings me to chat but doesn't show me what it was" complaint
  // that migration 125 fixed one level up.
  const [searchParams] = useSearchParams();
  const focusRun = searchParams.get('run');
  // The census over the whole history, from the same response as the page of
  // runs — "12 failed" next to a page showing three is what stops a short
  // list reading as a short history. Null until the endpoint answers.
  const [census, setCensus] = useState<Record<string, number> | null>(null);
  // Per-run task detail (migration 124), fetched on first expand and kept.
  const [expandedRun, setExpandedRun] = useState<string | null>(focusRun);
  const [runDetails, setRunDetails] = useState<
    Record<string, (EvalRun & { tasks: EvalRunTask[] }) | 'loading' | 'error'>>({});

  const active = runs.find(r => r.status === 'running') || null;

  const load = () => {
    getEvalSuites()
      .then(d => {
        setSuites(d.suites);
        setVerdicts(d.verdicts);
        setSuite(s => s || d.suites[0]?.suite || '');
      })
      .catch(e => { setSuites([]); setStatus(String(e)); });
    getEvalRuns(12)
      .then(p => { setRuns(p.runs); setCensus(p.census); })
      .catch(() => {});
    getEvalStandings()
      .then(s => { setStandings(s); setStandingsError(''); })
      .catch(e => {
        setStandings(null);
        setStandingsError(String(e instanceof Error ? e.message : e));
      });
    fetchComparisons()
      .then(c => { setComparisons(c); setComparisonsError(''); })
      .catch(e => {
        setComparisons(null);
        setComparisonsError(String(e instanceof Error ? e.message : e));
      });
  };

  useEffect(() => {
    load();
    getModels(false).then(setModels).catch(() => {});
  }, []);

  // Re-read on every suite change: the rubric belongs to the suite, and a
  // stale list under a new heading is worse than none.
  useEffect(() => {
    if (!suite) return;
    setTasks(null);
    getEvalTasks(suite).then(setTasks).catch(() => setTasks([]));
  }, [suite]);

  // Poll only while something is running. A finished board does not need a
  // timer, and a 3-repeat suite is minutes — the operator should not have to
  // sit on the tab to find out how it went.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      getEvalRuns(8).then(p => {
        setRuns(p.runs);
        setCensus(p.census);
        if (!p.runs.some(r => r.status === 'running')) load();
      }).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [active?.id]);

  /** Fetch a run's per-task record once; 'error' renders as its own row
   *  rather than an eternal spinner. */
  const ensureRunDetail = (id: string) => {
    if (runDetails[id]) return;
    setRunDetails(d => ({ ...d, [id]: 'loading' }));
    getEvalRunDetail(id)
      .then(det => setRunDetails(d => ({ ...d, [id]: det })))
      .catch(() => setRunDetails(d => ({ ...d, [id]: 'error' })));
  };

  // The deep link opens its run expanded — same reasoning as `focusRun`
  // opening the history: a push saying "1/7" must land on the seven.
  useEffect(() => {
    if (focusRun) ensureRunDetail(focusRun);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRun]);

  const toggleRun = (id: string) => {
    setExpandedRun(cur => (cur === id ? null : id));
    ensureRunDetail(id);
  };

  const chosen = suites?.find(s => s.suite === suite);

  async function run() {
    if (!suite || !model) return;
    setBusy(true);
    setStatus('');
    try {
      const r = await startEvalRun(suite, model, repeat);
      setRuns(prev => [r, ...prev]);
    } catch (e) {
      setStatus(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  /** A verdict, with everything needed to not over-read it. */
  function verdictLine(v: EvalVerdict) {
    const s = suites?.find(x => x.suite === v.suite);
    const stale = v.suite_version != null && s && v.suite_version !== s.version;
    // `status IN ('passed','failed')` is not the same question as "was this a
    // measurement": a run killed at task 3 of 7 lands 'failed' with three
    // tasks graded, and its 1/7 in a picker reads as a model that answered six
    // questions wrongly. latest_verdicts now carries the derived reading.
    const o = (v as EvalVerdict & { outcome?: RunOutcome }).outcome ?? null;
    return (
      <div key={`${v.agent_name}:${v.model}`}
        className="flex items-baseline justify-between gap-3 text-xs py-0.5">
        <span className="truncate">
          {/* WHICH SUITE. The row is keyed on (agent, model), so a model
              tested against two suites produced two identical-looking lines
              and there was no way to tell which score was which. */}
          <span className="text-stone-500">{v.suite}</span>
          <span className="text-stone-600 mx-1">·</span>
          <span className="font-mono text-stone-400">{v.model}</span>
        </span>
        <span className="flex items-baseline gap-2 shrink-0">
          <span className={v.tasks_passed === v.tasks_total
            ? 'text-emerald-400' : 'text-stone-300'}>
            {v.tasks_passed}/{v.tasks_total}
          </span>
          <span className="text-stone-500">
            {v.repeat_count > 1
              ? `over ${v.repeat_count} runs`
              : 'one run — a draw'}
          </span>
          {o && !o.measurement && (
            <span className="text-amber-400/90" title={outcomeTitle(o)}>
              {o.code === 'unknown' ? 'unverifiable' : 'incomplete — not a score'}
            </span>
          )}
          {v.suite_version == null && (
            <span className="text-stone-600" title="Recorded before the suite version was stored, so which tasks it graded is unknown.">
              unversioned
            </span>
          )}
          {stale && (
            <span className="text-amber-400/90"
              title={`Graded against suite v${v.suite_version}; it is now v${s!.version}. This score describes a different set of tasks.`}>
              v{v.suite_version} — suite moved
            </span>
          )}
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-stone-700 bg-stone-800/30 p-3 space-y-3">
      <div>
        <h3 className="text-sm text-stone-200">Test a model</h3>
        <p className="text-xs text-stone-500 mt-0.5">
          Each suite is a set of recorded incidents from this repo, replayed
          against frozen fixtures. A run is real agent turns with real tool
          calls, so it costs minutes and tokens.
        </p>
      </div>

      {suites === null ? (
        <div className="text-xs text-stone-500">Loading…</div>
      ) : !suites.length ? (
        <div className="text-xs text-stone-500">No suites found.</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select value={suite} onChange={e => setSuite(e.target.value)}
              className="bg-stone-900 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200">
              {suites.map(s => (
                <option key={s.suite} value={s.suite}>
                  {s.suite} — {s.tasks} tasks (v{s.version})
                </option>
              ))}
            </select>
            <select value={model} onChange={e => setModel(e.target.value)}
              className="bg-stone-900 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200 max-w-[16rem]">
              <option value="">choose a model…</option>
              {models.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}
            </select>
            <label className="text-xs text-stone-500 flex items-center gap-1">
              repeat
              <select value={repeat} onChange={e => setRepeat(Number(e.target.value))}
                className="bg-stone-900 border border-stone-700 rounded px-1.5 py-1 text-xs text-stone-200"
                title="Each task runs this many times, and counts as passed only if it passed every one. 1 is a single draw.">
                {[1, 2, 3, 5].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button onClick={run} disabled={busy || !!active || !model}
              className="px-3 py-1 text-xs rounded bg-teal-700/80 hover:bg-teal-700 disabled:bg-stone-700 disabled:text-stone-500 text-white">
              {active ? 'a run is going…' : busy ? 'starting…' : 'Run'}
            </button>
          </div>

          {chosen && (
            <p className="text-[11px] text-stone-500">
              {chosen.cost.note}
              {repeat > 1 && chosen.cost.measured &&
                ` Running ${repeat}x multiplies that.`}
            </p>
          )}
          {status && <p className="text-[11px] text-amber-400/90">{status}</p>}

          {/* WHILE IT RUNS, IT IS VISIBLE. This block used to say "running"
              and nothing else for eight minutes — Jeremy watched one with no
              feedback at all — while the row underneath it has carried a
              per-task cursor since migration 124. "task 3 of 7" is the
              difference between a progress bar and a spinner, and
              "interrupted twice, resumed" is the difference between a slow
              run and a broken one. */}
          {active && (() => {
            const o = outcomeOf(active);
            const at = (active as RunExtras).task_index ?? 0;
            const of_ = active.tasks_total ?? 0;
            const pct = of_ > 0 ? Math.round((at / of_) * 100) : 0;
            return (
              <div className="text-xs text-stone-300 border border-stone-700 rounded p-2 space-y-1.5">
                <div>
                  <span className="font-mono">{active.model}</span> on{' '}
                  <span className="font-mono">{active.suite}</span> —{' '}
                  <span className={o ? outcomeTone(o) : 'text-teal-400'}>
                    {o ? o.label : 'running'}
                  </span>
                  {active.repeat_count > 1 && `, ${active.repeat_count} repeats each`}.
                </div>
                {of_ > 0 && (
                  <div className="h-1 rounded bg-stone-700 overflow-hidden">
                    <div className="h-full bg-teal-600 transition-all"
                      style={{ width: `${pct}%` }} />
                  </div>
                )}
                {o?.stalled ? (
                  <p className="text-[11px] text-amber-400/90">
                    It has stopped reporting. Recovery picks it up at the task
                    it reached — this is the harness, not the model, and it
                    does not need a new run.
                  </p>
                ) : (
                  <p className="text-[11px] text-stone-500">
                    {of_ > 0
                      ? `${of_ - at} task${of_ - at === 1 ? '' : 's'} to go. `
                      : 'Loading the suite. '}
                    This page updates on its own, and the result is sent to
                    your chat when it lands — you do not have to sit here.
                  </p>
                )}
              </div>
            );
          })()}

          {/* WHAT IS ACTUALLY BEING TESTED. The panel shipped without this and
              the first question asked of it was "there's no indication of what
              the tests are at all" — a score with no visible rubric is a number
              you have to trust. Every task carries an `intent` explaining the
              incident it came from, which was the best prose in the repo and
              invisible outside it. */}
          <details className="group">
            <summary className="text-xs uppercase tracking-wide text-stone-500 cursor-pointer hover:text-stone-400 list-none flex items-center gap-1">
              <span className="group-open:rotate-90 transition-transform">▸</span>
              What {suite} tests {tasks && `(${tasks.length})`}
            </summary>
            <div className="mt-2 space-y-2 pl-3 border-l border-stone-700">
              {tasks === null ? (
                <p className="text-xs text-stone-500">Loading…</p>
              ) : !tasks.length ? (
                <p className="text-xs text-stone-500">No tasks in this suite.</p>
              ) : tasks.map(t => (
                <details key={t.id} className="text-xs">
                  <summary className="cursor-pointer text-stone-300 hover:text-stone-200">
                    {t.title}
                    {!!t.grades.length && (
                      <span className="text-stone-600 ml-2">
                        — {t.grades.join(', ')}
                      </span>
                    )}
                  </summary>
                  <div className="mt-1 mb-2 space-y-1 text-stone-500">
                    <p className="italic text-stone-400">&ldquo;{t.prompt}&rdquo;</p>
                    <p className="leading-relaxed">{t.intent}</p>
                  </div>
                </details>
              ))}
              <p className="text-[11px] text-stone-600 pt-1">
                Tasks live in <span className="font-mono">backend/app/evals/tasks/{suite}/</span>.
                Each is a recorded incident with a contract; adding or changing
                one is a code change, so it is reviewed like one.
              </p>
            </div>
          </details>

          {/* THE QUESTION THE NIGHTLY ROTATION EXISTS TO SETTLE. There is one
              `main` binding and one install-wide standby, and no way to bind a
              different local model per agent — so "best at guardian" is a
              question nobody can act on, and "best across everything a local
              model may have to run" is the only one that is. The caveats are
              on the face of it rather than in a tooltip because a bare winner
              is exactly what gets over-read: the BASIS says which suites the
              comparison rests on, and a tie says tie. */}
          <div>
            <h4 className="text-xs uppercase tracking-wide text-stone-500 mb-1">
              Best local model, across suites
            </h4>
            {standingsError ? (
              <p className="text-xs text-stone-500" title={standingsError}>
                standings unavailable
              </p>
            ) : standings === null ? (
              <p className="text-xs text-stone-500">Loading…</p>
            ) : !standings.comparable ? (
              <div className="space-y-1">
                {/* AN EMPTY BOARD MUST SAY WHY IT IS EMPTY. Bumping a suite's
                    version voids every recorded run of it — correctly — but
                    the board it leaves used to look exactly like one where
                    nothing had ever been measured. That is a reset wearing an
                    absence's clothes, and ~48 nights of owed rotation were
                    invisible behind it. */}
                {((standings as EvalStandings & StandingsExtras).coverage_reset
                  ?? []).length > 0 && (
                  <p className="text-xs text-amber-400/90">
                    Coverage reset by suite edit — this is not an empty
                    history:{' '}
                    {((standings as EvalStandings & StandingsExtras)
                      .coverage_reset ?? []).map(cr =>
                        `${cr.suite} is now v${cr.version} and every recorded `
                        + `run predates it (${cr.runs_voided} run`
                        + `${cr.runs_voided === 1 ? '' : 's'} voided`
                        + (cr.measured_versions.length
                          ? `, newest at v${cr.measured_versions[0]}` : '')
                        + (cr.last_measured
                          ? `, last measured ${fmtDateTime(cr.last_measured)}`
                          : '')
                        + ')'
                      ).join('; ')}.
                  </p>
                )}
                <p className="text-xs text-stone-500">
                  Not comparable yet — no suite has been graded against all{' '}
                  {standings.installed.length} installed local models at repeat{' '}
                  {standings.min_repeat} or more. {standings.missing.length}{' '}
                  pairing{standings.missing.length === 1 ? '' : 's'} still owed
                  {(standings as EvalStandings & StandingsExtras)
                    .rotation_enabled === false
                    ? ' — and the nightly tournament is OFF (evals.tournament_every_hours), so nothing will pay them off until it is switched on or a run is started here.'
                    : '; the nightly rotation is what pays them off.'}
                </p>
              </div>
            ) : (
              <>
                <p className="text-[11px] text-stone-500 mb-1">
                  Over {standings.basis.length} suite
                  {standings.basis.length === 1 ? '' : 's'} at the current
                  version ({standings.basis.join(', ')}), repeat ≥{' '}
                  {standings.min_repeat}, comparing only the models graded on
                  all of them.
                  {standings.missing.length > 0 &&
                    ` ${standings.missing.length} pairing${standings.missing.length === 1 ? '' : 's'} still owed.`}
                </p>
                {standings.table.map(r => (
                  <div key={r.model}
                    className="flex items-baseline justify-between gap-3 text-xs py-0.5">
                    <span className="truncate">
                      <span className={r.ranked
                        ? 'font-mono text-stone-400' : 'font-mono text-stone-600'}>
                        {r.model}
                      </span>
                      {standings.leader === r.model && (
                        <span className="text-emerald-400 ml-2">ahead</span>
                      )}
                    </span>
                    {/* An unranked model is not a zero. It has not been
                        measured across the whole basis, so it has no score
                        here at all — showing 0/0 would read as "lost". */}
                    {r.ranked ? (
                      <span className="flex items-baseline gap-2 shrink-0">
                        <span className="text-stone-300">
                          {r.passed}/{r.total}
                        </span>
                        <span className="text-stone-500">
                          {r.pass_rate == null
                            ? '—'
                            : `${Math.round(r.pass_rate * 100)}%`}
                        </span>
                      </span>
                    ) : (
                      <span className="text-stone-600 shrink-0"
                        title={r.covered.length
                          ? `Measured on ${r.covered.join(', ')} — not across the whole basis.`
                          : 'Never graded at the current suite version.'}>
                        not yet measured across all {standings.basis.length}
                      </span>
                    )}
                  </div>
                ))}
                {!standings.leader && (
                  <p className="text-[11px] text-stone-500 pt-1">
                    Nothing is ahead by a margin, so this names no winner. Two
                    of these have tied at 2/7 over three repeats each, and a
                    ranking that breaks a tie by sort order is an artifact.
                  </p>
                )}
              </>
            )}
          </div>

          {/* THE DURABLE PAIRWISE VERDICTS. The CLI printed a scoreboard and
              persisted nothing, so "did the challenger beat the champion" was
              answerable only by whoever was watching the terminal. These rows
              are eval_comparisons; no Promote button on purpose — scores flip
              run to run (2/7 then 3/7 on consecutive nights), and promotion
              is a separate deliberate decision. */}
          {(comparisonsError || (comparisons?.length ?? 0) > 0) && (
            <div>
              <h4 className="text-xs uppercase tracking-wide text-stone-500 mb-1">
                Champion vs challenger
              </h4>
              {comparisonsError ? (
                <p className="text-xs text-amber-400/90">{comparisonsError}</p>
              ) : (
                (comparisons ?? []).map(c => {
                  const stale = c.current_suite_version != null
                    && c.suite_version !== c.current_suite_version;
                  return (
                    <div key={c.id}
                      className="flex items-baseline justify-between gap-3 text-xs py-0.5">
                      <span className="truncate">
                        <span className="text-stone-500">{c.suite}</span>
                        <span className="text-stone-600 mx-1">·</span>
                        <span className="font-mono text-stone-400">
                          {c.champion}
                        </span>
                        <span className="text-stone-600 mx-1">vs</span>
                        <span className="font-mono text-stone-400">
                          {c.challenger}
                        </span>
                      </span>
                      <span className="flex items-baseline gap-2 shrink-0">
                        <span className="text-stone-300"
                          title={`Of ${c.tasks_total} tasks, ${c.tasks_gradeable} were gradeable for both sides${c.tasks_invalid ? `; ${c.tasks_invalid} invalid (a suite gap, neither model's score)` : ''}. A task counts only if it passed every one of ${c.repeat_count} repeat(s).`}>
                          {c.champion_passed}–{c.challenger_passed}
                          <span className="text-stone-500">
                            {' '}of {c.tasks_gradeable}
                          </span>
                        </span>
                        {c.regressions.length > 0 && (
                          <span className="text-amber-400/90"
                            title={`Challenger broke contracts the champion kept: ${c.regressions.join(', ')}`}>
                            {c.regressions.length} regression{c.regressions.length === 1 ? '' : 's'}
                          </span>
                        )}
                        {stale && (
                          <span className="text-amber-400/90"
                            title={`Recorded against suite v${c.suite_version}; it is now v${c.current_suite_version}. This verdict describes a different set of tasks.`}>
                            suite moved
                          </span>
                        )}
                        <span className="text-stone-600 tabular-nums">
                          {fmtDateTime(c.at)}
                        </span>
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          )}

          <div>
            <h4 className="text-xs uppercase tracking-wide text-stone-500 mb-1">
              Latest verdict per model
            </h4>
            {!verdicts.length ? (
              <p className="text-xs text-stone-500">
                Nothing has been graded yet. A model with no verdict is not
                &ldquo;fine&rdquo; — it is unmeasured, and model fitness says so.
              </p>
            ) : (
              verdicts.map(verdictLine)
            )}
          </div>

          {/* THE HISTORY, not just the standing. "Latest verdict per model"
              collapses to one row per (agent, model), which hides that a
              score moved — and a score moving is the most informative thing
              here: the same model scored 2/7 and 3/7 on consecutive runs of
              the same suite. A board showing only the newest number reads as
              settled when it is not. */}
          {runs.length > 0 && (
            /* Opened by the deep link the finished-run notification carries
               (/library/models?run=…), so "show me the detail" from a push
               lands on the run it was about instead of a collapsed list. */
            <details open={!!focusRun}>
              <summary className="text-xs uppercase tracking-wide text-stone-500 cursor-pointer hover:text-stone-400 list-none">
                ▸ Run history ({runs.length})
                {/* The census is over the WHOLE history (and ignores any
                    status filter, zeros stated), so a page of twelve rows
                    cannot read as twelve runs ever. */}
                {census && (
                  <span className="normal-case tracking-normal text-stone-600">
                    {' '}— {censusLine(census)}
                  </span>
                )}
              </summary>
              <div className="mt-1.5 space-y-0.5">
                {runs.map(r => {
                  const o = outcomeOf(r);
                  return (
                  <div key={r.id}>
                  <div
                    onClick={() => toggleRun(r.id)}
                    title="Show the per-task record"
                    className={`flex items-baseline justify-between gap-3 text-[11px] cursor-pointer hover:bg-stone-800/60 rounded ${
                      focusRun === r.id
                        ? 'ring-1 ring-teal-600/60 rounded px-1 -mx-1' : ''}`}>
                    <span className="truncate">
                      <span className="text-stone-500">{r.suite}</span>
                      {r.suite_version != null && (
                        <span className="text-stone-600"> v{r.suite_version}</span>
                      )}
                      <span className="text-stone-600 mx-1">·</span>
                      <span className="font-mono text-stone-400">{r.model}</span>
                    </span>
                    <span className="flex items-baseline gap-2 shrink-0">
                      {/* THE DERIVED READING, not the status word. A run that
                          graded all seven tasks and scored two is a
                          measurement; one that died at task 0 is the harness.
                          Both were 'failed'/'error' and both rendered here as
                          "did not finish", which is how a result Jeremy paid
                          eight minutes for reached nobody. The fallback below
                          is the pre-127 rendering, kept for a response that
                          predates the field rather than crashing on it. */}
                      {o ? (
                        <>
                          <span className={outcomeTone(o)} title={outcomeTitle(o)}>
                            {o.label}
                          </span>
                          {o.measurement && r.repeat_count > 1 && (
                            <span className="text-stone-600">×{r.repeat_count}</span>
                          )}
                          <DeliveryNote run={r} />
                        </>
                      ) : r.status === 'running' ? (
                        <span className="text-teal-400">running…</span>
                      ) : r.status === 'error' ? (
                        <span className="text-amber-400/90"
                          title={(() => {
                            const f = failureOf(r);
                            return f ? `${f.type}: ${f.message}` : (r.error || '');
                          })()}>
                          {failureOf(r)?.resource_refusal
                            ? 'refused — out of resources, not a verdict'
                            : 'did not finish'}
                        </span>
                      ) : (
                        <>
                          <span className={r.tasks_passed === r.tasks_total
                            ? 'text-emerald-400' : 'text-stone-300'}>
                            {r.tasks_passed}/{r.tasks_total}
                          </span>
                          <span className="text-stone-600">
                            ×{r.repeat_count}
                          </span>
                        </>
                      )}
                      <span className="text-stone-600 tabular-nums">
                        {fmtDateTime(r.started_at)}
                      </span>
                    </span>
                  </div>
                  {/* THE PER-TASK RECORD (migration 124), which had zero
                      consumers until here: which tasks passed, how many of
                      the repeats each survived, and the grader's own
                      CheckResult lines for the ones that did not. */}
                  {expandedRun === r.id && (() => {
                    const det = runDetails[r.id];
                    if (!det || det === 'loading') {
                      return <div className="pl-3 py-0.5 text-[11px] text-stone-500">Loading tasks…</div>;
                    }
                    if (det === 'error') {
                      return (
                        <div className="pl-3 py-0.5 text-[11px] text-amber-400/90">
                          The per-task record could not be loaded.
                        </div>
                      );
                    }
                    if (!det.tasks?.length) {
                      return (
                        <div className="pl-3 py-0.5 text-[11px] text-stone-500">
                          No per-task record — this run predates the per-task cursor.
                        </div>
                      );
                    }
                    return (
                      <div className="ml-1.5 pl-2 py-0.5 border-l border-stone-700 space-y-0.5">
                        {det.tasks.map(t => (
                          <div key={t.task} className="text-[11px]">
                            <div className="flex items-baseline justify-between gap-3">
                              <span className="truncate font-mono text-stone-400">
                                {t.task.startsWith(`${r.suite}/`)
                                  ? t.task.slice(r.suite.length + 1) : t.task}
                              </span>
                              <span className="flex items-baseline gap-2 shrink-0">
                                {!t.gradeable ? (
                                  <span className="text-amber-400/90"
                                    title="This task could not be graded — a harness gap, not a model verdict.">
                                    ungradeable
                                  </span>
                                ) : (
                                  <span className={t.passed ? 'text-emerald-400' : 'text-stone-300'}
                                    title={`Passed ${t.runs_passed} of ${t.runs} repeat(s) — a task counts only if it passed every one.`}>
                                    {t.passed ? 'passed' : `${t.runs_passed}/${t.runs} repeats`}
                                  </span>
                                )}
                                {t.duration_s != null && (
                                  <span className="text-stone-600">{t.duration_s}s</span>
                                )}
                              </span>
                            </div>
                            {t.errors.length > 0 && (
                              <div className="text-amber-400/90 truncate" title={t.errors.join('\n')}>
                                {t.errors[0]}
                              </div>
                            )}
                            {!t.passed && t.contract_failures.length > 0 && (
                              <details>
                                <summary className="cursor-pointer text-stone-600 hover:text-stone-400">
                                  {t.contract_failures.length} failed check{t.contract_failures.length === 1 ? '' : 's'}
                                </summary>
                                <ul className="pl-3 text-stone-500 font-mono">
                                  {t.contract_failures.map((c, i) => (
                                    <li key={i} className="truncate" title={c}>{c}</li>
                                  ))}
                                </ul>
                              </details>
                            )}
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                  </div>
                  );
                })}
              </div>
            </details>
          )}

          {/* Only the MOST RECENT run, and only if it did not measure
              anything. Scanning the last eight for any error surfaced a
              failure from hours earlier in amber as though it had just
              happened — which is the same absence-read-as-now mistake this
              whole lane is about.

              The condition is the DERIVED one now, not `status === 'error'`.
              A run killed at task 3 of 7 lands 'failed' with a partial score
              and used to slip past this line wearing a number; a run that
              graded everything and scored 2/7 is a result and must not be
              in amber. */}
          {runs[0] && runs[0].status !== 'running'
            && outcomeOf(runs[0]) && !outcomeOf(runs[0])!.measurement && (
            <p className="text-[11px] text-amber-400/90">
              Last run: {outcomeOf(runs[0])!.headline}.
              {outcomeOf(runs[0])!.why ? ` ${outcomeOf(runs[0])!.why}` : ''}
            </p>
          )}
          {/* ...and when it DID measure, say so and say whether you were
              told. Jeremy's report was "I ran a model eval test, haven't seen
              any update" about a run that had completed: the panel knowing
              and him not knowing is the failure, so the delivery is on the
              face of it rather than in a tooltip. Receipt is never claimed
              from a transport — `confirmed` is the notification being opened
              on a device, and nothing else prints as delivered. */}
          {runs[0] && runs[0].status !== 'running'
            && outcomeOf(runs[0])?.measurement && (
            <p className="text-[11px] text-stone-500">
              Last run: {outcomeOf(runs[0])!.headline} —{' '}
              {outcomeOf(runs[0])!.basis}.{' '}
              {(() => {
                const a = announcementOf(runs[0]);
                if (!a) return 'No announcement has been recorded for it yet.';
                if (a.backfilled) return 'It predates result notifications, so nobody was told at the time.';
                return `Told you: ${a.how}.`;
              })()}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Which model does what — every binding in one place.
 *
 *  Before this, "which model does what" had no home, and the answer was
 *  scattered across four screens: the compaction model under Settings →
 *  Context next to a message-count threshold, the voice model under Voice,
 *  the local fallback under Inference, and every agent's own binding under
 *  Agents. The operator went looking for the compaction model in the model
 *  library — the only place that *looks* like it is about models — and it
 *  wasn't there. A feature with no binding of its own had also started
 *  quietly borrowing the compaction model, which is exactly what happens when
 *  there is nowhere for this question to live.
 *
 *  Nothing moved. Every row is still the same setting, saved through the same
 *  endpoint, so precedence and the Redis sync are untouched — this is a view,
 *  not a new source of truth. The task rows are DERIVED: SettingsTab renders
 *  every setting of type `model`, so a role added later appears here on its
 *  own. The agent rows are read-only on purpose: agents have a real editor
 *  one tab over, and two write paths onto the same column drift. */
function RolesPanel() {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  // The standby order, DERIVED. Rendering a.fallback_model instead shows
  // "inherited" on every row while a real chain exists behind it — which is
  // how this panel came to look like the feature was missing.
  //
  // null means "not answered", which is not the same as "no standby" — see the
  // note in AgentsTab. A swallowed failure here painted the amber warning onto
  // every row at once.
  const [chains, setChains] = useState<Record<string, ChainLink[]> | null>(null);

  useEffect(() => { getAgents().then(setAgents).catch(() => setAgents([])); }, []);
  useEffect(() => {
    getAgentModelChains().then(setChains).catch(() => setChains(null));
  }, []);

  return (
    <div className="rounded-lg border border-stone-700 bg-stone-800/30 p-3 space-y-4">
      <div>
        <h3 className="text-sm text-stone-200">Which model does what</h3>
        <p className="text-xs text-stone-500 mt-0.5">
          Every model binding Nova has, in one place. Changing one here is the
          same as changing it in Settings — this is where you can see them together.
        </p>
      </div>

      <div>
        <h4 className="text-xs uppercase tracking-wide text-stone-500 mb-2">Tasks</h4>
        <SettingsTab types={['model']} />
      </div>

      <div>
        <h4 className="text-xs uppercase tracking-wide text-stone-500 mb-2">Agents</h4>
        {agents === null ? (
          <div className="text-xs text-stone-500">Loading…</div>
        ) : !agents.length ? (
          <div className="text-xs text-stone-500">No agents.</div>
        ) : (
          <div className="space-y-1.5">
            {agents.map(a => (
              <div key={a.id} className="text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className={a.enabled ? 'text-stone-200' : 'text-stone-500'}>
                    {a.name}
                    {!a.enabled && <span className="text-xs text-stone-600"> (disabled)</span>}
                  </span>
                  <span className="text-xs text-stone-400 font-mono truncate">{a.model}</span>
                </div>
                <div className="text-[11px] text-stone-500 pl-2">
                  {chains?.[a.id] === undefined ? null
                    : chains[a.id].length === 0 ? (
                      <span className="text-amber-400/90">no standby — dies with its model</span>
                    ) : (
                      <>then {chains[a.id].map((l, i) => (
                        <span key={l.model} title={l.why}>
                          {i > 0 && ', '}
                          <span className="font-mono text-stone-400">{l.model}</span>
                        </span>
                      ))}</>
                    )}
                </div>
              </div>
            ))}
            <p className="text-xs text-stone-500 pt-1">
              Change these in the Agents tab — they are each an agent's own
              binding, and having two places to write the same field is how
              they end up disagreeing. The standby order shown is derived: your
              own choice first, then the install default, then the main agent's
              model, then a model on the other tier so an agent survives its
              whole tier going down.
            </p>
          </div>
        )}
      </div>
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
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-stone-100 truncate">{p.label}</span>
                    <span className="text-[10px] font-mono px-1 rounded bg-stone-700 text-stone-400">{p.slug}</span>
                    {p.is_system && <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400 shrink-0">seed</span>}
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
                  <div className="flex items-center gap-1.5 flex-wrap justify-end min-w-0">
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

// Format a context window: 1000000 → "1M", 128000 → "128K".
function fmtCtx(n?: number): string | null {
  if (!n) return null;
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return `${n}`;
}

// Description keywords that stand in for a use-case when there's no curated row.
// Grounded in the PROVIDER'S OWN description text — a claim we surface, not one
// we invent. vision/long-context come from hard metadata instead.
const _USE_CASE_KEYWORDS: Record<string, string[]> = {
  coding: ['coding', 'code', 'programming', 'software', 'developer'],
  reasoning: ['reasoning', 'reason', 'math', 'logic', 'stem'],
  writing: ['writing', 'write', 'creative', 'prose', 'storytelling'],
  'agentic-tools': ['agent', 'tool', 'function call', 'function-call', 'tool use'],
  chat: ['chat', 'conversation', 'assistant', 'dialogue'],
  multilingual: ['multilingual', 'languages', 'translation'],
  summarization: ['summar'],
};

/** The use-case tags for a catalog model. If a curated row exists, those
 *  editorial tags are authoritative (`vetted`). Otherwise infer from provider
 *  facts (vision←modality, long-context←window) and description keywords —
 *  clearly styled as inferred, with the description shown so matches explain
 *  themselves. */
function catalogTags(m: ModelInfo, row?: CuratedModel): { tag: string; vetted: boolean }[] {
  if (row && row.use_cases.length) return row.use_cases.map(t => ({ tag: t, vetted: true }));
  const out: { tag: string; vetted: boolean }[] = [];
  if (m.vision) out.push({ tag: 'vision', vetted: false });
  if ((m.context_length ?? 0) >= 200_000) out.push({ tag: 'long-context', vetted: false });
  const d = (m.description ?? '').toLowerCase();
  if (d) {
    for (const [tag, words] of Object.entries(_USE_CASE_KEYWORDS)) {
      if (out.some(t => t.tag === tag)) continue;
      if (words.some(w => d.includes(w))) out.push({ tag, vetted: false });
    }
  }
  return out;
}

/** Everything the configured credentials can reach; installed local models
 *  can be uninstalled from here (covers pulls that aren't in the curated
 *  table). Any cloud model can be approved straight from here in one click —
 *  approval just creates (or re-enables) its curated row, which is what puts
 *  it in the agent + chat dropdowns. Cloud rows carry the provider's own
 *  "good for" facts (description, context, vision, price) so a bare id isn't
 *  the only thing to go on. */
function FullCatalog() {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [curated, setCurated] = useState<CuratedModel[]>([]);
  const [filter, setFilter] = useState('');
  const [locFilter, setLocFilter] = useState<'all' | 'local' | 'cloud'>('all');
  const [useCaseFilter, setUseCaseFilter] = useState('');
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

  const q = filter.trim().toLowerCase();
  const shown = (models ?? []).filter(m => {
    const local = m.provider === 'ollama';
    if (locFilter === 'local' && !local) return false;
    if (locFilter === 'cloud' && local) return false;
    if (useCaseFilter &&
        !catalogTags(m, rowFor(m.id)).some(t => t.tag === useCaseFilter)) return false;
    if (q && !m.id.toLowerCase().includes(q) &&
        !(m.description ?? '').toLowerCase().includes(q)) return false;
    return true;
  });
  const hasCloud = (models ?? []).some(m => m.provider !== 'ollama');

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
        {models && models.length > 0 && (
          <div className="mb-2 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-stone-500">filter</span>
              <div className="inline-flex rounded border border-stone-700 overflow-hidden">
                {(['all', 'local', 'cloud'] as const).map(loc => (
                  <button key={loc} onClick={() => setLocFilter(loc)}
                    className={`text-[11px] px-2 py-0.5 ${locFilter === loc
                      ? 'bg-teal-800/70 text-teal-100' : 'text-stone-400 hover:text-stone-200'}`}>
                    {loc}
                  </button>
                ))}
              </div>
              <select value={useCaseFilter} onChange={e => setUseCaseFilter(e.target.value)}
                className="bg-stone-800 border border-stone-700 rounded px-2 py-0.5 text-[11px] text-stone-300"
                title="best for use-case">
                <option value="">any use-case</option>
                {USE_CASES.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
              {(useCaseFilter || locFilter !== 'all' || filter) && (
                <button onClick={() => { setUseCaseFilter(''); setLocFilter('all'); setFilter(''); }}
                  className="text-[11px] text-stone-500 hover:text-stone-300 underline">clear</button>
              )}
              <span className="text-[11px] text-stone-600 ml-auto">{shown.length} of {models.length}</span>
            </div>
            <input placeholder="search id or description…" value={filter}
              onChange={e => setFilter(e.target.value)}
              className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200" />
            {useCaseFilter && hasCloud && (
              <div className="text-[10px] text-stone-600">
                cloud tags marked <span className="font-mono">?</span> are inferred from each provider's
                description &amp; metadata (shown per row); curated models use their vetted tags.
              </div>
            )}
          </div>
        )}
        <div className="max-h-80 overflow-y-auto nice-scroll space-y-1">
          {models === null ? (
            <div className="text-xs text-stone-500">loading…</div>
          ) : models.length === 0 ? (
            <div className="text-xs text-stone-500 italic">
              nothing reachable — no local models installed and no cloud credentials
            </div>
          ) : shown.length === 0 ? (
            <div className="text-xs text-stone-500 italic">no models match the current filter</div>
          ) : (
            shown.map(m => {
              const row = rowFor(m.id);
              const approved = !!row?.enabled;
              const tags = catalogTags(m, row);
              const ctx = fmtCtx(m.context_length);
              return (
                <div key={m.id} className="rounded border border-stone-800 bg-stone-900/30 px-2 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-mono text-stone-300 truncate">{m.id}</span>
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
                  {(ctx || m.vision || m.price_in != null) && (
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-stone-500">
                      {ctx && <span>{ctx} ctx</span>}
                      {m.vision && <span className="text-violet-400/80">vision</span>}
                      {m.price_in != null && (
                        <span>${m.price_in}/${m.price_out ?? '?'} per M</span>
                      )}
                    </div>
                  )}
                  {tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {tags.map(({ tag, vetted }) => (
                        <button key={tag} onClick={() => setUseCaseFilter(tag)}
                          title={vetted ? 'curated tag' : "inferred from the provider's description / metadata"}
                          className={`text-[10px] px-1.5 py-0.5 rounded border ${useCaseFilter === tag
                            ? 'bg-teal-800/60 border-teal-700 text-teal-100'
                            : vetted ? 'bg-stone-800/60 border-stone-700 text-stone-300 hover:text-stone-100'
                              : 'border-dashed border-stone-700 text-stone-500 hover:text-stone-300'}`}>
                          {tag}{vetted ? '' : ' ?'}
                        </button>
                      ))}
                    </div>
                  )}
                  {m.description && (
                    <div className="mt-0.5 text-[10px] text-stone-600 line-clamp-2" title={m.description}>
                      {m.description}
                    </div>
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
