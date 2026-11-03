# Versioning, changelog, and what "deployment" means today
Owner request + verified state, 2026-11-03.

## Verified state (Muse, via git + process checks, 16:22 ET)
- origin/main = **726cc7f4**. Merged TODAY: #284, #285 (Health
  caps/diagnostics UI), #286, #288 (roadmap filing). Merging is
  NOT paused and never was.
- Why the builder thought "#206 was last": the clone ROOT
  checkout's local `main` still sits at 04512c07 (PR #206) and
  was never pulled. Read state from origin/main or a fetched
  worktree, NEVER from the clone-root checkout.
- Running right now: ONE node process from the preview
  worktree at current main (restarted 16:02), console :4318,
  hub door :4320, tailnet shim :4319 → Serve :9445 (console)
  and :9446 (door). QA instance (:4321) is on-demand, down.

## Deployment — the honest answer
There is NO release/deployment process today: no versions, no
tags, no signed releases, no installed production instance
anywhere. The entire pipeline is: PR → CI gate → merge to main
→ builder restarts the preview (tmux, preview worktree) → the
owner uses that preview over Tailscale. The self-update
channel (Amendment B: ADR first, signed releases, backup +
rollback) is designed, not built. Until it is, "deployment"
means the preview, and any document claiming otherwise is
wrong.

## Work item — versioning + in-app changelog (owner request)
1. **Version**: SemVer, alpha series. Single source of truth:
   `version` in package.json. First version: **0.1.0-alpha.1**,
   assigned at this item's merge. Bump the alpha counter on
   every merge that changes shipped behaviour; milestone
   completions bump the minor (0.2.0-alpha.1 at M10 close).
   Tag main `v<version>` at each bump.
2. **Display**: the UI shows version + short commit hash +
   build date — footer on desktop, an About card in Health.
   Nova must be able to state its own version in chat from
   core state (self-knowledge rule).
3. **Changelog**: `CHANGELOG.md` at repo root, Keep a
   Changelog format, plain language only. Rule (extends the
   LEDGER rule): a merge that changes shipped behaviour is
   incomplete without its changelog entry in the same PR —
   the changelog is the user-facing face of the ledger.
4. **Surface**: a Changelog view in the app (route
   /changelog, reachable from Health/About and the footer
   version) rendering CHANGELOG.md, newest first, with the
   running version + commit pinned at top and any gap between
   running build and latest changelog entry shown honestly.
5. **Backfill**: one opening entry summarising the alpha so
   far (M0–M10, vault, design system) in plain language from
   docs/LEDGER.md — one entry, not a per-PR reconstruction.
Slot: with the wiring workstream (it is a reachability item:
a built thing with no door). Failing test first where the
repo's patterns call for it; styleguide entry precedes the
new surface per the design-first rule.
