/** The Vault: her notes, their links and their tags, as one surface.
 *
 *  Everything Library → Files does, plus the three questions a file manager
 *  cannot answer — what links to this, what shares its subject, and what does
 *  the whole corpus look like. It reuses `src/files/*` rather than
 *  reimplementing it, so there is ONE write path, one refusal vocabulary and
 *  one retarget dialog across both surfaces.
 *
 *  Desktop does NOT use `Surface`'s card. Three reasons, and `SettingsPage`
 *  already set the precedent for leaving it: `OverlayScrim`'s
 *  click-outside-to-close fires on any stray click in the margin, which over
 *  an editor is either a confirm you did not ask for or a silent discard; a
 *  fixed-width card cannot hold a tree, a note and a graph (the Library
 *  already had to special-case Files to `w-[64rem]`); and a translucent scrim
 *  over a live force graph is noise. The chat dock survives, because
 *  `useShellInsets().right` is exactly the width it is holding.
 *
 *  Phone DOES use `Surface` — its mobile branch already is the full-screen
 *  page, safe-area padding included, and re-deriving that is how insets rot.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Surface } from '../components/ui';
import { useIsMobile } from '../shell/useIsMobile';
import { useShellInsets } from '../shell/insets';
import { useSheetHistory } from '../shell/useSheetHistory';
import { confirmDiscard, setDirtyCount } from '../files/dirty';
import { nodeKey, type Row } from '../files/Tree';
import { useFileTree } from '../files/useFileTree';
import { Viewer } from '../files/Viewer';
import { LinkPlanDialog } from '../files/LinkPlanDialog';
import {
  FileRead, FilesRefusal, LinkPlan, LinkReceipt,
  deleteEntry, newFile, newFolder, readFile, renameEntry, writeFile,
} from '../files/api';
import { useVaultGraph } from './useVaultGraph';
import { linkKey } from './graph/model';
import { refKey, vaultUrl, type NoteRef } from './vaultRoute';
import { VaultSidebar, type SidebarMode } from './VaultSidebar';
import { GraphPane } from './GraphPane';
import { Links } from './Links';

const parentOf = (p: string) => p.split('/').slice(0, -1).join('/');
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Does `path` name the open file, or a FOLDER containing it? Same guard as
 *  FilesTab: equality alone leaves the editor holding a file that no longer
 *  exists after an ancestor is renamed or deleted. */
const hits = (open: NoteRef | null, root: string, path: string) =>
  !!open && open.root === root
  && (open.path === path || open.path.startsWith(path + '/'));

const btn = 'px-2 py-1 rounded text-[11px] border border-stone-700 text-stone-300 '
  + 'hover:bg-stone-800 disabled:opacity-40 disabled:hover:bg-transparent';

type Sheet = null | 'graph' | 'links';

export function VaultPage({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const params = useParams();
  const [search, setSearch] = useSearchParams();
  const mobile = useIsMobile();
  const { right } = useShellInsets();

  const root = params.root ?? '';
  const path = params['*'] ?? '';
  const openRef = useMemo<NoteRef | null>(
    () => (root && path ? { root, path } : null), [root, path]);

  const tag = search.get('tag');
  const globalGraph = search.get('graph') === '1';

  const [mode, setMode] = useState<SidebarMode>('files');
  const [doc, setDoc] = useState<FileRead | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<'edit' | 'preview'>('preview');
  const [status, setStatus] = useState('');
  const [receipt, setReceipt] = useState<LinkReceipt | null>(null);
  const [plan, setPlan] = useState<LinkPlan | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);

  const { index, refresh: refreshGraph, error: graphError } = useVaultGraph();

  /** Drafts survive navigation, which the Files tab never had to care about.
   *  React Router 6 without a data router has no `useBlocker`, so browser-back
   *  cannot be intercepted — and in a link-driven vault, back happens
   *  constantly. Keeping the text means only a reload or a tab close can lose
   *  it, and `beforeunload` covers those. */
  const drafts = useRef(new Map<string, string>());
  /** A wikilink or a graph node fires `readFile` far faster than a
   *  double-click does; without a token a slow first read lands after a fast
   *  second one and the editor shows the wrong file. */
  const seq = useRef(0);

  const dirty = !!doc && draft !== doc.text;

  useEffect(() => {
    if (!openRef) return;
    const k = refKey(openRef);
    if (dirty) drafts.current.set(k, draft);
    else drafts.current.delete(k);
    setDirtyCount('vault', drafts.current.size);
  }, [dirty, draft, openRef]);
  useEffect(() => () => { drafts.current.clear(); setDirtyCount('vault', 0); }, []);

  // ── opening ───────────────────────────────────────────────────────────
  const tree = useFileTree(r => goto({ root: r.root, path: r.path }));

  const loadDoc = useCallback(async (ref: NoteRef) => {
    const mine = ++seq.current;
    setStatus('');
    try {
      const d = await readFile(ref.root, ref.path);
      if (mine !== seq.current) return;
      setDoc(d);
      const saved = drafts.current.get(refKey(ref));
      setDraft(saved ?? d.text);
      setReceipt(null);
      setPlan(null);
      setView(d.editable ? 'preview' : 'preview');
    } catch (e) {
      if (mine === seq.current) { setStatus(msg(e)); setDoc(null); setDraft(''); }
    }
  }, []);

  useEffect(() => {
    if (!openRef) {
      setDoc(null);
      setDraft('');
      // `/vault/workspace` names a root without naming a file. Expanding it is
      // what makes that URL mean anything — otherwise it renders the memory
      // tree and looks like the link was ignored.
      if (root) void tree.reveal(root, '');
      return;
    }
    void loadDoc(openRef);
    void tree.reveal(openRef.root, openRef.path);
    // reveal/loadDoc are stable; re-running on tree identity would loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, path]);

  /** Every navigation the Vault owns passes through here, so the discard
   *  question is asked once and cannot be routed around. */
  const goto = useCallback((ref: NoteRef | null, q?: { tag?: string | null; graph?: boolean }) => {
    navigate(vaultUrl(ref, {
      tag: q && 'tag' in q ? q.tag : tag,
      graph: q && 'graph' in q ? q.graph : globalGraph,
    }));
    setSheet(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, tag, globalGraph]);

  const openDocId = useCallback(
    (docId: string) => goto({ root: 'memory', path: docId }), [goto]);

  /** `[[Title]]` → the note that owns that title.
   *
   *  Resolution is by frontmatter TITLE, never filename — the opposite of
   *  Obsidian's default — and `buildIndex` reproduces the backend's rule for
   *  which notes are even in the namespace. A miss is styled as dangling
   *  rather than being a dead click. */
  const openTitle = useCallback((title: string) => {
    const id = index?.byTitle.get(linkKey(title));
    if (id) openDocId(id);
  }, [index, openDocId]);

  const resolveWikilink = useCallback(
    (title: string) => !!index?.byTitle.has(linkKey(title)), [index]);

  // ── the only writer ───────────────────────────────────────────────────
  /** The only writer. Ctrl/Cmd-S and the Save button both land here, so the
   *  link question cannot be bypassed by the keyboard — and it is asked by the
   *  BACKEND, which refuses regardless of what this does. Copied from
   *  FilesTab.save(); the two surfaces have separate state but must not have
   *  separate rules. */
  async function save(opts?: { links: 'retarget' | 'unlink'; confirm_plan: string }) {
    if (!openRef || !doc) return;
    setSaving(true);
    try {
      const res = await writeFile(openRef.root, openRef.path, draft, opts);
      setDoc({ ...doc, text: draft, bytes: res.bytes, mtime: res.mtime });
      drafts.current.delete(refKey(openRef));
      setDirtyCount('vault', drafts.current.size);
      setStatus('');
      setPlan(null);
      setReceipt(res.links ?? null);
      await tree.refresh(openRef.root, parentOf(openRef.path));
      // the note's own inbound count is stale the moment its title moves
      const fresh = await readFile(openRef.root, openRef.path);
      setDoc(d => (d ? { ...d, inbound_links: fresh.inbound_links, dangling: fresh.dangling } : d));
      // the edge this save may have created does not exist in the graph the
      // panes are drawing until it is re-read
      await refreshGraph();
    } catch (e) {
      if (e instanceof FilesRefusal) { setPlan(e.detail); setStatus(''); }
      else { setPlan(null); setStatus(msg(e)); }
    } finally { setSaving(false); }
  }

  // ── file operations ───────────────────────────────────────────────────
  const sel = tree.sel;
  const selRoot = tree.selRoot;

  async function create(kind: 'file' | 'folder') {
    if (!sel) return;
    const name = window.prompt(kind === 'file' ? 'New file name' : 'New folder name');
    if (!name?.trim()) return;
    const target = tree.targetDir;
    const p = target ? `${target}/${name.trim()}` : name.trim();
    try {
      if (kind === 'file') await newFile(sel.root, p);
      else await newFolder(sel.root, p);
      await tree.reveal(sel.root, p);
      setStatus('');
      if (kind === 'file') goto({ root: sel.root, path: p });
      await refreshGraph();
    } catch (e) { setStatus(msg(e)); }
  }

  async function rename() {
    if (!sel?.path) return;
    const to = window.prompt(`Rename "${sel.name}" to`, sel.name);
    if (!to?.trim() || to.trim() === sel.name) return;
    try {
      const res = await renameEntry(sel.root, sel.path, to.trim());
      await tree.refresh(sel.root, parentOf(sel.path));
      tree.setSelected(nodeKey(sel.root, res.path));
      if (hits(openRef, sel.root, sel.path)) {
        // works for the file itself AND for a renamed folder above it
        goto({ root: sel.root, path: res.path + openRef!.path.slice(sel.path.length) });
      }
      setStatus('');
      await refreshGraph();
    } catch (e) { setStatus(msg(e)); }
  }

  async function remove() {
    if (!sel?.path) return;
    if (!window.confirm(`Delete "${sel.name}"? This cannot be undone.`)) return;
    const target = sel;
    const del = async (recursive: boolean) => {
      await deleteEntry(target.root, target.path, recursive);
      await tree.refresh(target.root, parentOf(target.path));
      if (hits(openRef, target.root, target.path)) goto({ root: target.root, path: '' });
      tree.setSelected(null);
      setStatus('');
      await refreshGraph();
    };
    try { await del(false); } catch (e) {
      // The backend refuses a non-empty folder with the count in the sentence,
      // so the second ask can say how much is about to go.
      const m = msg(e);
      if (/holds \d+ item/.test(m) && window.confirm(`${m} Delete all of it?`)) {
        try { await del(true); } catch (e2) { setStatus(msg(e2)); }
      } else setStatus(m);
    }
  }

  // ── derived ───────────────────────────────────────────────────────────
  /** A memory graph node's id IS its path, so this is identity, not a lookup
   *  table. Workspace files have no doc_id because they are not in the store. */
  const docId = openRef?.root === 'memory' ? openRef.path : null;
  const node = docId ? index?.byId.get(docId) : null;

  const dimmed = useMemo(() => {
    if (!index || !tag) return null;
    const keep = new Set(index.tags.find(t => t.tag === tag)?.docs ?? []);
    return new Set(index.nodes.filter(n => !keep.has(n.id)).map(n => n.id));
  }, [index, tag]);

  const setTag = useCallback((next: string | null) => {
    const p = new URLSearchParams(search);
    if (next) p.set('tag', next); else p.delete('tag');
    setSearch(p, { replace: true });
  }, [search, setSearch]);

  const setGlobal = useCallback((next: boolean) => {
    const p = new URLSearchParams(search);
    if (next) p.set('graph', '1'); else p.delete('graph');
    setSearch(p, { replace: true });
  }, [search, setSearch]);

  const leave = (go: () => void) => { if (confirmDiscard('vault')) go(); };

  const links = (
    <Links
      index={index}
      docId={docId}
      inboundCount={doc?.inbound_links}
      dangling={doc?.dangling}
      indexed={openRef ? openRef.root === 'memory' : true}
      onOpen={openDocId}
    />
  );

  const graph = (
    <GraphPane
      index={index}
      docId={docId}
      global={globalGraph}
      onToggleGlobal={setGlobal}
      dimmed={dimmed}
      onOpen={openDocId}
    />
  );

  const editor = doc && openRef ? (
    <Viewer
      root={openRef.root}
      path={openRef.path}
      doc={doc}
      draft={draft}
      dirty={dirty}
      saving={saving}
      mode={view}
      title={node?.label}
      onWikilink={openRef.root === 'memory' ? openTitle : undefined}
      resolveWikilink={openRef.root === 'memory' ? resolveWikilink : undefined}
      /* Never on the phone: `Surface`'s header already draws the chevron, and
         two of them stacked is what the Files tab's own single-pane layout
         avoids by not having a Surface above it. */
      onBack={undefined}
      onDraft={setDraft}
      onMode={setView}
      onSave={() => save()}
    />
  ) : (
    <div className="h-full flex items-center justify-center text-xs text-stone-500 px-6 text-center">
      {mobile ? 'Tap a note to open it.' : 'Pick a note on the left, or a star in the graph.'}
    </div>
  );

  const banners = (
    <>
      {(status || graphError) && (
        <div className="shrink-0 px-3 py-1 text-xs text-red-400">{status || graphError}</div>
      )}
      {receipt && (
        <div className={`shrink-0 px-3 py-1 text-xs ${
          receipt.failed.length ? 'text-red-400' : 'text-teal-300'}`}>
          {receipt.action === 'retarget'
            ? `Moved ${receipt.occurrences} link${receipt.occurrences === 1 ? '' : 's'} in ${receipt.notes} note${receipt.notes === 1 ? '' : 's'} to “${receipt.to}”.`
            : `Turned ${receipt.occurrences} link${receipt.occurrences === 1 ? '' : 's'} in ${receipt.notes} note${receipt.notes === 1 ? '' : 's'} into plain text.`}
          {receipt.failed.length > 0 &&
            ` ${receipt.failed.length} could not be written: ${receipt.failed.join(', ')}.`}
        </div>
      )}
    </>
  );

  const sidebar = (
    <VaultSidebar
      mode={mode}
      onMode={setMode}
      tree={tree}
      index={index}
      tag={tag}
      onTag={setTag}
      onOpenDoc={openDocId}
      onOpenRow={r => onRow(r)}
      narrow={mobile}
      selRoot={selRoot}
    />
  );

  function onRow(r: Row) {
    if (r.dir) { void tree.toggle(r); return; }
    leave(() => goto({ root: r.root, path: r.path }));
  }

  const toolbar = (
    <div className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 border-b border-stone-800 flex-wrap">
      <button className={btn} onClick={() => create('file')}
        disabled={!sel || !selRoot?.writable}>New note</button>
      {/* Presence is DERIVED from the root, not from a list of which roots
          allow folders: memory globs `<type-dir>/*.md` one level deep, so a
          folder there would hold notes she could never find. */}
      <button className={btn} onClick={() => create('folder')}
        disabled={!sel || !selRoot?.can_mkdir}>New folder</button>
      <button className={btn} onClick={rename} disabled={!sel?.path || !selRoot?.writable}>Rename</button>
      <button className={btn} onClick={remove} disabled={!sel?.path || !selRoot?.writable}>Delete</button>
      <span className="flex-1" />
      {tag && (
        <button className={btn} onClick={() => setTag(null)}>
          tag: {tag} ×
        </button>
      )}
      <button className={btn} onClick={() => void refreshGraph()} title="Re-read the graph">↻</button>
    </div>
  );

  // ── phone ─────────────────────────────────────────────────────────────
  useSheetHistory(!!sheet, () => setSheet(null));

  if (mobile) {
    if (sheet) {
      return (
        <Surface
          title={sheet === 'graph' ? 'Graph' : 'Links'}
          onBack={() => setSheet(null)}
          bodyClass="overflow-hidden"
        >
          {sheet === 'graph' ? graph
            : <div className="h-full overflow-y-auto nice-scroll">{links}</div>}
        </Surface>
      );
    }
    return (
      <Surface
        title={openRef?.path ? (node?.label ?? openRef.path.split('/').pop()!) : 'Vault'}
        onBack={() => leave(openRef?.path
          ? () => goto({ root: openRef.root, path: '' })
          : onClose)}
        bodyClass="overflow-hidden"
        actions={openRef?.path ? (
          <div className="flex items-center gap-1">
            <button onClick={() => setSheet('links')} className={btn}>links</button>
            <button onClick={() => setSheet('graph')} className={btn}>graph</button>
          </div>
        ) : undefined}
      >
        <div className="h-full flex flex-col min-h-0">
          {banners}
          {/* The panes take turns: at 390px a tree beside an editor leaves the
              editor a slit, and three panes is not a layout at all. */}
          {openRef?.path
            ? <div className="flex-1 min-h-0 px-2 pb-2">{editor}</div>
            : <>{toolbar}<div className="flex-1 min-h-0">{sidebar}</div></>}
        </div>
        {plan && (
          <LinkPlanDialog plan={plan} busy={saving}
            onCancel={() => setPlan(null)}
            onChoose={m => save({ links: m, confirm_plan: plan.plan })} />
        )}
      </Surface>
    );
  }

  // ── desktop ───────────────────────────────────────────────────────────
  return (
    <div
      className="absolute inset-y-0 left-0 z-30 flex flex-col bg-stone-950 border-r border-stone-800"
      style={{ right }}
    >
      <header className="shrink-0 flex items-center gap-3 px-3 py-2 border-b border-stone-800">
        <h2 className="text-sm font-medium text-stone-100">Vault</h2>
        <span className="text-[11px] text-stone-500 truncate">
          Her notes, their links and their tags
        </span>
        <span className="flex-1" />
        <button onClick={() => leave(onClose)}
          className="text-stone-500 hover:text-stone-200 text-lg px-1" aria-label="Close">×</button>
      </header>

      {banners}

      <div className="flex-1 min-h-0 flex">
        <div className="w-64 shrink-0 min-h-0 border-r border-stone-800 flex flex-col">
          {toolbar}
          <div className="flex-1 min-h-0">{sidebar}</div>
        </div>

        {globalGraph ? (
          <div className="flex-1 min-w-0 min-h-0">{graph}</div>
        ) : (
          <>
            <div className="flex-1 min-w-0 min-h-0 px-3 py-2">{editor}</div>
            <div className="w-[22rem] shrink-0 min-h-0 border-l border-stone-800 flex flex-col">
              <div className="h-[45%] min-h-0 border-b border-stone-800">{graph}</div>
              <div className="flex-1 min-h-0 overflow-y-auto nice-scroll">{links}</div>
            </div>
          </>
        )}
      </div>

      {plan && (
        <LinkPlanDialog plan={plan} busy={saving}
          onCancel={() => setPlan(null)}
          onChoose={m => save({ links: m, confirm_plan: plan.plan })} />
      )}
    </div>
  );
}
