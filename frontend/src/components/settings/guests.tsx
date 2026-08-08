import { useEffect, useState } from 'react';
import {
  GuestSessionRow, deleteGuest, getModels, listGuests, mintGuest, revokeGuest,
} from '../../api';

/** Settings → Guest access (docs/plans/public-access-and-guests.md §3).
 *
 *  Jeremy, 2026-08-07: "grant guest access over a small amount of time with
 *  specific llms to test out or whatever" and "a sandbox memory that gets
 *  wiped when I remove the guest access for that user".
 *
 *  The link is shown ONCE. Only a sha256 is stored, so there is no endpoint
 *  that could show it again — the same shape as the secrets card, for the same
 *  reason: a credential that can be re-read is a credential a screenshot
 *  leaks. Revoke is the recovery path, not "look it up".
 *
 *  Nothing on this page is a control. The expiry, the model allowlist and the
 *  route restrictions are all enforced in the backend; this only mints rows.
 */

const PRESETS = [
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
  { label: '1 day', minutes: 1440 },
  { label: '1 week', minutes: 10080 },
];

function when(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function statusOf(g: GuestSessionRow): string {
  if (g.revoked_at) return 'revoked — memory wiped';
  const exp = g.expires_at ? new Date(g.expires_at.replace(' ', 'T')).getTime() : 0;
  return exp && exp < Date.now() ? 'expired' : `active until ${when(g.expires_at)}`;
}

export function GuestAccessCard() {
  const [rows, setRows] = useState<GuestSessionRow[] | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [label, setLabel] = useState('');
  const [minutes, setMinutes] = useState(240);
  const [picked, setPicked] = useState<string[]>([]);
  const [minted, setMinted] = useState<GuestSessionRow | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try { setRows(await listGuests()); } catch { /* backend offline */ }
  };
  useEffect(() => {
    void refresh();
    getModels().then(m => setModels(m.map(x => x.id))).catch(() => {});
  }, []);

  const create = async () => {
    if (!label.trim() || picked.length === 0) return;
    setBusy(true); setMsg('');
    try {
      const row = await mintGuest(label.trim(), minutes, picked);
      setMinted(row);
      setLabel(''); setPicked([]);
      await refresh();
    } catch (e) { setMsg(String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  };

  const revoke = async (g: GuestSessionRow) => {
    if (!window.confirm(
      `Revoke "${g.label}"?\n\nTheir access stops immediately and everything `
      + `they asked Nova to remember is deleted.`)) return;
    // A failed wipe is a 500 carrying the directory that survived — surfaced
    // verbatim, because "revoked" with files still on disk is precisely the
    // outcome that must never read as success.
    try { await revokeGuest(g.id); await refresh(); }
    catch (e) { setMsg(String((e as Error).message ?? e)); }
  };

  const remove = async (g: GuestSessionRow) => {
    if (!window.confirm(
      `Delete "${g.label}" entirely?\n\nThis removes the link, their whole `
      + `conversation, and their notes.`)) return;
    try { await deleteGuest(g.id); await refresh(); }
    catch (e) { setMsg(String((e as Error).message ?? e)); }
  };

  const toggle = (m: string) =>
    setPicked(p => p.includes(m) ? p.filter(x => x !== m) : [...p, m]);

  // Built from the funnelled hostname the operator is actually on when they
  // open this over tailscale, and from wherever they are otherwise. Not
  // hardcoded: the guest page is same-origin with this one by construction.
  const linkFor = (token: string) =>
    `${window.location.origin}/guest#token=${encodeURIComponent(token)}`;

  return (
    <div className="rounded-lg border border-stone-700/70 bg-stone-800/40 px-3 py-2.5 space-y-3">
      <div>
        <div className="text-sm text-stone-200">Guest access</div>
        <div className="text-xs text-stone-500">
          A time-boxed link that gets chat, web search, and a private notebook
          &mdash; nothing else. Guests cannot reach settings, secrets, files,
          your conversation, or any tool that changes something. Their notes
          live in their own space and are deleted the moment you revoke them.
        </div>
      </div>

      {minted?.token && (
        <div className="rounded border border-teal-800/60 bg-teal-950/30 p-2.5 space-y-1.5">
          <div className="text-xs text-teal-300">
            Copy this now &mdash; it is never shown again.
          </div>
          <input
            readOnly
            value={linkFor(minted.token)}
            onFocus={e => e.currentTarget.select()}
            className="w-full bg-stone-950 border border-stone-700 rounded px-2 py-1
                       text-xs font-mono text-stone-300" />
          <div className="flex gap-2">
            <button
              onClick={() => void navigator.clipboard?.writeText(linkFor(minted.token!))}
              className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-2 py-1">
              Copy link
            </button>
            <button onClick={() => setMinted(null)}
              className="text-xs text-stone-400 hover:text-stone-200 px-2 py-1">
              Done
            </button>
          </div>
          <div className="text-[11px] text-stone-500">
            To reach it from outside your tailnet, the funnelled port is
            :10000 &mdash; swap the port in the link above.
          </div>
        </div>
      )}

      <div className="space-y-2 border-t border-stone-700/60 pt-2.5">
        <div className="flex gap-2">
          <input
            value={label} onChange={e => setLabel(e.target.value)}
            placeholder="Who is this for?"
            className="flex-1 bg-stone-900 border border-stone-700 rounded px-2 py-1 text-sm" />
          <select
            value={minutes} onChange={e => setMinutes(Number(e.target.value))}
            className="bg-stone-900 border border-stone-700 rounded px-2 py-1 text-sm">
            {PRESETS.map(p => <option key={p.minutes} value={p.minutes}>{p.label}</option>)}
          </select>
        </div>
        <div>
          <div className="text-xs text-stone-500 mb-1">
            Models this guest may use (at least one)
          </div>
          <div className="max-h-40 overflow-y-auto nice-scroll flex flex-wrap gap-1.5">
            {models.length === 0 && (
              <span className="text-xs text-stone-600">no models available</span>
            )}
            {models.map(m => (
              <button key={m} onClick={() => toggle(m)}
                className={'text-xs rounded px-2 py-1 border '
                  + (picked.includes(m)
                    ? 'bg-teal-800/50 border-teal-700 text-teal-200'
                    : 'bg-stone-900 border-stone-700 text-stone-400 hover:text-stone-200')}>
                {m}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={() => void create()}
          disabled={busy || !label.trim() || picked.length === 0}
          className="bg-teal-700 hover:bg-teal-600 disabled:opacity-40 text-white
                     rounded px-3 py-1.5 text-sm">
          Create guest link
        </button>
      </div>

      {msg && <div className="text-xs text-amber-400">{msg}</div>}

      <div className="border-t border-stone-700/60 pt-2 space-y-1.5">
        {rows === null ? (
          <div className="text-xs text-stone-600">loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-stone-600">No guest links yet.</div>
        ) : rows.map(g => (
          <div key={g.id} className="flex items-center gap-2 text-xs">
            <div className="flex-1 min-w-0">
              <div className="text-stone-300 truncate">{g.label}</div>
              <div className="text-stone-500 truncate">
                {statusOf(g)} &middot; {g.allowed_models.join(', ')}
                {g.last_seen ? ` · last seen ${when(g.last_seen)}` : ' · never used'}
              </div>
            </div>
            {!g.revoked_at && (
              <button onClick={() => void revoke(g)}
                className="text-amber-400 hover:text-amber-300 px-1.5 py-1">
                Revoke
              </button>
            )}
            <button onClick={() => void remove(g)}
              className="text-stone-500 hover:text-red-400 px-1.5 py-1">
              Delete
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
