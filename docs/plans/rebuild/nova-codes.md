# Nova codes — she runs her own development

Status: DESIGN, 2026-10-05. Nothing here is built. This amends
[`doing-things.md`](doing-things.md) for self-coding; where the two disagree,
this doc wins, because its owner decisions are newer. Every 09-30 answer in
`doing-things.md` still stands unless a decision below replaces it.

## Summary

- She codes what the owner asks (her own repo first, other repos later), starts
  work herself (fixes from her record, roadmap items, her own ideas;
  continuously or on a schedule), and reacts when monitoring or CI shows
  something wrong.
- She always drives. The code comes from her own loop on any model (local, or
  an API key) or from an outside coder she runs (Claude Code first). Her
  landing step judges it either way, and the record names the coder.
- Self-coding goes right after S42b and the provider-balances slice: S29 → S30
  → S32 → S32b → S33 → S34 → S35. Then S34b (she starts work), S37c (she
  reacts) and S32c (other repos).
- From S35 on she builds the rest herself, with Claude Code as one of her
  coders while the owner's subscription lasts.
- `CLAUDE.md` is now `AGENTS.md`, and `CLAUDE.md` is a symlink to it.

## The asks, verbatim (2026-10-05)

> what do we need to do to give nova the ability to take over doing her own
> coding? right now, you (claude) is doing all the coding and I want to
> convert that over so nova does her own coding. That way, if and when my
> usage gets paused or expires, I can keep working with nova to continue
> building her.

> i don't get the open source comment. why would that even matter to nova?
> what could you possibly implement? I can use any coding agent to change nova
> because it's source code ina repo. Also, my intention is that nova can code
> thigns I request, or code things she thinks improves herself.

Asked which work she may start on her own, he chose all three options offered
(fixes from her own record, roadmap items, her own feature ideas) and added:

> Improvements on other repos. She should be able to work continuously or on
> cron heartbeats, be reactive (ie: if we implmeent monitoring and something
> happens on her or antoher repo, she should respond to it and try fixing it)

> […] I mean Nova can also use outside coding agents. But it'll be Nova
> driving. So she should be able to use locall llms to code as well as other
> things like claude code subscriptsions or api keys.

> We should rename CLAUDE.md to AGENTS.md and then symlink a CLAUDE.md to the
> AGENTS.md (I intend to gerneralize nova to use AGENTS.md in the future and
> other coding agents already use AGENTS.md, so it's industry standard vs
> CLAUDE.md).

## Owner decisions, 2026-10-05

1. **Self-coding goes next**, right after S42b and the provider-balances
   slice. The standing admin path (S30b), the HTTP tool (S37d), the install
   walk and screens (S39) wait behind it.
2. **Her own repo first, other repos later.** Her code tools work in any repo
   from the start; landing and deploying are built for her own repo first.
3. **She starts work herself**: fixes from her own record, roadmap items, her
   own feature ideas, and improvements to other repos; continuously or on cron
   heartbeats.
4. **She reacts**: when monitoring sees something wrong with her or a repo,
   she investigates and tries to fix it.
5. **Nova always drives; the coder is pluggable.** Her own loop on any model
   (local LLMs, API keys), or an outside coding agent she runs (Claude Code on
   a subscription or an API key). S32b stays, and widens.
6. **Who picks the coder:** the owner's Routing order; she may override it for
   a task; the record names which coder wrote each change.
7. **No separate spend cap** on work she starts herself. The existing provider
   caps apply.
8. **Several pieces of work at once**, each in its own git worktree.
9. **Her first self-coded change runs on a frontier model first, then on a
   local one.**
10. **`CLAUDE.md` becomes `AGENTS.md`**, with `CLAUDE.md` a symlink to it.
    Done in the change that adds this doc.

## What she lacks today, and what supplies it

| Gap | Today | Supplied by |
|---|---|---|
| Hands on the mini PC, where her repo and stack run | no agent on the hub | S42b (in progress) |
| Reading and editing her big files | whole-file reads and writes up to 256 KiB (`caps.go:23-24`); `chat.py` is 339 KB and `guards.py` 482 KB; nothing edits part of a file | S30: range reads (designed), plus part-file edits and code search (added here) |
| Running the suites | a command is killed at 110 s (`client.go:42`); the core suite's CI job takes about 5½ minutes | S30: jobs |
| Results she can be held to | the exit code is only prose; honest device reads are corrected as unbacked | S29 |
| Landing a change | nothing | S32 |
| Deploying, with rollback | nothing; Claude deploys | S33 |
| Work longer than one turn | 6 tool rounds per turn by default (an agent may have up to 50); nothing survives a restart | S34, and S38b for long attempts |
| A coder that is not the owner's Claude login | — | her own loop on the `coding` role (S34) and outside coders (S32b) |
| The build rules | in `CLAUDE.md` and in Claude's own memory, which she never reads | `AGENTS.md`, rewritten in S32 and put in front of every coding attempt |

## Changes to the designed slices

**S29 — unchanged.** It is still the first slice. Its `edited_file`,
`ran_command` and `tests_passed` claim kinds are what keep her coding reports
honest.

**S30 — adds part-file edits and code search.**

- `fs.edit` in the agent replaces one exact snippet in a file. The snippet
  must occur exactly once; zero or several matches is a stated cannot that
  names the count, and the file is left untouched. The write is atomic (a
  temporary file renamed over the original, in the same directory) and keeps
  the file's mode. It works on files past the 256 KiB whole-file cap, up to a
  ceiling the plan sets and states. Core's tool is `device_edit_file`; its
  span files an `edit` fact `{target, matches, bytes_before, bytes_after}`,
  which S29's `edited_file` claim reads.
- `fs.search` in the agent searches a directory for a regex or a literal,
  honours `.gitignore`, and is capped by matches and bytes (reaching a cap is
  stated). It is native Go, so it works on every OS without ripgrep. Core's
  tool is `device_search`, `reads_only`.
- Pins: registry +2 beyond S30's own; `reads_only` +1.

**S32 — her changes in parallel, and the rules in front of her.**

- **A worktree per change.** Starting a change makes a branch
  `nova/<id>-<slug>` and a worktree `.worktrees/nova-<id>` on the hub, inside
  the repo and gitignored, as `AGENTS.md` requires. Several can be open at once
  (decision 8). The tool that starts a change returns `AGENTS.md` from that
  worktree in its result, so no change starts without the rules in front of
  whoever writes it.
- **Landings merge one at a time.** A change whose base is behind `main` is
  brought up to date and its suites run on the result, so the verdict is about
  the exact commit that lands (keyed by SHA, as designed). A conflict is a
  stated cannot naming the files, and the change goes back to its author to
  rebase.
- **The record names the coder.** Each landing row records who wrote the
  change: her own loop and the model id, or an outside coder by kind and
  machine.
- **`AGENTS.md` is rewritten for any coder** — Nova, Claude Code, or any other
  agent:
  - written to "the coder", not as Claude's "I";
  - the line "infrastructure code in git is mine; operating the running
    system is hers" restated for a Nova who now writes her own code;
  - the v3-era operational traps replaced with v4's;
  - the 07-14 "never commit" rule reconciled with the 08-10 amendment, under
    which the coder drives the loop;
  - the standing rules that today live only in Claude's memory folded in —
    for example: format only the files you edited, run web tests with
    `npm test` and never `npx vitest run`, sweep guard regexes for time,
    take the next migration number from the directory, and read a trace by
    turn id.

  The repo is public, so the rewrite carries no MACs, tailnet IPs, GPU UUIDs
  or other identifiers the repo already keeps out.

**S32b — outside coders, Nova driving.**

- Widened from Claude Code to any coding agent that runs headless in a
  directory. Claude Code is the first kind: `claude -p` on a machine where the
  owner is logged in, run as him through that machine's agent, or on an API
  key from her store (Q6). Nova never holds or reads his login. Each further
  kind is one adapter.
- She runs it as a job (S30) in the change's worktree, gives it the task,
  keeps its transcript, and judges its work with the landing step — the diff
  and the suites on a clean copy — never by its report.
- Routing: the `coding` role's order lists both models (her own loop on that
  model) and outside coders. She may name another entry for a task, and the
  landing row records which one wrote the change.
- The policy from Q5 is unchanged: running `claude -p` on your own machine
  with your own subscription is documented; a released Nova that drives other
  people's logins needs Anthropic's answer first.
- It comes after S32, as before, because it needs S30's jobs and S32's landing.

**S33 — unchanged.** Its automatic rollback is what stops a bad change of hers
from leaving her broken with nobody to fix her.

**S34 — goals carry the coding work.**

- Several goals run at once, each in its own worktree. How many is a setting;
  the plan measures its default on the mini PC, because every landing runs the
  full suites there.
- Every goal attempt in the `coding` role is framed with the change's
  `AGENTS.md`, by code.
- The `coding` role gets its own per-attempt round cap (a setting), because six
  rounds are too few for a coding attempt.
- Long attempts use S38b's summaries once S38b lands (it is next after S38 in
  the browser lane).

**S35 — frontier first, then local.** The `uptime_s` goal runs first on the
strongest model her providers offer, then a second change of the same size
runs on the Dell's local model. Both runs' `goal_attempts` rows become S26's
first coding cases. A local failure after a frontier success is about the
model, not the design.

## New and widened slices

Each one is designed — spec, then the owner's review, then a plan — when its
turn comes. These stubs are the contract that design starts from.

**S34b — she starts work herself.**

- Modes, as a setting: off; heartbeat (a cron schedule on the existing
  timers); or continuous (whenever fewer of her own goals are running than the
  setting allows).
- Sources: her record (failed and interrupted turns, guard corrections, tool
  errors, slow turns, failing checks and eval cases); `ROADMAP.md`'s next
  unbuilt items; her own ideas; and other repos once S32c exists.
- Each pick becomes a goal she authors, with S34's finish families (a fix:
  the failing case or check now passes; a feature: landing green and
  deployment serving) and the reason for the pick on the row.
- No separate spend cap (decision 7). The Spend page shows what her own work
  spent, apart from what the owner's requests spent — a fact, never a limit.
- A change she starts herself lands and deploys on green like any other, and
  the owner reads it afterwards on the Changes page (the 09-03 ruling, Q2).
- This deliberately ends the 09-18 line that the goal loop "has no drives —
  it runs only goals someone stated".

**S37c — she reacts (widened).**

- As designed: an event from another program starts a turn of its own kind;
  its payload is data, never instructions; each sender has its own token.
- Widened: monitoring is a source. That covers her own checks and health (a
  service down, a rolled-back deploy, a failing check), CI on GitHub for her
  repo and for other repos (through S37a's GitHub MCP, or GitHub's webhooks
  into this intake), and errors in her own traces. An event opens or resumes a
  goal to investigate and fix, on the same landing and deploy path.

**S32c — other repos.**

- Her tools already work in any repo (S30). S32c generalizes the landing step:
  a repo on a paired machine, with its own test commands and its own default
  branch.
- How her changes reach another repo's main — merged directly, or pushed as a
  branch for that repo's maintainers — is S32c's question for the owner.
- Work she starts on other repos arrives through S34b's sources once this
  exists.

## AGENTS.md

- **Done with this doc:** `CLAUDE.md` was renamed to `AGENTS.md`, and
  `CLAUDE.md` is now a relative symlink to it. Claude Code still reads the same
  file, and agents that read `AGENTS.md` find it. The content is unchanged
  until S32 rewrites it.
- A Windows checkout without symlink support gets `CLAUDE.md` as a one-line
  text file naming `AGENTS.md`. Nothing in the build or CI reads it.
- v3's root `docker-compose.yml` bind-mounts `./CLAUDE.md` into `mcp-runner`.
  Docker resolves the link on the host, and v3's stack is not running.

## Order

S42b (in progress) → the provider-balances slice → S29 → S30 → S32 → S32b →
S33 → S34 → S35 → S34b → S37c → S32c → S30b → S37d → the install walk → S39.

S37a (MCP), S38 (her browser) and S38b run in parallel now, unchanged. S36
and S37b stay unscheduled. Then the paused hub slices, then S26, then S27.

From S35 on, the slices are built through her. She drives, and Claude Code is
one of her coders while the subscription lasts. Q14's ends still hold:
`repo_land` (S32) ends Claude committing in her tree, and `deploy_stack`
(S33) ends Claude deploying.

## What this cannot do

- **Prove she can code here.** Nothing has measured it on any model, and
  every Nova version so far has run day to day on 27B-or-smaller or budget
  models. S35 measures it, frontier first.
- **Judge whether a change does what was asked.** Green suites and a serving
  deploy are facts about the machine, as `doing-things.md` says.
- **Limit what her own work spends** beyond the provider caps (decision 7).
- **Show a change before it ships.** Any change, including a feature she
  invented, deploys on green and is read afterwards (the 09-03 ruling, Q2).
- **Run unlimited work at once.** Every landing runs the full suites on the
  mini PC, so how many run together is measured, not assumed.
- **Finish a long attempt before S38b lands.** An attempt that fills its
  context ends, and the goal's next attempt resumes from its notes.

## Reconciled with doing-things.md

- Its DROP "the coder being an outside agent" and its rejected "coder
  sidecar" both meant an outside agent in charge. With Nova driving, an
  outside coder is one of her tools, run as a job through an agent. There is
  still no coder sidecar service (owner, 2026-10-05).
- Its line that the goal loop "has no drives" is superseded by S34b.
- Its order is superseded by the order above.
- Everything else stands, including every 09-30 answer.
