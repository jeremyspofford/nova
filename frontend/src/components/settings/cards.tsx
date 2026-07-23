import { useState, useEffect } from 'react';
import {
  SettingDef, getStorageInfo, getAuthToken, getServerToken, StorageInfo as StorageInfoData,
} from '../../api';
import qrcode from 'qrcode-generator';

/** Where memory physically lives — shown and verified in the UI; changing
 *  it is the ONE deployment-time setting (a docker bind mount can't be
 *  remounted from inside the container it serves). */
export function StorageCard() {
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
export function PhoneSetupCard({ defs }: { defs: SettingDef[] }) {
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
