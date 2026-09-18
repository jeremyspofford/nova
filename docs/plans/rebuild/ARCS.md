# Nova — the arcs

What Nova is being built toward, and where v4 is along each line.

`ROADMAP.md` answers **what is next**. This answers **what is Nova becoming**.
Nothing here is scheduled, rated or ranked for priority; the near-term queue
lives in the roadmap and is the owner's to order. This is the map the queue
moves across.

Written 2026-09-18 from the intent corpus — v3's 51-item backlog
(`docs/archive/ROADMAP-v3.md`), the 49 design documents in `docs/plans/`, the
28 v4 slice docs, the release trees, and the owner's own words throughout.
Not from a diff of shipped code. An earlier version of this section was built
that way and got it wrong in both directions: it reported unbuilt plans as
defects, and it retired three capabilities the owner intends to have.

---

## The thesis

One sentence, said four ways over two years:

> "That way **nothing is on the user to decide and manage**." (2026-09-15)
>
> "I can't think of every edge case so we need to build nova to be able to
> **think on her feet**." (2026-09-10)
>
> "Nova should do the work ad-hoc to get the resources live, **not read stale
> shit**." (2026-09-14)
>
> "**everything is going to be wide open to Nova.** if it can't figure out safe
> shit, it in itself is shit and we'll scrap it." (2026-09-03)

Every arc below is a facet of that. Where an arc seems to want a switch, a
prompt or a click, it is probably being designed wrong.

## How to read an arc, and the one rule that governs all of them

The 2026-09-03 ruling (`no-approvals.md`) deleted exactly **one** of v3's 51
items outright — #29, operator consent. Everywhere else it killed a *named
mechanism* inside an item while the capability underneath survived: 14 of
them. And in most of those, v3 had **already built a non-approval rail beside
the gate** — eval floors, spend ceilings, protected-path tripwires,
containers, verb allow-lists, catalog-verified writes, the honesty guards.

So when an arc meets an old design:

- **The gate is dead.** Consent cards, dispositions, earned autonomy,
  per-agent and per-device grants, `fs_roots`, deny-roots, operator-merge
  locks, "enable it yourself" toggles standing in for a capability.
- **The capability is not.** It is what the owner asked for.
- **The rail usually already exists.** Name it instead of inventing one.

A check may state that a call **cannot** run — unpaired, offline, malformed,
a model that does not exist. It may never decide that it **may not**.
`services/core/tests/test_no_approvals.py` is what refuses the day someone
rebuilds one.

---

## 1. Autonomy — she acts unasked, and without asking

The arc that produced the ruling, and the one with the most heat in his own
words.

> "that needs to be a **continuous ongoing process that I don't even think
> about or approve**. She just needs to do it, score improvements, and if it's
> degrading, roll it back and try something else." (2026-08-07, v3 #47)

The case study is v3 #46: he asked for a model to be made available and "got
**31 minutes of instructions to click**", because no agent could write to the
tables that mattered.

**Already decided**
- **Nothing self-modifies until it can be graded** (v3 #36) — the durable half
  of the self-improvement arc; the operator-approval half is dead.
- Six rails, all non-approval: a protected-paths tripwire (*"a loop that can
  edit its brakes has none"*), an eval floor as a sandbox stage, a spend
  ceiling that refuses to start, a standing goal authorising a claim rather
  than a click, research→score with a **different-model judge**, auto-merge
  plus a rollback watcher living outside the thing it watches (v3 #47).
- Urgency is a property of the check, declared in code, and exactly one family
  may claim it (S11).
- The ideator proposes and never acts (v3 #34).

**What v4 has** — the hourly `watch` beat over ~13 checks and a daily `digest`
(S11); she may act on anything her tools allow in the same traced turn and the
digest reports what she did; quiet is computed rather than claimed, and the
engine's own death breaks the silence; the Inbox she can read with her own
`notices` tool (S25); timers in three kinds including a real model turn while
nobody watches (S09).

**Next move** — the heartbeat's missing half: nothing yet periodically asks
*"does anything need Jeremy?"* as an open question rather than a checklist
(v3 #45, three DECIDE items open). It rides the scheduler that already exists.
Depends on nothing; the cost controls are the design work.

**The friction log belongs here.** v1 had a `Friction` page where the owner
logged what annoyed him and "Fix This" dispatched a pipeline task with the
service logs auto-attached; its planned next steps were a friction→memory
pipeline ("if the memory system knows 'file uploads crash when disk is >90%
full,' future tasks can be warned") and GitHub issue export. That is the
**human-to-Nova work intake** this arc otherwise lacks — the Inbox carries
what *she* noticed, and nothing carries what *he* noticed.

---

## 2. Honesty, observability and reliability

Four of v3's six CRITICAL items. The thesis is v3 #39's own sentence: *"she
was not blind, she was **reassured**, which is worse."* This is the arc the
ruling explicitly keeps whole — the guards *"catch HER lying, they never ask
HIM."*

**Already decided**
- Discover failure stores from the catalogue at call time, never from a
  maintained list; an unclassified failure-shaped table forces `INCOMPLETE`
  at runtime (v3 #39).
- Derive the verdict, never conflate: "scored 2/7" and "the harness crashed"
  are different outcomes (v3 #51).
- Traces answer *why*; the audit log answers *what happened* (v3 #3).
- Refresh before judging (v3 #50). Refusals are first-class, with reasons.
- A degrading model passed as a reply is a **failure that retries on the
  standby**, not a reply (v3 #51).

**What v4 has** — the guard family (`narration`, `capability_claim`,
`consent_claim`, `deferral`, `bare_intent`, `state_claim`, `presented_listing`,
`delegation_claim`, `deleted_file`, `stated_spend`, `pulled_model`,
`stack_claim`) with one guard-vetted retry; the markup rule, so prose never
dispatches; `turns` + `turn_spans` from turn one; the Activity page; the
governance ledger as a record and never a gate; `tools/where-did-that-come-from.sh`.

**Next move** — v3 #42 is the open wound and it is *not* fixed: **she answers
from the model's weights and calls it memory**, measured 0/3 → 2/5 and left
there. Its own note says the cause "is not laziness, which is why a prompt
cannot fix it". Three questions were to be answered in a design doc before any
code. That doc does not exist.

Known misses, pinned rather than hidden: the narration guard's reported-speech
homograph (`notes.md` → "notes"), the `state_claim` accepted-miss list, and a
device named "office" arming the state guard on unrelated prose.

---

## 3. Voice and presence

The only arc v3 ever labelled *"the core arc."* Five separate "requested"
stamps in a single day, and the owner reviewing orb frames by eye.

**Already decided**
- **Wake word is the target UX** — he chose it over the recommended
  push-to-talk; PTT ships anyway as the fallback (v3 #1).
- Local-first Kokoro-class TTS and faster-whisper STT; premium cloud is a
  keyed opt-in, never the default.
- **Honest platform limit, not wished away:** a PWA cannot listen in the
  background or with the screen locked.
- The face is **stylized androgynous — a presence, not a person** (v3 #2).
- Register: *"Jarvis-from-Iron-Man / Sarah-from-Eureka — warm, wry, concise"*;
  "what time is it?" gets the time, not a paragraph (v3 #13).
- **Position beats emphasis** — identity goes LAST in the prompt; the success
  test is that a new agent or route gets Nova's voice with no way to bury it
  (v3 #15).
- Voice audio is biometric-adjacent: explicit opt-in, local only, clips
  browsable and deletable (v3 #11).

**What v4 has** — none of it. v4 rebuilt the spine, not the presence. The
design system survived, though: v1's custom teal is v4's accent
(`--accent-500: 25 168 158` = `#19A89E`, `apps/web/src/index.css`), and
amber-for-thinking survives in the orb and the home-screen icon.

**Next move** — this arc is untouched in v4 and that is a position on the map,
not a defect. Its natural entry point is TTS, because it needs nothing else:
the presence views consume `speaker.level()` and a `setActivity` contract that
both have shipped designs.

---

## 4. Memory and knowledge

Three CRITICALs. Hand her anything — a URL, a video, a PDF, a photo of a
letter — and she knows it later, linked, sourced, and forgettable on request.

**Already decided**
- **Link at write time** (v3 #27). *"Fix the data, not the renderer."*
- **Links anchor; tags may only merge the unanchored** — the owner picked
  Option B on 2026-07-28 (v3 #37).
- Identity is a UUID plus sha256, **never the filename**; bytes are
  content-addressed on disk (v3 #22).
- Forget is a **content-hash tombstone**, never a silent splice — *"a log that
  quotes what was forgotten has not forgotten it."*
- Provenance tier (`mechanical → ocr → vision`) rides into the turn as a
  caveat.
- Live beats stored, and **which source wins is code, not judgement**
  (`live_facts.lines()`).

**What v4 has** — recall measured honestly (6/20 → 12/20 answer-in-context)
with chunking, stemming, a derived floor and local embeddings; **recall may
return nothing and says so** (confident answers to unanswerable questions 6/6
→ 0/6); distillation into dated notes with `subject`/`said_at`/`source`/
`superseded_by`; the live-facts check that runs before the prompt is composed
and marks itself `unasked`; attachments landing in the workspace she already
reads (S28).

**Next move** — the largest named ceiling is in v4's own carries: on a
semantically-found hit **the excerpt loses the answer**, because the snippet
centres on query-term matches and a semantic hit shares no terms, so it falls
back to the head of the unit — which in a transcript is the question, not the
answer. The honest fix needs a semantic anchor and costs an embed call per long
hit, so it needs measuring first. Also parked with its design already agreed:
a **memory page** (`GET /notes` in the memory service, `/memory` in the web
app), deferred by the owner 2026-09-11.

A warning recorded by the people who made it twice: **the recall fixture is one
sample of a noisy generator** — three runs of identical code scored 7/7/10 and
12/12/14. No later slice should claim a recall win on twenty questions.

---

## 5. Reach — computers, browsers, machines, the house

His most expansive ask, and the arc where v4 has more than the roadmap
previously credited.

> give her the ability to "**do things on the desktop, and throughout the
> machine**" — mouse, keyboard, arbitrary apps. Every OS he touches: macOS,
> Linux, Windows, WSL, and "hopeful" for Android/iOS. (v3 #43)

**Already decided**
- **The transport is not the decision.** The control is a **per-machine verb
  allow-list resolved to argv by a sidecar**, because no line of code can
  refuse `rm -rf /` from free text (v3 #48).
- Authority leaves core only as **signed envelopes verified on the device**;
  the model never talks to the daemon.
- Home Assistant: HA Container as a compose service, **IP-based devices only
  under WSL2** (no USB-radio fights), a dedicated HAOS box later —
  *"Nova-side integration identical either way"* (v3 #35).
- Vision input is a **prerequisite** for the screenshot → reason → act loop
  (v3 #23).

**What v4 has — more than "nothing"** — `apps/novad`, a pure-Go daemon on a
paired Linux box holding an outbound WebSocket, executing only ed25519
**one-use signed envelopes verified on that machine**, with a hash-chained
local audit replayed upstream and a loud `device.audit_break`. Nine device
tools are registered: `device_run` (argv-only), `device_write_file`,
`device_launch_app`, `device_list_apps`, `device_read_file`,
`device_list_files`, `device_info`, `device_list`, `device_notify`. What is
absent is **browser automation and GUI/desktop control** — not "computer
control".

**Next move — a browser of her own.** The owner's ask, 2026-09-18: an internal
Chromium sandbox **only Nova uses**, for two jobs — (a) spin up what she is
working on and QA her own changes; (b) do what people do on the internet: find
resources, watch videos.

**This is a re-port, not a new build.** v2 shipped it: `browser-worker/` at
`v0.5.0-alpha` is a Playwright service, session-scoped and *orchestrator-only*,
with one persistent context per domain (logins survive restarts) and — the
part that matters — **snapshots as a numbered list of interactive elements
from the accessibility tree, acted on by ref number** (`click | type | select |
press`), "which keeps payloads small and stable versus raw DOM/screenshots".
Screenshots optional. v3's #43 reached the same conclusion independently
without noticing v2 had already built it: *"Browser-only is a real, much
smaller slice … deterministic, no screenshot-guessing, and scoped to one
browser context that can be handed no cookies, no saved passwords, no other
tabs."*

**What the ruling changed here.** #43's headline objection was that "an agent
that can click is an agent that can approve its own consent card" — the UI
layer was where v3's mechanical gates bottomed out, on the assumption a human
does the clicking. **v4 has no consent cards, no Approve buttons, no goal
gate.** That objection is gone.

What remains is real and must not be smoothed over: **web content is untrusted
input, and a browsing agent can be steered by text on a page.** That is the
vendor's own warning about their own reference implementation, not a
hypothetical.

So the open design question is the honest one #43 asked and never answered —
**is there a mechanical backstop, or is this the capability that runs on
containment alone?** The candidate answer in v4's idiom: the container *is*
the boundary (its own network, no host X11, no real profile, no host
filesystem), the accessibility-tree interface is narrower than pixels, and
every action files a `turn_span` so the trace shows what she clicked.

The two jobs pull differently and the slice should say so: **QA** needs to
reach the dev stack, screenshot, assert and iterate — a loop, and the natural
partner to self-coding. **Open internet** needs egress and video, and is where
injection risk actually lives. They may want different network policies in the
same container.

---

## 6. Coding and self-modification

She delegates real coding work, in a container, and eventually to her own repo.

**Already decided**
- **ACP is not a security boundary — the CONTAINER is** (v3 #20).
- Repos are **cloned from the remote**, so `.env` cannot cross, by
  construction.
- Roles are **stages of a backend state machine, not conversing agents**
  (v3 #33). Red→green enforced mechanically by the broker.
- The operator-merge lock is **lifted** — v3 #47 reversed it in five places at
  once, before the ruling generalised it.
- A coding session's state is **known, not assumed**: `updated_at` measures
  attention, not progress (v3 #50).
- The landing step parses **the DIFF, never the report**.

**What v4 has** — nothing of the coding lane. `coder/` and `git-landing/` on
`main` are v3's.

**Next move** — this arc waits on S26. A self-coding loop whose gate is an
eval floor needs an eval corpus that measures capability, which is exactly
what S26 builds and today's 23 honesty pins cannot do.

**IDE integration belongs here, and it is nearly free.** v1 pointed
Continue.dev, Cursor and Aider at the gateway's OpenAI-compatible endpoint —
*"`apiBase` is the only thing that matters"* — plus `editor-vscode/` and
`editor-neovim/`. **v4's gateway already serves `POST /v1/chat/completions`**
(`services/gateway/app/data_plane.py`). Pointing his editor at Nova means her
routing, spend ledger, model catalog and fallback chains cover his coding too.
What is missing is an auth story for that path and a page of documentation —
not a subsystem.

---

## 7. Models and inference

She owns her own brain stack: many backends, many models, honest routing, and
she can add a model herself.

**Already decided**
- **No pin may ever point at a model that doesn't exist** (v2) — validated on
  write, 409 with a repoint dialog on delete.
- Every catalogue fact carries `{value, basis, source}` (S10a).
- At a cost cap, degrade **warn → prefer local → pause cloud**, *never a
  mid-turn hard cut* (v3 #16).
- The fallback must **not** be settable by the model — "a model that can choose
  its own standby can route itself onto one with no tool support" (v3 #38).
  A capability-correctness rail, not an owner gate.
- The SSE frame, `model_used` and the trace must all name **what actually
  ran**.
- **Fitness measures, never declares** — she may state which model measured
  best, per role; she may not switch to it (ruling, 2026-09-03).

**What v4 has** — providers as data, not code, with verify-before-save and a
three-valued `key_proven`; one catalogue row shape across installed, curated,
provider listings and HuggingFace; spend per completion with cost basis and a
`/spend` page that says what the totals leave out; role routing with ordered
fallback chains and providers walled on refusal; live VRAM read at the moment
of the question (the fictional `swappable` flag was **deleted, not repaired**);
`prefill_ms`/`ttft_ms`/`thinking_ms` as three separate fields with the
reasoning stream read.

**Planned in the hub lane** (2026-09-18, [`hub-topology.md`](hub-topology.md)):
local models on any machine, with ids that name the machine (`hub:`, `dell:`),
served through the Nova agent on that machine, and woken over LAN when asleep.
Every speed and fit number becomes keyed by the compute it was measured on.

**Next move** — S23, parked with every number already measured on this host.
The first move on pickup is one cheap experiment, not a migration: does
`LLAMA_ARG_CACHE_RAM` reach ollama's llama-server child the way
`LLAMA_ARG_KV_OFFLOAD=0` was proven to? Separately and cheaply: the ollama
runtime knobs — `OLLAMA_MAX_LOADED_MODELS`, KV quantisation, a context cap —
were audited and **every one is unset**, which on a machine routinely 6 GB down
is plausibly the cheapest fix available.

---

## 8. Durability and ops

His single longest stated requirement, and one that explicitly reversed a
shipped default:

> "a **100% backup and restore process** … if a computer crashes, spin Nova up
> on a different machine and keep configurations, secrets, conversation and
> memories, so it's like we only lost what happened since the last backup."
> (2026-08-02, v3 #31)

**Already decided**
- A complete encrypted bundle; the passphrase behind a **resolver seam**
  because "eventually it'll get it from a secrets manager"; a **weekly restore
  drill**; the standalone restore script travels **inside every bundle**.
- Coverage is **derived from the compose file** — an unclassified volume
  **refuses** rather than silently skipping.
- Secrets: built-in encrypted store first, `{{secret:name}}` resolved **only at
  the outbound call**, agents list names and never values; 1Password /
  Bitwarden are later resolvers behind the same seam (v3 #32).

**What v4 has** — a real installer (`./install` → preflight → hardware →
secrets → up → health table, refusing to report success on a line it cannot
read), compose profiles, one durable HTTPS origin on the tailnet that survives
restarts and reboots. No backups. **Provider API keys are plaintext `text` in
the gateway database**, masked only on read.

**Planned in the hub lane** (2026-09-18, [`hub-topology.md`](hub-topology.md)):
S41 builds verified backup and restore to the rules above, and S45 uses them to
move Nova from the Dell to an always-on hub, which is the first real restore.

**Next move** — the restore drill is the part that makes the rest true. A
backup nobody has restored is a belief; v3 knew that and made it a phase.
Secrets and backups are the same slice in practice, because the bundle needs a
passphrase and the resolver seam is where it comes from.

---

## 9. UI and shell

**Already decided**
- A dedicated top-level Observability panel, **peer to Settings** (v3 #30, his
  call).
- `/vault` is a top-level view over the same roots, and **"what we owe" is to
  retire Library → Files into it** — "the README must never carry two
  file-manager rows" (v3 #41).
- Three refusals kept in the Vault "because the alternative would lie".
- Mobile: **the complaint was discoverability, not absence** — Settings *is*
  reachable behind the ellipsis, and the owner could not find his own settings
  (2026-09-15). The mobile nav is "the desktop nav, filtered" rather than a
  surface designed for a phone.
- Rendering at 393px is part of done for anything touching `apps/web`.

**What v4 has** — the v1 design system carried across; ten routed pages;
Settings in five tabs, each a real address; threads as rooms off the hallway;
the Inbox; an onboarding wizard whose Ready step performs a **real inference
round-trip and cannot be reached on a fake**; a component gallery.

**Next move** — `SURFACE_PRESET` is hardcoded to `'advanced'` in both
`Sidebar.tsx` and `MobileNav.tsx` with its own comment saying it waits for a
real feature-flag source. The three-way preset exists as a type and a working
filter and **nothing sets it**. That is S27's, and it is why S27 is last
rather than never.

---

## 10. Household and people — the arc v3 never wrote

v3 has no people lane. It has `about: user` edges (*"everything here exists in
orbit around this relationship"*), a daily briefing that was never built, and
a calendar that exists only as a forward reference. If Nova is a household
assistant rather than a lab instrument, **this arc gets written rather than
mined**, and it is where to expect items with no v3 number at all.

**Already decided**
- **Personalization never authentication** (`speaker-id.md`, locked) — knowing
  who is speaking may change what she says; it may never become what she is
  allowed to do.
- Guest access is **time-boxed** and model-restricted, and the restriction is
  enforced in `model_chain`, **never in the guest's prompt** (v3 #49). Note
  this is authorization over a *non-owner*, which the ruling did not address —
  it needs an explicit v4 decision rather than an assumption either way.
- Per-person skills and per-person timezone both wait on this arc.

**What v4 has — the plumbing, not the door.** `people` carries
`role IN ('owner','adult','kid','guest')` with a unique index enforcing one
owner; `person_id` scopes conversations, turns, timers, queued messages and
attachments; memory is partitioned per person; the busy gate is per person, so
two rooms cannot run two turns on one card. And `identity.py` already states
the rule in code: **every authenticated person sees every route, and
`Person.role` is "carried, never branched on for access"** — naming the gap
deliberately rather than leaving it to be discovered.

So the schema is a household and the product is one man: `/register` refuses
once any person exists, nothing else creates a person, and Settings has no
people tab.

**Next move** — a second person is mostly a route and a Settings tab. The
design work is not the code; it is deciding what `kid` and `guest` *mean* at
the tool layer without building the authorization system the ruling forbids.
The v4-shaped answer is that a person's scope is **structural** — whose memory,
whose conversations, whose workspace — never a gate that asks or refuses.

A precondition recorded by the memory slice, not backlog: memory's
`append_journal` read-modify-write race **must** be fixed before concurrent
multi-person ingest.

---

## Jev — a decision model, and the switch that keeps Nova local

Researched 2026-09-18 from TypeSafe's published documentation. Nothing about
this is in the repo yet and nothing here has been measured on this stack — the
numbers below are the vendor's claims, cited so the next reader can check them.

**What it is.** TypeSafe AI launched Jev on 2026-09-15 as the first "System
One" model. It **does not generate text**. It takes a `state` plus typed
questions and returns typed answers with probability distributions and
confidence, every question evaluated **in parallel and in isolation** against
the same state — so adding questions "does not create context-rot".

`POST https://api.typesafe.ai/v1/systemone`, Bearer auth:

```json
{ "state": "…", "model": "jev-latest",
  "questions": { "q1": { "type": "noul|choice|score",
                         "instructions": "…", "criteria": { } } } }
```

Three primitives:

| type | question | answer |
|---|---|---|
| `noul` | is this statement true? | `{"noul": 0.92}` |
| `choice` | which one of these? | `choice` + `probabilities` + `confidence` |
| `score` | where on this scale? | float `score` + `legend` + `probabilities` + `confidence` |

Also reachable OpenAI-compatibly through OpenRouter as `typesafe/jev-1.13` or
`~typesafe/jev-latest`, 32k context, **$0.042/M input and $0/M output**,
reported at 70–500 ms. Official Python SDK: `pip install typesafe-sdk`.

**Why it fits Nova unusually well.** This codebase is already a pile of typed
decisions currently made by regex, or by asking a chat model for JSON and
hoping:

- The honesty guards are **noul** questions about a reply given a trace.
- S10's role routing and S28's vision routing are **choice** questions — and
  S28 already hand-rolled `Choice.certain` to separate "no model here can see
  images" from "I could not tell", which is exactly a confidence threshold.
- Notice urgency, skill-repetition detection and distillation subject
  extraction are classification.
- **S26's judge is the sharpest fit.** The corpus needs "a judge with a
  non-boolean score" — that is `score`, and per-question isolation blunts the
  position bias that made a judge model a thing to distrust.

**The rule that makes this safe, and it is the whole design:**

> **Jev may only ever be *additive* to a mechanical control that already
> stands alone without it.**

A guard that fails open when the network is down, the key is unset or the
switch is off is worse than no guard. The regex guards stay the floor; Jev may
only *add* a finding, never remove one. The landing spots are the ones where
degrading is honest: the S26 judge, routing hints, urgency and dedup.

**The switch**, as the owner framed it: **On** — better capability, not
local-only. **Off** — local-only, and the structured features are gone. Same
shape as S26's already-decided local/cloud judge toggle, with one lesson
carried from `attachments.allow_cloud_vision`: that flag **refuses** rather
than warns, which S28 flagged as a refusal on the owner's behalf. **This switch
states what is unavailable; it never refuses on his behalf.** Every Jev-backed
feature names what it degrades to when off, in the UI, derived rather than
written.

**Open, and his to decide** — whether Off is the default (privacy-first says
yes); whether it routes through OpenRouter (one key, and S10's provider and
spend machinery already handles it) or direct to `api.typesafe.ai` (a provider
entry plus the secrets store that does not exist yet); and how spend reads when
output is free.

Sources: [TypeSafe docs](https://docs.typesafe.ai/introduction) ·
[HTTP API](https://docs.typesafe.ai/api.md) ·
[OpenRouter](https://openrouter.ai/typesafe) ·
[Python SDK](https://github.com/typesafe-ai/typesafe-sdk-python)

---

## Things assumed missing that are not

Checked in code 2026-09-17/18. Recorded because each was nearly proposed as new
work:

- **Onboarding** — `OnboardingWizard.tsx`, eight steps, Welcome → CreateAccount
  → Timezone → HardwareDetection → ChooseEngine → PickModel → Downloading →
  Ready, plus `./install`. Better than v1's shell wizard.
- **The design system** — v1's custom teal is v4's accent, verbatim.
- **A quality page** — `AIQualityPage.tsx` exists. S26 is about what the corpus
  *measures*, not about building a page.
- **Computer control** — see arc 5. Nine device tools, signed envelopes.
- **The multi-person rule** — see arc 10. Already stated in `identity.py`.
- **Activity / audit** — `/activity`, backed by `activity.py`.
