import { useState, useEffect } from 'react';
import {
  AgentInfo, ChainLink, ModelInfo, createAgent, deleteAgent,
  getAgentModelChains, getAgents, getModelCapabilities, getModels, patchAgent,
} from '../../api';
import { agentDisplayName } from '../../names';
import { Toggle, CardsSkeleton } from '../ui';
import { ConcurrentLoad, DetectSuggest } from './models-shared';
import { groupModels } from '../../models';

/** Where each link came from. Labels only — the ORDER and the reasoning are
 *  the backend's (GET /api/v1/agents/model-chains). */
const CHAIN_SOURCE: Record<ChainLink['source'], string> = {
  agent: 'yours',
  install: 'install default',
  main: 'main agent',
  cross_tier: 'derived',
};

/** Per-agent model + status — every agent has its OWN model. */
export function AgentsTab() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [showAllModels, setShowAllModels] = useState(false);
  const [allModel, setAllModel] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AgentInfo | null>(null);
  const [expandedPrompt, setExpandedPrompt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // what the LOCAL server says each model can do — never inferred from names
  const [caps, setCaps] = useState<Record<string, string[]>>({});
  const emptyForm = {
    name: '', description: '', system_prompt: '', model: '',
    allowed_tools: '', routing_keywords: '',
  };
  const [form, setForm] = useState(emptyForm);

  // The standby order, derived by the backend — never restated here.
  //
  // null is NOT an empty chain. This started as `useState({})` with a swallowed
  // catch, so one failed request rendered "dies with its model" in amber on
  // every agent at once — a fleet-wide alarm produced by a dropped fetch. An
  // absent answer and an answer of "nothing" have to be different values, or
  // the UI states the more alarming one whenever it knows the least.
  const [chains, setChains] = useState<Record<string, ChainLink[]> | null>(null);
  const [chainsError, setChainsError] = useState('');
  const loadChains = () => getAgentModelChains()
    .then(c => { setChains(c); setChainsError(''); })
    .catch(e => { setChains(null); setChainsError(String(e)); });
  const load = () => getAgents().then(setAgents).catch(e => setStatus(String(e)))
    .finally(() => { setLoaded(true); loadChains(); });
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    getModels(showAllModels).then(setModels).catch(() => {});
  }, [showAllModels]);
  useEffect(() => {
    getModelCapabilities().then(setCaps).catch(() => {});
  }, []);

  async function setThinking(a: AgentInfo, thinking: 'auto' | 'on' | 'off') {
    try {
      await patchAgent(a.id, { thinking });
      setAgents(prev => prev.map(x => x.id === a.id ? { ...x, thinking } : x));
    } catch (e) { setStatus(String(e)); }
  }

  /** Only for models the server reports as thinking-capable — a model that
   *  cannot reason gets no control rather than a dead one. */
  const thinkingSelect = (a: AgentInfo) => {
    if (!(caps[a.model] ?? []).includes('thinking')) return null;
    return (
      <select
        value={a.thinking ?? 'auto'}
        onChange={e => setThinking(a, e.target.value as 'auto' | 'on' | 'off')}
        title="Reasoning models think before answering. Off is markedly faster for short replies; on is worth it for hard, multi-step work. Auto leaves the model to its own default."
        className="text-[11px] bg-stone-800 border border-stone-600 rounded px-1 py-0.5 text-stone-300"
      >
        <option value="auto">thinking: auto</option>
        <option value="on">thinking: on</option>
        <option value="off">thinking: off</option>
      </select>
    );
  };

  async function setModel(a: AgentInfo, model: string) {
    try {
      await patchAgent(a.id, { model });
      setAgents(prev => prev.map(x => x.id === a.id ? { ...x, model } : x));
      loadChains();   // the derived link depends on which tier this model is on
    } catch (e) { setStatus(String(e)); }
  }

  /** The standby. Choosing this agent's own model is the same as choosing
   *  none — the backend blanks it — so the row reflects what was stored,
   *  never what was clicked. */
  async function setFallback(a: AgentInfo, fallback_model: string) {
    try {
      await patchAgent(a.id, { fallback_model });
      const stored = fallback_model === a.model ? null : (fallback_model || null);
      setAgents(prev => prev.map(x => x.id === a.id ? { ...x, fallback_model: stored } : x));
      loadChains();
    } catch (e) { setStatus(String(e)); }
  }

  async function setAll() {
    if (!allModel) return;
    try {
      // Migration 082's trigger blanks any standby that now equals the new
      // model, so a bulk set can silently drop a standby the operator chose.
      // Say which ones rather than letting the row quietly change under them.
      const cleared = agents
        .filter(a => a.fallback_model && a.fallback_model === allModel)
        .map(a => agentDisplayName(a.name));
      await Promise.all(agents.map(a => patchAgent(a.id, { model: allModel })));
      setStatus(cleared.length
        ? `All agents set to ${allModel} — standby cleared on ${cleared.join(', ')} (it matched the new model)`
        : `All agents set to ${allModel}`);
      setTimeout(() => setStatus(''), cleared.length ? 6000 : 2000);
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
      {groupModels(models).map(g => (
        <optgroup key={g.slug} label={g.label}>
          {g.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </optgroup>
      ))}
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
                  {thinkingSelect(a)}
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
              {/* The standby, on its own line: the header row is already
                  four controls wide, and this one needs its inheritance
                  explained rather than guessed at from a blank select. */}
              <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] uppercase tracking-wide text-stone-500"
                  title="Used only when this agent's model fails before producing any output — a dead local server, an unpulled model, a cloud provider refusing. A model that can't do this agent's job (no tool support, too small a window) is refused rather than quietly used.">
                  Standby
                </span>
                {modelSelect(a.fallback_model || '', v => setFallback(a, v),
                  'inherit the install default…')}
              </div>
              {/* The order itself, DERIVED. This used to be a sentence typed
                  here naming two links; the chain has four and the sentence
                  had no way to notice. */}
              <div className="mt-1 flex items-center gap-1 flex-wrap text-[11px]">
                {chains?.[a.id] === undefined ? (
                  // Not loaded, or this agent was created after the last fetch.
                  // Say nothing rather than guess — the guess would be alarming.
                  chainsError ? (
                    <span className="text-stone-500"
                      title={chainsError}>standby order unavailable</span>
                  ) : null
                ) : chains[a.id].length === 0 ? (
                  <span className="text-amber-400/90"
                    title="Every link in this agent's chain is on the same tier as its own model, or there are none. If that tier goes down the turn fails with no answer.">
                    no standby — this agent dies with its model
                  </span>
                ) : (
                  <>
                    <span className="text-stone-500">order</span>
                    <span className="text-stone-400 font-mono">{a.model}</span>
                    {chains[a.id].map(l => (
                      <span key={l.model} className="flex items-center gap-1">
                        <span className="text-stone-600">→</span>
                        <span className="text-stone-400 font-mono" title={l.why}>{l.model}</span>
                        <span className="text-stone-600">{CHAIN_SOURCE[l.source] ?? l.source}</span>
                      </span>
                    ))}
                  </>
                )}
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
