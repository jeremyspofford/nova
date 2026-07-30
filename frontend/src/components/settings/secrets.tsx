import { useState, useEffect } from 'react';
import {
  SecretRow, SecretSource, listSecrets, putSecret, revealSecret, secretUsage,
  deleteSecret, secretSources, putExternalSecret,
} from '../../api';

/** Settings → Secrets (docs/plans/secrets-management.md phase 1).
 *
 *  The value is never in the list payload — only `has_value` — so a screenshot
 *  of this page leaks nothing. Revealing is a deliberate second act, and a
 *  separate POST rather than a GET so a credential cannot end up in a URL, a
 *  browser history or an access log.
 *
 *  The master-key warning is stated here rather than buried: the plan's own
 *  first listed risk is that losing the key loses every secret, and a risk the
 *  operator only meets at recovery time was not communicated. */
export function SecretsCard() {
  const [rows, setRows] = useState<SecretRow[] | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [desc, setDesc] = useState('');
  const [shown, setShown] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [sources, setSources] = useState<SecretSource[]>([]);
  const [source, setSource] = useState('builtin');

  const refresh = async () => {
    try { setRows(await listSecrets()); } catch { /* backend offline */ }
  };
  useEffect(() => { void refresh(); void secretSources().then(setSources); }, []);
  const picked = sources.find(s => s.source === source);

  const save = async () => {
    if (!name.trim() || !value) return;
    setBusy(true); setMsg('');
    try {
      const n = name.trim().toLowerCase();
      // An external source stores a POINTER; the value stays where it is.
      if (source === 'builtin') await putSecret(n, value, desc.trim());
      else await putExternalSecret(n, source, value, desc.trim());
      // the value leaves the browser and is not kept here either
      setName(''); setValue(''); setDesc('');
      await refresh();
      setMsg('Stored. Reference it in config as {{secret:' + name.trim().toLowerCase() + '}}');
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };

  const reveal = async (n: string) => {
    if (shown[n]) { setShown(s => { const c = { ...s }; delete c[n]; return c; }); return; }
    try {
      const v = await revealSecret(n);   // resolve first: a setState updater is not async
      setShown(s => ({ ...s, [n]: v }));
    } catch (e) { setMsg(String(e)); }
  };

  const remove = async (n: string) => {
    const used = await secretUsage(n);
    const warn = used.length
      ? `\n\nWARNING: referenced by ${used.join(', ')} — those will fail until you fix them.`
      : '';
    if (!window.confirm(`Delete the secret "${n}"?${warn}`)) return;
    try { await deleteSecret(n); await refresh(); } catch (e) { setMsg(String(e)); }
  };

  return (
    <div className="rounded-lg border border-stone-700/70 bg-stone-800/40 px-3 py-2.5 space-y-2">
      <div>
        <div className="text-sm text-stone-200">Secrets</div>
        <div className="text-xs text-stone-500">
          Tokens Nova's integrations need — a GitHub PAT, an API key. Stored
          encrypted, referenced in config by name as{' '}
          <code className="text-stone-400">{'{{secret:name}}'}</code>, and
          substituted only at the moment the request goes out. Nova can be told
          a name; she is never given a value.
        </div>
      </div>

      {rows === null ? (
        <div className="text-xs text-stone-500">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-stone-500 border-t border-stone-800 pt-2">
          Nothing stored yet.
        </div>
      ) : rows.map(s => (
        <div key={s.name} className="border-t border-stone-800 pt-2 text-xs space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">
              <code className="text-stone-300">{s.name}</code>
              {s.source !== 'builtin' &&
              <span className="text-amber-600/90"> · {s.source}: {s.ref}</span>}
            {s.description && <span className="text-stone-500"> · {s.description}</span>}
              <span className="text-stone-600">
                {' '}· {s.last_used_at ? `used ${s.last_used_at.slice(0, 10)}` : 'never used'}
              </span>
            </span>
            <span className="shrink-0 flex items-center gap-2">
              <button onClick={() => reveal(s.name)}
                className="px-2 py-0.5 rounded border border-stone-700 text-stone-300 hover:border-teal-600">
                {shown[s.name] ? 'hide' : 'reveal'}
              </button>
              <button onClick={() => remove(s.name)}
                className="text-stone-600 hover:text-red-400">remove</button>
            </span>
          </div>
          <code className="block truncate text-stone-400 bg-stone-900/60 rounded px-1.5 py-0.5">
            {shown[s.name] ?? '•'.repeat(24)}
          </code>
        </div>
      ))}

      <div className="border-t border-stone-800 pt-2 space-y-1.5">
        <div className="flex items-center gap-2">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="name (github_pat)"
            className="min-w-0 flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200" />
          <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="what it's for"
            className="min-w-0 flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200" />
        </div>
        <div className="flex items-center gap-2">
          <select value={source} onChange={e => setSource(e.target.value)}
            className="bg-stone-800 border border-stone-700 rounded px-1.5 py-1 text-xs text-stone-300">
            {sources.map(o => (
              <option key={o.source} value={o.source} disabled={!o.available}>
                {o.label}{o.available ? '' : ' (needs its CLI)'}
              </option>
            ))}
          </select>
          <input value={value} onChange={e => setValue(e.target.value)}
            type={source === 'builtin' ? 'password' : 'text'}
            placeholder={source === 'builtin'
              ? 'value — encrypted on save'
              : `reference — e.g. ${picked?.ref_example ?? ''}`}
            autoComplete="off"
            className="min-w-0 flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200" />
          <button onClick={save} disabled={busy || !name.trim() || !value}
            className="text-xs px-2.5 py-1 rounded bg-teal-700 hover:bg-teal-600 text-white disabled:opacity-40">
            Store
          </button>
        </div>
      </div>

      {msg && <div className="text-xs text-teal-400 break-words">{msg}</div>}
      <div className="text-xs text-stone-600 border-t border-stone-800 pt-2">
        Encrypted with a master key from <code>NOVA_SECRET_KEY</code>, or a
        generated one at <code>/state/secret.key</code> if that is unset.
        <span className="text-amber-600"> Lose the key and every secret here is
        unrecoverable</span> — the ciphertext is worthless without it. A
        generated key is also per-machine, so set <code>NOVA_SECRET_KEY</code>
        before running a second instance against this database.
      </div>
    </div>
  );
}
