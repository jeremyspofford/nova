# Sandbox — she builds it, boots it, and proves it before it reaches him

Implementation plan, authored 2026-08-05 at Jeremy's request:

> "it would be beneficial to have her work sandboxed. ie: if she's spinning up
>  a new service for her to use, update her code or whatever, she should go
>  through the following flow: write code, build it and test it, but the build
>  & test will be in a sandbox environment. It'll just be exactly as her, but
>  would either be a different container, different suite of services/pods in
>  k8s, or an entirely new nova instance at an endpoint like
>  sandbox.nova.tailscalethingymagicdns.net"

## Why this, and why now

Her only test surface today is `delegate_coding_task`: a coding agent runs the
repo's tests inside a private clone. That catches unit-level breakage and
nothing else.

Every real failure of 2026-08-05 was invisible to it, and the list is the
argument for this document:

| what broke | what would have caught it |
|---|---|
| Home Assistant's `/config` bound to a path **inside the sidecar** — its whole configuration would have been deleted by the next sidecar rebuild | booting the stack and inspecting the mount |
| `serve.json` gaining a comment key → tailscale discarded the entire serve config | booting tailscale |
| editing `serve.json` broke its single-file bind → container would not start, and **:443 went down with it**, taking the phone off Nova | booting tailscale |
| `home.timezone` defaulting to a real zone, so "unset" and "chosen" were the same value and the deploy could never ask | running the deploy |
| `_service_logs` referencing an unimported `settings` | calling the tool once |
| three suites red on pinned expectations after a new tool | running the suite against a **migrated** database |

Unit tests would have caught exactly one of those (the last). The gap is not
test coverage; it is that **nothing ever boots her candidate code before it
reaches the operator's machine**.

## The shape, in one line

An **ephemeral second stack**, built from her branch, with its own database
and its own data, that runs migrations, boots, runs the suite, and reports —
then is torn down.

## LOCKED decisions

Jeremy, 2026-08-05, in the message that requested this:

- **It goes in a plan first, and the current lane continues.** This is scoped,
  not started.

Decided in the same exchange and recorded here because the reasoning is the
expensive part:

- **The sandbox shares NOTHING with production.** Its own Postgres, its own
  memory directory, its own `nova_state`, its own auth token. This is not
  tidiness. A sandbox that touches live rows is *worse than no sandbox*
  because it looks safe: it has happened twice already on this install —
  the staged-tree suite that mutated live rows
  (`staged-tree-suite-mutates-live`) and `test_goals.py`, which spent
  Jeremy's real goal approvals until one hit 10/10 and was exhausted.
- **Automations and notifications are OFF in the sandbox.** A second Nova
  holding his ntfy topic pushes to his phone from a test run. `notify.*`
  disabled and every automation `enabled=false` at seed time.
- **No local inference.** No `ollama` in the sandbox profile. Six models
  back-to-back already starve the GPU on this box
  (`tournament-vram-self-starvation`); a second stack competing for 24GB
  makes both stacks slow and neither trustworthy. The sandbox uses cloud
  models, or a stub.
- **Her memory is SEEDED, never copied.** A sandbox runs model-authored code;
  handing it his real journals makes it an exfiltration surface. Seed a small
  synthetic corpus, or a redacted snapshot, and accept that some behaviour is
  not reproducible there.

## Phases

### Phase 1 — the boot gate (the whole value, none of the UI)

Given a `nova/<slug>` branch that `git-landing` produced:

1. `git worktree add` that branch to `.worktrees/sandbox-<slug>` — inside the
   repo, per the project's own worktree policy, never a sibling directory.
2. `docker compose -p nova-sandbox -f <worktree>/docker-compose.yml up -d`
   with an **override file** that: renames every volume, binds no host ports
   (or binds high ones), points `NOVA_MEMORY_DIR` at a seeded directory, sets
   a fresh `NOVA_AUTH_TOKEN`, and omits the `inference`, `notify`, `home` and
   `tailscale` profiles.
3. Wait for `/health`, then assert three things and report each separately:
   **migrations applied**, **backend booted**, **`tests/run_all.py` green**.
4. `docker compose -p nova-sandbox down -v` — always, including on failure,
   because a sandbox left running is a second attack surface and a GPU/disk
   drain.

A `nova-sandbox` compose project name is what keeps containers and volumes
from colliding with `nova`; it is the single most important flag in the whole
design.

**Deliverable:** a `sandbox_check` capability she calls with a branch name,
returning the three verdicts and the failing output. Not a card, not a UI —
a tool, so it composes into the phase-3 step machine as one step of a larger
task.

### Phase 2 — reachable preview

The same stack, kept alive and served at `sandbox.<tailnet>` so Jeremy can
click through her change before merging.

- A second `tailscale serve` route, or a second tailscale node. A second node
  is cleaner (its own MagicDNS name, no route collisions with :443/:8443/:8123)
  and costs an auth key.
- **TTL enforced by the backend, not by intention** — a preview stack expires
  and is torn down on a timer, because "I'll clean it up later" is how a
  second Nova ends up running for a week.
- The preview is where "exactly as her" starts to matter: same agents, same
  tools, seeded memory.

### Phase 3 — the loop closes

`delegate_coding_task` → `sandbox_check` → **only a green sandbox may raise a
landing card**. That last clause is the point of the whole document: it turns
"she wrote some code" into "she wrote code that demonstrably boots", and it is
a mechanical gate rather than a habit.

## Open questions

1. **Docker-in-docker, or the host socket?** `inference-control` already holds
   the socket and could run the sandbox compose project. That keeps one
   dangerous mount instead of two — but it also means a sandbox failure can
   reach the production daemon. DinD is more isolated and much slower on WSL2.
   *Leaning: host socket via a dedicated fixed verb on the existing sidecar,
   because the compose project name is the real isolation and DinD's cost is
   paid on every run.*
2. **How is the sandbox's database seeded?** Migrations alone give an empty
   install with no agents. Either run the same seed path a fresh install uses,
   or snapshot-and-redact production. The first is honest and diverges from
   his real setup; the second reproduces his setup and carries his data.
   *Leaning: fresh-install seed, plus a fixture pack of agents/tools so
   behaviour is comparable.*
3. **What does a k8s variant buy?** Jeremy raised it as an option. Her
   namespace is already fenced (Pod Security, quota, default-deny egress), so
   it is a genuinely stronger boundary than a compose project — but Nova is
   not deployed as k8s manifests, so this would mean maintaining a second
   deployment description of the whole stack. *Leaning: no, unless Nova itself
   moves to k8s.*
4. **Cost ceiling.** A boot-and-suite run is minutes of CPU and a few hundred
   MB of images. A preview stack held for a day is not free. Needs a cap and a
   number Jeremy has agreed to.

## What this does NOT solve

It does not review her code. A stack that boots green can still contain a
change that is wrong, ugly, or unsafe — the diff on the landing card is still
the review, and the operator merging is still the gate. This makes "it boots"
a fact instead of a hope; it does not make "it is correct" one.
