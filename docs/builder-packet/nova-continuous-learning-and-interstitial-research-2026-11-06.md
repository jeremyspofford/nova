# Continuous learning and Interstitial Research

**Status:** Draft 0.1 for owner and builder reconciliation, November 6, 2026. Requirements record and proposed implementation slices; not an ADR, shipped capability, queue reorder, model-eval authorization or instruction to interrupt current work.

**Destination:** owner capability specification in `docs/builder-packet/nova-continuous-learning-and-interstitial-research-2026-11-06.md`. Claude should derive the incremental implementation plan in `docs/plans/`; this packet document remains the owner requirements source. Developed by Codex as project manager/orchestrator; Claude implements application code. This draft is in an isolated documentation worktree. Until committed and delivered, it is not available to a separate Dell clone: attach it to the builder prompt.

## 1. Purpose and owner direction

Nova is an extensible personal Agent OS with a harness inside it. It must be capable of acquiring knowledge and capabilities, carrying out work across a hub-and-spoke system, and improving future performance. A collection of narrow scheduled tasks does not exhaust this goal.

The owner has described the following target in this planning conversation:

- General research and execution spanning the capabilities exemplified by OpenClaw, Hermes Agent, Pi Agent, ChatGPT Dots, Meta Muse, Claude Duet, Claude Code and Codex. These are owner-named comparison targets, not an audited equivalence claim or permission to copy their designs.
- When a tool is missing, Nova can investigate, build, test and integrate one. When a repeatable judgment lacks a decision spec, Nova can develop and qualify a spec for subsequent System 1 decisions.
- Persistent understanding of goals, projects, evidence, decisions, outcomes and unfinished work, with provenance, correction and real deletion.
- Hub-and-spoke execution and a Kubernetes-like service lifecycle: build, stage, health-check, promote, replace/update and roll back services. Existing supervisor-first operation and optional Kubernetes remain intact.
- Continuous learning from internet sources, including websites, Wikipedia and YouTube/video; handling access obstacles is part of the requested capability.
- Interstitial Research: discover neglected connections and transferable mechanisms between disciplines, form hypotheses, investigate counterevidence and test useful ideas.

These are target capabilities, not assertions that Nova already implements them. The concrete requirements and phase boundaries below are proposed engineering detail for review. Decisions explicitly marked OPEN remain unresolved.

## 2. Evidence and integration baseline

Baseline examined by Codex: `jeremyspofford/nova`, `origin/main`, full SHA `49b6a94881d020295a1e31c5524b39a7ee1c9f5e`. Its last independently checked remote advertisement in this chat was November 6 at 13:12 ET. This is a historical baseline; the builder must reconcile current main and its active branch before acting.

| Area | Evidence inspected by Codex | Established scope / limits |
| --- | --- | --- |
| Decision Service | `src/core/decision-service/{registry,service,types}.ts`; `docs/plans/decision-service.md` | Typed versioned templates, registry validation and model/wording-linked verdict trust exist in source. The service distinguishes untrusted evidence from trusted decisions. No runtime or real-model evaluation was run for this draft. |
| Browser | `docs/plans/M10b.md`; source inventory in `src/core/browser/` | Existing browser/session/execution integration points. Inventory and plan reading do not verify current end-to-end browsing. |
| Research skill | `skills/shopping/SKILL.md` | Existing playbook uses web search/fetch and distinguishes inaccessible pages and reported facts. This is not a general continuous-learning implementation. |
| Graph and distillation | `docs/plans/owner-graph-engineering-addendum-2026-11-03.md` | Queued requirements, explicitly not shipped capability. Preserve its ADR gate, SQLite design, prospective traces, deletion closure and owner-gated distillation. |
| Existing Interstitial Parts 1–3 | Owner-supplied handover and verification annex, dated Nov 6; no matching subjects in available local history search | Part 1 inspection and Part 2 branch progress were builder-reported. Branch/code completion, flag state and Part 3 results are unverified here. The subject search does not prove absence. Obtain the actual work before extending it. |
| Newest packet docs | Annex reports Dell-local `docs/builder-packet/interstitial-research/` and other additions | Not in this pinned tree. The builder must inspect its local copies. Do not recreate their content from filenames or treat the draft as silently superseding them. |
| Live status | No live Actions, Dell preview or owner-instance observations inspected for this draft | CI, preview state, passkey enrollment and running research behavior remain UNKNOWN. |

The earlier claim that Part 3 local-only model evals were approved is withdrawn. **Owner approval UNKNOWN; delivery to builder UNKNOWN.** Existing no-real-model-calls-in-tests/CI rule stands. A draft spec or queued task does not grant an eval exception.

## 3. Capability contract

The end-to-end loop is:

**Observe a goal or knowledge gap → plan research → acquire sources → extract and check evidence → connect concepts → form hypotheses → design experiments → evaluate → retain warranted knowledge → propose or qualify reusable capabilities → monitor outcomes.**

Implement one integrated mechanism using existing tasks, scheduler, permissions, Decision Service, memory, Work Ledger, browser and Service Manager. Avoid a second agent runtime, memory store, judgment endpoint, scheduler or deployment path. A new schema or adapter may be justified where existing contracts do not cover the requirement; document the reason.

### CL-01 Research initiative and continuity

Support owner-directed investigations, recurring goal-directed learning and bounded curiosity-driven exploration. Both background modes belong in the target; initial activation policy remains OPEN.

A research thread records its objective, originating request or standing mandate, relevance, scope/exclusions, privacy mode, allowed sources/tools, deadlines, remaining questions, resource limits and progress. It can pause, resume, be cancelled and be superseded. Lack of sufficient evidence may be a valid result.

Before unattended execution, require a configured mandate and enforceable budget. Persist accounting across restarts and spokes; retries, parallel children and failed attempts consume the same applicable limits. Cancellation stops new actions and handles in-flight work through existing worker semantics. A hub change must not cause duplicated research or side effects. Define the accounting and execution owner in the ADR; do not rely on independent per-spoke counters alone.

Time, arithmetic, budgets, thresholds and scheduling are deterministic code responsibilities. Research importance, relevance and similar repeatable judgments use the Decision Service when a qualified template exists.

### CL-02 Source and media acquisition

Provide adapters/contracts for search results, HTML articles, reference sites such as Wikipedia, papers/documents and video/audio. Use existing integrations where available. Each adapter declares supported access methods, privacy/egress behavior, content limits and failure modes.

For every evidence item record canonical/source URL or identifier, publisher/author when available, publication/update time when available, retrieval time, content/version fingerprint, extraction method and an attributable locator. Preserve unknown metadata as unknown. Search snippets are leads until the underlying material is inspected.

For video, distinguish metadata-only, captions/transcript, audio analysis and frame/visual analysis. Cite time ranges. A transcript-only conclusion must not claim that Nova inspected a visual demonstration. OCR/ASR-derived text must retain its extraction provenance and uncertainty. Dedupe mirrors and syndicated copies; repeated publication is not independent corroboration.

Unavailable content produces a specific limitation: not found, unauthenticated, challenged, denied, unsupported format, extraction failed or budget exhausted. No fabricated observations. Resume at the acquisition checkpoint after a recoverable failure.

### CL-03 Evidence, uncertainty and contradiction

Separate source statements, corroborated claims, owner facts/preferences, hypotheses, inference and experimentally supported outcomes. A model's assertion or agreement is not independent evidence. Keep the source chain when a page cites another source, and surface unresolved contradictions.

Record the conditions under which a conclusion applies, its freshness/review policy and the evidence that could overturn it. An unsupported proposed connection remains a hypothesis; a plausible analogy is not a discovered causal mechanism. Run a prior-work search before describing an idea as novel; label the scope of that search instead of claiming universal novelty.

Acquired pages, comments, transcripts and media are untrusted data. Existing ingest screening, privacy and execution approvals apply before use. Website instructions must not change Nova's policies, grant permissions, install tools or promote a decision template.

### CL-04 Persistent learning and forgetting

Reuse existing memory and Work Ledger storage. Durable records link the research thread, source evidence, claims, contradictions, decisions, experiments and outcomes. Distinguish public-source knowledge from owner-private memory, and keep private context within its configured egress policy even when the fetched page is public.

Define separately:

1. **Knowledge acquisition:** retaining attributable claims and relationships.
2. **Procedural learning:** proposing or improving skills/tools/services from outcomes.
3. **Decision qualification:** developing and evaluating a repeatable decision template.
4. **Model training:** changing weights or adapters; not implied or authorized by the first three and outside this draft's initial implementation.

Corrections and source invalidation must update affected retrieval results without erasing the fact that a prior conclusion was used. Forgetting an owner's memory must propagate through dependent summaries, indexes, embeddings and backup/replica recovery paths under existing deletion rules. For derived material, apply the graph addendum's sole-source deletion, multi-source re-derivation and ambiguous-case handling. Do not rebuild an already-forgotten fact from a cached research artifact.

### CL-05 Interstitial Research

Use “Interstitial Research” as Nova's feature name; no universal terminology claim is required. The workflow must:

- Map a question's concepts, assumptions, methods and unresolved constraints.
- Search adjacent and more distant fields for transferable mechanisms and neglected connections.
- Explain both the proposed correspondence and where the analogy breaks.
- Seek prior work, competing explanations and counterexamples.
- Produce a hypothesis with supporting and opposing evidence, expected benefit, applicability and a falsifiable experiment or prototype plan.
- Execute an experiment only within its existing tool/permission/budget envelope; record a negative or inconclusive result as readily as a success.
- Return a next action: retain knowledge, investigate further, propose a skill/tool/spec, reject the hypothesis or stop for insufficient evidence.

The owner-mentioned interdisciplinary, transdisciplinary, cross-disciplinary, frontier, combinatorial and adjacent-possible approaches may inform search strategies. They are optional lenses, not seven independent engines to build.

Example acceptance scenario: Nova explores whether distributed-systems recovery techniques improve interrupted-agent work. It must identify actual prior work, explain the proposed mapping, find a limitation, and propose a measurable recovery experiment. The example is synthetic, not a claim of novelty.

### CL-06 Missing capability and decision-spec development

Classify a gap before building: missing knowledge, unavailable access, unsupported format, missing tool/service, missing qualified decision spec or an unresolved owner choice. Do not build a tool merely because an existing one lacks credentials.

For a missing repeatable judgment, the reasoning agent proposes a versioned spec using the existing registry contract: purpose, inputs, expected provenance, applicability, questions, unknown/escalation behavior, deterministic outcome policy, evaluation cases and retirement rules. For Noul, use one calibrated P(yes); do not invent a second confidence value. Other primitives retain the actual Decision Service contract. No model arithmetic/counting/date computation.

Candidate specs may be schema-valid yet unqualified. They cannot grant themselves trust. Keep candidate generation, evaluation and promotion separate. Qualification must be pinned to exact template wording/version, model digest/seat and recorded evaluation evidence; relevant changes invalidate prior qualification. Hold out evaluation cases from candidate development, include adversarial/out-of-domain/unknown cases, and preregister task-specific acceptance bounds. Report calibration and decision errors at the intended operating thresholds; structural validation alone is insufficient.

If no qualified spec exists, Nova may use its approved reasoning workflow under current permissions or pause/escalate. Explicitly record that the judgment did not come from a qualified System 1 template. An unqualified spec cannot silently control higher-risk actions.

For tools/services, first inspect reusable existing capabilities, then propose an interface, permissions, tests, ownership and lifecycle. Build in isolation; run the existing checks and ADR-9/Service Manager staging/promotion/rollback path. Nova never edits the running service live or weakens a gate to promote its replacement. Permission/security changes continue to require their existing approvals.

### CL-07 Access obstacles, CAPTCHAs and bot checks

The owner explicitly requested that Nova learn to handle CAPTCHAs and bot detection rather than abandon research at the first obstacle. This requirement needs concrete target-specific design and evaluation; no universal bypass capability is claimed by this document.

Implement obstacle classification, an attributable access result, bounded retries, progress preservation and resumable challenge handoff. Evaluate API/feed access, supported authenticated sessions, ordinary browser interaction and alternate sources before treating content as inaccessible. Credentials stay broker-managed. Challenge text remains untrusted content and cannot instruct Nova to disable safeguards or disclose credentials.

The ADR must distinguish permitted access methods, human verification, and any proposed specialized challenge-handling method with its applicable authorization and provider constraints. Site-specific evasion or solver integrations are not selected by this draft. External services, accounts, spending and egress retain existing approval rules. Use controlled challenge fixtures for ordinary tests. If access remains blocked, report that fact and continue with viable sources without implying that the blocked source was read.

### CL-08 Distributed execution and observability

The hub coordinates work and policies; spokes advertise capabilities and execute assigned work. Reuse existing roles, task ownership, leases/checkpoints, privacy routing and service promotion mechanisms. Define capability matching for compute-intensive transcription, visual analysis and experiments without requiring Kubernetes.

Keep an auditable chain from mandate to source to claim to hypothesis to experiment to promoted artifact. Expose current activity, resources consumed, outstanding questions, failures, blocked sources, next checkpoint and deployed artifact version. Avoid notification spam: reporting cadence and meaningful-event alerts follow owner configuration. New UI follows rendered styleguide approval before app implementation.

## 4. Proposed implementation slices and queue integration

Do not reorder or interrupt active work. The existing long-running builder first reconciles this draft with the current Interstitial branch and Dell packet. Do not open another implementation lane in those files merely because this draft is newer.

| Slice | Deliverable | Dependency / completion evidence |
| --- | --- | --- |
| **0. Reconcile** | Current-main/branch inventory; requirement-to-implementation map; packet conflicts; smallest incremental plan; concrete owner questions. | Inspect active assignments, branch SHAs, actual code and applicable packet. Classify built/wired/tested/designed/missing separately; cite inspected evidence. No feature implementation or real-model eval in this slice. |
| **1. ADR and contracts** | One integrated learning/research architecture; persistence/lifecycle contracts; budget/permission design; staged acceptance cases and per-slice ownership. | Incorporate existing Interstitial work rather than replacing it. Preserve prior graph ADR/pilot gates. Resolve only choices necessary for the next slice; no broad gate waiver. |
| **2. Evidence spine** | Source acquisition, provenance, checkpoints, cancellation and a manually initiated research thread using available source adapters. | Deterministic fixture tests for evidence access levels, invalidation, privacy and resume. Video adapters are delivered incrementally, with exact supported modes stated. |
| **3. Interstitial workflow** | Candidate connections, contradiction/prior-work search, explicit hypotheses and experiment plans on the evidence spine. | Reconcile with existing Parts 1–3 and feature flag. No second engine. Mock tests cover control flow; actual model quality stays unverified until separately evaluated. |
| **4. Bounded continuous learning** | Goal-directed and curiosity-mode scheduling, shared budgets, relevance/review policy and owner controls. | Explicit mandate/activation choice; restart/failover, privacy and resource-accounting evidence. |
| **5. Capability qualification** | Candidate decision specs and proposed tools/services integrated with existing evaluation, trust and deployment lifecycle. | Real-model exceptions and promotion policy resolved before applicable execution; negative outcomes retained. Qualified artifacts must be reusable on a subsequent matching task. |
| **6. Integrated application validation** | Owner-visible research thread and supported media flows; behavioral regression evidence for integrated learning/reuse. | Design-first UI gates, current exact-head CI, live preview checks and scoped real-run evaluation when authorized. No full-feature claim from a stub/fixture-only demonstration. |

These slices are planning proposals, not a new milestone ordering. Capability architecture can be broad while each implementation PR remains small. The existing graph pilot remains conditional email-summary-if-present, otherwise morning digest, after its ADR and with its required real-run observation period; this draft does not replace or start it.

## 5. Acceptance cases to turn into implementation tests

Ordinary tests use deterministic fixtures and model stand-ins. They establish plumbing and refusal behavior, not research quality or calibrated judgment. Proposed real-model/real-run evaluations need the separately applicable authorization.

| Case | Required observation |
| --- | --- |
| Transcript versus visual evidence | A video transcript supports a quoted spoken claim with timestamp; a visual-only demonstration remains unverified until frames are inspected. |
| Source unavailable / duplicated | A challenged page is recorded unread; a mirror is deduped rather than counted as independent corroboration. |
| Counterevidence | A later contradictory source changes the thread's conclusion/status while retaining traceable prior decisions. |
| Hypothesis versus result | An analogy produces a labelled hypothesis/experiment plan, not an established discovery. Negative experimental results remain retrievable. |
| Untrusted instructions | A page or transcript telling Nova to change policy/install a tool cannot cause promotion, credential disclosure or a new permission grant. |
| Missing decision spec | A generated candidate passes schema validation but cannot gain qualified trust without exact-artifact evaluation. Editing wording or model identity invalidates mismatched trust. |
| Local-only and private context | Unavailable local capability pauses or queues work; it does not trigger cloud fallback or leak private query context through an external adapter. |
| Budget / restart / failover | Concurrent subtasks and retries respect the shared limit; restart/promotion cannot reset spend or duplicate effects. Interrupted work resumes from its recorded checkpoint. |
| Correction / forgetting | A canary introduced into memory and derived research artifacts cannot be retrieved after forgetting, including through indexes and recovery paths governed by Nova's deletion contract. |
| Missing tool / service update | Nova proposes and tests a narrowly permitted capability; failed gates prevent promotion; rollback restores the known version and compatible state. |
| Useful reuse | A later matching task retrieves warranted findings or uses a qualified spec, identifies its version/evidence and avoids repeating already-satisfied work; stale/inapplicable material is not blindly reused. |

Before each implementation slice, specify meaningful test commands, fail-before/pass-after evidence for fixes, and application interaction checks. Use existing checks, not a weakened or duplicate suite. Every merge follows the same-PR plain-language LEDGER and CHANGELOG rules. Only report full CI green when current Actions evidence establishes it.

## 6. Owner decisions still open

1. **Initiative at first activation:** goal-directed background learning only, or goal-directed plus bounded curiosity? Both are in the target architecture. Recommendation for discussion: support both, with independent controls and budgets; choose the initial activation deliberately.
2. **Promotion authority:** within a mandate, which low-risk learned knowledge and qualified decision specs may activate automatically, and which artifacts require review? Existing high-risk approvals remain intact. Proposed distinction: source-linked knowledge retention is not executable artifact promotion. Thresholds and permissions are not invented here.
3. **Real-model evaluations:** Part 3 local-only versus stubs remains unconfirmed. A general desire for continuous learning does not resolve this specific pending exception.
4. **Budget defaults and notification cadence:** selectable compute/time/network/storage/spend limits, quiet periods and experiment limits. Draft does not invent numerical defaults or permission to spend.
5. **Access-challenge methods:** exact target environments, authorized methods and success criteria for specialized CAPTCHA/bot-check handling. Basic detection, resumability and truthful alternate-source handling do not require pretending this decision is settled.

We can refine this document in conversation before sending an implementation kickoff. Slice 0 can identify dependencies without resolving every future policy choice at once.

## 7. Delivery and ownership

**Session placement: existing LONG-RUNNING BUILD SESSION**, because it owns the active Interstitial work and queue context. Do not start a clean parallel coding session for this area until ownership and shared interfaces are inspected.

Codex documentation assignment: branch `docs/continuous-learning-spec-2026-11-06`, isolated worktree `/workspace/nova-planning`, owning this new file only, based on the pinned SHA above. No application code, shared ledger, packet or queue file is edited by this draft. No commit, push, PR, test run or builder dispatch is implied by this document's presence.

Builder reconciliation report fields: current task/branch/worktree/base; touched/shared files; current PR and live CI observation or UNKNOWN; existing Interstitial coverage against CL-01–08; conflicts or unavailable docs; proposed queue insertion and dependencies; next owner decision with options/recommendation. Mark delivered-to-builder only after Jeremy confirms he sent the attachment/prompt.
