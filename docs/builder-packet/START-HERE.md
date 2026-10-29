# Nova Builder Packet — START HERE

You are building **Nova**, a Personal Agent OS with a harness inside it. This packet is the complete, authoritative design. Read it in the order below before writing code. Where this packet and any existing code disagree, this packet wins; where you find a genuine conflict inside the packet, stop and report it rather than improvising.

## Reading order
1. `SYSTEM-MAP.md` — what exists, where it lives, what is canonical.
2. `NOVA-SPEC.md` — the product: what Nova is, its charter, its loop, its rules.
3. `CAPABILITY-INVENTORY.md` — target capabilities vs. what the existing codebases already have.
4. `ARCHITECTURE-AND-DECISIONS.md` — stack and binding architecture decisions (ADRs).
5. `CONTRACTS.md` — the interfaces everything must honor.
6. `DESIGN-SYSTEM.md` — how Nova looks, and the rules that keep it consistent and swappable.
7. `EXTENSION-MODEL.md`, `PROFILES-AND-CUSTOMIZATION.md` — how Nova stays general.
8. `CONTEXT-AND-CAPTURE.md`, `LOCAL-FIRST-AND-DEVICE-MESH.md`, `LOCAL-MODELS.md` — context, devices, models.
9. `WORK-LEDGER-AND-VERIFICATION.md` — durable work and proof.
10. `ROADMAP-AND-GATES.md` — build order and the gates each milestone must pass.
11. `OPERATING-RULES.md` — how you (the builder) work: git discipline, evidence, stop conditions.

Visual references (in this folder): `nova-architecture.png` (system/flow), `nova-app-concept.png`, and UI concepts `nova-ui-a…h*.png` — the approved direction is round 2 (E–H) as one design language; see `DESIGN-SYSTEM.md`.

## The five product promises
1. Your context stays yours — local-first, inspectable, exportable.
2. Any agent can work here — Nova harnesses other AIs instead of competing with them.
3. Work doesn't disappear into chats — durable tasks in a Work Ledger.
4. Important results carry evidence — "done" must be proven.
5. Your devices act as one private system — a mesh with one logical Nova.

## Non-negotiables (summary — details in the docs)
- ONE Nova. Never a parallel version. Correctness beats loyalty to existing code.
- Nothing user-specific is hard-coded in core. Every personal detail arrives via a profile/config pack or an extension.
- Nova's charter: honesty outranks agreeableness. Nova is critical, not sycophantic.
- Communication: human, concise by default; depth on demand. (NOVA-SPEC §5)
- The running system is never edited live by an agent. Changes: sandbox → tests → versioned deploy → rollback. (ARCHITECTURE ADR-9)
- Fallbacks never violate a task's privacy mode. Local-only never silently falls back to cloud.
- If it isn't committed and pushed, it doesn't exist.
