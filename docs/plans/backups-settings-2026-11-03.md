# Backups settings and recovery key implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development task-by-task. Steps use checkbox syntax.

**Goal:** Give built backup settings and the encrypted-copy recovery key a reachable, usable home in Settings, starting with a rendered entry for owner recognition.

**Architecture:** One pure view builder is shared by the living styleguide and the eventual Settings surface. The app uses existing backup routes and existing mesh capability metadata; backend authorization remains authoritative. Key display is temporary UI state, separate from loaded/cacheable backup data. No new credential store, auth policy, HTTP client or morph framework.

**Tech Stack:** Existing JavaScript ES modules/components/tokens; Node26.3.1, existing unit tests and cached Chromium/WebKit. No dependency or image install.

**Spec:** owner queue docs/plans/owner-priority-queue-2026-11-02.md item4 (Backups first); docs/reviews/nova-whole-app-review-2026-11-02.md section4; docs/builder-packet/OPERATING-RULES.md design-first rule and docs/builder-packet/DESIGN-SYSTEM.md §§0,2,5,7. Existing contracts src/core/resilience/index.ts:113–163,504–527 and backup.ts:658–666.

## Global Constraints

- Stage1: rendered `/styleguide?entry=backups-settings`, own `#sg-backups-settings` anchor, realistic neutral state screenshots and independent review. Owner approves before app view/state/API composition; do not treat approval of279/280 or current unrelated messages as this recognition. Quote/link the exact operating rule if waiting.
- Only Task1 is currently authorized to execute without that recognition. Tasks2/3 are queued; app code awaits actual reply. Generic existing inputs are not blanket surface approval.
- Reuse existing components/tokens/type/spacing/radius/icons; no redesign, theme revision, arbitrary values, gradients or stage2 frontend refactors. No implementation/API instructions in product copy. All components appear in styleguide; no helper exemption to hide a new surface.
- Pure renderer in ui/js/view.js: `renderBackupsSettings(model, { id = 'settings-backups' } = {}) -> HTML`. Model has settings `{target,keep,encrypted_target}`, permissions `{canEdit,console,readOnlyReason}`, state (`loading`, `ready`, `saving`, `error`), `errors: {target?,keep?,encrypted_target?}`, `notice?: string`, and `recovery: {state: hidden|first-shown|confirm|shown|unavailable, key?: string, confirmed?: boolean, error?: string}`. Only first-shown/shown may render key text; hidden/confirm/unavailable render no key bytes. Saving marks aria-busy and disables duplicate submit, without discarding editable draft/focus. Input names exactly target/keep/encrypted_target; callbacks/event binding belong to eventual surface. Unique id prefix per styleguide example.
- Existing defaults/validation: keep7; whole number1–365; null clears an optional folder; blank input is not silently interpreted as removal. Target must already exist, be private, outside/not contain Nova home. Encrypted copy needs target and a different existing folder. App validates simple form constraints; backend performs filesystem checks. No directory creation/browse promise the server cannot honor.
- Existing roles: PUT/backups/settings is approver (tier2), including hub console. Initial encrypted-copy setup may return its key once to that authorized caller. POST/backups/recovery-key requires the console principal AND confirm:true (tier3), every time. Preserve this distinction; no new broader reveal. GET/mesh/status.you has console/can_approve; reuse store.mesh.you rather than viewport/hostname guesses. Replica/unknown/unavailable capability states remain read-only; backend guards unchanged.
- The key is for encrypted backup copies, not a promise to recover credential-vault factors or every sign-in. It has64 hex characters in8 groups. Demo only uses a public placeholder with that geometry. No real owner key/home/vault/backup/desktop session; no provider/model/cloud/device/paid calls/image pulls. No broker key/recovery testing under this UI task.
- Actual app key handling after approval: never URL/dataset/hidden inputs/localStorage/sessionStorage/service-worker cache/log/toast/chat/model/telemetry; display only in its dedicated visible section, clear on Hide/navigation/capability loss. Copy only after explicit user click. Preserve a just-shown key through ordinary SSE refresh until Hide/navigation/defined visibility lifecycle, not overwrite it with a GET response. No automatic clipboard changes.
- Same controls in phone/rail/tablet/half-open layouts, labels/keyboard/touch/long folder paths/errors/readonly access. Preserve focus/caret/unsaved drafts through SSE and failed save. No duplicate ids or nested forms; all arbitrary strings escaped.
- Work ONLY owned /home/jeremy/.codex/worktrees/nova-health-backend-wiring/nova-build, branchcodex/backups-settings-wiring from qualifiedmain702dd. Old286 branch/history/private audit retained. One implementation writer globally; root owns git/PR/CI/owner question/preview. No worker subagents or other checkout edits.
- Vault275 is frozen5f/draft for owner-arranged approved live review; no branch/source edits there. Its new static findings and failing CI remain parked. J needs actualP1a/b/c; K needs J per orchestration ADR; this is independent Track1 design preparation while those gates wait, not shipping a reordered M10 phase.
- Runtime checks cached Playwright1.56.1-noble --pullnever/networknone/uid1000/read-only own source+Node26/private/tmp HOME/finite env/file-key mode, matching dependencies read-only if needed. No owner/sharedGit config/home/desktop mounts. Keep tripwire and egress guard; compiler via tripwire if applicable. No NOVA_UI_SHOTS globally. Browser tests go in tests/ui (browser-equipped CI job), not tests/core. No new skips/forced successful exits/timeout raises/blind retries/warning suppression.

## Review Focus

1. Clearing/disabling an encrypted folder is explicit; blank or invalid keep must not silently change policy.
2. Initial one-time key response versus console-only repeated reveal: role/layout distinctions and no accidental key exposure/caching.
3. Slow save, failed save, SSE update and capability changes preserve drafts/focus while clearing sensitive state appropriately.
4. Empty/unavailable folders, long paths and long key groups remain readable/tappable in every posture.
5. Actual Home-start clicks reach the Settings section and controls; route-only tests cannot mark the capability shipped.

## Task1: rendered Backups entry (EXECUTE NOW)

**Files:** ui/js/view.js, styleguide.js, narrowly scoped ui/css only if existing patterns need it; tests/backups-settings-view.test.js, tests/ui/backups-settings-styleguide.test.ts; screenshots/docs/evidence for this entry.
**Produces:** renderer above and `backups-settings` entry, composed from app components and realistic fixtures. No app.js/surfaces.js/settings navigation/backend changes in this task.
- [ ] Write meaningful failing renderer/state/label/escaping/permissions tests before implementation; preserve existing styleguide-coverage gate. Show missing renderer/entry then minimal code. No test that merely mirrors class names.
- [ ] Render loading, no folders, configured, saving, failed save/field errors, first key shown, console confirmation, paired viewer/approver without repeated reveal, and read-only/standby/unavailable states. Combine equivalent states only with clear evidence; no raw endpoint prose. Use valid-width public dummy key and neutral folder names.
- [ ] Styleguide fixtures do not call real backup/reveal endpoints or clipboard; submit/actions are confined to the demo. New app handlers remain unwritten.
- [ ] Browser checks actual component in Chromium/WebKit, all6 active themes for legibility/overflow, keyboard/labels and varied path/key lengths. Capture every meaningful state at phone390×844, desktop1440×900, tablet820×1180, half-open842×675, both engines in approved OrbTeal; geometry/theme tests may avoid redundant screenshot copies. Scoped output path only, no global screenshot overwrite.
- [ ] Run affected unit/styleguide coverage/token/theme/JS checks plus the focused browser file. Cache-only isolated harness and exact contemporary argv/env/cwd/status/hashes; preserve failures/warnings. Baseline source702dd has full pre/post hosted CI green; no need repeat its full suite merely to establish baseline. No installs.
- [ ] Produce concise full Task1 report/commit/RELEASE with exact state/screenshot matrix, slop §0.4 eight-item pass/fail/n-a and accessibility/interaction limits. Root independently reviews, inspects representative real PNGs, publishes concrete draft/recognition question. Do not proceed into Task2 while waiting.

## Task2: reachable Settings form and key flow (AFTER actual recognition)

**Files:** ui/js/surfaces.js/app.js existing Settings loading/routing and event handlers, shared renderer, tests/ui/backups-settings.test.ts and current Home phone/rail crawl. Existing core routes unchanged unless a separately demonstrated production composition defect requires root ruling.
**Consumes:** accepted renderer and existing `/backups`, `/resilience`, `/mesh/status` through ui/js/core.js request/api. No new client layer.
- [ ] Failing real Home-start browser test proves Settings>Backups currently has no controls, then compose shared component with ordinary navigation/search anchor. Extend crawl to assert folder/keep/encrypted controls and recovery-key affordance under correct principal, in phone and rail, no direct Settings URL or injected route.
- [ ] Load backup data and mesh capabilities; unknown/replica/viewer state read-only. Save preserves explicit clearing/null semantics, integer validation and backend errors. Retain field drafts/caret across SSE/inflight/failed save and revalidate capabilities before mutation. Guard duplicate submit.
- [ ] Initial authorized settings response key enters only ephemeral visible state; GET data cannot restore it. Repeated reveal composes existing tier3 confirmation/checkbox, posts confirm:true only from console, paired clients show why unavailable. Keep backend role denial/confirmation checks intact and test real HTTP counterparts. No key logging/cache/URL/hidden DOM/storage. Explicit Copy/Hide, clear on exit/capability loss.
- [ ] Prove actual user save/readback, first key display, explicit repeated confirmation, paired/viewer denial, offline/save retry, SSE focus, key hiding and clipboard intent using synthetic private fixtures only. No plaintext key sent to another service/model. Use ordinary benign UI/authorization tests, not credential recovery or adversarial extraction.
- [ ] Remove Health's literal PUT/API instruction, link to Settings>Backups and preserve current backup/drill controls. Same feature homes in every layout; no right-column duplication added. Update only actual capability rows after Home crawl reaches them.
- [ ] Capture app screenshots matched to styleguide across required postures, slop results, affected tests, full report and clean commit/RELEASE for fresh task review.

## Task3: final qualification and delivery (root gates)

- [ ] Complete self-contained current evidence/claims and plain same-PR LEDGER: what the person can do, role limits and actual backup versus credential-vault recovery scope. No universal recovery/whole-phase claim. Preserve historical failed attempts and screenshot provenance.
- [ ] Fresh independent whole-branch review; fix reproduced findings test-first with scoped rereview. Ordinary exact-head CI allrequired green; merge main in never rebase if needed; no blind CI retry/relaxed gates.
- [ ] Root --match-head-commit merge only after actual rendered approval/taskreviews/finalreview/CI. Approved preview restart after merge, exactcleanmain/app-health-mesh200. Report merge one line; immediately next unblocked owner queue item. Archive only completed plan scratch after verified private audit; protected worktrees stay preserved.
