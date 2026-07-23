import { useState, useEffect } from 'react';
import {
  DbToolInfo, McpServer, McpTool, ToolsCatalog, approveMcpServer, createMcpServer, createTool, deleteMcpServer, deleteTool, getMcpServerTools, getMcpServers, getTools, patchMcpServer, patchTool,
} from '../../api';
import { displayName } from '../../names';
import { Toggle, CardsSkeleton } from '../ui';

/** DB-created HTTP tools (toggleable, creatable, editable) + read-only builtins. */
export function ToolsTab() {
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
