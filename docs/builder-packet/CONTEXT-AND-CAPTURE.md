# CONTEXT AND CAPTURE

Nova's usefulness scales with context; its trustworthiness depends on capture being permissioned, visible, and honest about platform limits.

## Principles
- Capture is off by default, enabled per source, per device, with a visible indicator whenever it is active.
- Every source is pausable and excludable (per app, per site, per space/book, per time window). Private/incognito contexts are never captured.
- Captured data lands in the user's store on their devices first (local-first), classified by space, with provenance. Retention is user policy; deletion is real deletion.
- Capture feeds memory deliberately: raw capture is evidence, not memory. Promotion into long-term memory follows the memory rules (CONTRACTS §7) and is auditable.

## The Capture API
One internal API regardless of source: `capture.stream(device, kind)` → normalized events (`kind`: screen, audio, meeting, browser, app-activity, sensor) with timestamps, device, space attribution hooks, and consent state. Screenpipe-compatible ingest is the first adapter: existing Screenpipe pipelines flow into the API unchanged. Native capture components (Rust, ADR-2) are added incrementally behind the same API — consumers never know which source produced an event.

## Per-platform posture (design to the limit, don't discover it)
- **Desktop (Windows/macOS/Linux)**: deep capture is possible — screen, audio, meetings, app activity — under OS permissions the setup flow requests explicitly.
- **Android**: broad capture possible with user-granted accessibility/notification permissions; declare them as extension-grade permissions.
- **iOS**: no passive capture of other apps. iPhone context comes from what the platform offers: user-initiated recording, screenshots, Share Sheet, Shortcuts automations, notifications Nova is sent, and hub-side sources (mail, calendar, files). The product must say this plainly in setup — never imply desktop-grade capture on iOS. This is a primary reason native iOS integration is a later, deliberate step.
- **Foldables/wearables**: capture follows the device agent present; posture affects UI, not capture policy.

## Classification
Activity is attributed to spaces/books by signals the user configures (active app, calendar, device, explicit switch) — never by fragile heuristics alone, and never by folder paths. Ambiguous activity stays unclassified rather than guessed; the user (or a triage decision with an escape) resolves it.

## WorkLedger note
Timecard/standup generation is a workflow built on this capture layer (durations from capture, attribution from spaces), shipped as a workflow/skill on top of Nova — not a core feature. Its evidence discipline (completed-only, sanitized before crossing spaces) is inherited from the verification layer.
