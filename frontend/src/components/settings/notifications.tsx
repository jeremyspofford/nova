import { useState, useEffect } from 'react';
import {
  SettingDef, getNotifyReachability, getNotifyService, notifyServiceAction,
} from '../../api';
import type { NotifyReachability, NotifyService } from '../../api';

/** ntfy topic input with a Randomize button — on a public/shared server the
 *  topic name is the only secret, so an easy way to mint a long unguessable
 *  one matters. */
export function NtfyTopicField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
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
export function NotifyServiceControl({ defs }: { defs: SettingDef[] }) {
  const [svc, setSvc] = useState<NotifyService | null>(null);
  const [busy, setBusy] = useState(false);
  const val = (k: string) => String(defs.find(d => d.key === k)?.value ?? '');

  const refresh = () => getNotifyService().then(setSvc).catch(() => setSvc(null));
  useEffect(() => { refresh(); }, []);

  if (val('notify.provider') !== 'ntfy' || val('notify.ntfy.server_mode') !== 'builtin'
      || !svc?.available) return null;

  const running = !!svc.ntfy?.running;
  const exposed = !!svc.tailnet_route;
  const act = async (action: 'up' | 'down' | 'expose') => {
    setBusy(true);
    try {
      await notifyServiceAction(action);
      // the sidecar op runs async — poll a few times to reflect the new state
      for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 2500)); await refresh(); }
    } catch { /* leave state; a recheck will catch up */ }
    finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg border border-stone-700/70 bg-stone-800/40 p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
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
      {running && !exposed && (
        <div className="flex items-center justify-between gap-3 pt-1 border-t border-stone-700/60">
          <div className="text-xs text-amber-400 min-w-0">
            Not exposed on your tailnet — your phone can't reach it yet.
          </div>
          <button onClick={() => act('expose')} disabled={busy}
            className="shrink-0 text-xs px-2.5 py-1 rounded bg-stone-800 border border-stone-700 text-stone-200 hover:border-teal-600 disabled:opacity-50">
            Apply route
          </button>
        </div>
      )}
    </div>
  );
}

/** Read-only status of the notification delivery path — turns "is this even
 *  wired?" from invisible into a row of dots, and shows the exact URL + topic
 *  the phone needs. Refreshes when a notify setting changes. */
export function NotificationsReachability() {
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
export function NotificationsHelp({ defs }: { defs: SettingDef[] }) {
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
