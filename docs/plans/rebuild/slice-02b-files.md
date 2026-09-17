# Slice 2b — Workspace Files viewer (visibility mini-slice)

Parent: the Master Roadmap; trigger: owner S2 QA finding 2026-08-29 — the
tool loop works but the files Nova creates are invisible in the app.
Slice type: additive. Size: S.

Goal: the operator can SEE what Nova wrote — browse the workspace, open a
file's real contents and path, download it — from the sidebar and from
each write span in Activity. Read-only this pass (editing/delete later).

## DoD (operator-visible, walked in the running app)
1. Sidebar has a Files item; it lists the workspace files (groceries.md
   and anything else Nova wrote) with size, path, modified time.
2. Click a file → its real contents render (mono) with its real path
   shown; a Download button downloads it.
3. In Activity, a workspace_write_file / workspace_read_file span's path
   is a link that opens that file in the Files view.
4. Empty workspace → EmptyState, not a fake row.

## Backend (services/core) — READ-ONLY
- `GET /api/v1/workspace/files` → recursive listing under WORKSPACE_ROOT
  (default /data/workspace): [{path (root-relative), size, modified}],
  capped (e.g. 500 entries + stated truncation), directories included or
  flattened — pick the simpler that renders cleanly. Contained via the S2
  workspace realpath guard (reuse it; do not reimplement).
- `GET /api/v1/workspace/file?path=` → {path, size, modified, text?,
  binary?} — text files (<=256 KB) return contents; larger or binary
  return metadata + a binary/too-large flag (never dump binary as text).
  Path contained; traversal/escape → 400 named; missing → 404.
- `GET /api/v1/workspace/raw?path=` → the bytes with a download
  content-disposition; same containment.
- Auth like every route (session or bearer). Writes NOTHING.

## Web (apps/web)
- Files nav item (System section; lucide icon). Route /files.
- List (v0.5.0-alpha Files/AuditLog layout idiom): rows path/size/modified,
  click → detail. EmptyState on empty.
- Detail: real path (mono), contents (mono, scrollable), Download button
  (hits /raw). Binary/too-large → a stated "N bytes, not shown — download
  to view" instead of garbage.
- Activity drill-in: workspace_write_file/read_file spans render their
  meta.args_redacted.path as a link to /files?path=<path> (guard the
  polymorphic-string args_redacted shape — only link when path is
  extractable).

## Tests
- Backend (pytest, real-stack or scratch DB fine per the new testing
  policy — no isolated stack required): listing, containment refusals
  (traversal/absolute/symlink-out), text vs binary vs too-large, 404,
  raw download headers, auth refusal.
- Web (vitest): list renders + EmptyState; detail renders text and the
  binary/too-large states; the Activity span-path link builds correctly
  for both args_redacted shapes.

## Rails
Read-only (grep-pin no INSERT/UPDATE/DELETE in the new module); path
containment reuses the S2 guard; no fake numbers; 127.0.0.1; refuse-all
tokens; comments self-contained.

## Process
One implementer + review + fix rounds; then rebuild the real stack
(`docker compose -f deploy/docker-compose.yml up -d --build core web`) and
hand to the owner to walk (per the new testing policy — real stack, no
isolation). Carries → fold into slice-02-carries.md or a short note.
