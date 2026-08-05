# The Vault — an Obsidian-style view over the files Nova can reach

**Status: built 2026-08-05 in `.worktrees/vault-view` (branch `vault-view`),
uncommitted.** Roadmap #41.

## Why

Her notes already *are* a vault. `data/memory/` is 263 hand-editable markdown
files with frontmatter, `tags: [a, b, c]` and `[[wikilinks]]` that 219 of them
use, and `docker-compose.yml` says out loud that `NOVA_MEMORY_DIR` can point at
an Obsidian folder. The backend already resolves those links
(`backend/app/memory/links.py`), counts backlinks, detects dangling ones, and
refuses a retitle that would orphan inbound links.

What was missing was a place to *read* it that way. The corpus was split across
three surfaces that each showed one facet and none of which connected:

- **Library → Files** — a real two-pane file manager, but no links, no tags, no
  graph.
- **The brain canvas** — four renderers over `/api/v1/memory/graph`, which show
  the graph *instead of* the notes.
- **MemoryAtlas** — a browsable index, label/tag filtering only, no bodies.

So walking from a note to the notes it links, filtering by tag, or seeing what
points *here* was not possible anywhere in the app.

## The fact that made it cheap

A memory graph node's `id` is `str(p.relative_to(base_dir))` from
`OkfStore.iter_files()` — byte-identical to the Files API's
`{root: 'memory', path}`. The graph and the editor already address the same
thing, so **the Vault needed no backend change at all**: it is
`getMemoryGraph()` (which had existed in `src/api.ts` with zero callers) joined
to the Files API the Library already used.

Measured on the live corpus, 2026-08-05: 262 nodes, 279 edges, 186 KB in 40 ms
— small enough to fetch whole and derive titles, backlinks and tags from.
Edge kinds: 218 `link`, 48 `subject`, 13 `tag`. 262 files, **261 titles**.
465 distinct tags over 238 tagged notes, `transcript` and `media` on 216 each.
No note has more than one distinct wikilink: the authored graph is four hub
stars plus summary↔transcript pairs.

## What was built

```
frontend/src/files/            (git mv from components/library/files/)
  api.ts  Tree.tsx  Viewer.tsx  LinkPlanDialog.tsx    shared, near-verbatim
  dirty.ts                                            owner-keyed, owns beforeunload
  useFileTree.ts               NEW — extracted from FilesTab

frontend/src/vault/
  VaultPage.tsx      the routed surface, and THE ONLY WRITER
  vaultRoute.ts      NoteRef ⇄ /vault/:root/*
  useVaultGraph.ts   the single getMemoryGraph() fetch + refresh()
  VaultSidebar.tsx  TagBrowser.tsx  SearchPanel.tsx  Links.tsx  GraphPane.tsx
  graph/model.ts     buildIndex → VaultIndex; linkKey(); neighbourhood()
  graph/engine.ts    d3-force + canvas 2D, no React
  graph/ForceGraph.tsx  React wrapper: canvas + ResizeObserver + 3 effects
  graph/colors.ts
```

Edits elsewhere: two routes in `AppShell`, one icon + one item in `Rail`, one
`NavRow` in `ChatPanel`'s phone drawer, opt-in wikilinks in `Markdown.tsx`, and
import paths in `FilesTab`/`LibraryPage`. **Zero new npm dependencies** — d3 and
react-markdown were already there, so neither image needs rebuilding for the
code to appear at `:5173`.

## Decisions, and what each one refuses

**Resolution is by title, and the client is allowed to do it — but only because
it reproduces the backend's rule.** `memory.graph()` sets
`label = fm.get("title", doc_id)`, so a label that *equals* its id is the
no-frontmatter-title fallback; `links.py title_map()` excludes exactly those
notes from the namespace, and the live corpus has one (an untitled journal).
`buildIndex` drops `label === id` and empty keys for the same reason. An earlier
draft of this plan had the client build the map naively; that would have made
the one untitled note link-addressable, which `memory.py:778-785` exists to
prevent.

**`[[a|b]]` and `[[a#h]]` stay unparsed.** `links.py:26-30` records that 50 of
97 live link targets contain regex metacharacters and two titles contain a
literal `|`. The renderer uses the same regex as `store.py:27` and never
interprets the inside.

**A `[[link]]` in a Workspace file does not render as a link.** `links.apply()`
walks `iter_files()`, which structurally cannot see Workspace, so a retitle
would never rewrite it. Making it clickable would promise maintenance that does
not exist. The rule, stated once: *a root participates in the Vault's knowledge
features exactly when its files are the OKF store's files.*

**The wikilink plugin is opt-in, so chat cannot start linkifying.**
`Markdown.tsx` gained an `onWikilink` prop; absent, the plugin is not even in
the remark array and the components map is the same hoisted object it always
was. Verified by counting: the Files preview of a note containing `[[…]]`
renders **0** wikilink buttons and keeps the literal brackets; the Vault renders
the link.

**The graph draws `link` edges only, and never re-derives clustering.** A `tag`
edge's endpoints are an arbitrary pair from a spanning path (`Brain.tsx:474-477`,
`systems.ts:41`), so drawing them would invent relationships; the 48 `subject`
edges are pairs the backend *deliberately refused* to fuse (ROADMAP #37). Tag
grouping still shows, through node colour, via `tagColor` imported read-only
from `brain/systems.ts` so the Vault, the Atlas and the Universe agree.

**The graph stops drawing.** `brain/graph2d.ts` runs a permanent rAF loop; the
Vault sits *over* a canvas that is already animating, so a second permanent loop
is a real cost. `sim.on('tick', requestDraw)`, and `draw` clears its pending
frame without rescheduling. Measured: **103 frames in 2 s while the 262-node
layout settles, 0 in a quiet 2 s, 1 for a wheel event, 0 again.**

**No poller.** `<Brain/>` is mounted permanently outside the router, so its 20 s
`/brain/graph` poll keeps running behind the Vault — and `memory.graph()`
re-reads and parses every file on disk per call. The Vault loads once, refreshes
after a write, and offers a manual control.

**One write path.** `VaultPage.save()` is a near-copy of `FilesTab.save()` and
carries its docstring forward: *the only writer*. `FilesRefusal` →
`LinkPlanDialog` → `save({links, confirm_plan})`, unchanged. The two surfaces
have separate state but must not have separate rules — fork them and the app
gets two editors that eventually disagree about what a refusal means, which is
what extracting `systems.ts` was meant to prevent.

**A draft cache, which the Files tab never needed.** React Router 6 without a
data router has no `useBlocker`, so browser-back cannot be intercepted — and in
a link-driven vault, back happens constantly. Drafts are kept per note across
navigation, so only a reload or a tab close can lose work, and `beforeunload`
(now owned by `dirty.ts`) covers those.

**`dirty.ts` is owner-keyed.** `FilesTab` cleared the single flag
*unconditionally* on unmount; with a second editing surface that clear would
erase the other's state and `beforeunload` would silently stop firing.

## Verified in the running app

Second vite from the worktree against the live backend
(`VITE_PROXY_TARGET=http://127.0.0.1:8000`, port 5174):

- Rail → Vault opens; deep links restore the tree, the note and the graph.
- A `[[link]]` click navigates; the target's Links pane reads
  **LINKED FROM (1) · 2 occurrences**, the notes-vs-occurrences distinction.
- `sources/cloud-codes---videos.md` shows 69 backlinks and a 70-node local graph.
- The global graph draws the four hubs plus 25 drifters, fitted.
- Tag filter narrows tree and graph; non-members recede rather than vanish.
- A save writes **byte-identical** content — no restamped timestamp, no adopted
  tags, no `Related:` line.
- A retitle with inbound links raises the LinkPlan dialog with the referrer list
  and its counts; **Cancel left the corpus untouched** (verified on disk).
- `soul.md` and journals open read-only. Memory offers no New folder; Workspace
  does. A Workspace path with a space in it round-trips through the URL.
- Phone (393×852): panes take turns, one back chevron, graph and links as
  sheets that the back gesture closes without leaving the note.

Gate: `npx tsc --noEmit` has **no errors outside the pre-existing
`IngestionPanel.tsx` baseline** (see below).

## Known gaps and follow-ups

1. **Search is titles, paths and tags — not bodies**, and the placeholder says
   so. There is no HTTP search route (`BM25Index.search` has exactly two
   callers, both internal to the agent's retrieval path) and fetching 262 bodies
   to grep in the browser is a download, not a search. A
   `GET /api/v1/memory/search` over the existing index is the fix; it must call
   `memory.index.search()` **directly**, not `memory.context()`, which sets the
   `untrusted` taint and collapses transcripts behind their summaries.
2. **Backlinks show notes, not occurrence counts per referrer, and no context
   snippet.** Both need `GET /api/v1/memory/backlinks`; `links.scan()` already
   produces the inbound map and `router_files._link_facts` throws all but the
   count away.
3. **Tag tiers are not surfaced.** `memory/tagtiers.py` already knows that
   `transcript` (216 notes) is STRUCTURAL and earns no graph edge. Until
   `GET /api/v1/memory/tags` exists the pane can only order by count.
4. **Out-of-band edits still desync the BM25 index** — no watcher, no
   reindex-on-read. `GET /api/v1/memory/index` (a stat-only drift diff) plus a
   drift-scoped `POST /api/v1/memory/reindex` would let the UI say so and repair
   it. Today the only repair is a container restart.
5. **`Brain` keeps painting behind the Vault** at ~60 fps. `Brain.tsx:176-197`
   already has the occlusion machinery; it is wired only for the phone's chat.
   An 8-line `nova:surface-opaque` event would cover it. Left undone
   deliberately: `Brain.tsx` was being edited by a parallel session.
6. **The `:8080` phone build cannot show this lane until merge** — `docker
   compose build web` runs from the repo root and builds `main`, not the
   worktree.
7. **Two file managers.** The Vault is a superset of Library → Files, and is
   defensible only as a transition. Once it reaches parity, `LibraryPage` should
   redirect `kind === 'files'` to `/vault` and `FilesTab.tsx` should be deleted;
   `router_files.py` stays, since it is the API both use. Parity checklist:
   create, rename, delete, folder-create, binary download, the `indexed` flag,
   the `can_mkdir: false` refusal, arrow-key tree navigation, and the
   narrow-screen single-pane behaviour. **The README must never carry two
   file-manager rows** — the row that retires Files is the row that amends the
   Vault's.

## Lane notes

`main` does not compile on a clean checkout: `IngestionPanel.tsx` is committed
importing `dismissIngestJob`, `dismissFinishedIngestJobs`, `restoreIngestJob`
and `getDismissedIngestJobs` from `../api`, and HEAD's `api.ts` exports none of
them — they exist only in the uncommitted ingest-dismissal work. It is a
*runtime* break too, not just a typecheck one: the module fails to load and the
whole shell goes blank.

So this worktree **borrows** `frontend/src/api.ts` and
`frontend/src/chat/ChatPanel.tsx` from the main checkout, unstaged. They are a
pair — borrowing only `api.ts` gives the new paged `getMessages` to the old
consumer and chat history breaks. Neither is part of this lane; committing the
ingest-dismissal work makes both unnecessary.

One consequence to carry to review: **the `<NavRow label="Vault">` hunk lives in
that borrowed `ChatPanel.tsx`.** It is a two-line insert above the Library row
in the phone drawer's `NavList` and applies cleanly to either version.
