/** The one question the operator has to answer before a retitle lands.
 *
 *  Not `window.confirm`: there are three outcomes rather than two, and the
 *  referrer list is the whole point — "60 links in 60 notes" is a number you
 *  can wave past, while a scrollable list of the notes about to be rewritten
 *  is a thing you look at.
 *
 *  Both actions are reversible by doing the opposite, which is why this is a
 *  dialog and not a typed confirmation phrase like the restore path uses.
 */

import { LinkPlan } from './api';

export function LinkPlanDialog({ plan, busy, onChoose, onCancel }: {
  plan: LinkPlan;
  busy: boolean;
  onChoose: (mode: 'retarget' | 'unlink') => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-stone-700 bg-stone-900
                   shadow-2xl p-4 space-y-3"
        role="dialog"
        aria-modal="true"
        aria-label="This title has inbound links"
        onClick={e => e.stopPropagation()}
      >
        <div className="text-sm text-stone-100">The title changed.</div>

        <div className="text-xs text-stone-400 leading-relaxed">{plan.message}</div>

        <div className="rounded border border-stone-800 bg-stone-950/60 p-2 text-[11px] font-mono">
          <div className="text-stone-500">
            <span className="text-stone-300">{plan.old_title}</span>
            {' → '}
            <span className="text-teal-300">{plan.new_title}</span>
          </div>
        </div>

        <div className="max-h-40 overflow-auto nice-scroll rounded border border-stone-800
                        bg-stone-950/40 p-2 text-[11px] font-mono text-stone-400 space-y-0.5">
          {plan.referrers.map(rf => (
            <div key={rf.doc_id} className="flex justify-between gap-2">
              <span className="truncate">{rf.doc_id}</span>
              <span className="shrink-0 text-stone-600">{rf.count}</span>
            </div>
          ))}
          {plan.notes > plan.referrers.length && (
            <div className="text-stone-600">
              …and {plan.notes - plan.referrers.length} more
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button onClick={onCancel} disabled={busy}
            className="px-2.5 py-1 text-xs rounded border border-stone-700
                       text-stone-300 hover:bg-stone-800 disabled:opacity-40">
            Cancel
          </button>
          <button onClick={() => onChoose('unlink')} disabled={busy}
            title="The links become the plain text they already displayed"
            className="px-2.5 py-1 text-xs rounded border border-stone-700
                       text-stone-300 hover:bg-stone-800 disabled:opacity-40">
            Turn them into text
          </button>
          <button onClick={() => onChoose('retarget')} disabled={busy}
            className="px-2.5 py-1 text-xs rounded bg-teal-700 hover:bg-teal-600
                       text-white disabled:bg-stone-800 disabled:text-stone-500">
            {busy ? 'moving…' : `Move ${plan.occurrences} link${plan.occurrences === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
