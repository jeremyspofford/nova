# LOCAL-FIRST AND DEVICE MESH

## 1. Local-first posture
Nova is self-hosted by default: the hub runs on the user's hardware (mini-PC class is the reference), data lives on the user's devices, and cloud services are optional accelerators. A fresh install must be fully useful with the network cable pulled: local models, local data, local search, queued outbound work.

## 2. Privacy modes (per task, default from profile)
- **Local-only** — nothing leaves the mesh. Decision layer uses the local Decision Model Provider/rules; reasoning uses local models. If a capability is unavailable locally, the task queues or degrades honestly — it never silently reroutes to cloud.
- **Local-preferred** — local first; cloud fallback allowed for capability/quality, disclosed in the context receipt.
- **Cloud-allowed** — Nova chooses freely within policy and budget.
Fallback chains (provider, model, device) are evaluated *inside* the mode. Mode changes mid-task require the new mode to permit everything already sent; otherwise the task restarts clean or asks.

## 3. Enrollment (see CONTRACTS §5)
Three front doors, one protocol: QR scan (phone), hub URL + confirmation code (any browser), one-line command (computer). The joining device generates its keypair; the hub-side approval prompt is the security gate; codes are short-lived and single-use. Onboarding copy must warn: only enter a code at the hub's own address shown on a device you already trust.

## 4. Mesh behavior
- The **hub is a role** (ADR-11): exactly one active hub; a designated standby syncs continuously and can be promoted manually or on sustained hub failure. Promotion is a ledger-recorded event.
- Spokes work offline: capture, queue tasks and events locally, resync on reconnect with conflict rules (server-wins for config, merge-with-provenance for memory, never lose a ledger entry).
- Heavy data moves peer-to-peer inside the mesh where possible (e.g. a capture file needed by the GPU spoke), rather than hub-relayed.
- Every device has a revocable record: identity, capabilities, last-seen, trust level. Revocation propagates immediately and kills sessions.

## 5. Sync and backup
- Sync is end-to-end encrypted between paired devices; the optional cloud relay, when used, is a dumb encrypted transport/storage — never a plaintext data home.
- Nightly hub backups (local target + optional encrypted cloud copy), with a **tested** restore path: restore drills are part of the roadmap gates, not documentation promises.

## 6. Clients: PWA first, native later
- The client is a PWA served by the hub: installable on desktop, laptop, iOS, Android, tablets, foldables. Layouts respond to viewport and **posture** (foldable cover screen = glance view; unfolded = full layout; half-open = split) — capability and size detection, never device-name detection.
- Known PWA limits are design inputs, stated plainly to users where they matter (notably iOS background behavior: the hub does the always-on work; the phone is a window).
- Native apps, when built, exist for deeper device integration (widgets, share targets, background capture where the OS allows, OS intents) — as far as each manufacturer permits, recorded in a per-platform capability table. Native clients consume the same APIs and the same design-system packages (tokens compile to native themes); no feature may be native-only by accident — it is native-only only where the OS forces it, and the PWA must degrade honestly there.
