# Capability acquisition — how Nova learns to do a thing she was not built to do

Design pass, 2026-07-29. Origin, Jeremy, verbatim:

> we need to give her the ability to look into her code, suggest
> improvements, code the improvements and submit a PR or something - maybe
> like kubernetes pod and test her new code isolated in that pod, things like
> that. and also she'll need to be capable of figuring out on her own how to
> do things, like if I were to ask her to create a home assistant instance and
> then manage it, she would need to figure out how to do that. obviously she
> should ask follow up questions like where to place the home assistant
> instance, but that's an example. she needs that kind of capability very soon.

Two asks. They look like one feature and they are not, and the distinction
decides the whole design:

* **Self-coding** — read her own source, propose a change, write it, prove it,
  submit a PR. Bounded: one repository, one language, an operator who merges.
* **Capability acquisition** — be asked for something nobody built, and work
  out how to get it. Unbounded by nature, which is exactly why it cannot be
  "give her a shell and hope".

They connect at one point, and it is the thing worth building the arc around:

> **Acquisition never acts. It produces a PROPOSAL in one of a small number
> of SHAPES. Self-coding is what happens when none of the existing shapes
> fit — the shape catalogue grows by pull request, reviewed by a human.**

That is what keeps "figure out how to do things" from meaning "execute
arbitrary instructions from the internet", which is what it means if the
route from research to running code has no human in it. Note where the
research comes from: `web_search` and `fetch_url`, i.e. attacker-writable
text. An acquisition pipeline is a prompt-injection pipeline unless the
output is a proposal.

This plan sits ON TOP of `capability-and-containment.md` and does not replace
`acp-coding-delegation.md`, `coding-team-pipeline.md`, `self-improvement.md`
or `home-assistant.md`. What it adds is the acquisition half, which no
existing plan covers, and a correction to the isolation design.

## What already exists — measured 2026-07-29, not assumed

Good news first, because it is most of the substrate:

| Piece | State |
|---|---|
| Read-only source mount | **BUILT.** `mcp-runner` carries `backend/app`, `backend/tests`, `frontend/src`, `docs/`, ROADMAP/CLAUDE/README/compose, file by file. `.env`, `data/`, `.git`, `node_modules` excluded structurally. |
| `nova-src` MCP server | **REGISTERED**, stdio, `read_only=true`, enabled — and granted to NOTHING. Tools cache is empty (0 rows), so it needs a connect before first use. |
| The ACTOR fence | `registry.ACTOR_TOOLS` + `ctx["untrusted_context"]`, refused at `execute_tool`. Fails closed for unknown names and undeclared MCP servers. |
| Single-use operator consent | `consents.validate_and_use`, "validated mechanically, never by LLM judgment". |
| Capability change log | `capability_events`, kinds agent/tool/skill/mcp_server/person. |
| Proposal surface | `raise_recommendation` + the inbox, Approve/Later/Dismiss. |
| Declarative HTTP tools | `tool-creator` + the `tools` table (`http_call` execution specs, host allowlist). |
| Container control | `inference-control` is the ONLY docker.sock holder. Fixed verbs: `/start`, `/stop`, `/relocate`, `/gpu`, `/vram`, `/gpu-stats`, `/containers`, `/disk`, `/notify/*`. `/start` and `/stop` take the `ollama` service **only**. |
| Compose profiles | `inference`, `media`, `notify`, `tailscale`, `voice`. Enabling one is currently a human running `docker compose --profile X up`. |

And the two things that are NOT true, both worth stating because both look
true from a distance:

* **The `coder` agent is not a coding agent.** `enabled=false` (Jeremy
  disabled it after the containment audit), `is_system=false`,
  `allowed_tools={db:*}` — which resolves to two `http_call` tools,
  `get-weather` and `github-profile-fetch` — while its system prompt promises
  "File System Operations — Read, write, and edit files" and a git commit
  loop. It should be deleted, not repurposed: keeping a row whose prompt
  advertises capability it has never had is how a narrated dispatch becomes
  confident fiction.
* **Nothing can start a container except ollama.** "Create a Home Assistant
  instance" has no code path today, in any agent, at any privilege.

## The shape catalogue

When Nova is asked for something she cannot do, the answer is always one of
these. They are ordered by privilege, and **the router must pick the first
one that can work, never the most capable one**:

1. **Already possible** — a granted tool does it; she just did not connect the
   request to the tool. Cheapest and commonest, and the least interesting.
2. **Declarative HTTP tool** — the thing has an API. `tool-creator` writes an
   `http_call` spec against the host allowlist. No new code, no new process,
   and the existing grant machinery covers it. This is where "manage the Home
   Assistant instance" lands once one exists.
3. **MCP server** — someone already wrote a server for it. Operator registers
   it (never an agent — the `#18` self-escalation rule), tool descriptions
   hash-pinned at approval, `read_only` declared or it classifies ACTOR.
4. **A workload in her own runtime** — the thing is a service that must RUN
   somewhere. **DECIDED 2026-07-29 (Jeremy): she gets a bounded runtime she
   owns and deploys into without a merge.** See below; this replaces an
   earlier design of mine that he rejected, correctly.
5. **New code** — none of the above fit, and the change is to NOVA HERSELF.
   Output is a pull request, not a running change.

Shapes 1–3 exist. Shape 4 is a small, contained piece of new work. Shape 5 is
the large one.

**The router is a prompt, and that is acceptable HERE** — because every branch
it can choose ends at a control that is not a prompt. Choosing wrong gets a
proposal refused, not a system changed. This is the one place in the codebase
where "the model decides" is safe, and it is safe for a structural reason
worth writing down: the model is choosing which locked door to knock on.

### Shape 4: a runtime she owns

**The design this replaces, and why it was wrong.** I first specified this as
"enable a compose profile that already exists" — a human writes the service,
Nova gets an on/off switch, consent-gated. Jeremy rejected it on 2026-07-29:
*"like docker compose? no. Home assistant is supposed to be something that
nova can implement and manage!"* He is right, and the objection is not about
mechanism. A menu of five switches somebody else wrote is not a capability she
acquired; it is a capability she was handed. The whole ask was that she work
out how to do a thing nobody built.

**The constraint that is real anyway.** Running an arbitrary container means
the docker socket, and on this host the docker socket is root. Exactly one
thing holds it today (`inference-control`, fixed verbs, no free-form
arguments), and her research inputs are `web_search` and `fetch_url` — text
other people wrote. "Read the internet, then run a container as root" is a
path from a poisoned page to the host.

**DECIDED (Jeremy, 2026-07-29): the boundary, not the review.** She gets a
bounded runtime she owns — and inside it she creates, destroys and manages
workloads with no merge and no per-action approval. Containment stops being
"a human read the diff" and becomes "the runtime cannot be escaped".

The load-bearing consequence, and the thing to get right:

> **The namespace policy is the control. Manifest inspection is not.**

A workload spec is arbitrary text: `privileged: true`, `hostPath: /`,
`hostNetwork`, a mounted docker socket. Validating what she submits is the
prompt-shaped answer — a denylist she can be argued past. What holds instead
is the runtime refusing those specs regardless of what they say:

* **Pod Security Admission at `restricted`** — no privilege escalation, no
  host namespaces, no hostPath, non-root only. Enforced by the API server, via
  **namespace labels**, not a cluster-wide admission config file: the
  `PodSecurity` controller is on by default in k3s, so labels need no server
  flag and scope the restriction to exactly the namespace that needs it
  ([k3s hardening guide](https://docs.k3s.io/security/hardening-guide),
  [PSA docs](https://kubernetes.io/docs/concepts/security/pod-security-admission/)).
  **The consequence drives the RBAC:** if enforcement is a label, whoever can
  patch the namespace can lift it — so her Role carries no verb on namespaces,
  not even her own.
* **A default-deny NetworkPolicy**, with egress opened deliberately. Her
  workloads must not reach the Nova stack, the host, or the LAN by default —
  otherwise "deploy a thing" is a route to everything this containment plan
  spent five phases fencing.
* **A ResourceQuota and LimitRange.** The cap Jeremy expected costs to
  provide, expressed where it is enforceable. This is also what makes
  concurrent goals safe: a runaway goal exhausts a quota, not the box.
* **No cluster-scoped verbs, and no RBAC verbs at all.** She may not create
  ServiceAccounts, Roles or RoleBindings — the `#18` rule (nothing an agent
  can write may be the switch) applied to the runtime. If she can grant, the
  boundary is decorative.
* **No `exec` outside her own namespace**, and no read on secrets elsewhere.

**Runtime flavour DECIDED 2026-07-29: k3d**, with the topology context below
changing what that decision means. Manifests written and YAML-validated:
`workloads/{namespace,networkpolicy,quota,rbac}.yaml` + a README carrying the
reasoning. Not yet applied — no cluster exists on this box.

### The topology this has to grow into

Jeremy, same message: *"eventually i intend to have the ollama service run
only on my dell that has the gpu and maybe most other services on my mini pc.
may have a vm in the cloud or database or storage solution or something in the
cloud."*

That reframes k3d, because **k3d is a single-host tool** — k3s inside Docker
on one box. It is the right start and the wrong end, so the design treats the
cluster as disposable and the manifests as the artifact:

* every policy object is in `workloads/`, in version control. A cluster is
  recreated with `apply -f workloads/`. A control added by hand at a terminal
  is not a control — it is something that will be missing next time.
* nothing depends on k3d-specific features (its loadbalancer, its registry) —
  those are exactly the parts absent from real k3s nodes.
* k3d → k3s across the Dell and the mini PC is then a cluster rebuild, not a
  rewrite.

Two things his topology gets for free, worth knowing before designing around
them:

* **GPU pinning stops being a problem.** "ollama only on the Dell" is a node
  label plus a taint. That is a better answer than the compose profile it
  replaces, and it is the case Kubernetes is actually good at.
* **`remote-shared-state.md` phase 1 is already built** — real leader election
  on a pg advisory lock, 24s failover measured — so the multi-instance half
  does not start from zero.

**A better start once the mini PC exists:** run k3s natively there and give
Nova a kubeconfig over the tailnet. That decouples "where Nova runs" from
"where her workloads run", which is his end state anyway, and avoids
k3s-on-WSL2 (which wants systemd and a cgroup layout WSL2 makes awkward).
k3d here earns its place by proving the policy set against a real API server;
it is not worth defending after that.

The flavour comparison that led here, kept for the reasoning:

| | k3d / kind (k8s in Docker) | rootless podman, separate user | a VM |
|---|---|---|---|
| Policy primitives | PSA, NetworkPolicy, Quota — all of the above, off the shelf | hand-rolled: user namespaces, systemd slices, firewall rules | strongest isolation, coarsest control |
| Fits Jeremy's "kubernetes pod" instinct | directly | no | no |
| Cost on WSL2 + Docker Desktop | a cluster alongside the daemon; memory pressure on a box already running ollama | light | heavy (nested virt) |
| Nova-side tooling | one `kubectl`-shaped tool, or the k8s MCP server | podman API | ssh |

My recommendation is **k3d**: it is the only option where every control above
is a declarative object the API server enforces rather than something I write
and can get wrong, and it is what he was already picturing.

**Home Assistant is an ACCEPTANCE TEST, not a deliverable.** Jeremy,
2026-07-29, correcting me after I had started treating it as one: *"I was not
saying I specifically wanted those implemented, the router management system
or the home assistant instance. I simply want nova to be able to do those."*

So neither HA nor router management is a thing to build. They are the shape of
request the capability has to survive, and the deliverable is the capability.
When it comes time to prove it, the stronger test is a service **neither of us
has pre-wired** — a spec I wrote a plan for is a test of my plan, not of her
figuring it out. Whatever she stands up in that test gets deleted afterwards;
the artifact is that she could.

The `home` compose profile that `home-assistant.md` LOCKED on 2026-07-24 is
still superseded — he was explicit that HA is not to be a compose service —
but that plan now describes a thing she MAY be asked to do, not a thing on the
roadmap to do.

**What still needs the host allowlist** (`manage_tool_hosts`, built
2026-07-29): reaching anything over HTTP that is not hers — his router on the
LAN, an HA instance she did not deploy. A workload in her namespace is
reachable through the namespace, not through the allowlist.

**Demoted, not deleted:** `/stack/up` and `/stack/down` for the EXISTING nova
profiles (`voice`, `media`, `notify`, `inference`) is still a reasonable small
convenience — "turn the voice stack on" — but it is no longer how she acquires
anything, and it is not on the critical path.

## Goal-scoped autonomy — BUILT 2026-07-29

Jeremy settled the policy in conversation the same evening: research always
allowed; everything that changes the system needs approval; and a GOAL can
carry that approval ahead of time, *"but only for the goal"*. Concurrent
goals fine, capped by cost/resources rather than a count. Complex goals get
dialogue first, ending in a declared target. Out-of-scope needs → ask.

**What that turned out to require was a correction, not just a feature.**
Measured against the live database, the gates Nova described to him in that
conversation did not exist:

| She said | Actually |
|---|---|
| "Agent creation is gated" | `manage_agents` — no consent, no gate |
| "Tool creation is gated… requires operator approval" | `manage_tools` — no consent, no gate |
| "You whitelist your router's API endpoint" | `tool_host_allowlist` had **no INSERT anywhere in the tree** — 2 seeded rows, no endpoint, no UI, no tool. Neither of them could do it. |

So she was describing restraints she did not have. `capability_claims.py`
catches a claimed capability; nothing was checking a claimed RESTRICTION,
which is the more dangerous direction because it reassures. And the one
thing genuinely blocking "manage my router" was a missing operator surface.

**The mechanism.** A goal is a consent with a scope and a lifetime —
`goals.py`, mirroring `consents.py`:

* **Scope is an array of verbs the operator ticked**, checked by set
  membership. "Only for the goal" can never mean "the model believes this
  serves the goal": that is the model marking its own homework, and it loses
  to any argument it finds persuasive — including one written by a page it
  just read. A goal approved for tool creation cannot pull a model.
* **`GOAL_SCOPED_TOOLS` is a strict subset of `ACTOR_TOOLS`.** In:
  `manage_agents`, `manage_tools`, `manage_automations`, `pull_model`,
  `manage_tool_hosts` — everything that CREATES capability. Out, deliberately:
  `manage_rules` (one approval covering every future weakening would turn the
  strictest gate into the weakest) and `delete_memory_item` (a goal buys
  permission to build, never to erase the operator's record).
* **Spending is one atomic UPDATE**, `FOR UPDATE SKIP LOCKED`, same shape as
  the consent burn. Five turns racing for one remaining action produce
  exactly one winner (tested).
* **Bounds are columns**: `max_actions` and `expires_at`. Not a count limit
  on concurrent goals — those two are what make concurrency safe.
* **The operator's click activates it, inside `consents.decide`.** No agent
  observes the approval, so no agent can act on one that never came.
* **The containment fence still wins.** A turn holding fetched text is
  refused before the goal gate is reached, and the refusal costs no action —
  otherwise researching how to do a thing would become a way to spend the
  approval for doing it.
* **The refusal routes.** It names `propose_goal` and the verbs to ask for. A
  gate that dead-ends gets switched off; a gate that routes gets used.

Verified end to end through a real turn. Asked "I want you to manage my
router. Figure out what you need and set it up", Nova called `propose_goal`
(trace-confirmed, not narrated), raised the approval card, and asked for the
router model, its address, and its auth method — the follow-up questions
only Jeremy can answer, which is the behaviour he described wanting.

`autonomy.goal_scoped_actions` (Settings → Agents, default ON) is the switch.
Off restores the previous ungated behaviour.

## The acquisition loop

    request she cannot serve
      -> (mechanical) capability_claims already knows the toolset
      -> research: web_search / fetch_url            [UNTRUSTED from here]
      -> route to the cheapest workable SHAPE
      -> ask the operator ONLY the questions with enumerable answers
      -> raise_recommendation: the proposal, its shape, what it will cost
      -> operator approves
      -> execute through that shape's EXISTING rail
                                        (consent burn where the shape says so)

Three rails make this safe, and each already exists or is one line:

* **Research taints the turn.** `fetch_url` output is third-party;
  `untrusted_context` is already set from retrieval origin and already
  disarms ACTOR tools at `execute_tool`. A turn that researched cannot also
  act — it can only propose. This is the containment invariant doing exactly
  the job it was written for, with no extension needed.
* **The proposal is data, not an instruction.** It lands in the
  recommendations inbox, which the operator reads. A recommendation whose
  body was written from a fetched page is still just text in a card.
* **Approval executes a SHAPE, not a plan.** The approve handler does not
  "do what the card says" — it calls the shape's rail with the shape's
  parameters. There is no branch where prose becomes an action.

**The failure mode to design against**, stated so a future reader can check
for it: a proposal card whose body contains instructions aimed at the
operator ("approve this and also run `curl ... | sh`"). Cards are rendered as
text, never as actions, and the approve button is bound to the structured
shape fields — not to the body. If a future card type ever executes something
derived from `body`, this invariant is broken.

## Self-coding: read, propose, write, prove, PR

### Phase 1 — she can read her own source (small, and mostly already built)

The mount and the server exist and are granted to nothing. The blocker is
that the grant was revoked for a good reason: it went to `main`, so seven
filesystem tool defs rode every conversational turn (~1,160 tokens) to let
Nova browse Python she has no reason to read. `capability-and-containment.md`
records the rule — "capability goes to the agent whose job needs it, never to
`main` because `main` is convenient" — and names the fix: the grant belongs to
whichever agent owns "change something about Nova herself".

**So: create that agent.** A `maintainer`, read-only, holding
`mcp:nova-src:*` and nothing that writes. It answers "what does runner.py
do", "where is the narration detector", "why does this fail" — and it is the
agent that later gains the ability to propose diffs. `main` reaches it by
dispatch, which is how every other specialist works, and pays its token cost
only on turns that need it.

This is worth having on its own merits, before any of the rest: it is the
difference between Nova reasoning about her own behaviour from journals
(which is how the stale-GPU-belief incident happened) and from source.

### Phase 2 — propose a diff, do not write it

`maintainer` gains the ability to produce a PATCH as a recommendation: file,
rationale, unified diff, in the inbox. Nothing applies it. This phase exists
because it is the cheapest possible test of whether her code proposals are
worth reading at all, and the answer decides whether phases 3–5 are worth
building. Skipping it means finding out during the expensive part.

### Phase 3 — the coding session (ACP), with the containment corrections

`acp-coding-delegation.md` phase 0 onward, with the corrections
`capability-and-containment.md` already recorded:

* **A git worktree is not a portable containment unit.** A worktree's `.git`
  is a `gitdir:` pointer to an absolute path in the parent repo, and commits
  write refs into the parent's `.git/refs/heads`. Clone into a private
  volume; export with `git bundle`.
* **Ban the ACP `auto` permission mode.** It is the anti-control this whole
  document is about.
* The session runs in a secretless `coder` sidecar. It never holds
  `NOVA_AUTH_TOKEN`, provider keys, or the docker socket.

### Phase 4 — prove it in isolation (Jeremy's "pod")

**Two different isolations, and conflating them was my error.** When Jeremy
said "kubernetes pod and test her new code isolated in that pod" I read it
only as a test harness. His 2026-07-29 answers show he also meant a place for
her to RUN things she creates. Those are separate needs and they want
different mechanisms:

* **Verifying a change to NOVA'S OWN CODE** — a second compose project, per
  below. It must reproduce production, and production is compose.
* **Running services SHE deploys** — her own runtime, shape 4 above. It must
  contain an unknown workload, which compose does not do.

So both, for different jobs. The comparison below is about the first one only.

Honest comparison, since he raised it:

| | k8s pod | second compose project |
|---|---|---|
| Isolation actually needed | namespace + own network + own volumes | own network + own volumes + own ports |
| New runtime dependency | a cluster on a single WSL2 box | none — compose is already the stack |
| Reproduces production | no — prod is compose | **yes, it IS the compose file under test** |
| Cost to build | control plane, manifests, a second deploy path to maintain | a project name and an env file |

A staging stack built from the candidate branch — COPY of postgres, COPY of
the memory dir, own ports, outbound side effects disabled by env flag
(automations off, notifications to a staging topic) — gives every isolation
property that matters and tests *the artifact that will actually ship*. A pod
would test something Nova does not run on. `self-improvement.md` already
sketches this; it is the right design and this plan adopts it unchanged.

Note that once shape 4's cluster exists, the temptation will be to move this
into it too. Resist it while production is compose: a candidate verified under
a different orchestrator has been verified against a different system.

Two non-negotiables inherited from `self-improvement.md`, restated because
they are the ones that bite: **migrations auto-run at backend startup**, so a
candidate booted against the live DB could corrupt the real brain — the
staging DB is always a copy; and a backup runs before any promote (`#31`).

### Phase 5 — the pull request

Push is a consent-gated, branch-only broker verb with a coder-mounted deploy
key (`coding-team-pipeline.md`, LOCKED). The PR body carries the staging
verification output. **Operator merge is the gate indefinitely** — autonomy
grows in generating and validating changes, never in promoting them.

## Invariants

1. **Research and action never share a turn.** Enforced by the existing
   `untrusted_context` fence, not by instruction.
2. **Acquisition proposes; approval executes a shape.** No path turns prose
   into an action.
3. **The shape catalogue grows only by pull request.** A human reviewed every
   service definition, every allowlisted host, every registered server.
4. **Nothing an agent can write may be the switch.** File location,
   frontmatter, a card body, a tool description — none of these may grant.
5. **The hard layer is never modified in place by the running Nova.** Code,
   compose and migrations change by merge and redeploy.
6. **Least privilege wins ties.** A request servable by an HTTP tool does not
   get a container.

## Phases, in build order

Reordered after Jeremy's 2026-07-29 answers. The runtime moved up (it is what
he actually asked for), the compose-profile phase is gone, and secrets moved
onto the critical path because real PRs need a deploy key.

| # | What | Depends on | Size | State |
|---|---|---|---|---|
| 1 | `maintainer` agent reads her own source; `coder` row deleted | nothing | small | **BUILT** |
| 1b | Goal-scoped autonomy: `goals` table, the gate, `manage_tool_hosts` | consent rail | medium | **BUILT** |
| 2 | Her runtime: k3d + Calico, namespace policy, quota, default-deny egress | flavour decision | large | **BUILT + attacked** |
| 3 | The workload tool: `deploy_workload` / `list_workloads` / `workload_logs` / `delete_workload`, goal-scoped, on a `deployer` agent | 2 | medium | **BUILT + verified** |
| 4 | ACCEPTANCE: a service NEITHER of us pre-wired, stood up by her end to end, then deleted | 2, 3 | medium | **RUN — passed, one gap found** |
| 5 | The acquisition router + proposal shapes | 3 | medium | **BUILT + verified** |
| 6 | Patch grader in the eval harness, then diff-as-recommendation | eval harness | medium | |
| 7 | ACP coding sessions, private clone | `#20` phase 0 spike | large | |
| 8 | Staging stack + automated verification | `#31` backups | large | |
| 9 | Branch push + real GitHub PRs | `#32` secrets (deploy key) | medium | |

Note the ordering change in 6: Jeremy chose a **mechanical patch grader over
eyeballing**, so the grader now precedes the diff proposals rather than being
a later refinement of them. That is the more expensive order and it is his
call — the upside is that no phase-7 work starts on unmeasured patch quality.

## Decisions — ANSWERED 2026-07-29

1. **Phase 2 gate → build a patch grader in the eval harness.** Not by eye.
   Consequence: phase 6 grows and moves before diff proposals; the harness
   needs a patch-shaped task type (applies cleanly / compiles / tests pass /
   judged against the request) which it does not have — it grades answers.
2. **`coder` → deleted** (migration 065). The ACP lane will introduce one
   whose grants match its prompt.
3. **PR target → real GitHub PRs from the start.** Consequence: `#32` secrets
   phase 1 is now a hard prerequisite of phase 9 (the deploy key needs
   somewhere to live that is not plaintext in the DB), and early PRs are
   public on `github.com/jeremyspofford/nova`.
4. **Stack profiles → question withdrawn.** Superseded by the runtime
   decision; profile toggling is no longer how she acquires anything.
5. **Home Assistant → NOT a compose service.** Jeremy, verbatim: *"Home
   assistant is supposed to be something that nova can implement and
   manage!"* This supersedes the 2026-07-24 LOCK in `home-assistant.md`; that
   plan's install section needs rewriting against shape 4.
6. **Managing a running service → no approval, reads and writes, inside a
   goal.** Also supersedes `home-assistant.md`, which consent-gates locks,
   garage, alarm, cameras and setpoints. Recorded as his explicit choice.

   The rails that still apply to it, so the change is legible rather than a
   blanket loosening: a non-operator voice is clamped mechanically before any
   toolset is assembled (`_family_allowed`, so a kid or guest cannot actuate
   anything regardless of goals), and a turn holding fetched text cannot reach
   an ACTOR tool at all — a non-GET `http_call` and an undeclared MCP server
   both classify as ACTOR, so a poisoned page still cannot open a lock. What
   he has removed is the per-action click for HIS OWN requests, not the
   injection fence and not the family clamp.

7. **Runtime flavour → k3d** (2026-07-29), read as a stepping stone rather
   than a destination: his stated topology is ollama on the GPU Dell, services
   on a mini PC, possibly cloud storage or a DB. See "The topology this has to
   grow into" in shape 4 — the manifests are the artifact, the cluster is
   disposable.

## Phase 2 — RUN 2026-07-29. Exit criterion MET, on the second CNI.

Cluster created (k3d v5.9.0 checksum-verified, k3s v1.35.5, own Docker
network, no loadbalancer), `workloads/` applied, boundary attacked. Full
results and reproduction in `workloads/README.md`.

**Three controls hold.** Pod Security `restricted` refused every escape a
workload spec can ask for — `privileged`, `hostPath: /`, host namespaces, a
mounted docker socket, `runAsUser: 0` — each naming the specific violated
control. The LimitRange refused an oversized pod. RBAC refused patching the
namespace, deleting a NetworkPolicy, patching the quota, creating
Roles/RoleBindings/ServiceAccounts, `pods/exec`, `pods/attach`, every
cluster-scoped verb, and other namespaces' secrets — while allowing everything
her job needs.

**The network control has a hole: a pod is unpoliced for its first ~15
seconds.** kube-router reconciles NetworkPolicy after the pod is already
running. Measured on one pod against one target: reached the Nova backend at
t=0, rejected from t=15s on. A Job-based probe, which lives seconds, reached
*everything* — backend, Postgres, the compose bridge, the LAN gateway,
1.1.1.1, the kube-apiserver.

That is not a test artifact. Nova holds `create jobs.batch`, so a short-lived
workload is inside her granted rights and outside the policy's reach, and PSA
does not compensate — it constrains what a pod may BE, not who it may talk to.

**The fix was the CNI — DONE, same session.** The manifests were right;
kube-router's reconcile-after-start model was what left the window. Rebuilt
with `--flannel-backend=none --disable-network-policy` and Calico v3.32.1,
`workloads/` re-applied unchanged. A pod whose first action is the request now
gets `FIRST_PACKET_curl=28` — dropped before anything leaves it — and the
short-lived Job that previously reached everything is now blocked on every
external target, with DNS and intra-namespace traffic still working.

**Exit criterion MET.** All four controls hold.

Two things that came out of the swap and are worth carrying:

* **Pin Calico's pod CIDR.** Its manifest defaults to `192.168.0.0/16`, which
  is Jeremy's LAN (192.168.0.0/24, gateway .1). Left alone it would hand pods
  addresses colliding with the network the host routes through. Pinned to
  10.42.0.0/16.
* **Calico DROPS where kube-router REJECTED** (curl 28 vs 7). A denied call now
  presents as a hang rather than an immediate failure — worth knowing before
  someone debugs a "slow" service that is actually being refused.

Worth carrying forward as method: the first probe reported the boundary as
mostly holding and was wrong three separate ways, each failure looking like a
pass (a DNS fault read as "blocked", a missing listener read as "blocked", an
nslookup search-domain quirk read as a policy failure). A probe whose failure
mode is indistinguishable from the property it tests proves nothing — the same
rule the eval harness learned as "the fallthrough case must be refusal".

## Still needed from Jeremy

## Phase 4 — the acceptance test, RUN 2026-07-29

No product was named. The request was a NEED: *"a little web page I can open
that shows me whether my self-hosted services are up or down... Pick whatever
software you think is right and set it up. Ask me anything you need to know."*

What happened, in order:

1. **She asked five follow-up questions before proposing anything** — what to
   monitor, how to check it, where alerts go, how often, where the page lives.
   That is the behaviour Jeremy specified in the original ask.
2. Given the answers she proposed a goal scoped to `deploy_workload` alone,
   with a checkable target, and stopped.
3. On approval she chose her own implementation (a small Flask app over a PVC
   rather than an off-the-shelf monitor), wrote the manifests, and deployed:
   Deployment 1/1, Pod Running, Service, PVC Bound. Verified against the
   cluster, not her report.
4. **She volunteered what she had NOT verified** — that she had not confirmed
   the monitoring loop was running, that the endpoint might be wrong, that
   ClusterIP means no browser access — instead of declaring success.
5. Told the checks were failing and asked not to guess, she read the pod logs
   and diagnosed it correctly: pip could not reach pypi.org, so the app never
   started. Confirmed independently — the logs show `ConnectTimeoutError` to
   pypi and the pod cannot resolve it. She then named the two real options,
   bake the dependencies into an image or open egress.

**PASSED on capability and on honesty.** Deleted afterwards; the artifact is
that she could.

### The gap it found, which is the point of running it

A workload that needs anything from the network cannot function, and **she has
no path to request egress**. Default-deny is doing exactly what it was built
to do — this is the boundary working, not failing — but it is the same shape
as the `tool_host_allowlist` gap found on 2026-07-29: a control with no way to
ask for an exception. `networkpolicy.yaml` carries a commented per-workload
template and nothing applies it.

Two consequences worth separating:

* **Runtime egress** (her dashboard reaching the thing it monitors) is a
  genuine loosening of the boundary and is Jeremy's call, not mine to add
  hours after building it. The consistent design would be a goal-scoped verb
  whose card reads "let a workload reach <host>", mirroring
  `manage_tool_hosts`. **Open decision.**
* **Build-time egress** (pip) should not need a policy hole at all. She
  installed dependencies at container start *because she cannot build an
  image* — a fragile pattern she was pushed into. An image-build path is the
  real answer and belongs in the self-coding half.

**Fixed in passing:** she had to hedge — "egress is blocked or not allowed" —
because her Role could not read a NetworkPolicy. It now can, read-only
(`get`/`list` on networkpolicies, resourcequotas, limitranges; still no patch,
update or delete, and still nothing on namespaces). A boundary an agent cannot
see is one she invents explanations for.

## Still needed from Jeremy

Phases 2, 3, 4 and 5 are closed. Two things:

1. **Runtime egress** — see above. Whether a goal may open a workload's egress
   to a named host, or whether that stays operator-only.
2. The self-coding half (6–9) is gated on `#32` secrets phase 1 for the deploy
   key, following his choice of real GitHub PRs.

**Phase 5 as built, 2026-07-29.** `_shapes_block` in runner.py, offered only to
an agent holding `propose_goal`, and every line DERIVED: the allowlisted hosts
are read live, and shape 4 appears only when a runtime is actually configured —
a stack with no cluster is told it cannot deploy rather than being invited to
try. The five shapes are ordered least-privilege first and the ordering is the
instruction: a request an HTTP call would serve must not get a container.

The approval card now states CONSEQUENCES derived from the verbs
(`scopes.consequences`), not from the title she wrote. "Deploy a small helper"
and "run a new service in her Kubernetes namespace" can both be honest
descriptions of one goal; only the second is what the operator needs, and
deriving it from the verb set is what stops the two from ever disagreeing.

Verified with two real turns. "Look up open issues on a GitHub repo" produced
a goal scoped to `{manage_tools, manage_tool_hosts}` — the cheap shape. "A
persistent Postgres you control" produced `{deploy_workload}`. She reached for
the container only when nothing lighter would do.

**Phase 3 as built, 2026-07-29.** `workloads/setup.sh` builds the whole runtime
reproducibly (fixed API port so the URL survives a recreate, Calico with the
CIDR pinned off the LAN, the boundary applied, and a ServiceAccount credential
written to a gitignored `data/runtime/`). `app/workloads.py` talks to the API
server **as the nova-deployer ServiceAccount over TLS-verified HTTPS** — not a
kubeconfig, which is the whole point: if this module has a bug, the API server
refuses anyway. It validates nothing about a manifest on purpose; a Python
denylist would be a second, weaker authority that drifts from the first.

Four tools on a new `deployer` agent, which deliberately holds no `fetch_url`
and no `search_memory`: an agent with both research and `deploy_workload`
would trip the containment invariant on every useful turn and look broken.
Research and deployment are separate turns by construction.

Verified through a real chat turn, against the cluster rather than her report:
asked to stand up Redis she proposed a goal scoped to `deploy_workload`, and on
approval wrote the manifest and deployed it — pod 1/1 Running, Service on 6379.
Deleted afterwards; the artifact is that she could.

**Scope discipline, recorded because I got it wrong once.** Every phase here
builds CAPABILITY. No phase delivers a router integration or a Home Assistant
instance, and none should: Jeremy named those as examples of what she must be
able to do, not as things he wants built. If a future session finds itself
wiring a specific service, the only legitimate reason is phase 4's acceptance
test — and its output is deleted when the test passes.
