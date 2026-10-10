# Doing things — she changes her own code, deploys it, and loops until a goal is met

Status: DESIGN. Written 2026-09-18; **refreshed 2026-09-30** against `main`
at `e9c871f3` and, read-only, `slice/s42b` at `96f6c6c3`. **Nothing in S29
and after is built.** S37a, the MCP client, started 2026-09-30 in its own
lane. The owner answered three questions on 2026-09-30 (below). The
questions still open are at the end, each with a default.

**2026-10-05: self-coding moved forward and widened.** See
[`nova-codes.md`](nova-codes.md). It amends this doc and wins where the two
differ: the new order, outside coders with Nova driving (S32b widened), work
she starts herself (S34b), reacting to monitoring and CI (S37c widened), other
repos (S32c), and `CLAUDE.md` becoming `AGENTS.md`.

How it was produced, so it can be distrusted in the right places. The
2026-09-18 design came from a read-only understand pass (eight readers over
`services/`, `apps/novad`, `deploy/`, `tests/e2e`, the v3 plan docs and the
master plan; every claim re-opened at its cited line by a second, adversarial
agent; a completeness critic), then a design pass (three architectures, three
judges, one synthesis). The 2026-09-30 refresh re-opened every file:line
citation against `e9c871f3` and re-measured every guard behaviour by
**calling** the pure guard functions, not by reading them. Runtime facts that
could only be re-measured by operating the stack are marked "as of 2026-09-17,
not re-measured".

## Owner decisions, 2026-09-30

1. **The doing lane goes right after S42b.** The hub lane's remaining slices —
   S46a, S46b, S43a, S43b, S44, S48 and S49 — are **paused**. Capability
   first. The downside, accepted: the Dell stays hand-powered (nothing wakes
   it), nothing holds it awake while she uses it, new machines join the tailnet
   by hand, and there is no Headscale or LAN-only transport.
2. **An MCP client starts now, as S37a** (branch `slice/mcp-client`,
   `.worktrees/mcp`), beside S42b. This answers Q12 in part: MCP first.
   GitHub, which CI watching needs, ships an official MCP server with Actions
   tools, and the complex self-hosted apps named as examples have MCP servers
   too (Home Assistant through its own MCP Server integration and the
   community `ha-mcp`; n8n through its built-in instance-level server) — so an
   app she installs often brings its own way in. The stored HTTP tool-definition table (Q12's old option B) is not being
   built now.
3. **This refresh**, with the still-open questions re-asked with defaults.

Clarified the same day: **Home Assistant and n8n are examples, not install
targets.** The owner runs neither and does not want them installed. What he
wants is the capability to install any program, and those two are named
because they are the hard case: complex, self-hosted apps.

## The asks, verbatim

**2026-09-17:**

> I really want to get Nova to start "doing" things. Like modify her own
> code/configurations is a must. Be able to do things like blue/green
> deployments of her instance. Be able to search the internet, research
> solutions to goals, improvise, test, confirm, loop until goal is met. I
> need nova to be able to do things like setup applications, configure
> integrations, sign up for things. She needs to be able to read
> information on every device she has a thin client instance on that she
> can control, etc.
>
> I'd rather be able to work with nova to develop herself than an outside
> AI coding agent such as claude.

**2026-09-30:**

> whats next, remaining, your recommendations, and what can we do to get
> nova to start being able to do thigns. ie: download and configure
> applications like n8n, homeassistant or others? Add devices on it's own to
> home assistant, configure connections and configure n8n settings, browse
> the internet, code, watch ci/cd pipeliens, edit and modify it's own
> code/environment and filesystem, do all those things on other devices,
> watch and record screens of other devices, be proactive and reactive and
> logical?

**2026-09-30, clarifying** (relayed; the bracketed words are the relay's):

> I don't [run HA or n8n] and I don't want them installed. What I want is
> nova to have the capabilities to install though. Any programs, but those
> are complex ones because you can host [them yourself].

## The finding, in one paragraph (revised 2026-09-30)

On 2026-09-18 the finding was that **reach was not the gap; honesty and
durability were**: the Dell ran the stack and was already a paired device with
sudo and docker. Since 2026-09-22 the stack runs on the mini PC, and **the mini
PC has no agent** (`slice-42a-agent-every-os.md:146`: "There is no mini-PC-agent
step (no such agent exists)"). S42b installs one: `./install` installs the hub
machine's own agent (S42b plan, Task 27). So for one more slice, reach on the
hub **is** a gap, and S42b closes it. After that the 09-18 finding holds again,
re-measured below: what her hands did cannot be checked (a failed command is
filed as a success), nothing she starts outlives a turn, and nothing says which
commit a service is running. None of that needs a new service. S38, her own
browser, is the first slice here that adds one.

## Changed since 2026-09-18

Every correction, with its evidence.

| 2026-09-18 said | Now | Evidence |
|---|---|---|
| The stack host is the Dell, a paired novad device | The stack runs on the mini PC since 2026-09-22. It has no agent until S42b. The Dell runs the S42a Windows agent and its own ollama | `slice-42a-agent-every-os.md:146`, `:397-398`; S42b Task 27 |
| novad is Linux-only (`main.go:162`) | Native Linux, macOS and Windows agents (S42a); the frame reports `runtime.GOOS` | `apps/novad/main.go:188`; `services/core/migrations/036_agent_facts.sql` |
| No frame carries a daemon version | The facts frame carries `agent.version`, stamped at build. S42b makes it the git tree of `apps/novad`, the same on CI, the hub and every laptop | `internal/facts/facts.go:59`, `main.go:36-38`; S42b Task 4 |
| `Dispatch` is a literal switch (`caps.go:45-66`) | A handler table (S42a); `caps.Names()` derives the list | `internal/caps/table.go`, commit `47a66713` |
| `shell.exec` hangs on a backgrounded child; a command killed by its own socket closing is audited `ok:true, exit -1` | **Fixed** in S42a: the whole process group dies on timeout, `WaitDelay` bounds the pipe drain, a dropped connection is never "ran" | `internal/caps/procattr_unix.go:29-42`; commits `c3da4ff9`, `2a8402b2` |
| The host daemon is a pre-ruling build (`676d554f`); linger is off | Moot. The WSL agent was revoked 2026-09-28 and S42b retires it; S42b's Linux service turns linger on | `slice-42a-agent-every-os.md:397`; S42b Tasks 3 and 8 |
| Eight capabilities | Nine on `main` (`facts.refresh` added); S42b adds `daemon.update` | `internal/caps/table.go:12-22`; the same file on `slice/s42b` |
| S31, a signed self-update, is future work | **S42b builds it**: a core-signed manifest, `daemon.update` (download, verify, stage), `supervise` swaps and reverts, an update counts only when the agent reconnects on the new build, and Nova updates idle agents one at a time | S42b plan summary; Tasks 9, 10, 18, 20, 22 |
| Commands can hang on a password prompt | S42b P30: children get no terminal and empty input, so `sudo` fails at once in its own words. S42b P29: the agent reports in advance what elevating would meet (`sudo -n`, Administrators membership, Windows sudo's mode) | S42b plan lines 41-42, 92-93; Tasks 10b, 10c |
| Structured span facts exist for two things | Six kinds now: device connectivity, machine status (`answering`, `checked_now`), Nova's address, the setup card, the resolved model id, agent delegation. Still none for a command's exit code, a file, or a probe | `tools/devices.py:102`; `tools/machines.py:161-166`; `tools/setup.py:75-77, 149-153`; `tools/models.py:651, 764`; `agents.py:1410` |
| Registry 39, `reads_only` 20, `Tool` 8 fields, `ToolContext` 6 | Registry 43, `reads_only` 22, `Tool` 10 fields, `ToolContext` 7. S42b takes the registry to 44 | `tests/test_no_approvals.py:139-150`; S42b plan line 40 |
| Corpus 23 cases, `suite_version` 13 | 30 cases, `suite_version` 17. S42b: 32 cases, 18 | `tests/test_eval_corpus.py:471-477`; S42b plan line 40 |
| Next core migration 035 | `main`'s last is `038` (S37a's `038_mcp_servers`, 2026-10-06); S42b takes `039_agent_lifecycle`; this lane starts at 040 | `services/core/migrations/`; S42b Task 14 |
| `live_facts.AUTO_RUN`: sixteen reads | Eighteen | `live_facts.py:82` |
| Twelve typed settings, one with a writer tool | Fourteen, still one writer tool (`model_pull` sets `chat.model`). The decision switches added 2026-09-29 have no tool | `settings_store.py`; `tools/models.py:777` |
| Item 0, the core suite wedge, blocks S32 | Resolved 2026-09-18 | `ROADMAP.md:48`; `docs/incidents/2026-09-16-core-suite-wedge.md` |
| The roadmap's "section F" marks a goal loop superseded; its proposals A (secrets), B (MCP), D (backups) | That section was removed; the roadmap now names the goal loop as a capability the owner intends to have. Secrets are ARCS arc 8; MCP is S37a; backups shipped in S41 | `ROADMAP.md:219-223`; `ARCS.md` §1, §8 |
| No backups, so S33 writes its own `pg_dumpall` | S41 shipped an encrypted bundle, a verified restore and a drill, as operator commands (`./install backup`, `restore`, `drill`). Nothing runs the drill on a schedule and she has no tool for any of it | `slice-41-portable-hub.md`; `deploy/backup.sh`; no backup tool in the registry |
| CI and hooks are off | `rebuild-ci` runs on `main` and `slice/**` since 2026-09-21. **Every run on `main` since 2026-09-28 has failed**: core, web and backup-macos fail, gateway and memory are cancelled | `.github/workflows/rebuild-ci.yml:12-16` (`1b61b0eb`); run `36719466510` on `e9c871f3` |
| The v3 compose shares the project name `nova` | v3's root compose is project `nova-v3` | `docker-compose.yml:8`; commit `37b73ca5` |
| — | **New:** the decision role asks a per-turn tool hint on typed and eval turns, and fails open | `ROADMAP.md:50`; PRs #85, #86 |
| — | **New, in review, not on `main`:** a tool written as text, or a device action claimed with nothing run, gets an append-only correction at the end of the turn | `fix/said-not-done`: `bc89e231`, `863ef2db`, `ea48347a` |
| — | **New:** the handback guard was built and **shelved** by the owner 2026-09-29. A redirect that invites action could not be made both safe and useful by regex | `fix/handback-guard` at `8591c74f`, `docs/plans/rebuild/handback-shelved/` |
| — | **New ruling, 2026-09-27: no phrase matchers.** A regex over the owner's message that makes the backend act was rejected (PR #77, reverted by #78). Every guard in this design reads her reply and the turn's facts, never his message | `slice-47-setup-qr.md:4531-4534` |

**Re-measured and still true on `e9c871f3`** (each guard was called, not read):

- "I ran pytest and all 40 tests passed" is **silent**, with no span and with an
  ok `device_run` span.
- "I edited chat.py and fixed the bug" and "I deployed the new core" are
  **silent**. Edit, fix, patch and deploy are not narration verbs
  (`guards.py:410-420`).
- "I read config.yaml on the Dell", with an ok `device_read_file` span, is
  **corrected as unbacked**: `_READ_TOOLS` names only `workspace_read_file`
  (`guards.py:64`). The same for an ok `device_write_file`.
- "I can't search the web" and "I can't run commands on your laptop" are
  **silent**. S42a added one narrow row, so "…on a Windows PC" is corrected
  (`guards.py:1755-1768`).
- "The new backend is not responding yet", with a probe behind it, is
  **replaced** as a stale-outage claim (`stack_claim_check`, `guards.py:7044`).
- `device_run` returns the exit code only in its text (`tools/devices.py:273-282`);
  the agent reports `ok:true` on a nonzero exit by design
  (`internal/caps/shell.go:17-18`).
- `chat._redact` filters nothing by name (`chat.py:1665-1679`).
  `live_facts.SPAN_RESULT_HEAD_CHARS` is 400 (`live_facts.py:60`), chat's is 500
  (`chat.py:425`), and the comment above the first still says they match.
- The Activity page renders no span facts (no `facts` in
  `apps/web/src/pages/activity/`).
- The scheduler never reads `conversations.person_busy`; only chat does
  (`chat.py:6131, 6218`).
- Spans are written only at turn close (`traces.close_turn`, `traces.py:241-262`).
  A scheduled turn starts with no history (`scheduler.py:605-615`).
  `SERVICE_VERSION = "0.0.1"` in all three services. `./install update` exits 1
  (`install.sh:1874-1877`). No image installs git. Core mounts only its
  workspace and a read-only status volume. The compose file still has four
  relative binds (`./postgres-init`, `../data`, `../searxng`, `./tailscale`).

**Not re-measured** (runtime facts of 2026-09-17, on a machine that no longer
runs the stack): which trees the live images were built from, image build times
against commits, the exited v3 containers. Since 2026-09-25 the owner's rule is
that everything deployed is built from `~/workspace/nova` on `main`, never a
worktree.

## What is true today

**Her hands.** The Dell's Windows agent is paired (S42a); the hub has none
until S42b. `device_run` is argv-only, and core sends only `argv`
(`tools/devices.py:273-282`) although the agent honours `cwd`
(`internal/caps/shell.go:33-36`). The agent kills a command at 110 s
(`internal/client/client.go:42`); core waits 120 s (`tools/devices.py:42`);
output is capped at 64 KiB (`internal/caps/caps.go:25`). File reads and writes
are whole-file, up to 256 KiB (`caps.go:23-24`); `chat.py` is now 318 KB, so no
tool reads her largest file whole. A command that needs admin rights can
today wait on a password prompt until the 110 s timeout; S42b makes it fail at
once in the program's own words, and says in advance that it would.

**What the hands do cannot be checked.** See the re-measured list above.

**Nothing survives.** There is no goal row; the word appears nowhere under
`services/core/app`. A chat turn stops at `agents.max_tool_rounds` (default 6,
`settings_store.py:152`; an agent may have 1 to 50, `agents.py:94`): the
pending calls are refused and a note says so (`chat.py:4569-4571, 4676-4684`).
Tool results never cross a turn. A graceful core stop drains for up to 330 s
(`deploy/docker-compose.yml:49`); then the startup sweep marks unfinished turns
interrupted (`traces.sweep_orphaned_turns`, `main.py:76`). Nothing resumes.

**Nothing says what a service is running.** No SHA in any image and no
`update` verb. The agent is the exception: it reports its version (S42a), and
S42b makes that version a content hash of its source tree.

**The loop primitives that exist.** Scheduled timers, hers to create and
cancel, paused after five failures with the reason on the row. `checks/` (S11):
code predicates with a three-way verdict. `live_facts.AUTO_RUN` (eighteen
reads) and `NOT_AUTO_RUN` (`fetch_url`, `web_search`, `memory_search`,
`load_skill`, each with its reason, `live_facts.py:134`). The scheduler already
runs `device_notify` unasked from an owner-written reminder with code-built
arguments (`scheduler.py:456-500`). `_ROLE_BY_KIND` gives a turn kind its
routing role in one dict entry (`chat.py:3150`). The proactive beat and daily
digest (S11) exist and ship **off** (`proactive.enabled` default False,
`settings_store.py:194`).

**What nothing inside the stack can do.** Reach the repo, git, docker or a
shell. Send anything but a GET: `fetch_url` is public addresses only, 500 KiB,
text and JSON only, no cookies, no JavaScript, no PDF (`tools/web.py:33, 72-76,
175, 192-196`). Filter a search: `web_search` takes only a query
(`tools/web_search.py:272-284`). No browser, no mailbox, no secrets store, no
MCP client (S37a starts one), no screen capture, no event intake. Tool
arguments reach `turn_spans` unmasked.

**The pins that move**, counted from after S42b lands: registry 44;
`reads_only` 22; `Tool` 10 fields and `ToolContext` 7, both pinned exactly by
`test_no_approvals`; corpus 32 cases at `suite_version` 18; next core migration
039. S37a moves the registry too. **Whichever lands second renumbers once.**

## The asks, clause by clause

| Clause | Today | Delivered by |
|---|---|---|
| **Install any program** (Home Assistant and n8n are the owner's examples of the hard case; neither is to stay installed) | `device_run` on a paired machine, 110 s per command, no came-up check, no agent on the hub | S42b (the hub's agent) → S30 (jobs that outlive a turn, a came-up probe) → S37d (the app's API) → the install walk. Admin-rights installs: Q17 |
| **Configure an installed app** ("add devices to Home Assistant on its own", "configure connections and n8n settings", "configure integrations") | config files through `device_write_file`; its HTTP API only through `curl` inside `device_run` | four routes, below |
| Browse the internet; search it; sign up for things | `web_search`, `fetch_url` (GET, public, no JavaScript) | S38 (her own browser); sign-ups also need Q6 |
| Research solutions to goals | a turn whose successful calls were all ephemeral reads is never ingested into memory; findings survive only if she saves them | S34 (`goal_note`) |
| Code; modify her own code; develop herself with him | nothing | S29 → S30 → S32 → S33 → S35 (Q2, Q5, Q14) |
| Watch CI/CD pipelines | nothing, and CI on `main` fails every run | S37a (GitHub's MCP server: runs, job logs, reruns) + S34 (a goal that waits for a run). CI must go green on `main` first, or there is nothing to watch |
| Edit her own environment and filesystem; modify her own configuration | workspace tools; device tools elsewhere; one settings writer tool | S29, S30 (range reads, jobs), S37b (Q11) |
| Blue/green deployments of her instance | nothing | S33 (Q4) |
| Improvise, test, confirm, loop until the goal is met | six rounds and out | S34 (Q3) |
| All of it on other devices; read every device | hands on every OS (S42a) | S42b (install, updates). S30's jobs and S39's screens live in the agent, so every machine gets them |
| Watch and record screens of other devices | nothing | S39 |
| Be proactive | S11's beat and digest, off by default | turning `proactive.enabled` on is a setting, not code; S34 keeps work going unasked |
| Be reactive | only chat and timers start a turn | S37c (event intake) |
| Be logical | the model; nothing measures reasoning | Q5 (which model does this work) and S26 (measures it). The decision role's tool hint already helps the 8B pick tools |

**Configuring an installed app has four routes**, and each has a slice:

| Route | Today | Slice |
|---|---|---|
| Its config files | `device_read_file` / `device_write_file`, whole-file, 256 KiB | range reads in S30 |
| Its HTTP API | only `curl` inside `device_run`, whose HTTP status is prose nobody checks | **S37d**, a general HTTP request tool (a gap; stub below) |
| Its web UI | nothing | S38, her own browser — for the steps that have no API |
| Its MCP server | nothing | S37a, when the app ships one |

## What v3 built, and what survives the ruling

v3 built a self-coding lane and exercised it once, by hand. Every stop was
infrastructure or money — a key, a dirty tree, a reloader, a floor nobody
seeded — never her judgment. **The lane spent weeks building gates and
never got one change through them unattended.**

- KEEP, as facts: the tri-state grader (pass / fail / skip, skip never
  success); verdicts keyed to the exact SHA and written on every path;
  name-validated, came-up-verified redeploy; *the reporter must outlive
  the thing it reports on*; different-model review as a recorded fact;
  ceilings as CANNOTs; *the model never closes its own goal*; *derived
  from the artifact, never from the report*.
- DROP: operator merge as the gate (lifted by the owner 08-07, banned
  09-03); the protected-paths hit that "becomes a card and waits"; goal
  activation by consent; the `untrusted_context` fence; the coder being an
  outside agent.
- REFRAME: detecting what a diff touched stays (parsed from the diff,
  unreadable stated, never "none"); what a hit DOES is Q7. The threat a
  fetched page poses stays as a FACT on the record, never a refusal (Q13).

## How this sits against the roadmap

- **The goal loop is back on the map.** The roadmap section that recorded it
  as superseded was removed on 2026-09-18 (`da4bda92`); the roadmap now lists "the
  autonomous goal loop" among capabilities the owner intends to have
  (`ROADMAP.md:219-223`), and ARCS arc 1 carries it. What differs from v1's
  `cortex`: it is closed by a code predicate and never by her sentence, its
  budgets are columns read before anything is spent, every attempt is a
  traced turn through the one funnel, and it has no drives — it runs only
  goals someone stated.
- **Secrets.** ARCS arc 8's position — an encrypted store, `{{secret:name}}`
  resolved only at the outbound call — is Q6's default. S37a needs somewhere
  to keep tokens now; whatever its spec chooses is replaced by Q6's store
  when that exists.
- **Backups shipped** (S41). S33's pre-deploy snapshot is an S41 bundle taken
  by the host job, not a second dump path.
- **S26 before self-coding?** ARCS arc 6 says the coding arc waits on S26,
  because a self-coding loop gated by an eval floor needs a corpus that
  measures capability. This order runs self-coding first, and it can,
  because **no eval floor gates a landing or a deploy under any answer
  here**: the landing step runs the pinned test suites, which exist. S35's
  `goal_attempts` rows become S26's first coding-capability cases (the old
  Q0's argument). What does wait on S26 is the answer to "can the local
  model do this work", which is why Q5's default points the `coding` role
  at a cloud model until S26 says otherwise.
- **The paused hub slices.** With wake and the hold paused, a goal attempt
  routed to the Dell's models stalls while the Dell sleeps. A cloud-first
  `coding` chain (Q5's default) does not.

## The design

Five moves. Two of them are now partly S42b's.

1. **Every hand files a fact** (S29). Each device-backed call files
   structured facts on its span, taken from the agent's own result frame,
   each with a generic `target` key. Guards and eval predicates read facts,
   never `result_head` prose. A new `Tool.backs` field (the `result_kind` /
   `reports_spend` / `reads_machines` pattern) replaces the hand-kept
   `guards._KIND_TOOLS`, so a tool joins a guard by declaring what it backs.
2. **The agent says what it is, runs work that outlives it, and can be
   updated by her.** "Says what it is" and "updated by her" are S42b's. What
   is left is S30: detached jobs whose wrapper process owns the log and
   writes the terminal record to disk outside every container, and range
   reads.
3. **Every image says which commit it is** (S32). The git SHA and a
   per-service content hash are baked in and reported on `/status`; images
   are tagged by that hash so the previous build is still there. S42b's
   agent version, the git tree of `apps/novad`, is the same idea already
   working.
4. **Landings and deployments are rows keyed to a SHA** (S32, S33). The
   verdict is written by a host process outside core and reconciled by
   whichever core comes up next. `deploy_stack` takes a LANDING id, never a
   SHA, so "deploy an unverified commit" cannot be written down.
5. **A goal is a row that code closes** (S34). A finish line from a fixed
   vocabulary of predicate families, its arguments validated at creation
   and immutable after; budgets as columns read before a turn is opened;
   re-entered as a timer kind on the existing claim, so the next process
   resumes it for free.

### Every claim gets a fact

| She says | The fact that backs it | Read by |
|---|---|---|
| "all 40 tests passed" | a `run` fact whose target names the test runner and whose `exit_code` is 0; or a landing fact `green` | `narration_check` kind `tests_passed`. With `exit_code != 0` this turn, corrected. With exit 0, stands — a guard that corrects an honest reply is the liar |
| "I read config.json on the Dell" | a `file` fact `{op: read, target}` on a `device_read_file` span | `narration_check` via `tools.tool_names_backing`. The measured false correction becomes a pin that must stay silent |
| "the new backend is not responding yet" | a `probe` fact `{ok: false, target}` this turn | `stack_claim_check` — stands; corrected only when the probe said ok |
| "the Dell is offline", after a severed call | the LAST `{device, connected}` fact on the span (the sink is append-only; a severed redeploy leaves both true and false) | `state_claim_check`, last-fact rule pinned |
| "I can't run commands on your laptop" | none can: `device_run` is in the registry | `capability_claim_check`, kept complete by `test_every_registered_tool_is_covered_or_excused` — the `AUTO_RUN` / `NOT_AUTO_RUN` shape |
| "I installed X" / "X is up" | a `job` fact `done` with exit 0 and a `probe` fact `ok` on X's address | `narration_check` kinds `installed` / `came_up` |
| "I removed X" | a `job` fact `done` with exit 0 and a `probe` fact that X no longer answers | `narration_check` kind `removed_app` |
| "I landed it" | a landing fact `green`. Red, `cannot` and `pending` back nothing | `narration_check`; `deploy_stack` reads the row |
| "I deployed it" | a deploy fact `serving`, written by the reconciler from the host wrapper's verdict after a `/status` read-back | `narration_check`. With state `started`, corrected to "started deployment <id>" |
| "core is running abc123" | a `build` fact from core's own env or a peer's `/status` | `narration_check`; `stack_build_identity` finds `unknown` or `latest` |
| "the job is done" | a `job` fact `done` with an exit code read back from the wrapper's record. An unknown id is "no job <id> on this device", never done | `narration_check`; `deferral_check` backs a deferral that names a started job |
| "the goal is met" | a `goal` fact `met` produced by the predicate from row arguments only | `goal_claim_check`; a grep pin that only `goals.close` writes `met` |

Every check here reads **her** reply and the turn's facts. None reads the
owner's message (ruling 2026-09-27).

### Which line of code refuses when she is wrong

- **Dispatch is untouched.** One await, the executor; `_run_tool` awaits
  only dispatch. `Tool` gains `backs` (10 → 11 fields) and `ToolContext`
  gains `turn_id` (7 → 8) as dated pin bumps in `test_no_approvals`, each
  with an AST twin of `test_dispatch_never_reads_reads_only`. `turn_id` is
  an identity channel for writing provenance, never a principal.
- **Every cannot is a fact and says which:** unpaired; offline; the agent
  answered "unknown capability" (the words `caps.Dispatch` keeps for this);
  no job by that id; no landing row for that id; the suite is red on this
  SHA; a deployment is already started for this tree; a budget column is
  exhausted; a migration was crossed; the finish line could not be read five
  times running; the command needs admin rights this machine's agent does
  not have (S42b's `elevation` fact).
- **A finish predicate receives only arguments from the row**, pinned by a
  spy family. Families live OUTSIDE `checks.REGISTRY`, pinned — otherwise
  the hourly beat would run a goal's argv unasked.
- **The protected set is derived, not listed:** paths under `tests/`,
  every test file's app imports, `evals/cases`, `migrations/`, and the
  landing job's own scripts. An unreadable diff is recorded `unreadable`,
  never `[]`.
- **Credentials never reach the trace:** masking of `env` / header / token
  maps and credential-shaped values in `chat._span_arguments`, BEFORE
  `_bounded`, pinned by a test that no token bytes reach `turn_spans`.
- **A deploy is `serving` only after a read-back** — container healthy AND
  `/status` reporting the expected content hash. "Requested" and
  "confirmed" are different columns.

## The slices

Sizes S/M/L. Every DoD is operator-visible in the running app, walked in
her words, and read by turn id. Each slice gets its own implementation plan
when its turn comes; this is the contract those plans are written against.

**S29 — Facts on device spans, guards that read them, and the measured
defects fixed (M; core only; runs against today's agents).** The facts
vocabulary with `target`; `device_run` files `run` from the frame's
existing exit code; file facts on device reads and writes; `Tool.backs` and
`tools.tool_names_backing`, with `_KIND_TOOLS` deleted; claim kinds
`edited_file` / `ran_command` / `tests_passed`, fact-gated and
target-aware; capability rows for `web_search` and every device tool, plus
the covered-or-excused tripwire; the `stack_claim` probe exemption; the
last-connectivity-fact rule; span masking; `live_facts`' head length
imports chat's constant; presented-listing arms on the `run` fact instead
of the prose preamble; an eval `fixture_device` seam (S42b's carry: "the
case waits for a fixture that can answer `device_run`") and one generic
`fact_matches` predicate; corpus cases in both directions; Activity renders
span facts. It builds on whatever `fix/said-not-done` lands, since both
change the same guard family.
*DoD:* "run `python3 --version` on the mini PC" — the reply quotes the exit
code and Activity shows `facts.run.exit_code`; a fixture exit 1 under "all
40 tests passed" is corrected and the same case with exit 0 is not; "I read
README.md on the Dell" stands; "can you run commands on my laptop?"
answered "no" is corrected; a `device_run` with `env {GH_TOKEN: …}` shows
`<masked:40>` on Activity and `turn_spans` holds no token bytes.
*Pins:* `Tool` 10 → 11; corpus 32 → about 40, `suite_version` 18 → 19.
*Waits on:* S42b (it changes the same device tools and the eval harness).

**S30 — Jobs that outlive a turn, range reads, and the came-up probe (L;
smaller than it was).** Already done elsewhere, and struck from this slice:
the dispatch table, the build stamp and version frame, group kill (S42a);
linger, how-the-agent-runs facts, no-input commands, updates (S42b). What
is left. In the agent: `fs.stat`; `fs.read` by byte, line or grep range;
`job.start/status/log/stop/list` with a wrapper (`novad job-exec`, a
separate process) that owns the log and writes the terminal record and exit
code to disk, a scanner that re-sends unacked `job` frames on reconnect,
and ONE audit entry per terminal job so the chain stays single-writer. In
core: migration 039 (`device_jobs`); `device_run` gains `cwd`, `env` and
`timeout_s`; `device_stat`; range reads on `device_read_file`;
`device_job_start/status/log/stop`; `device_probe_http` (moved here from
S32, because an install needs a came-up check; `NOT_AUTO_RUN`, with the
reason); `ToolContext.turn_id`; `hands.py`, the seam code uses to touch a
machine, with the stack host derived — now the hub's own agent (S42b's
`host` transport); claim kinds `installed`, `came_up` and `removed_app`,
backed only by job and probe facts.
*DoD:* a `sleep 200` job survives a web restart and reads back `done, exit
0`; an unknown job id answers "no job <id> on this device"; "read lines
1200–1260 of chat.py on the mini PC" returns the range with `bytes_total`
on the fact; a probe of a port nothing listens on is `ok:false` with the
reason.
*Pins:* registry 44 → 50; `reads_only` 22 → 26; `ToolContext` 7 → 8.
*Waits on:* S42b.

**S31 — superseded by S42b.** S42b builds the signed update path end to
end. Nothing of S31 is left.

**S30b — The standing admin path (M; owner, Q17, 2026-09-30).** Installed
once per machine with one OS prompt: on Linux a root-owned helper the agent
talks to over a socket only the agent's user can open (or a sudoers rule for
the agent's user — the plan picks and says why); on Windows an elevated
scheduled task or service the agent drives. It runs ANY command as root or
admin, not only named fixes (S42c's boundary is dropped by the owner).
`device_run` gains `elevated`; the agent's facts report whether the path is
installed and which kind; every elevated call is a span with `elevated:
true` and the machine; nothing asks and nothing refuses. Uninstall removes
it and proves the removal. The Devices page states the surface: a core
compromise is root on every machine with the path.
*DoD:* on the mini PC, "install htop" runs `apt-get install -y htop`
elevated with no prompt, and the span says `elevated: true`; on the Dell, an
elevated winget install succeeds from a signed-in session with no UAC
prompt; uninstalling the path on one machine makes the next elevated call a
stated "no admin path on <machine>".
*Waits on:* S30 (jobs, because an install outlives a turn).
*Moved 2026-10-06 (owner):* S30b now runs right after the provider-balances
slice, ahead of S46a ([`s46a/spec.md`](s46a/spec.md) §11) and of S30. Its
elevated `device_run` runs inside a turn; an install that outlives a turn waits
for S30's jobs, so the htop and winget proofs above are short installs. On
Windows the path must be a service, not a scheduled task: S46a suspends
BitLocker from its pre-shutdown handler.

**S32 — Build identity and her landing step (L).** `NOVA_BUILD_SHA` and a
per-service content hash baked into all four images, reported on `/status`
and web's `/build.json`; images tagged by that hash — a tree-wide tag would
recreate all four services on every deploy, killing gateway mid-inference
and severing every agent through web; binds made absolute (today four are
relative, so a deploy from another directory silently loses them);
`SERVICE_VERSION` deleted; `stack_status`; `repo_status` / `repo_diff`
(live tree derived from container labels, never assumed); `repo_land` +
`deploy/land_check.sh`: a commit authored `Nova <nova@host>` with a
`Nova-Turn` trailer, then **the suites run on a clean export of that
commit** against a per-job scratch database, so a dirty operator tree is a
fact on the record (`dirty_outside`), never a blocker and never a
contaminant; `landings` rows with the stored patch, read back by
`landing_status`; a **Changes page** and a thread on the landing notice —
the first surface where the owner sees her diff as a fact and can discuss
it. `nova-scratch-pg` becomes a compose service or a finding; today it is a
stray container every landing would depend on. GitHub CI runs on `main`
now, but the landing's verdict is her own suite run: CI is a second
opinion, and red today. From this DoD on, Claude does not commit in her
landing tree.
*DoD:* "what commit is running?" is answered per service and matches `git
log`; "change `get_time` to include the ISO week and land it" shows the
diff facts, a landings row (`green`, author Nova), the patch on the Changes
page and the commit in `git log`; a landing touching `guards.py` states
`protected: [services/core/app/guards.py]` on the record and in her reply;
a failing test shows `red` and the failing suite.
*Pins:* registry +5. *Waits on:* S30; Q2; Q7.

**S32b — Claude Code as a coder (M; owner, Q5, 2026-09-30).** A coding
step in a goal attempt can be handed to `claude -p` on a machine where the
owner is logged into Claude Code, run as him through that machine's agent
(a detached job, S30), in her branch's worktree, with its transcript kept
(`stream-json`) and its permissions set by flags. Nova never holds or reads
his Claude login. The result is judged by S32's landing step — the diff and
the suites on a clean copy — never by the session's report. Routing gains
"Claude Code on <machine>" as a coder choice beside the `coding` role's
models. Policy (Anthropic docs, checked 2026-09-30): running `claude -p`
yourself with your subscription is documented; a product offering claude.ai
login is not allowed without approval; a RELEASED Nova driving each user's
own logged-in Claude Code is unclear — ask Anthropic before it ships to
anyone else. It shares his subscription's limits with his own sessions.
*Waits on:* S30 (jobs), S32 (the landing step that judges it).

**S33 — Deploy by SHA with the verdict outside core (L).**
`deploy/redeploy.sh`: build with args, tag, **an S41 bundle as the
pre-deploy snapshot** (it holds provider keys and the core signing key, and
it lives on the host because a rollback artifact must not share a deletion
boundary with the data it restores); migrations checked before and after
**per database** (three `schema_migrations` tables); `up -d` of only the
services whose content hash changed; health by inspect; `/status`
read-back; the ollama compute line; `verdict.json`. `deploy_stack` /
`deploy_verdict` / `deploy_rollback`; a lifespan reconciler and a hub
on-register hook so the NEXT core reads the verdict; a deployment silent
for ten minutes becomes a finding, never closed as serving by a timeout.
**The stop producer goes at signal level, not in lifespan:** uvicorn waits
up to 300 s on open connections before lifespan shutdown runs, and an SSE
chat turn is one. Incremental span writes on the existing `turn_spans.id`
(`002_core_schema.sql:58` — no migration) so a replaced turn keeps its
spans. A rollback across a migration answers "crossed migration NNN in
<db> — restore the bundle at … first; this tool does not". A disk-headroom
finding, because tagged images and a bundle per deploy accumulate on the
mini PC. **Retires "Claude deploys".**
*DoD:* "deploy landing <id>" — her turn ends with "deployment <id> started;
this core will be replaced" and closes ok with spans visible while the
build runs; minutes later the row reads `serving` with observed hashes and
the Inbox has "Deployed abc123" with a room; gateway was not recreated;
"roll back" brings the previous tags up.
*Pins:* registry +3. *Waits on:* S32; Q4, Q7, Q10.

**S34 — Goals: a durable loop closed by code (L).** Migration after S30's:
`goals`, `goal_attempts`, `turns.goal_id`, timer kind `goal`. Finish
families in `checks/goals.FAMILIES`: `file_contains`, `http_probe`,
`device_exit0`, `job_done`, `stack_serving`, `landing_green`,
`deployment_serving`. The runner, in order: budgets BEFORE `open_turn` (an
exhausted goal opens no turn, pinned by "no `llm_call` span exists"); defer
while the owner is mid-turn without counting an attempt; **evaluate the
predicate first** — met closes with no model call — and again after; an
interrupted attempt is charged from its written spans, not dropped; five
consecutive `CannotCheck` exhaust the goal; the retry cadence doubles after
three attempts with an identical facts line. Each re-entry is framed by
CODE from the goal's own record instead of an empty history. `goal_note`
writes to `goals/<id>/` on the workspace volume and the runner frames those
notes every attempt — **the durable research the ask needs**, with the
ephemeral-read exclusion left exactly as it is. Attempts land in an
inactive log conversation (the agents idiom), so the hallway gets ONE
notice per goal, with a room. Five tools: `goal_create`, `goal_check`,
`goal_note`, `goal_stop`, `goal_list`. A Goals page with Stop. Role
`coding`. Unasked predicate spans are stamped `args_authored_by`.
*DoD:* a goal he states in chat shows attempts on the Goals page, each a
kind-goal turn in Activity, and closes `met` with the probe's facts — her
reply never closed it; "goal met" typed by her with no goal fact gets the
appended contradiction; a goal that can never hold ends `exhausted:
budget_attempts 2 reached` with no further turns; Stop ends a running
attempt within one round; an attempt that started a deployment resumes on
the new core with the verdict in its frame.
*Pins:* registry +5. *Waits on:* S30; Q3, Q5, Q9.

**S35 — The first change she lands herself, end to end, as a goal (S; the
walk doc is the deliverable).** Below. Its `goal_attempts` rows become
S26's first coding-capability cases: the measurement, before anyone claims
the local model can code.

**S36 — Her tools over S41, the drill on a schedule, fleet fan-out (M;
smaller than it was).** S41 built the bundle, the verified restore and the
drill as operator commands. Left: her tools over them; a scheduled drill
that files a finding when it is stale or failed, because a backup nobody
has restored is a belief; `devices_run_all` with one span per device. Under
Q4's third option only: a candidate stack that exists to VERIFY, its
verdict a separate column never folded into the suites'.
*Waits on:* Q4, Q6.

**S37 — Integrations and her own configuration.**

- **S37a — The MCP client. In progress since 2026-09-30** on
  `slice/mcp-client`, specced in its own lane. Not designed here.
- **S37b — Her own configuration as data (M).** Shape by Q11.
- **S37c — Event intake (M).** A webhook from an installed app or GitHub
  starts a turn of its own kind, its payload framed as data from that sender
  and never as instructions; each sender has its own token, so a stranger
  cannot start one, and its own routing role. This is how she reacts to
  something other than chat and timers. After S34, because an event will
  usually start or resume a goal. Placement: Q16.
- **S37d — A general HTTP request tool (M).** Any method, headers and body,
  to the machines she works on — including private, LAN and tailnet
  addresses and a machine's own localhost, which is where an installed app
  listens — with tokens referenced from Q6's store, never typed into
  arguments, and masked in spans. The status code and headers are facts, so
  "configured it" can be checked. Most naturally an agent capability
  (`http.request`), because the app listens on that machine; core keeps
  `fetch_url` for the public web. Without it, an app's API is reachable only
  through `curl` inside `device_run`, whose HTTP status is prose. Placement:
  Q16.

**S38 — Her own browser (L; IN PROGRESS beside S37a since 2026-09-30).**
Spec approved by the owner: `docs/plans/rebuild/s38/spec.md` on
`slice/s38-browser`. Approach C: Microsoft's Playwright MCP server as a
pinned engine container, and five tools of hers in core that call it
through S37a's client (`browser_open`, `browser_read` in parts or by search,
`browser_act`, `browser_back`, `browser_screenshot`); ONE browser that
reaches everything (the owner's choice over two walled ones); her own
persistent profile; downloads into her workspace; and a shipped `browser`
agent the owner routes to a cloud or local model. It is also the route for
any app setting that has no API. Sign-ups need Q6's store and mailbox.

**S38b — Reading past the context (M; right after S38, owner 2026-09-30).**
His idea: "read what it can, then compress/summarize it when the context is
almost full, then continue reading". When a turn's gathered tool results
near the model's context, the older ones are replaced by written summaries
so the turn can go on; the full text stays on the trace, and a summary is
marked as one. General — logs, files and command output as well as pages —
which is why it is its own slice with its own evals and measurement.

**S39 — Screens: see, record, then act (L).** An agent capability that
captures the machine's desktop. The Windows agent runs in the user's
session (S42b's Run key), so it can see the desktop; Linux under Wayland
goes through the desktop portal, which may ask on that screen; macOS needs
Screen Recording permission and is unwalked. S28's vision routing reads a
capture the way it reads an attached image: the `chat.vision_model` setting,
or a model that can see which she picks. Recording is a job
(S30) that writes a file on that machine, which she reads back or hands to
the vision model as stills. Mouse and keyboard come after, in the owner's
daemon → browser → GUI order (master plan, 2026-08-27). Whether a capture
goes to a local or a cloud vision model is stated on the result, never
refused.

**The install walk (after S30 and S37d; not a slice).** It proves "install
any program" on the hard case: a complex self-hosted app of the same shape
as the owner's examples — several containers, its own database, a first-run
setup, an API — on the mini PC. She installs it as jobs, probes that it came
up, completes its first-run setup through its API (or finds the step that
has none — that is S38's first job), proves it works, then **removes it and
proves the removal**: containers, volumes and files gone, the port no longer
answering. It leaves nothing installed unless the owner names an app he
wants kept (Q18). What it will surface, stated so it is not rediscovered:
docker access on Linux is root-equivalent; an app that wants LAN discovery
needs host networking; Nova's own backups (S41) do not cover an app's data;
anything that needs admin rights is Q17.

## Order

**Superseded 2026-10-05** by [`nova-codes.md`](nova-codes.md): S42b → the
provider-balances slice → S29 → S30 → S32 → S32b → S33 → S34 (with the
`coding` role's modes, Q5) → S35 → S34b → S37c → S32c → S30b → S37d → the
install walk → S39. **S37a (MCP) and S38 (her browser), then S38b, run in
parallel now** (owner, 2026-09-30: "both in parallel").
S36 and S37b after S34, unscheduled. Then the paused hub slices (S46a,
S46b, S43a, S43b, S44, S48, S49, and S42c per Q15), then S26, then S27.

The 2026-09-30 order, for the record: S42b → S29 → S30 → S30b → S37d → the
install walk → S34 → S37c → S39 → S32 → S32b → S33 → S35.

## The first change she lands herself

`uptime_s` on core's `/status`. Small, in a small file, checkable from
outside. On the mini PC, whose agent S42b installs.

1. Jeremy, in chat: "Goal: add an integer `uptime_s` to core's `/status`,
   land it and deploy core. Finish: `GET http://127.0.0.1:8000/status` on
   the mini PC returns 200 with `uptime_s`. 4 attempts." → `goal_create`.
   Rows: `goals` (active, authored by the owner since the finish line is
   his words), a `goal` timer, an inactive log conversation.
2. The tick claims the timer: budgets unspent, owner not busy, predicate
   first → `not_met {status 200, matched false}`. The runner opens a
   kind-goal turn, role `coding`, framed from the row.
3. Attempt 1: `repo_status`, a range read of `main.py`, `goal_note
   plan.md`. Spans land on disk as they happen.
4. She writes the change, reads `repo_diff` back (`files: [main.py +4]`,
   `protected: []`), calls `repo_land`. The turn closes.
5. Between attempts the land job finishes on the host. The wrapper writes
   the verdict; the scanner sends the `job` frame; `landings.verdict`
   becomes `green`; a notice with a room.
6. Attempt 2: the frame carries the green landing. She calls
   `deploy_stack {landing_id}`; the row is inserted BEFORE the job starts;
   her turn is ended by code after one narration round.
7. The host job replaces her: build, tag, S41 bundle, `up -d core`,
   read-back, `verdict.json: serving`.
8. **The new core reconciles a verdict it did not start**, then the next
   tick evaluates the predicate → `met {status 200, matched true}`. One
   `goal_done` notice. Her sentence closed nothing.
9. Jeremy asks her "what's running?" and "what did you change?"; both
   answers are backed by facts.
10. The same day: memory `nova4-fable-drives-the-loop` and `CLAUDE.md` are
    amended to name the registrations that ended the bootstrap rules.

## Questions

### Answered or settled

- **Q0, where this lane sits** — answered 2026-09-30: right after S42b; the
  rest of the hub lane paused; S26 after the paused hub slices.
- **Q1, her hands on the host: the agent or a warden** — settled by S42b
  unless the owner says otherwise: the hub's own agent is her hands on the
  hub. A warden service stays possible later, behind `hands.py`.
- **Q12, what an integration is** — answered in part 2026-09-30: MCP first
  (S37a). An app without an MCP server is configured through S37d, S38 or
  its files.
- **Q8** is merged into Q7.
- **Q2, where her code goes** — answered 2026-09-30: the default. Her own
  branch per change; a change whose suites pass on a clean copy merges
  itself into `main`; deploys come from `~/workspace/nova` on `main`.
- **Q3, who decides a goal is done** — answered 2026-09-30: the default.
  Code, from a fixed list of finish checks set when the goal is made; he can
  stop any goal.
- **Q4, what blue/green means** — answered 2026-09-30, after he asked about
  lightweight Kubernetes ("deploy a new pod of a service, test it"): in
  place by commit NOW, shaped like a Kubernetes rollout (a desired image per
  service, a health gate, automatic rollback), so the master plan's optional
  S20 (a k3s target) can later swap the engine without changing her tools.
  Recorded with it: the real blocker for blue/green under compose OR k3s is
  the shared database (a new core runs its migrations against live data at
  start) and two singletons (memory's index file, the device hub) — true
  blue/green needs backward-compatible migrations, which a test can enforce.
- **Q5, which model does the doing work** — answered 2026-09-30: MODES plus
  Claude Code. The `coding` role (reserved today) gets a mode on Routing like
  the decision role's switches: Local only, Cloud only, or Hybrid, default
  local first (his words: "for me, it would be local first"). And Claude
  Code is BUILT IN as an optional coder: a coding step can be handed to
  `claude -p` on a machine where he is logged in, run as him through that
  machine's agent; Nova never holds or reads his Claude login; its work is
  judged by the diff and the suites on a clean copy, never by its report,
  and its transcript is kept. Policy, checked 2026-09-30 against Anthropic's
  docs: running `claude -p` yourself with your subscription is documented
  (code.claude.com/docs/en/headless); a product offering claude.ai login is
  not allowed without approval (code.claude.com/docs/en/agent-sdk/overview);
  a RELEASED Nova driving each user's own logged-in Claude Code is unclear —
  ask Anthropic before it ships to anyone else. An API key (the existing
  Anthropic provider) is the clearly allowed path. It shares his
  subscription's usage limits with his own Claude sessions.
- **Q6, credentials** — answered 2026-09-30: the default. An encrypted
  store (`{{secret:name}}` resolved only at the outbound call, its key on
  its own volume, provider keys and S37a's MCP tokens moved in); no tool
  ever returns a value; sign-ups use a browser profile (S38's) and a
  mailbox that are hers alone.
- **Q7, how her landing step judges a change** — answered 2026-09-30: the
  default. Suites always run on a clean copy; red cannot deploy; a change to
  the tests that grade her lands flagged; "could not measure" deploys with a
  note; "still running" waits.
- **Q9, her own goals' address/command checks** — answered 2026-09-30: the
  default. They run when she calls them inside her own turn; checks with no
  address or command of hers run unasked.
- **Q10, rollback on a failed read-back** — answered 2026-09-30: yes,
  recorded as "rolled back", never across a migration.
- **Q11, her configuration** — answered 2026-09-30: the default. Her
  instructions and typed settings are data she changes with a tool; compose
  and nginx stay code.
- **Q13, a page steering her commands** — answered 2026-09-30: the default.
  Recorded, not prevented: every call that changes something carries whether
  untrusted text was in that turn; research and action go in separate goal
  attempts by convention.
- **Q14, when the Claude rules end** — answered 2026-09-30: the default.
  `repo_land` (S32) ends "Claude commits in her tree"; `deploy_stack` (S33)
  ends "Claude deploys".
- **Q15, S42c** — answered 2026-09-30: paused with S46a. (Q17 below
  drops its "named fixes only" limit for the admin path; whether S46a still
  wants a named-fix layer on top is S46a's question when it resumes.)
- **Q16, placement of S37d and S37c** — answered 2026-09-30: the default.
  S37d right after S30 (and S30b); S37c right after S34.
- **Q17, installs that need admin rights** — answered 2026-09-30: **a
  standing admin path, NOT the default.** Set up once per machine with one
  OS prompt (sudo on Linux, UAC on Windows); after that she can run any
  command as root or admin on that machine. The owner chose it knowing the
  downside: anything she runs there can run as root, the widest reach there
  is, and it breaks S42c's "named fixes only" boundary. Consequences, all
  record-never-refuse: a new slice S30b builds it; every elevated call is a
  span with `elevated: true`; the machine's facts say whether the path is
  installed; and the Devices page states the accepted surface where he
  reads it — a core compromise is now root on every machine with the path.
- **Q18, the proving app** — answered 2026-09-30: the default. A complex
  self-hosted app (Gitea or Paperless-ngx) on the mini PC, proven working,
  then removed, and the removal proven.

### As asked (all answered 2026-09-30 — see above)

Kept as the owner saw them: defaults first, every option one line, downside
first. Q4 and Q5 were answered after a discussion (lightweight Kubernetes;
Claude Code), and Q17 against the default.

**Q2. Where does her code go, and what gets deployed?** (S32, S33)
*Changed from the 09-18 recommendation, which deployed from a branch of her
own — the owner's 2026-09-25 rule says deploys come from `main`.*
- **Default:** her own branch per change; a change whose suites pass on a
  clean copy merges itself into `main`, and deploys come from
  `~/workspace/nova` on `main`. Downside: her changes reach `main` before
  anyone reads them; he reads them afterwards, on the Changes page and in
  `git log`.
- A long-lived branch of hers that the live stack runs until he merges.
  Downside: breaks the 09-25 rule that deploys come from `main`.
- Nothing deploys until he merges a PR. Downside: an approval gate, which
  the 2026-09-03 ruling rules out.

**Q3. Who decides a goal is done?** (S34)
- **Default:** code — a finish check from a fixed list (a file contains X,
  an address answers, a command or job exits 0, a landing is green, a
  deploy is serving), fixed when the goal is made; he can stop a goal any
  time. Downside: a goal needs a checkable finish line, so "make it nicer"
  is not one.
- One long chat turn. Downside: it dies at the round cap and on any restart.
- Today's scheduled timer. Downside: "done" is her word, the thing every
  guard exists to distrust.

**Q4. What does blue/green mean on the mini PC?** (S33, S36) *The default is
not what he literally asked for, which is why this stays a question.*
- **Default:** in place, by commit — the previous images stay tagged, an S41
  bundle is taken first, only changed services restart, and it counts as
  live only after a read-back; "blue" is the previous tags plus that bundle.
  Downside: there is no second running copy, and a core restart ends a chat
  turn in flight (the goal survives).
- Two copies sharing one database, switched at the tailnet. Downside: a
  migration run by green changes blue's data too, so blue is no longer a
  rollback — and the mini PC's 16 GB would carry two stacks.
- The default plus a throwaway copy that only verifies and never touches
  live data. Downside: more memory and moving parts on the mini PC, and the
  08-29 "no throwaway stacks" rule would need an exception.

**Q5. Which model does the doing work?** (S34, S35) *Changed from the 09-18
recommendation (local first): wake is paused and the mini PC has no GPU, so
a local model is there only while the Dell is on.*
- **Default:** her own loop, with the `coding` role pointed at a frontier
  cloud model first and the Dell's local model second, until S26 shows a
  local model can do this work. Downside: it costs money, and code, logs and
  context leave the box.
- Local first. Downside: it runs only while the Dell is on, and nothing has
  measured whether the local model can do this work.
- An outside coding agent in a sidecar. Downside: the outside agent he said
  he would rather not use.

**Q6. Where do the credentials she creates live, and what does she sign up
with?** (S36, S37d, S38)
- **Default:** an encrypted store (`{{secret:name}}` resolved only at the
  outbound call, its key on its own volume, provider keys moved in); no tool
  ever returns a value; sign-ups use a browser profile and a mailbox that
  are hers alone. Downside: a slice of work before any sign-up, and a secret
  can never be read back to paste somewhere.
- A plaintext column masked on read, as provider keys are today. Downside:
  anyone who can read the database has every key.
- His logged-in browser and his mailbox. Downside: his accounts, his mail
  and the injection risk all in one place.

**Q7. How does her landing step judge a change?** (S32, S33; Q8 merged)
- **Default:** it always runs the test suites on a clean copy of the
  commit; red means that commit cannot deploy (stated); a change that
  touches the tests that grade her lands and is flagged on the record;
  "could not measure" (the scratch database was down) deploys with a note;
  "still running" waits. Downside: a change could edit its own tests to go
  green — flagged, not stopped.
- Stop on anything not green. Downside: it refuses on his behalf when only
  the measuring broke.
- No checks. Downside: nothing stops a red commit going live.

**Q9. May a goal she wrote run its finish check unasked when that check
picks an address or a command?** (S34)
- **Default:** no. Checks with no address or command of hers (a landing is
  green, a deploy is serving) run unasked; an address or command check on
  a goal she wrote runs when she calls it inside her own turn. Downside:
  her own goals advance only while she is in a turn.
- Yes, every check, stamped "written by Nova". Downside: the backend runs
  arguments nobody vetted — the line `live_facts` draws today.
- Never unasked for her goals. Downside: her goals never close on their own.

**Q10. When a deploy's read-back fails and no migration was crossed, may the
host job put the previous images back itself?** (S33)
- **Default:** yes, recorded as "rolled back", never across a migration.
  Downside: a service that would have come up on a retry gets rolled back.
- Record only. Downside: a broken core cannot recover, because every
  rollback tool lives in core.

**Q11. Is her own configuration data or code?** (S37b)
- **Default:** her instructions and the typed settings are data she changes
  with a tool (1 of the 14 settings has one today); compose and nginx stay
  code. Downside: a bad setting she writes takes effect at once (it is in
  the trace).
- All code, changed by a landing. Downside: every persona tweak is a
  rebuild and a deploy.
- All data. Downside: compose and nginx genuinely are code.

**Q13. A page she reads can steer the same turn's commands. What then?**
(S38 most; S37a and S37d too)
- **Default:** accept it and record it — every call that changes something
  carries whether untrusted text (a fetched page, a browser page, an MCP
  tool's description or result, an HTTP response) was in that turn; by
  convention, research and action go in separate goal attempts. Downside:
  recorded, not prevented.
- The same, plus a non-urgent notice each time it happens. Downside: noise.
- Record nothing. Downside: when it happens, nobody can tell.

**Q14. When do the "Claude commits and deploys" rules end?** (S32, S33)
- **Default:** her `repo_land` (S32) ends "Claude commits in her tree"; her
  `deploy_stack` (S33) ends "Claude deploys"; until each lands, Claude
  deploys by hand and says so in each slice doc. Downside: two more slices
  of Claude doing it.
- Both end now. Downside: she would deploy the very layer that makes her
  deploys checkable, through the path it replaces.
- Neither until her first self-landed change succeeds (S35). Downside: the
  rules outlive their reason for longer.

**Q15. S42c, the admin helper, was due after S42b and before S46a. Pause it
with S46a?**
- **Default:** yes — it exists to apply S46a's named fixes; build it when
  S46a resumes. Downside: until then nothing she does can use admin rights,
  not even a named fix.
- Build it right after S42b. Downside: the doing lane starts a slice later,
  and as designed it would not install programs anyway (named fixes only,
  `s46a/spec.md` §4.2, §8).

**Q16. Where do S37d (HTTP requests) and S37c (reactive) go?**
- **Default:** S37d right after S30, because the install walk configures an
  app through its API; S37c right after S34. Downside: self-coding (S32/S33)
  moves two M-sized slices later. (S38 no longer waits: it runs in parallel
  since 2026-09-30.)
- Both after self-coding. Downside: until then, app APIs mean `curl` inside
  `device_run`, and events from other programs reach nothing.

**Q17. Installing programs that need admin rights (sudo on Linux, UAC on
Windows).** Today such a command fails; S42b makes it fail at once and says
in advance that it would (`elevation` fact). S42c's helper, as designed, runs
only compiled named fixes, never an installer.
- **Default:** installs as the agent's own user only — containers where the
  agent's account can run docker, winget's user scope, pipx, uv, npm and
  `flatpak --user` — and anything needing admin is a stated "cannot" with
  the one command for him to run. Downside: some programs only install
  system-wide (Docker Desktop itself, drivers, services, most apt packages),
  and those stay his.
- A standing admin path, installed once with one OS prompt, after which she
  can run any command as root or admin on that machine. Downside: anything
  she runs there can run as root — the widest reach there is — and it breaks
  the helper's "named fixes only" boundary.
- The OS asks each time: every admin install raises a UAC or sudo prompt on
  that machine. Downside: someone must be at that keyboard every time, so no
  such install happens unattended.

**Q18. Which app proves "install any program", and does it stay?** (the
install walk)
- **Default:** a complex self-hosted app of the same shape as Home Assistant
  and n8n (for example Gitea or Paperless-ngx), installed on the mini PC,
  proven working, then removed with the removal proven. Downside: nothing
  useful is left behind.
- An app he names and wants, kept afterwards. Downside: it is then his to
  keep backed up, since S41 covers only Nova's own stack.

## Invariant under every answer — what can start now

S37a, now. After S42b: S29 and S30 entirely, S37d, and S34's machinery
unless Q3 is answered with the long chat turn or the timer. Build identity
(S32's first half) is tree-agnostic. Not this lane's, but every "watch CI"
goal needs it: CI green on `main`.

## Defects found on the way

Status as of `e9c871f3`.

- **Still:** `narration_check` retracts honest device-backed reads and
  writes (re-measured). S29.
- **Fixed (S29b):** `capability_claim_check` has rows for `web_search` and
  for the device tools in generic phrasing ("run commands on your laptop"),
  each firing only on an allowlist of what may follow the denial, and a
  hedged denial ("Maybe I can't …") is silent on every row.
  `tests/test_capability_coverage.py` makes every registered tool either
  covered by a row or listed with a reason.
- **Fixed (S29b):** an honest failing test report ("39 passed and 1
  failed") over a failing run is no longer corrected as a "tests passed"
  claim.
- **Still:** a capability row corrects her retracting an earlier denial
  ("Earlier I said I can't search the web, but I can"); the correction is
  redundant, not false. The `workspace_list_files` row corrects honest
  location replies ("I can't list files on the Mac mini").
- **Still:** `stack_claim_check` replaces an honest report backed by a
  probe (re-measured). S29.
- **Fixed (S29a):** `device_run` still returns `ok` on a nonzero exit, but
  the exit code is now a `run` fact on the span, and "the tests passed" and
  "I ran X" are checked against it.
- **Fixed (S29a):** a credential-shaped argv value (`KEY=value` with a
  credential key, or a `ghp_`/`github_pat_`/`sk-` token) is masked in the
  span's arguments and scrubbed from its result, error and facts.
- **Fixed (S29a):** Activity renders span facts (run, file, key: value).
- **Fixed (S29a):** the span result head length is one constant in
  `traces.py`, read by both chat and live_facts.
- **Still:** the scheduler never reads `person_busy`, so a firing contends
  with his chat for the one card. S34.
- **Still:** four relative binds in the compose file; `./install update` is
  a stub. S32.
- **Fixed (S42a):** `shell.exec` hanging on a backgrounded child, and a
  command killed by its own socket closing audited as "ran".
- **Fixed or moot (S42a, S42b):** the pre-ruling daemon, the missing
  version frame, linger.
- **Moot:** the exited v3 containers under project `nova` (v3's compose is
  `nova-v3`, and the Dell no longer runs the stack); "the live project spans
  four trees" was not re-measured.
- **New:** CI fails on every `main` run (core, web, backup-macos).

## What this design cannot do

- **True blue/green** (Q4). "Blue" is the previous tags plus the bundle.
- **Zero-downtime redeploy of core.** A chat turn in flight ends; the goal,
  not the turn, continues.
- **Contain what argv does on a machine.** The agent runs as the user;
  `docker compose down -v` through `device_run` is recorded, not prevented.
  This design makes every command checkable, not bounded.
- **Roll back across a migration automatically.** A stated cannot naming the
  bundle; the restore is her explicit call.
- **Prove the local model can code.** The loop measures attempts and stops
  at the budget. S35 and S26 measure; nothing here makes a weak model
  strong.
- **Judge whether a change does what was asked.** A green suite and a
  healthy probe are facts about the machine.
- **Wake the Dell or keep it awake** (paused by the owner 2026-09-30). A
  goal routed to the Dell's models stalls while it sleeps. The hub is always
  on, so the stack, the agent on it and every job there keep running.
- **Install what needs admin rights**, until Q17 is answered with something
  other than the default.
- **Stop him deploying a red SHA by hand.** The cannot lives in
  `deploy_stack`, not in the engine.

## Considered and rejected

- **A warden and a landing service as the first move** — a legibility
  choice, not a containment one, since the agent's raw reach stays. Kept
  reversible behind `hands.py` (Q1, settled).
- **Two app slots on a shared database** — see Q4.
- **A coder sidecar** — the ask, and the product principle.
- **Any refusal after a fetch; any protected-path hit that waits for a
  click; an owner-closes goal.** Approval shapes.
- **A phrase matcher over the owner's message** to decide when she should
  act, and **the handback redirect** — rejected 2026-09-27 and shelved
  2026-09-29 respectively.
- **`tests_passed` backed only by a landing verdict** — it designs in a
  false correction of an honest "I ran pytest and all 40 passed" over exit
  0. The run fact anchored to the command and exit code backs it; exit 1
  corrects it.
- **Finish predicates as `checks.Check` entries** — the hourly beat would
  run a goal's argv unasked.
- **A `daemon_caps` column tools read to refuse** — `devices.capabilities`
  is pinned absent for a reason, and a self-reported row goes stale. The
  live check is sending the envelope and restating the agent's own
  "unknown capability".
- **A hand-kept protected list**; **`repo_land` refusing on a dirty tree**
  (v3's thirteen deaths, reborn) — the clean export removes the hazard.
- **Seam claims made without reading the tree**, struck by the 09-18
  judges: a migration adding `turn_spans.id` (it exists since 002); "cwd is
  ignored by the old daemon" (it is honoured); an eval runner that "mounts
  fake peers" (it has no such hook); a daemon-ancestry check (no image has
  git — it can only be equality). Recorded because a design is a claim too.
