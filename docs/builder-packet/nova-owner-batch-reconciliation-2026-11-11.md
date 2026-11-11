# Owner batch 2026-11-11: reconciliation with the ledger

**Source:** the owner's batch, filed verbatim as
[INPUT-2026-11-11-OWNER-BATCH.md](INPUT-2026-11-11-OWNER-BATCH.md). **Read at:** main `d84959ba`
(after PR #499). The served preview reports the same build (`GET /api/v1/version`: "Running d84959ba,
the latest merged build", read 2026-11-11).

**The owner's rule for this note:** "ledger wins on conflicts — flag any conflict back, don't silently
resolve it." So nothing here is resolved. Each conflict quotes both sides. Every decision that is the
owner's is in the ruling list at the end (R1 to R22). Nothing in Nova changes in this step: no queue
item is started here.

**IDs:** source-prefixed (F- = Fable, A- = Astra). **Parked, not to be improvised:** F-012
(conversation deletion), F-049 (handoffs workflow), Jarvis promotion, D8 Interstitial Part 3 (no eval
runs), slice 1b of ADR #481 (the projection module and its route, parked until the owner's Gemini
review). Each item says whether it touches them.

**Preamble.** The batch queues behind work already in flight: #499, the scroll fix (#486) and "#494's
comparison". #499 and #494 are merged (`d84959ba`, `2526f06d4`). "#494's comparison" is read here as
a follow-up to the merged icon-sizes PR; nothing in this note changes it.

---

## Conflicts with the ledger or prior rulings (summary)

Each is restated, with its evidence, under its item below.

| # | Item | The batch says | The ledger or a prior ruling says |
|---|---|---|---|
| C1 | 8 | "a full-viewport 3D memory graph … Port the experience" | ADR #481 §7, out of scope: "A diagram, a map of everything, 2D or 3D views, the "Stellar Map" draft (PR #207, left untouched)." Owner's Q7: "slice 1 is a list inside Memory; the diagram stays behind the picture gate." |
| C2 | 8 | "a Topic Map (clusters as super-nodes sized by memory count …)", "color modes by cluster / engram type" | ADR #481 Q11 (answered "yes"): "No people, organisations or topics in version 1 (F-060)". §7 out of scope: "Whole-corpus extraction and cluster summaries". Q4: "vectors not planned while the bundled SQLite refuses extensions". |
| C3 | 8 | "Settings hierarchy inversion and the collapsed-rail literal "v" are already-filed defects and belong to this item's first PR." | Ledger `2026-11-10-settings-rhythm.md` (PR #458, commit `46aeaf649`): both fixed, with a UI test. The served build `d84959ba` contains that commit. |
| C4 | 5 | "The Nov 7 failure: pairing codes expire in ~7 minutes, approval windows in ~2" | `docs/LEDGER.md:2829-2850`, entry **2026-10-30**: the same report ("about 7 minutes", "about 2 minutes"), deferred by the owner to a desk session. The code's clocks are 5 min (code), 2 min (reveal) and 10 min (approval); the 2-minute window is the reveal, not the approval. |
| C5 | 2 | "a failed task is "Needs you" amber only after the fix attempt fails or hits a tier boundary" | Ledger `2026-11-10-status-truth.md` (ruling D5): a failed task's problem is raised amber at once, without `stops`; migration 0028 made the open ones amber. No fix attempt precedes it. |
| C6 | 3 | "Relay v0.8 already implements … acceptance gate requiring exact tree-hash match"; "Coding runs it literally via the Relay adapter" | `docs/LEDGER.md:2746-2748` (M8b): the adapter was built against Relay **v0.9.0**'s contract v1, vendored byte for byte at `tests/support/relay-contract-v1.json`, which has no acceptance-criteria, tree-hash, browser-evidence or consent fields. CAPABILITY-INVENTORY:65 (M10c): "Relay's own accept/merge is still not used: the merge is Nova's, tier 3." The adapter starts Relay's worker with check `none` ("the test is Nova's to run", `src/core/providers/relay.ts:10`). |
| C7 | 4 (attachment) | Higgsfield: "MCP generations always consume paid credits"; "It attaches as an optional MCP connection" | Owner's standing constraint (`docs/plans/owner-priority-queue-2026-11-02.md:14`): "No account creation, paid calls, key access …". MCP host ADR (`docs/plans/mcp-host-adr-2026-11-09.md:18-24`): **PROPOSED**, "no paid call is made", owner second-model review required before any build; "Nova has no MCP host". |
| C8 | 7 | "design a gated public ingress (console auth in front)" | M4 §0 (`docs/plans/M4.md:25-37`): the console is loopback only, "A reverse proxy … pointed at the console port therefore gets **no** console rights", and the model "tightens today's behaviour, never loosens it". There is no console authentication to put in front. |
| C9 | 7 | "ship Headscale … on the hub, on from first boot, as Nova's own mesh" | M10 (`docs/plans/M10.md:105-110`): "Networking (router, DNS, firewall, Tailscale): tier 3, always", with snapshot, diff, apply and a dead-man's switch; hard limit (`:125`): "No change to any real network configuration, including the owner's … Tailscale Serve settings". |
| C10 | 4, 8 | Legacy precedent "on the Dell, arialabs/nova v0.1.0-alpha tree", a "2026-05-05 feature-flags design", ForceGraph3D and pgvector | SYSTEM-MAP:9: `github.com/arialabs/nova` is "Python, dormant since Apr 2026 (OpenClaw-era). Reference only. Do not build on it." A 2026-05-05 design is after "dormant since Apr 2026". The batch's "port the experience, not the engine" agrees with "reference only"; the dates and description do not match. |

---

## Cross-cutting: the QA/UX loop (standing, not a queue slot)

**What exists.**
- Walker-like checks: the UI gate (`npm run test:ui`, `tests/ui/*.test.ts`, Chromium and WebKit), the
  served walkthrough (`scripts/shots.js`, 134 checks per the 2026-11-11 ledger entry), posture tests
  (`docs/plans/fold-postures.md`), failure postures already probed (offline, slow and unanswered reads,
  unknown address: ledger `2026-11-10-status-truth.md`), axe advisory (`npm run ui:axe`).
- The measured gates the batch names exist: CLS/INP vitals (`tests/ui/m9-vitals.test.ts`,
  `tests/ui/vitals-support.ts`), contrast in the theme check (`npm run check:themes`), the 8 ms scroll
  budget (owner ruling 2026-11-11; #486).
- Designer: DESIGN-SYSTEM §0 (art direction, the slop list), the styleguide, and the per-PR slop check
  (`OPERATING-RULES.md:110`). The reference board is `docs/builder-packet/ui-references/`.
- Verifier: independent review is already required before merge (owner queue
  `docs/plans/owner-priority-queue-2026-11-02.md:14`); "Verified needs evidence"
  (`docs/plans/M10i.md:21`).
- "Every confirmed defect becomes a permanent probe" matches the test-first rule every ledger entry
  records ("fails on the old code").

**Conflicts.** None with the ledger. One tension to rule (R19): `OPERATING-RULES.md:80` says "the build
stays single-builder, for coherence", and ChatGPT and Gemini are reviewers. The loop's Walker,
Designer and Verifier seats are not builders, so this reads as compatible, but which seats fill them is
the owner's.

**Dependencies, blockers, parked items.**
- **Pipeline noise blocks "per-merge" trust.** The full gates carry known pipeline bugs: #463, #490,
  #495, #497, #498, #488, #486 (open), plus #462, #464, #470, #472, #475, #476, #477, #483, #491. A
  Walker finding must not be raised from one of these; each is cited, never called a flake.
- **F-049 (parked) is touched if the schedule is built on the handoffs workflow.**
  `.github/workflows/handoffs.yml` wakes a headless Claude on `handoffs/inbox/`. A scheduled QA seat
  must not use or change it while F-049 is parked.
- **D8 (parked):** a scheduled loop must not run the Interstitial evals (`features.interstitial`,
  `src/config.js:44-48`; ledger `2026-11-07-interstitial-evals.md`).
- **Standing reminder:** the Walker uses Nova's own browser or the test browsers against the served
  preview, never the owner's personal browser; progress is read from `GET /api/v1/version`.

---

## Item 1 · [BUILD] Screen capture, first-party

**What exists.**
- The Capture API and Screenpipe ingest are built: M6a (`src/core/capture/`, Screenpipe REST adapter
  `src/core/capture/screenpipe.ts`, default `http://localhost:3030`) and M10h (the spoke data path,
  `src/core/capture/sync.ts`, `src/device/carrier.ts`, migration 0023). CAPABILITY-INVENTORY:44.
  Consent off by default per source and device, private windows dropped, exclusions, screening job 1
  (`capture-sensitive` v1), forgetting as real deletion.
- Stated gaps (CAPABILITY-INVENTORY:44): "a real Screenpipe is the owner's check"; native desktop app
  activity (ADR-2); Android; meeting/browser/sensor adapters. M10h: "no real Screenpipe is installed
  anywhere (that needs your …)" (`docs/plans/M10h.md:319`).
- **F-034 is already implemented:** capture-derived memories wait for review (ledger
  `2026-11-10-promotion-screen.md`: promotion screens every event, a block is refused, otherwise the
  memory "waits for the person's review unless they typed the words themselves"); review surfaces only
  in Memory and the digest (`ui/js/view.js:540`, "owner ruling on F-034"); F-038 review state (ledger
  `2026-11-10-f-038-review-state.md`); held items' Keep and Drop at rest with no count or badge (ledger
  `2026-11-11-held-actions-at-rest.md`, PR #499).
- iOS as a non-source agrees with LOCAL-FIRST-AND-DEVICE-MESH:27-28 ("the phone is a window"; native
  capture only "where the OS allows").

**Conflicts.** None with the ledger. The scope word "first-party" is open (R9): Screenpipe behind the
existing API already exists; a capture component of Nova's own would fall under ADR-2 ("capture … native
low-resource components are Rust", ARCHITECTURE-AND-DECISIONS:7).

**Dependencies, blockers.** A real Screenpipe on the owner's desktop is the owner's check (consent, a
real install). No parked item is touched, provided the review queue gets no popup, badge or count
(F-034).

---

## Item 2 · [DESIGN FIRST] Self-investigation / auto-fix loop

**What exists.**
- Repair playbooks: `src/core/resilience/playbooks.ts` (NOVA-SPEC §7, M7 plan §2): a problem kind
  carries steps for the person and, "where one is safe", a repair Nova makes itself; "safe" means it
  cannot lose or change the person's data; each attempt is recorded; a problem is marked dealt with
  "only when the repair could tell the cause is gone". Repairs in `src/core/resilience/repairs.ts`.
- Problems and severity: ledger `2026-11-10-status-truth.md`; orb states `docs/plans/orb-states.md:50-70`.
- Governed change: ADR-9 (ARCHITECTURE-AND-DECISIONS:23): worktree, tests, health gates, versioned
  release, canary, automatic rollback; core, security and permission changes need tier 3. The M7
  changes pipeline is `src/core/changes/*` (CAPABILITY-INVENTORY:35).
- Tiers: owner ruling `INPUT-2026-11-09-TIER-RULING.md`, decision 8 (direction: most things without
  asking, with three proposed floors).
- Diagnostics: `src/core/diagnostics/index.ts`.

**Conflicts.**
- **C5, D5.** The batch: "a failed task is "Needs you" amber only after the fix attempt fails or hits a
  tier boundary." The ledger (`2026-11-10-status-truth.md`): "Per D5 a failed task's problem is raised
  without `stops` (ledger.ts) and migration 0028 makes the ones already open amber." Today amber comes
  at once, with no fix attempt in between. (R10)
- **Tension, not a ledger conflict:** "never per-known-bug scripts" against today's playbooks, which
  are per problem kind (`server-crashed`, `connector-down`, `name-lookup` …). Per kind is not per bug,
  but the design must say whether it generalises them or replaces them. (R11)

**Dependencies, blockers.** Any code fix Nova makes to itself is self-modification under ADR-9 and goes
through the changes pipeline; "every auto-fix ships with a regression test and a rollback" matches
ADR-9. Parked items: none, unless the "journal" is built on the handoffs mailbox (F-049) or the
evidence-gathering step runs outside research (D8).

---

## Item 3 · [BUILD] Work system: promote Relay's pipeline as the spec

**What exists.**
- The Relay adapter: `src/core/providers/relay.ts` (M8b, PR #220; `docs/LEDGER.md:676-679`,
  `:2746-2770`). It briefs Relay over contract v1 (`CONTRACT_API = 1`, `relay.ts:34`), starts the
  worker with check `none`, reads Relay's worktree itself and compares it with Relay's own list of
  changes before copying them back.
- Coding runs (M10c, `src/core/coding/*`, `docs/plans/M10c.md`): Relay is one agent a run can use
  (`agent: relay`); the merge is Nova's, tier 3 (CAPABILITY-INVENTORY:61, :65). Nova already checks an
  exact tree digest: `digest(committed.entries) !== digest(after.entries)` fails the run
  (`src/core/coding/index.ts:449`), and records `tree_digest`.
- The Work Ledger and verification layer (WORK-LEDGER-AND-VERIFICATION:7-19): states, brief and report,
  "checks the evidence against the requirement before the task may be marked done", read-back for
  high-stakes classes. "The implementer never verifies its own work" matches ADR-8 ("Nova … checks the
  work itself").
- The vendored contract has `profile` (`id`, `revision`, `name`, `engine`, `model`, `effort`) and a run
  record with `profile`, `worktree`, `validation` and `review` (`tests/support/relay-contract-v1.json:168`,
  `:244-250`).

**Conflicts.**
- **C6.** Version and features: the batch names Relay v0.8 with a plan carrying acceptance criteria, a
  false-pass-guarded validation, a consented build stage, browser-verifier evidence and an exact
  tree-hash acceptance gate. Nova's integration was built against Relay v0.9.0's contract v1
  (`docs/LEDGER.md:2747-2748`), and that contract has none of acceptance criteria, tree hash, browser
  evidence or consent (zero occurrences in `tests/support/relay-contract-v1.json`). The features may
  exist in Relay beyond its contract; Nova cannot use what the contract does not carry. (R12)
- **C6, merge.** "Coding runs it literally via the Relay adapter" against CAPABILITY-INVENTORY:65:
  "Relay's own accept/merge is still not used: the merge is Nova's, tier 3", and the adapter's check
  `none`. Running Relay's gates "literally" changes who validates and who merges. (R12)

**Dependencies, blockers.**
- Relay's current contract (with the stages the batch lists) must be filed before the spec can cite it.
- Naming: "role profiles" collides with PROFILES-AND-CUSTOMIZATION (the person's settings archive). (R13)
- **D8 (parked):** the "research: source-check + second-model pass" composition overlaps the
  Interstitial Research skill, which ships off with both templates failing their evals (ledger
  `2026-11-07-interstitial-evals.md`). Building it would touch D8. (R21)
- **F-049 (parked):** handing work between implementer and verifier seats must not be built on the
  handoffs mailbox.
- The batch marks this item BUILD, but the spec it asks for (stages per task type, role profiles) has no
  ADR yet. Building without one would mean the builder sets the design. (R12)

---

## Item 4 · [DESIGN FIRST] Feature packs (attachment: media generation, Higgsfield)

**What exists.**
- **A flags mechanism exists:** `config.features` (`src/config.js:44-49`): `features.interstitial`
  (`NOVA_FEATURE_INTERSTITIAL`) and `features.memory_gate` (`NOVA_FEATURE_MEMORY_GATE`), off unless set
  on; "a flag that is off hides its skill everywhere" (`src/skills.js:109`); ledger
  `2026-11-09-memory-gate.md`. This is the "flags are the mechanism" half.
- The extension model (EXTENSION-MODEL.md): lifecycle discover → review permissions → install → health
  check → enable → update → disable → remove; "A removed extension leaves no residue". This is the
  closest existing shape for a pack's enable, disable and download.
- Navigation: a registry with reachability tests (`tests/navigation-registry.test.js`,
  `docs/plans/navigation-reachability-2026-11-02.md`); "Capture" is a secondary view under Settings
  (CAPABILITY-INVENTORY:72).
- MCP: ADR-6 (MCP is the extension protocol); the MCP host ADR is PROPOSED (`docs/plans/mcp-host-adr-2026-11-09.md:18`); "Nova has no MCP host"; OAuth MCP servers wait for broker-held OAuth (`:78`, `:160`).

**Conflicts.**
- **C7, Higgsfield.** "MCP generations always consume paid credits" against the standing "no … paid
  calls" (`owner-priority-queue-2026-11-02.md:14`) and the MCP ADR's hard limit "no paid call is made".
  Higgsfield also needs OAuth, which waits for the broker's OAuth row, and an MCP host that is not
  built. (R15)
- **C10, precedent.** The legacy feature-flags runbook and 2026-05-05 design are not in this repository
  and SYSTEM-MAP:9 describes the legacy tree differently (Python, dormant since April 2026). (R22)

**Dependencies, blockers.**
- "A disabled pack leaves ZERO UI trace" changes what the navigation and reachability tests assert and
  what CAPABILITY-INVENTORY claims (Capture, Topology). The design must amend those tests in the open.
  (R14)
- **D8 (parked):** `features.interstitial` is a flag; a packs design must not flip, move or re-gate it.
- **Jarvis promotion (parked):** design packages are extensions too (EXTENSION-MODEL "Design system");
  a packs design must not promote Jarvis into a pack.
- The legacy precedent must be filed into the packet (Muse or the owner) before the design can cite it.

---

## Item 5 · [BUILD] Pairing clock fix

**What exists: the clocks in code today, quoted.**
- `src/core/mesh/wire.ts:19-20`: `// A code works once, for five minutes.` /
  `export const PAIRING_CODE_TTL_MS = 5 * 60_000;`
- `src/core/mesh/enroll.ts:25-27`: `// A request must be revealed soon after the join, and approved within ten minutes of the reveal.` /
  `export const JOIN_REVEAL_TTL_MS = 2 * 60_000;` / `export const JOIN_APPROVE_TTL_MS = 10 * 60_000;`
- The code lives in hub memory between join and reveal; a restart forgets it and the request expires
  (`enroll.ts:231`, `:251-256`).
- Not pairing clocks, for completeness: passkey approval `APPROVAL_MS = 5 * 60_000`
  (`src/core/passkeys.ts:26`, `src/broker/policy.ts:18`).
- The design states the code clock: M4 §1, "Crockford-32 8-character codes, 5-minute TTL, single use"
  (`docs/plans/M4.md:75`).
- The defect is already in the ledger: `docs/LEDGER.md:2829-2850` (2026-10-30, owner decision): real-phone
  pairing deferred to a desk session; "The 2-minute reveal window is very likely the "approval window"
  the owner hit"; the agreed direction "the windows get longer, or the flow tolerates a retry without
  starting over … Both keep commit-then-reveal and the single use of a code."

**Conflicts.**
- **C4.** "~7 min / ~2 min" against the code: no clock is 7 minutes. The code is 5 min; the reveal is
  2 min after the join; approval is 10 min after the reveal. The ledger explains the "~7" as the owner's
  observation, not a constant. The batch dates the failure "Nov 7"; the ledger records the same numbers
  on 2026-10-30, and no 2026-11-07 pairing attempt is recorded. (R6)

**Dependencies, blockers.** Changing the 5-minute TTL amends M4 §1 (a security design) in the open.
Real-device verification is a desk session with the owner. Unblocks item 6. No parked item touched.

---

## Item 6 · [BUILD, after 5] Native iOS spoke app

**What exists.**
- The PWA is the client on every platform (LOCAL-FIRST-AND-DEVICE-MESH:26); native apps "exist for
  deeper device integration … Native clients consume the same APIs and the same design-system packages
  (tokens compile to native themes); no feature may be native-only by accident" (:28).
- iOS-specific work so far is PWA-side (`docs/plans/ios-status-bar.md`). Pairing is the M4 flow (`/pair`,
  `ui/pair.html`, `ui/js/pair.js`). No native app code and no roadmap milestone for one
  (ROADMAP-AND-GATES has none).

**Conflicts.** None with the ledger. Open design points: ADR-2 makes device-native components Rust;
an iOS app shell is Swift or a web view. (R8)

**Dependencies, blockers.** Item 5 first (owner's sequencing). Paid Apple developer signing is the
owner's account and payment; builders create no accounts. An iOS build needs macOS and Xcode; this
build host is WSL and CI is Ubuntu. No parked item touched.

---

## Item 7 · [DESIGN FIRST] Domain, ingress, bundled mesh

**What exists.**
- Mesh settings (`src/config.js:80-110`): `NOVA_MESH_URL` (https with `NOVA_TLS_CERT`/`NOVA_TLS_KEY`, or
  http only with `NOVA_MESH_TRANSPORT=proxy|network`, "an encrypted network, such as a tailnet"),
  `NOVA_MESH_PUBLIC_URL` (the address devices are told), `NOVA_MESH_ADDRESS`, `NOVA_MESH_SITE`
  (`home`/`cloud`), and the stable-name driver `NOVA_MESH_NAME_CONTROL` with `NOVA_MESH_NAME_TOKEN`
  (`src/core/index.ts:877-908`, `src/core/mesh/handover.ts:20-21`; "only a loopback stand-in in this
  build").
- The owner's preview reaches the device door through Tailscale Serve 9446 (`docs/LEDGER.md:2831-2833`).
- Trust model: M4 §0 (console loopback-only; device sessions after pairing; public routes limited to
  enrollment, `/pair`, `join.sh`, the device-agent tarball and `mesh/hello`).
- Endpoint exposure audit: `nova-endpoint-exposure-audit-2026-11-08.md`.
- No Headscale, Funnel equivalent or public ingress anywhere in `src/` or the plans.

**Conflicts.**
- **C8.** "console auth in front" against M4 §0: there is no authenticated remote console; a proxy
  gets no console rights by design, and the model may not loosen. (R16)
- **C9.** "on from first boot" against M10's networking tier 3 with dead-man's switch and the hard
  limit on real network configuration. (R17)

**Dependencies, blockers.** DNS for `nova.arialabs.ai` and any certificate are the owner's (R18).
Headscale is a new bundled dependency (OPERATING-RULES:19 needs a justification; BSD-3). Coexistence
with the owner's hosted tailnet and Serve ports is a design question (R17). No parked item touched.

---

## Item 8 · [BUILD, sequenced] Visible UI + immersive memory ("the Brain")

**What exists.**
- ADR #481, `docs/plans/knowledge-graph-adr-2026-11-10.md` (F-057 ≡ A-060): Accepted 2026-11-10;
  "Stage 2: Not opened" (`:30`); only the owner opens it by changing the line to "Opened <date>
  (owner)." The guard `tests/core/graph-guard.test.ts` fails any `graph_` table, view or index until
  then (ledger `2026-11-10-graph-table-guard.md`). Owner ruling 2026-11-10: "Accepted" alone never
  unlocks graph tables.
- No pgvector and no vectors: the bundled SQLite refuses extensions (`:68`); Q4 "vectors not planned".
  Nodes are pointers (`:84-85`, "A node points at one authoritative record"). Forget is absolute
  (§4). This matches the batch's "do NOT port the legacy engine".
- Slice 1a (filter, true source line; ledger `2026-11-10-memory-filter.md`) and F-038 (review state) are merged; slice 1b (projection
  `src/core/graph/` and `GET /memory/{id}/sources`) is **parked** until the owner's Gemini review
  (`:26-28`, `:475`).
- PR #207, "Stellar Map: memory drawn as a star system", open, never to be touched (Q12; SYSTEM-MAP:27).
- **The two "already-filed defects":** filed as UI items 25-27 and fixed by PR #458 (merged
  2026-11-10, commit `46aeaf649`), ledger `docs/ledger/2026-11-10-settings-rhythm.md`: "the Settings
  group title was caption size (smaller than the rows it headed) … It is now one step larger than its
  rows" and "The slim rail's version stamp showed a literal "v"; it now shows the short version
  (0.1.0)". Code: `ui/js/components.js:1174-1182` ("never a bare letter (slim rail; the owner found a
  lone "v" reading as a stray letter, 2026-11-10)"). Test: `tests/ui/settings-rhythm.test.ts`.

**Conflicts.**
- **C1.** The 3D graph against ADR #481 §7 and Q7 (quoted in the summary table). Building it is a
  change to an accepted ADR, which is the owner's. (R1)
- **C2.** The Topic Map and cluster/engram colour modes against Q11, §7 and Q4. Clusters need either
  topics (no, in v1), model derivation (out of scope; Q5 local-only if ever) or vectors (not planned).
  Clusters from recorded pointers only (source, device, conversation) would stay inside the ADR. (R2)
- **C3.** The two defects are recorded fixed and served. If the owner still sees them, that is a new
  defect or a regression on some surface the test does not cover, and needs evidence. (R5)

**Does a 3D graph surface need what slice 1b or stage 2 gates?** Yes, at least one of them:
- Any graph surface needs the projection (nodes and edges from recorded pointers). That is slice 1b,
  **parked**. Building item 8 before the Gemini review returns would improvise a parked item.
- A whole-corpus graph ("a map of everything") is outside stage 1's shape (one memory, one hop, p95
  under 200 ms proposed, `:142`). Whole-corpus at interactive frame rates is the "measured miss" that
  opens stage 2, and stage 2 also needs F-058 (a thread id) and the owner's "Opened" line. (R3)
- "Live reaction to retrieval" needs retrieval events exposed to the UI; retrieval today is a
  shared-word scan (Q4).

**Dependencies, blockers, parked items.**
- **Slice 1b (parked):** directly touched. **Stage 2:** touched for any stored or whole-corpus form.
- **PR #207:** overlaps in subject ("memory drawn as a star system"); must stay untouched. (R4)
- **Jarvis promotion (parked):** "visible UI" must not promote the Jarvis design (ledger
  `2026-11-08-jarvis-compositions.md`, step 1, for owner reaction only).
- **F-012 (parked):** conversation turns are graph nodes (`turn`, ADR `:121`); a surface that draws
  turns depends on how a conversation is deleted.
- The reference input (Muse's and Astra's merged reviews of the legacy tree) is not filed yet; the batch
  says to design against it, so design cannot start before it lands.
- "Visible UI" is not defined further in the batch. (R1)

---

## Proposed ordering by value per token (PROPOSAL, not a ruling)

The owner's numbering stays authoritative where it states sequencing: **5 before 6**, and item 8's
first PR carries the two defects. Inside that, by value per token:

1. **Item 5, pairing clocks** (small: constants, tests, an M4 amendment; unblocks 6 and the desk
   session). After R6 and R7.
2. **Item 8's two defects, re-walk only** (near zero: confirm on the served build; act only on new
   evidence). After R5.
3. **Item 4 design** (docs; settles where Coding, Capture and media sit, which items 1 and 3 need).
4. **Item 2 design** (docs; mostly generalises existing playbooks).
5. **Item 7 design** (docs; needs R16 to R18 before it can be more than options).
6. **Item 1** (most of it exists; the remaining build depends on R9; the real-Screenpipe check is the
   owner's).
7. **Item 3** (large; blocked on Relay's current contract and R12).
8. **Item 6** (after 5; blocked on the owner's signing account and a macOS build host).
9. **Item 8, the Brain** (largest; blocked on the legacy reviews, the ADR amendment (R1 to R3) and the
   Gemini review that unparks slice 1b).

The QA/UX loop starts now beside the queue, cheapest first: the Walker over the served preview with
the existing walkthrough and UI gate, findings filed as issues with evidence.

---

## Ruling list for the owner

Each is the owner's decision. None is decided here.

- **R1** (item 8, C1): amend ADR #481 to admit a whole-memory 3D surface (passing the picture gate), keep 2D/3D views out of scope, or hold item 8 to the visible-UI defects until stage 2?
- **R2** (item 8, C2): Topic Map clusters from recorded pointers only (source, device, conversation), reopen Q11 and Q4 for topics or vectors, or drop the Topic Map?
- **R3** (item 8): does item 8 wait for your Gemini review (slice 1b), and does a whole-corpus view count as stage 2's "measured miss", or must it stay on the one-hop read-time projection?
- **R4** (item 8): confirm item 8 is built fresh with PR #207 untouched (Q12), or rule on #207 itself?
- **R5** (item 8, C3): are "Settings hierarchy inversion" and the collapsed-rail "v" new or regressed defects (with the surface and evidence), or closed by PR #458?
- **R6** (item 5, C4): is "Nov 7" the 2026-10-30 report or a second failed attempt with new evidence?
- **R7** (item 5): longer windows (for example code 15 min, reveal 10 min, approval kept 10 min), a re-reveal under the same live code, or both, as the 2026-10-30 entry proposed?
- **R8** (item 6): a native Swift app, a web-view shell around the PWA, or a Rust core per ADR-2; and who supplies the Apple developer account and a macOS build host?
- **R9** (item 1): does "first-party" mean Screenpipe behind the existing Capture API (built; your real-Screenpipe check remains), or a capture component of Nova's own (ADR-2, Rust, new)?
- **R10** (item 2, C5): keep D5 as built (amber at once), or change it so a failed task shows as being repaired and turns amber only when the fix fails or reaches a tier boundary?
- **R11** (item 2): generalise the existing repair playbooks into invariant-based detection, or replace them; and do code fixes go through the ADR-9 changes pipeline with tier 3 for core?
- **R12** (item 3, C6): file Relay's current contract (the batch cites v0.8; Nova vendors v0.9.0's contract v1 without those stages), decide whether Relay's own gates and merge replace Nova's check and tier-3 merge for coding, and whether item 3 gets an ADR before build?
- **R13** (item 3): a name for Relay's "role profiles" that does not collide with Nova's profile (the settings archive)?
- **R14** (item 4): build packs on the existing `config.features` flags, on the extension lifecycle, or both; and may "zero UI trace" amend the navigation and reachability tests and inventory claims?
- **R15** (item 4, C7): allow paid Higgsfield calls (with a spend cap), or keep the no-paid-calls constraint until you lift it; and does Higgsfield wait for the MCP host ADR's acceptance and broker-held OAuth?
- **R16** (item 7, C8): a new authenticated remote-console role reached through the ingress, or an ingress that only reaches the device door with paired-device sessions?
- **R17** (item 7, C9): Headscale on from first boot, or offered at setup as a tier-3 change with the dead-man's switch; and how it coexists with your hosted tailnet and Serve ports?
- **R18** (item 7): you set up DNS and certificates for `nova.arialabs.ai`, or Nova does it as a tier-3 networking change once built?
- **R19** (QA/UX loop): which seats or models fill Walker, Designer and Verifier, on what schedule and token budget, on a vehicle other than the parked handoffs workflow?
- **R20** (ordering): accept, change or reject the proposed ordering above?
- **R21** (item 3): leave the "research" composition out until D8 is unparked, or include it now?
- **R22** (items 4, 8, C10): file the legacy references (Muse's and Astra's reviews, the feature-flags runbook and 2026-05-05 design) into the packet, and correct SYSTEM-MAP:9 if its description of the legacy tree is wrong?
