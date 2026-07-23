import { useState, useEffect } from 'react';
import {
  AgentInfo, ModelInfo, createAgent, deleteAgent, getAgents, getModels, patchAgent,
} from '../../api';
import { agentDisplayName } from '../../names';
import { Toggle, CardsSkeleton } from '../ui';
import { ConcurrentLoad, DetectSuggest } from './models-shared';

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
