import { useState, useEffect } from 'react';
import { getHomeAssistant, homeAssistantAction } from '../../api';
import type { HomeAssistantStatus } from '../../api';

/** Home Assistant start/stop — roadmap #35.
 *
 *  This control is not decoration around Nova's approved plan: it is what
 *  MAKES that plan legal. `actions.assert_routes_exist()` refuses to boot the
 *  backend unless every action type names an operator route that exists, and
 *  the rule it enforces is "an executor may only exist where the operator can
 *  already do this from the UI". Delete this and the button below stops
 *  working; delete the route and the backend stops starting.
 */
export function HomeAssistantControl() {
  const [ha, setHa] = useState<HomeAssistantStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => getHomeAssistant().then(setHa).catch(() => setHa(null));
  useEffect(() => { refresh(); }, []);

  const running = !!ha?.running;
  const act = async (action: 'up' | 'down') => {
    setBusy(true);
    try {
      await homeAssistantAction(action);
      // The sidecar accepts and works on its own thread; a first `up` pulls
      // ~1.5GB, so poll well past the point a fast start would settle rather
      // than showing "Stopped" next to a container that is busy downloading.
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 5000));
        await refresh();
      }
    } catch { /* leave state; the next refresh catches up */ }
    finally { setBusy(false); }
  };

  if (!ha) return null;

  return (
    <div className="rounded-lg border border-stone-700/70 bg-stone-800/40 p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-stone-200">Home Assistant</div>
          <div className="text-xs text-stone-500">
            {busy ? 'working — first start pulls the image, this takes a few minutes…'
              : running ? 'Running' : ha.present ? 'Stopped' : 'Not installed yet'}
          </div>
        </div>
        <button onClick={() => act(running ? 'down' : 'up')} disabled={busy}
          className="shrink-0 text-sm px-3 py-1.5 rounded bg-stone-800 border border-stone-700 text-stone-200 hover:border-teal-600 disabled:opacity-50">
          {busy ? '…' : running ? 'Stop' : 'Start'}
        </button>
      </div>

      {running && ha.url && (
        <div className="pt-1 border-t border-stone-700/60 text-xs">
          <a href={ha.url} target="_blank" rel="noreferrer"
            className="text-teal-400 hover:underline">{ha.url}</a>
          <span className="text-stone-500"> — also reachable over your tailnet.</span>
        </div>
      )}

      {ha.error && (
        <div className="pt-1 border-t border-stone-700/60 text-xs text-amber-400">
          {ha.error}
        </div>
      )}

      {/* The limit belongs here, not in the first support conversation.
          #35 locked IP-only scope deliberately. */}
      <div className="text-xs text-stone-500 pt-1 border-t border-stone-700/60">
        Controls IP-addressable devices. No mDNS/SSDP discovery and no
        Zigbee/Z-Wave — it runs on the compose bridge rather than your LAN, and
        USB radios aren't passed through under WSL2. A dedicated Home Assistant
        box is the answer when you need those.
      </div>
    </div>
  );
}
