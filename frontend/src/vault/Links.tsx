/** What points here, what this points at, and what points nowhere.
 *
 *  All three come from the graph payload the Vault already holds: `link` edges
 *  are directed and both endpoints are already resolved server-side, so
 *  inbound is `edges.where(target == me)` and outbound is the mirror. The
 *  dangling list comes from `/api/v1/files/read`, which computes it with the
 *  same `links.py` the rewriter uses.
 *
 *  The header's `inbound_links` count and this panel's length legitimately
 *  differ: the header counts OCCURRENCES (it is the blast radius of a retitle,
 *  and a note that links twice costs two rewrites) while this counts NOTES.
 *  The labels say which, rather than quietly showing two numbers.
 */

import type { VaultIndex } from './graph/model';

function Section({ title, note, children }: {
  title: string; note?: string; children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] uppercase tracking-wide text-stone-500">{title}</span>
        {note && <span className="text-[10px] text-stone-600">{note}</span>}
      </div>
      {children}
    </div>
  );
}

function Rows({ ids, index, onOpen }: {
  ids: string[]; index: VaultIndex; onOpen: (docId: string) => void;
}) {
  if (!ids.length) return <div className="text-[11px] text-stone-600 px-1">None.</div>;
  return (
    <div className="space-y-0.5">
      {ids.map(id => {
        const n = index.byId.get(id);
        return (
          <button
            key={id}
            onClick={() => onOpen(id)}
            className="w-full text-left px-1.5 py-1 rounded hover:bg-stone-800/60 group"
          >
            <div className="text-[12px] text-stone-300 group-hover:text-teal-200 truncate">
              {n?.label ?? id}
            </div>
            <div className="text-[10px] font-mono text-stone-600 truncate">{id}</div>
          </button>
        );
      })}
    </div>
  );
}

export function Links({ index, docId, inboundCount, dangling, indexed, onOpen }: {
  index: VaultIndex | null;
  /** null when the open file is not a memory note — Workspace has no titles. */
  docId: string | null;
  /** From `FileRead.inbound_links` — occurrences, not notes. */
  inboundCount?: number;
  dangling?: string[];
  /** False for a root with no link namespace at all. */
  indexed: boolean;
  onOpen: (docId: string) => void;
}) {
  if (!indexed) {
    return (
      <div className="text-[11px] text-stone-500 leading-relaxed px-1 py-2">
        Workspace files are ordinary files. They have no frontmatter, so they
        have no titles — and a <code className="text-stone-400">[[link]]</code> written
        here would never be rewritten when a note is retitled, so nothing links
        to them and they link to nothing.
      </div>
    );
  }
  if (!index || !docId) {
    return <div className="text-[11px] text-stone-600 px-1 py-2">Open a note to see its links.</div>;
  }

  const inbound = index.inbound.get(docId) ?? [];
  const outbound = index.outbound.get(docId) ?? [];
  const occ = inboundCount ?? 0;

  return (
    <div className="space-y-3 px-1 py-1">
      <Section
        title={`Linked from (${inbound.length})`}
        note={occ && occ !== inbound.length ? `${occ} occurrences` : undefined}
      >
        <Rows ids={inbound} index={index} onOpen={onOpen} />
      </Section>

      <Section title={`Links to (${outbound.length})`}>
        <Rows ids={outbound} index={index} onOpen={onOpen} />
      </Section>

      {!!dangling?.length && (
        <Section title={`Unresolved (${dangling.length})`}>
          <div className="space-y-0.5">
            {dangling.map(d => (
              <div key={d} className="px-1.5 py-1 text-[11px] text-amber-400/80 truncate"
                title={`No note is titled “${d}”`}>
                [[{d}]]
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
