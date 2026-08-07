import { useEffect, useState } from 'react';
import {
  BackupBundle, BackupsResponse, createBackup, decideRecCard, getBackups,
  revealSecret, verifyBackup,
} from '../../api';
import { CardsSkeleton } from '../ui';

/** Settings → Backups (roadmap #31).
 *
 *  Two things this surface must be honest about, because a backup UI that
 *  is cheerful is worse than none:
 *
 *  - WHAT IS NOT IN THE BUNDLE. Every excluded tier is listed with its
 *    reason, so nobody reads "backup complete" as "everything is safe".
 *  - WHY A BACKUP CANNOT BE MADE. When coverage refuses, the button is
 *    disabled and the unaccounted-for thing is named. The refusal means
 *    something on this stack is not classified, and shipping a bundle
 *    anyway would be shipping one that will be trusted.
 *
 *  Restore-in-place is deliberately absent: it replaces the database and
 *  overwrites files, and it belongs behind a considered flow rather than a
 *  button next to "create". Verifying a bundle — restoring it into a
 *  throwaway database and dropping it — is here, because that is the thing
 *  that turns a backup from a hope into a fact.
 */

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtStamp(s: string): string {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return s;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
    .toLocaleString();
}

export function BackupsCard() {
  const [data, setData] = useState<BackupsResponse | null>(null);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState('');
  const [showCoverage, setShowCoverage] = useState(false);
  const [verified, setVerified] = useState<Record<string, string>>({});
  const [phrase, setPhrase] = useState<string | null>(null);

  async function load() {
    try { setData(await getBackups()); } catch (e) { setStatus(String(e)); }
  }
  useEffect(() => { void load(); }, []);

  async function make() {
    setBusy('create'); setStatus('');
    try {
      const m = await createBackup();
      setStatus(`Backed up ${fmtBytes(m.bytes)} across ${m.members.length} parts.`);
      await load();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
    setBusy('');
  }

  async function check(b: BackupBundle) {
    const name = b.path.split('/').pop()!;
    setBusy(name); setStatus('');
    try {
      const r = await verifyBackup(name);
      // Three ways restored_ok comes back false: the migration gate refused
      // (missing_tables is EMPTY then, so "missing " alone named no reason),
      // tables are structurally absent, or an old backend sent neither field.
      setVerified(v => ({ ...v, [name]: r.restored_ok
        ? `restores: ${r.tables} tables, ${r.rows.toLocaleString()} rows`
        : `DID NOT RESTORE — ${r.migration_refusal
          ?? (r.missing_tables?.length
            ? `missing ${r.missing_tables.join(', ')}`
            : 'no reason reported')}` }));
    } catch (e) {
      setVerified(v => ({ ...v, [name]: e instanceof Error ? e.message : String(e) }));
    }
    setBusy('');
  }

  if (!data) {
    // load() fails into status, but this branch renders first — without the
    // check a failed getBackups() was a skeleton forever, error invisible.
    if (status) return (
      <div className="rounded-lg border border-stone-700 bg-stone-800/50 p-3 space-y-2">
        <div className="text-sm text-stone-200">Backups</div>
        <div className="rounded border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">
          {status}
        </div>
      </div>
    );
    return <CardsSkeleton n={1} />;
  }
  const cov = data.coverage;
  const enc = data.encryption;
  const blocked = !data.store_ok || !cov.may_snapshot;

  return (
    <div className="rounded-lg border border-stone-700 bg-stone-800/50 p-3 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm text-stone-200">Backups</div>
          <div className="text-xs text-stone-500 mt-0.5">
            One bundle holds the database, the memory tree, your documents and
            the keys. It is written only after it has been read back and
            checked, so a bundle that appears here is one that verified.
          </div>
        </div>
        <button
          onClick={() => void make()}
          disabled={blocked || busy === 'create'}
          className="shrink-0 text-xs bg-teal-700 hover:bg-teal-600 disabled:bg-stone-700 disabled:text-stone-500 text-white rounded px-3 py-1.5"
        >
          {busy === 'create' ? 'backing up…' : 'back up now'}
        </button>
      </div>

      {!data.store_ok && (
        <div className="rounded border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">
          {data.store_error}
        </div>
      )}

      {/* The passphrase panel. Bundles are encrypted; the passphrase Nova
          holds is stored INSIDE what it encrypts, so until the operator
          confirms an off-machine copy, this stays amber and a card stands
          in the inbox. Confirming here IS deciding that card — one fact,
          one place. */}
      {enc && enc.state !== 'unknown' && (
        <div className={`rounded border p-2 space-y-1.5 ${
          enc.state === 'confirmed'
            ? 'border-stone-700/60 bg-stone-900/40'
            : 'border-amber-900 bg-amber-950/30'}`}>
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-stone-300">
              Backups are encrypted
              {enc.state === 'unset'
                ? ' — the passphrase is generated at the first backup.'
                : ` (passphrase ${enc.fingerprint ?? '?'}, source: ${enc.source}).`}
            </div>
            {enc.state !== 'unset' && (
              <button
                onClick={() => void (async () => {
                  if (phrase) { setPhrase(null); return; }
                  try { setPhrase(await revealSecret(enc.secret_name ?? 'backup-passphrase')); }
                  catch (e) { setStatus(e instanceof Error ? e.message : String(e)); }
                })()}
                className="shrink-0 text-[11px] px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200"
              >
                {phrase ? 'hide' : 'reveal'}
              </button>
            )}
          </div>
          {phrase && (
            <div className="text-xs font-mono text-stone-200 bg-stone-950/60 rounded px-2 py-1 break-all select-all">
              {phrase}
            </div>
          )}
          {enc.state === 'unconfirmed' && (
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] text-amber-400/90">
                Nova&apos;s copy lives inside the bundles it opens. Write the
                passphrase down somewhere that is not this machine — then
                confirm.
              </div>
              {enc.card_id && (
                <button
                  onClick={() => void (async () => {
                    try {
                      await decideRecCard(enc.card_id!, 'approve');
                      setStatus('Recorded — thank you. The reminder is gone.');
                      await load();
                    } catch (e) {
                      setStatus(e instanceof Error ? e.message : String(e));
                    }
                  })()}
                  className="shrink-0 text-[11px] px-2 py-0.5 rounded bg-teal-700 hover:bg-teal-600 text-white"
                >
                  I recorded it off-machine
                </button>
              )}
            </div>
          )}
          {enc.state === 'declined' && (
            <div className="text-[11px] text-stone-500">
              You dismissed the off-machine reminder. If this machine dies
              with the only copy, the bundles die with it.
            </div>
          )}
          {enc.state === 'confirmed' && (
            <div className="text-[11px] text-teal-500">
              Off-machine copy confirmed. A restore needs only a bundle and
              this passphrase — <span className="font-mono">python3 nova_restore.py &lt;bundle&gt;</span>.
            </div>
          )}
        </div>
      )}

      {cov.refusals.length > 0 && (
        <div className="rounded border border-amber-900 bg-amber-950/30 p-2 space-y-1">
          <div className="text-xs text-amber-300">
            No backup can be made: {cov.refusals.length} thing
            {cov.refusals.length === 1 ? ' is' : 's are'} unaccounted for. A
            bundle that quietly skips something is worse than none, so this
            refuses rather than guessing.
          </div>
          {cov.refusals.map(r => (
            <div key={r.subject} className="text-[11px] text-amber-400/80">
              <span className="font-mono">{r.subject}</span> — {r.detail}
            </div>
          ))}
        </div>
      )}

      <div>
        <button
          onClick={() => setShowCoverage(v => !v)}
          className="text-[11px] text-stone-400 hover:text-stone-200"
        >
          {showCoverage ? '▾' : '▸'} what a backup contains
          {' '}({cov.entries.filter(e => e.included).length} in,{' '}
          {cov.entries.filter(e => !e.included).length} out)
        </button>
        {showCoverage && (
          <div className="mt-1.5 space-y-1">
            {cov.entries.map(e => (
              <div key={`${e.kind}:${e.name}`} className="text-[11px] flex gap-2">
                <span className={`shrink-0 w-10 ${e.included ? 'text-teal-400' : 'text-stone-600'}`}>
                  {e.included ? 'in' : 'out'}
                </span>
                <span className="font-mono text-stone-400 shrink-0 max-w-[13rem] truncate"
                  title={e.name}>{e.name.split('/').slice(-2).join('/')}</span>
                <span className="text-stone-600">{e.reason}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        {!data.bundles.length && (
          <div className="text-xs text-stone-500">No backups yet.</div>
        )}
        {data.bundles.map(b => {
          const name = b.path.split('/').pop()!;
          return (
            <div key={b.path} className="rounded border border-stone-700/60 bg-stone-900/40 px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs text-stone-300">{fmtStamp(b.created_at)}</div>
                  <div className="text-[11px] font-mono text-stone-500">
                    {fmtBytes(b.bytes)} · {b.members} parts
                    {b.encrypted && (
                      <span className="text-teal-600"> · encrypted</span>
                    )}
                    {b.passphrase_fingerprint && enc?.fingerprint
                      && b.passphrase_fingerprint !== enc.fingerprint && (
                      <span
                        className="text-amber-400"
                        title="Sealed with a DIFFERENT passphrase than the current one — it only opens with the passphrase recorded when it was made."
                      > · older passphrase {b.passphrase_fingerprint}</span>
                    )}
                    {!b.readable && (
                      <span className="text-red-400"> · UNREADABLE: {b.problem}</span>
                    )}
                    {b.excluded.length > 0 && (
                      <span className="text-stone-600"> · without {b.excluded.length} excluded</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => void check(b)}
                  disabled={!b.readable || busy === name}
                  className="shrink-0 text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200 disabled:opacity-40"
                  title="Restore this bundle into a throwaway database and drop it — proves it is restorable without touching anything live."
                >
                  {busy === name ? 'checking…' : 'test restore'}
                </button>
              </div>
              {verified[name] && (
                <div className={`mt-1 text-[11px] ${verified[name].includes('DID NOT')
                  ? 'text-red-400' : 'text-teal-400'}`}>
                  {verified[name]}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {status && <div className="text-xs text-stone-400">{status}</div>}
      {data.offsite?.configured ? (
        <div className={`text-[11px] ${
          !data.offsite.ok || data.offsite.newest_synced === false
            ? 'text-amber-400' : 'text-stone-500'}`}>
          Off-machine copy: <span className="font-mono">{data.offsite.dir}</span>
          {' '}— {data.offsite.ok
            ? (data.offsite.newest_synced === false
              ? 'the newest bundle has NOT arrived yet'
              : `${data.offsite.bundles} bundle${data.offsite.bundles === 1 ? '' : 's'}, up to date`)
            : data.offsite.problem}
        </div>
      ) : (
        <div className="text-[11px] text-stone-600">
          Bundles live in <span className="font-mono">data/backups</span> on
          this machine only. Mount a folder that survives it (NAS/USB) into
          the backend and name it in “Off-machine bundle folder” below —
          every verified bundle is then copied and re-checked there.
        </div>
      )}
    </div>
  );
}
