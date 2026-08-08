import { useEffect, useState } from 'react';
import {
  SpendCeilings, SpendOverview, SpendTokensRollup,
  getSpend, getSpendTokens, patchSpendCeilings,
} from '../api';
import {
  ceilingPct, firstSentence, fmtTokens, rollupBySourceModel,
} from '../observability';
import { fmtDateTime } from '../time';

/** The improve lane's spend, in the Observability board next to Turns & cost.
 *
 *  This is the surface for "why did no pass start": today's charges against
 *  the three ceilings, the escalating wall backoff AS A TIME rather than a
 *  streak counter, and the heartbeat preflight's five gates — the backend's
 *  own sentences, never restated. The ceilings are the only thing here an
 *  operator can change; everything else is a reading. */

const POLL_MS = 30_000;

function CeilingMeter({ label, used, max, fmt }: {
  label: string; used: number; max: number | null;
  fmt: (n: number) => string;
}) {
  const p = ceilingPct(used, max);
  const color = p == null ? 'bg-stone-600'
    : p >= 100 ? 'bg-red-500' : p >= 75 ? 'bg-amber-500' : 'bg-teal-500';
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[11px]">
        <span className="text-stone-400">{label}</span>
        <span className="text-stone-300 font-mono">
          {fmt(used)} / {max == null ? '—' : fmt(max)}
        </span>
      </div>
      <div className="h-2.5 rounded bg-stone-800 overflow-hidden">
        <div className={`h-full ${color} transition-[width] duration-500`}
          style={{ width: `${p ?? 0}%` }} />
      </div>
    </div>
  );
}

/** Edit the three ceilings in place. PATCH sends only the fields that
 *  changed; the backend refuses non-numbers, negatives and an empty patch,
 *  and its `detail` sentence is shown verbatim. */
function CeilingEditor({ lane, ceilings, onSaved }: {
  lane: string; ceilings: SpendCeilings;
  onSaved: (c: SpendCeilings) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ passes: '', tokens: '', usd: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const begin = () => {
    setDraft({
      passes: String(ceilings.max_passes),
      tokens: String(ceilings.max_tokens),
      usd: String(ceilings.max_usd),
    });
    setErr('');
    setOpen(true);
  };

  const save = async () => {
    const patch: Record<string, number | string> = { lane };
    const num = (s: string) => (s.trim() === '' ? NaN : Number(s));
    const p = num(draft.passes), t = num(draft.tokens), u = num(draft.usd);
    if (p !== ceilings.max_passes) patch.max_passes = p;
    if (t !== ceilings.max_tokens) patch.max_tokens = t;
    if (u !== ceilings.max_usd) patch.max_usd = u;
    if (Object.keys(patch).length === 1) { setOpen(false); return; }
    setBusy(true);
    try {
      onSaved(await patchSpendCeilings(patch));
      setOpen(false);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button onClick={begin}
        className="text-[11px] text-stone-500 hover:text-teal-400"
        title={ceilings.updated_at
          ? `Last set ${fmtDateTime(ceilings.updated_at)} by ${ceilings.updated_by}`
          : undefined}>
        edit ceilings
      </button>
    );
  }
  const field = (label: string, key: keyof typeof draft) => (
    <label className="flex items-center gap-1 text-[11px] text-stone-500">
      {label}
      <input
        className="w-24 bg-stone-900 border border-stone-700 rounded px-1.5 py-0.5 text-[11px] text-stone-200 font-mono"
        value={draft[key]}
        onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))} />
    </label>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      {field('passes', 'passes')}
      {field('tokens', 'tokens')}
      {field('usd', 'usd')}
      <button onClick={save} disabled={busy}
        className="text-[11px] px-2 py-0.5 rounded bg-teal-700/80 hover:bg-teal-700 text-white disabled:opacity-50">
        {busy ? '…' : 'save'}
      </button>
      <button onClick={() => setOpen(false)} className="text-[11px] text-stone-500">
        cancel
      </button>
      {err && <span className="text-[11px] text-red-400">{err}</span>}
    </div>
  );
}

export function SpendCard() {
  const [spend, setSpend] = useState<SpendOverview | null>(null);
  const [rollup, setRollup] = useState<SpendTokensRollup | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    const load = () => {
      getSpend('improve', 20)
        .then(s => { if (on) { setSpend(s); setErr(null); } })
        .catch(e => { if (on) setErr(String(e)); });
      getSpendTokens(7)
        .then(r => { if (on) setRollup(r); })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => { on = false; clearInterval(id); };
  }, []);

  if (err) {
    return (
      <section>
        <h3 className="text-xs uppercase tracking-wide text-stone-500 mb-2">Spend</h3>
        <div className="text-xs text-red-400">{err}</div>
      </section>
    );
  }
  if (!spend) return null;

  const { today, hold, improve, ceilings } = spend;
  const bySrcModel = rollup ? rollupBySourceModel(rollup.rows) : [];

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs uppercase tracking-wide text-stone-500">
          Spend — {spend.lane} lane
        </h3>
        {ceilings && (
          <CeilingEditor lane={spend.lane} ceilings={ceilings}
            onSaved={c => setSpend(s => (s ? { ...s, ceilings: c } : s))} />
        )}
      </div>

      {spend.ceilings_error && (
        <div className="text-xs text-red-400 border border-red-900/60 bg-red-950/30 rounded px-3 py-2 mb-2">
          Ceilings unreadable: {spend.ceilings_error}
        </div>
      )}

      {/* Today against the three ceilings */}
      <div className="grid md:grid-cols-3 gap-x-6 gap-y-3 mb-3">
        <CeilingMeter label="Passes today" used={today.passes}
          max={ceilings?.max_passes ?? null} fmt={n => String(n)} />
        <CeilingMeter label="Tokens today" used={today.tokens}
          max={ceilings?.max_tokens ?? null} fmt={fmtTokens} />
        <CeilingMeter label="Spend today" used={today.usd}
          max={ceilings?.max_usd ?? null} fmt={n => `$${n.toFixed(2)}`} />
      </div>
      {today.unmetered > 0 && (
        <p className="text-[11px] text-amber-500/80 mb-2">
          {today.unmetered} of today&apos;s {today.entries} ledger entries carry
          no token figures — these totals are a floor, not a measurement.
        </p>
      )}

      {/* The wall, as a time. hold.reason is the backend's full sentence. */}
      {hold.held && (
        <div className="rounded-lg border border-amber-900/70 bg-amber-950/20 px-3 py-2 mb-2">
          <div className="text-xs text-amber-300">
            Held until {hold.held_until ? fmtDateTime(hold.held_until) : '—'}
            {' '}— {hold.wall} wall
            {hold.streak > 1 && `, hit ${hold.streak} times in a row`}
          </div>
          {hold.reason && (
            <p className="text-[11px] text-stone-400 mt-1 whitespace-pre-wrap">{hold.reason}</p>
          )}
        </div>
      )}
      {!hold.held && hold.last_refusal && (
        <p className="text-[11px] text-stone-500 mb-2"
          title={hold.last_refusal.operator_note ?? undefined}>
          Not held. Last provider refusal: {hold.last_refusal.wall}
          {hold.last_refusal.reason && ` (${hold.last_refusal.reason})`}
          {' '}at {fmtDateTime(hold.last_refusal.at)}.
        </p>
      )}

      {/* Would the next heartbeat tick start a pass — first-class, not a log line */}
      <div className="rounded-lg border border-stone-700/70 bg-stone-800/40 px-3 py-2 mb-3">
        <div className={`text-xs ${improve.would_start ? 'text-teal-300' : 'text-amber-300'}`}
          title={improve.reason}>
          {improve.would_start ? 'Next tick would start a pass' : 'Next tick would not start'}
          {' '}— {firstSentence(improve.reason)}
        </div>
        <div className="mt-1.5 space-y-0.5">
          {improve.checks.map(c => (
            <div key={c.check} className="flex items-start gap-2 text-[11px]" title={c.note}>
              <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${
                c.ok ? 'bg-teal-500' : 'bg-amber-500'}`} />
              <span className="text-stone-400 font-mono w-16 shrink-0">{c.check}</span>
              <span className="text-stone-500 truncate">{firstSentence(c.note, 120)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* The goals paying for it */}
      {spend.goals.length > 0 && (
        <div className="mb-3 space-y-0.5">
          {spend.goals.map(g => (
            <div key={g.id} className="flex items-baseline justify-between gap-3 text-[11px]">
              <span className="truncate text-stone-400">
                {g.title}
                <span className="text-stone-600"> · {g.status}</span>
              </span>
              <span className="shrink-0 font-mono text-stone-500"
                title={g.last_refund_reason ?? undefined}>
                {g.actions_used}/{g.max_actions} used
                {g.refunds > 0 && (
                  <span className="text-amber-500/80"> · {g.refunds} refunded</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 7-day tokens by source × model */}
      {rollup && bySrcModel.length > 0 && (
        <div className="rounded-lg border border-stone-700/70 overflow-x-auto nice-scroll mb-3">
          <table className="w-full min-w-[30rem] text-[11px]">
            <thead className="text-stone-500 bg-stone-800/40">
              <tr>
                <th className="text-left font-normal px-3 py-1.5">source</th>
                <th className="text-left font-normal px-3 py-1.5">model</th>
                <th className="text-right font-normal px-3 py-1.5">calls</th>
                <th className="text-right font-normal px-3 py-1.5">prompt</th>
                <th className="text-right font-normal px-3 py-1.5">completion</th>
                <th className="text-right font-normal px-3 py-1.5">tokens · {rollup.days}d</th>
              </tr>
            </thead>
            <tbody className="font-mono text-stone-300">
              {bySrcModel.map(r => (
                <tr key={`${r.source} ${r.model}`} className="border-t border-stone-800">
                  <td className="px-3 py-1">{r.source}</td>
                  <td className="px-3 py-1 truncate max-w-[14rem]" title={r.model}>{r.model}</td>
                  <td className="px-3 py-1 text-right"
                    title={r.unmetered_calls
                      ? `${r.unmetered_calls} call(s) carried no token figures`
                      : undefined}>
                    {r.calls}
                    {r.unmetered_calls > 0 && (
                      <span className="text-amber-500/80"> ({r.unmetered_calls} unmetered)</span>
                    )}
                  </td>
                  <td className="px-3 py-1 text-right">{fmtTokens(r.prompt_tokens)}</td>
                  <td className="px-3 py-1 text-right">{fmtTokens(r.completion_tokens)}</td>
                  <td className="px-3 py-1 text-right">{fmtTokens(r.tokens)}</td>
                </tr>
              ))}
              <tr className="border-t border-stone-700 text-stone-400">
                <td className="px-3 py-1" colSpan={2}>total</td>
                <td className="px-3 py-1 text-right"
                  title={rollup.totals.unmetered_calls
                    ? `${rollup.totals.unmetered_calls} call(s) carried no token figures`
                    : undefined}>
                  {rollup.totals.calls}
                </td>
                <td className="px-3 py-1 text-right">{fmtTokens(rollup.totals.prompt_tokens)}</td>
                <td className="px-3 py-1 text-right">{fmtTokens(rollup.totals.completion_tokens)}</td>
                <td className="px-3 py-1 text-right">{fmtTokens(rollup.totals.tokens)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Recent ledger entries */}
      {spend.entries.length > 0 && (
        <div className="max-h-48 overflow-y-auto nice-scroll space-y-0.5">
          {spend.entries.map(e => (
            <div key={e.id} className="flex items-baseline gap-2 text-[11px]"
              title={e.kind === 'provider_refusal'
                ? (e.operator_note ?? e.refusal_reason ?? undefined) : undefined}>
              <span className="shrink-0 font-mono text-stone-600 w-20">{e.day}</span>
              <span className={`shrink-0 w-28 ${
                e.kind === 'provider_refusal' ? 'text-amber-400/90' : 'text-stone-400'}`}>
                {e.kind === 'provider_refusal'
                  ? `refused: ${e.wall ?? '?'}` : e.kind.replace('_', ' ')}
              </span>
              <span className="flex-1 min-w-0 truncate font-mono text-stone-500">
                {e.model || '—'}
              </span>
              <span className="shrink-0 font-mono text-stone-500">
                {e.metered && e.tokens_in != null
                  ? `${fmtTokens((e.tokens_in ?? 0) + (e.tokens_out ?? 0))} tok`
                  : e.kind === 'provider_refusal' ? (e.refusal_reason ?? '') : 'unmetered'}
                {e.usd != null && e.usd > 0 && ` · $${e.usd.toFixed(4)}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
