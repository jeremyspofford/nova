# Provider plurality (ADR, A1, 2026-11-09)

**Sources:** the owner's priority queue, `docs/plans/owner-priority-queue-2026-11-02.md` item 6
(line 12, A1, verbatim: "A1 provider plurality is hard: OpenAI-compatible (OpenRouter first, owner's
existing account), local Ollama, Claude and Codex behind existing abstraction; AgentSDK evaluated as
ONE provider with regression evals, never only way/no hardwired runner") and its licensing constraint
(line 14: product auth is API keys or bring-your-own, never subscription login offered to others;
provider keys go through the vault/broker). ADR-8 in `docs/builder-packet/ARCHITECTURE-AND-DECISIONS.md`
("Vendor agent SDKs are adapters", with the 2026-11-04 Ponytail amendments). ADR-10 (local-first,
egress visible). The broker design, `docs/plans/vault-broker.md` (§2 rows 4 and 17, §9 row 4). The
eval harness, `docs/plans/evals.md`. Cost caps, `docs/plans/cost-caps.md`. The whole-app review,
`docs/reviews/nova-whole-app-review-2026-11-02.md` (§3 and §6, which recommended the Agent SDK as the
primary chat adapter). The code: `src/core/providers/`, `src/core/models/`, `src/core/workers.ts`,
`src/core/caps/index.ts`, `src/core/vault.ts`, `src/broker/`, `src/core/broker/client.ts`,
`src/runner.js`, `src/agent.js`, `src/config.js`, `src/server.js`. Format follows
`docs/plans/model-fit-adr-2026-11-04.md` and `docs/plans/wol-inference-nodes-adr-2026-11-06.md`.

**Status:** PROPOSED, 2026-11-09. Design only: nothing in Nova changes in this step. Next is the
owner's second-model review, then the owner's answers to the open questions, then the build in the
order under "Migration". Every claim about today's behaviour below was read from source at
`dd0612ce` and carries a `file:line`. Writing this needed no account, no paid call, no key, no model
pull and no plugin install, and the build plan needs none of those either until the owner says so
(open questions 3, 7 and 8).

**Hard exclusions, kept:** the privacy gate (`permits`, `src/core/workers.ts:57-59`), the receipt's
local-only refusal (`src/core/receipts.ts:111`), the egress classifier (`#whereOf`,
`src/core/providers/registry.ts:240-283`) and the no-redirect rule (`src/core/providers/types.ts:128`)
are not loosened by this design or its build. New providers are classified by them; they are not
changed for them.

## What exists today

Most of what A1 asks for already has a place to go. The registry is a real multi-provider
abstraction; what is missing is mostly a second remote provider, keys outside core, and a few
accounting and routing holes.

| Piece | Where | What it does now |
|---|---|---|
| The provider contract | `types.ts:91-113` (`Impl`) | `check`, `unconfigured`, `uninstalled?`, `probe?`, `url?`, `reportedWhere?`, `model`, `effects?`, `work`, `chat?`. One object per implementation |
| The implementations | `types.ts:12`; `registry.ts:165` | Six, fixed: `claude-code`, `codex`, `openai-compatible`, `custom-cli`, `n8n`, `relay`. "Nova runs no code an extension ships" (`registry.ts:85`): an extension only picks one of these and gives it settings |
| The manifest | `types.ts:16-26` (`AdapterBlock`); `registry.ts:81-95` (`checkAdapter`) | Class (`coding-agent`, `chat`, `automation`), transport (`cli`, `http`), declared egress (`none`, `local`, `remote:<host>`), capabilities, default config, secret names |
| The built-ins | `builtins.ts:14-70` | Installed on every start, off until configured and turned on (tier 2, `registry.ts:398-405`). `claude-code` (CLI, `remote:anthropic`, 15-22), `codex` (CLI, `remote:openai`, 23-30), `openai-compatible` named "Local model (Ollama or compatible)", default `http://127.0.0.1:11434/v1` (31-38; `openai.ts:10`), `custom-cli` (agent_cmd, 39-46), `n8n`, `relay` |
| OpenAI-compatible HTTP | `openai.ts` | Streamed chat completions over SSE (98-148), `GET /models` probe (187-200), plain-words errors including 429 (71-85). Serves Ollama, llama.cpp, LM Studio and hosted compatible APIs (1-5). The key is read in core and sent as `Bearer` by core (89-94, 105-108) |
| A provider set to a role | `openai.ts:157-160`; `registry.ts:248-259, 484-503, 848-864` | `role: reasoner` or `triage-text` hands the call to the model manager instead of an address |
| Where data goes | `registry.ts:240-283` | Loopback or a mesh host is `local`; anything else is `remote:<host>`. An Ollama model named `-cloud`/`:cloud` is `remote:ollama.com` (265-267; `types.ts:120-123`) |
| The privacy gate | `workers.ts:57-59`; `registry.ts:643, 653-654`; `runner.js:280-298`; `receipts.ts:111` | `local-only` never reaches `remote`. Checked per run, again per model call in the runner, and a receipt for a remote call under local-only is refused |
| Choosing | `registry.ts:415-459` | One chat provider, one default per class. `recommend` ranks none < local < remote, healthy first (427-437) |
| The default chat path | `registry.ts:442, 475-477`; `runner.js:271-275, 392`; `agent.js:20-29`; `config.js:15-21` | With no chat provider chosen, chat is agent_cmd, which the runner spawns itself through `/bin/sh -c`. The shipped default agent_cmd is `claude -p … --tools "" …` |
| The model manager | `models/index.ts:684-750`; `recommend.ts:18` | Roles `triage-text`, `reasoner`, `embedder`, `transcriber`. `infer()` orders local and cloud by privacy mode (693) and never falls back once output has started (696-699, 717-719) |
| The cloud model | `models/index.ts:59, 315-318, 2081-2108` | Exactly one, in profile key `models.cloud`: `{name, base_url, model, api_key?, prices?, max_tokens?}`, its own address and key reference, called through `openai.ts chatMessages` (909). A new address needs `confirm: true` (2103-2104) |
| Cloud budget | `models/index.ts:1432-1455, 890-922, 1481-1488` | Per task and per period, in the `cloud_usage` table. A cloud call reserves its maximum cost before it is sent (896-900). A provider's report is counted after the task (1481-1488). With a budget set, unpriced usage makes the cloud wait (1437-1441) |
| Provider tasks and budget | `registry.ts:656-662`; `src/core/index.ts:416` | A ledger task for a remote provider waits on `budgetBlock` before it runs |
| Cost caps | `caps/index.ts:1-13, 157-159, 274-293`; `runner.js:354, 386, 410` | Iterations, tokens and priced dollars per task and per day, kept as JSON lines under `workers/spend/`. Only `where === 'remote'` is priced. The runner asks the meter before each model call |
| Keys | `src/core/index.ts:393-401`; `vault.ts:1-14` | `providerSecret` reads `provider/<NAME>` from the legacy vault in core; `NOVA_SECRET_<NAME>` is a dev/test fallback. Providers name keys `secret://NAME` (`types.ts:116`) |
| The broker | `src/broker/`; `origin.ts:12`; `http.ts:18, 71`; `broker.ts:366, 463`; `client.ts:1-13` | Built: `http` and `process` targets. An `http` use is one buffered request (4 MB cap, no streaming). A `process` use runs a hash-bound binary through the launcher with the value in its environment. Core's only live broker call today is `listRefs` (`diagnostics/index.ts:178`). Provider keys under the broker are planned, not built (`vault-broker.md:364`, §9 row 4: "a streamed response (SSE) flows back scrubbed") |
| CLI sign-ins | `vault-broker.md:130` (§2 row 17); `child-env.ts:4-10` | `claude` and `codex` use their own sign-ins. The child keeps `HOME` (`child-env.ts:5`), so the CLI finds whatever login its owner made. There is no API-key path in either adapter (`claude-code.ts:34-45`, `codex.ts:29-34`) |
| What a coding agent may do | `claude-code.ts:30-45`; `codex.ts:31`; `cli.ts:52-66`; `registry.ts:826-842` | Task folder only (`Read/Edit/Write(./**)`, `--strict-mcp-config`, `--safe-mode`; Codex `workspace-write`), its process group killed on exit, a finite env. Nova reads the diff itself, refuses out-of-scope changes and asks before running any test on what it wrote |
| Evals | `evals.md:50-146`; `tests/evals/tasks/regression.ts` | Regression (must be 100%, blocks merge), capability, injection. Every run goes through the registry with `openai-compatible` pointed at a stand-in. Scorecards per provider and model, with a drop rule. A real cloud scorecard has no path without the owner's go-ahead and caps (`evals.md:104-106`) |
| The Agent SDK | nowhere | Not in the repo. `package.json` has no runtime dependencies at all. The review recommends it as the primary chat adapter (`nova-whole-app-review-2026-11-02.md:243`) and, in its build order, behind agent_cmd and measured on the regression evals first (`:254`) |

### What is missing

1. **One OpenAI-compatible built-in.** OpenRouter today means repointing the one `openai-compatible`
   provider, which replaces local Ollama, or setting it as `models.cloud`. The regression task
   `grounding.one-openai-provider` asserts exactly that truth (`tests/evals/tasks/regression.ts:178-190`).
   So the same remote endpoint has two unrelated configurations: a provider (registry settings) and
   the cloud model (`models/index.ts:59`), each with its own address, key reference and budget path.
2. **A hardwired default runner.** When the person has chosen no chat provider, chat is agent_cmd
   (`registry.ts:442, 475-477`), and the shipped agent_cmd is `claude -p` (`config.js:15-21`). That
   path is outside the registry: no health, no probe, egress taken from a config flag
   (`runner.js:291-296`), and it signs in with whatever login `claude` finds under `HOME`. This is the
   "hardwired runner" the owner rules out, and for anyone but the owner it is the subscription login
   the licensing constraint forbids.
3. **Keys live in core.** A provider key is read in core and written into a `Bearer` header by core
   (`openai.ts:91, 107`; `models/index.ts:909`). The broker exists, but no provider uses it, and its
   `http` use cannot stream (`http.ts:71` buffers the whole body), which chat needs.
4. **The CLI agents have no key mode.** `claude-code` and `codex` run on their own sign-ins
   (`vault-broker.md:130`). Nothing lets them run on a key held by the broker.
5. **Budget holes.**
   - A chat provider set directly to a remote address is not checked against the cloud budget: the
     direct chat handle calls `impl.chat` with no `budgetBlock` (`registry.ts:504-511`); the budget
     is only in `#prelude`, which ledger tasks and coding runs pass (656-662). Only the caps meter
     holds such a chat (`runner.js:386`).
   - The role chat path drops usage: `call` returns text and `aborted` only (`registry.ts:500`; the
     `ChatHandle.call` type at 107 has no usage), so the meter estimates from characters.
   - Two spend stores: `cloud_usage` (`models/index.ts:1474`) and `workers/spend/*.jsonl`
     (`caps/index.ts:8-9`). The priority queue already records that provider-managed loops are not
     live-capped and that the stores are separate gaps (`owner-priority-queue-2026-11-02.md:19, 29`).
   - Codex reports tokens and no cost (`codex.ts:51-52`), so with a budget set its usage is unpriced
     and the cloud waits until the person prices it (`models/index.ts:1438`).
6. **No fallback across providers.** Only `models.infer` has a fallback chain, and it is local and
   one cloud model. A chosen chat provider that is down is an error; a task for a remote provider
   that is down fails or waits.
7. **Routing per role is local-only.** Each role has its own local placement, but every role shares
   the one cloud model (`models/index.ts:692`).
8. **No way to admit a new provider on evidence.** The eval runner refuses any non-loopback address
   (`evals.md:104-106`), there is no Agent SDK adapter, and nothing says what a candidate provider must
   pass before it may be turned on.

## Decision

1. **Plurality lives in the registry and `Impl`, nothing beside them.** No router, gateway or second
   provider interface. OpenRouter needs no new implementation: it is an `openai-compatible` built-in.
   The only new implementation this ADR allows is `claude-agent-sdk`, and only if it passes the
   evaluation below.
2. **OpenRouter first, as a second built-in manifest, `openrouter`.** Implementation
   `openai-compatible`, class `chat`, egress `remote:openrouter.ai`, default address
   `https://openrouter.ai/api/v1`, key `secret://OPENROUTER_API_KEY`. Off until the owner configures
   and turns it on, like every built-in. The existing `openai-compatible` built-in stays Ollama's.
3. **The cloud model becomes a reference to a provider.** `models.cloud` changes from
   `{name, base_url, model, api_key, …}` to `{provider, model, max_tokens?}`. Its address and key are
   the provider's. One place to set OpenRouter, one key, one egress rule.
4. **No runner is hardwired.** The chat model is always a registry provider. agent_cmd stays, as the
   `custom-cli` provider it already is (`builtins.ts:39-46`), but it is chosen, not fallen into. A
   fresh install has no chat model until the person picks one (open question 2). The owner's own
   `nova.config.json` keeps working.
5. **Keys go through the broker only.** A provider's key is a broker item bound to the provider's
   origin and its few paths. Core and every model hold the ref. The broker's streamed `http` use
   (`vault-broker.md` §9 row 4) is a prerequisite for any keyed remote chat provider, OpenRouter first.
6. **The CLI agents get a key mode through the broker.** `claude-code` and `codex` run as broker
   `process` targets, with the key in the child's environment only. Their own-login mode is kept only
   as the owner's personal opt-in, said plainly, and never offered in onboarding (open question 1).
7. **The Agent SDK is evaluated as one provider, in the `coding-agent` class first.** It runs as a
   broker `process` target, never in core's process. It must pass the regression evals below. It is
   never the default, never the only provider of its class, and the runner never imports it.
8. **Routing is a short ordered list per use and privacy mode,** built from provider refs, using
   today's order rule (`models/index.ts:693`). Fallback happens only before output, never to an
   egress the mode forbids, and never silently: a note and a receipt every time.
9. **Every remote call is accounted the same way.** Each remote chat call checks `budgetBlock`
   first, reserves its maximum when Nova can price it, and records one `cloud_usage` row tagged with
   the provider id. The caps meter keeps metering the run and reads the same price table it reads
   today.

## The provider contract

One interface: today's `Impl`. The change is small and has one point: an implementation never sees
a key again.

```ts
// src/core/providers/types.ts (proposed changes only)

// Replaces WorkInput.secret and the `secret` argument of probe/chat. Bound by the registry to the
// provider's own origin; backed by the broker's streamed `use` when the provider has a key, by plain
// fetch (NO_REDIRECT) when it has none (local Ollama). The implementation never sees a value.
export interface Send {
  (req: { method: 'GET' | 'POST'; path: string; body?: string; accept?: string; signal: AbortSignal }):
    Promise<{ status: number; headers: Record<string, string>; body: AsyncIterable<Uint8Array> }>;
}

// For a CLI provider with a key: the registry starts the program through the broker's launcher.
export interface Launch {
  (o: { argv: string[]; cwd: string; input: string; signal: AbortSignal; timeoutMs: number;
        onLine: (line: string) => void }): Promise<Ran>;   // Ran as in cli.ts:48
}

export type Auth = 'none' | 'broker-http' | 'broker-process' | 'own-login';
export type Pricing = 'free' | 'reported' | 'table';

export interface Impl {
  // … every existing member stays (types.ts:91-113), with `secret` replaced by `send`/`launch` …
  auth(c: Config): Auth;          // how it authenticates with these settings
  pricing(c: Config): Pricing;    // where its cost comes from
}

// ChatHandle.call (registry.ts:107) returns usage too, on both paths (fixes registry.ts:500).
call(req: ChatRequest): Promise<{ text: string; aborted: boolean; usage: Usage }>;
```

The registry, not the implementation, decides from `auth`:

- `none`: plain fetch to the checked address. Only for a provider whose `where()` is `none` or `local`.
- `broker-http`: `send` is the broker's streamed `use` on the provider's binding. If the broker is
  off, locked or in safe mode, the provider is `not_configured` with the broker's words, and
  `NOVA_SECRET_<NAME>` is refused (`vault-broker.md:364`).
- `broker-process`: the CLI runs through `launch`; `cli.ts runLines` is used only for keyless
  programs.
- `own-login`: allowed only with the owner's explicit opt-in (open question 1); refused on any
  other install; health says so in words.

How each provider the owner named sits behind it:

| Provider | Implementation | Class | Transport | Egress | Auth | Pricing | Status |
|---|---|---|---|---|---|---|---|
| Local Ollama | `openai-compatible` (address, or `role:` through the model manager) | chat | http | `local` | none | free | Exists (`builtins.ts:31-38`) |
| OpenRouter | `openai-compatible`, built-in `openrouter` | chat | http | `remote:openrouter.ai` | broker-http | reported if OpenRouter's usage carries a cost, else table | New manifest only |
| Claude, coding | `claude-code` | coding-agent | cli | `remote:anthropic` | broker-process (own-login: owner opt-in) | reported (`total_cost_usd`, `claude-code.ts:66`) | Exists; key mode new |
| Claude, chat | through `openrouter` | chat | http | `remote:openrouter.ai` | broker-http | as OpenRouter | No new code |
| Codex, coding | `codex` | coding-agent | cli | `remote:openai` | broker-process (own-login: owner opt-in) | table (tokens only, `codex.ts:51-52`) | Exists; key mode new |
| OpenAI models, chat | through `openrouter`, or an `openai-compatible` pointed at OpenAI | chat | http | `remote:openrouter.ai` or `remote:api.openai.com` | broker-http | table or reported | No new code |
| Claude Agent SDK | `claude-agent-sdk` (candidate) | coding-agent | cli (a Node child) | `remote:anthropic` | broker-process | reported | Evaluation only |
| agent_cmd | `custom-cli` | chat | cli | `agent_egress` | own command | table | Exists; no longer the silent default |
| Relay, n8n | unchanged | | | | | | Out of scope |

What is unverified, and stays so until the owner allows a real call: whether OpenRouter's streamed
usage carries a dollar cost, and the exact key variable each CLI reads in key mode. The build checks
both against the vendor's documentation and the installed CLI's `--help` (not a session), and falls
back to `table` pricing when unsure.

## The Agent SDK as one provider

**What is evaluated:** `@anthropic-ai/claude-agent-sdk` as an implementation `claude-agent-sdk`, class
`coding-agent`. Nova's chat runner keeps its own loop: this ADR offers no chat-class SDK provider,
because an SDK that owns the tool loop would make it the runner. A chat-class evaluation would be its
own ADR.

**Where it runs:** a small Nova entry script in a child process, started by the broker's launcher as a
`process` target (`broker.ts:366, 463`), with the API key in that child's environment only. The
binding pins the script's and Node's SHA-256, as the launcher does for any bound program. Core talks
to it over stdin/stdout lines, as it talks to `claude` today (`claude-code.ts:51-72`). The key is
never in core's process, which an in-process SDK would require.

**What it may do:** no more than the `claude-code` adapter. The task folder as working directory; tools
limited to `Read/Edit/Write` inside it (`claude-code.ts:33`); no MCP servers, no setting sources, no
session persistence; abort and timeout kill its process group (`cli.ts:61-66`). Nova reads the diff,
applies the scope check and asks before tests exactly as for any coding agent (`registry.ts:826-842`).

**The dependency:** it would be Nova's first runtime dependency (`package.json` has only
devDependencies). The evaluation adds it in an isolated worktree only. Merging it needs the owner's
separate yes after the evals pass (open question 7).

**The evals it must pass, in order. Failing any stops it:**

| # | Eval | Pass means |
|---|---|---|
| E0 | Stand-in reachable | The SDK can be pointed at a loopback stand-in model endpoint, so CI calls no real model. If it can't, it can't be evaluated in CI and is rejected for now |
| E1 | Regression suite | `npm test` and the REGRESSION suite at 100% with the SDK provider installed, both off and chosen as the coding-agent default |
| E2 | Parity with `claude-code` | The same coding golden tasks the `claude-code` adapter passes against `scripts/stand-ins/fake-claude.js` (`tests/core/providers.test.ts`): the same diff evidence, the same refusal of out-of-scope changes and of more than 200 files or 50 MB (`registry.ts:66-67, 829-835`), the same test ask |
| E3 | Security canaries | A canary key in the broker: after a run, no trace of it in core's environment, logs, receipts, problems, profile or task folder (`tests/core/provider-vault.test.ts`'s method); no file read outside the task folder; no connection except to the bound origin; abort leaves no process behind |
| E4 | Privacy | Under `local-only`, zero spawns and zero receipts; the task waits with today's words (`registry.ts:654`) |
| E5 | Cost | Each run reports cost or tokens; an over-budget task waits before spawning (`registry.ts:656-662`) |
| E6 | Real-model scorecard | Owner-run only, with the owner's key, under caps: the SDK and `claude-code` on the same golden tasks. Its regression pass rate is not lower than `claude-code`'s, by the scorecard drop rule (`evals.md` "The drop rule for real models") |

**How no runner is hardwired to it, enforced by tests rather than intent:**

- The SDK is imported in one file, `src/core/providers/claude-agent-sdk.ts`. A test fails if anything
  else imports the package, `src/runner.js` and `src/agent.js` included.
- A removal test: with `claude-agent-sdk` taken out of `IMPLEMENTATIONS`, every suite passes.
- It is never the result of `recommend()` when another enabled coding agent is healthy, and never a
  default without the person choosing it.
- It is the only provider of nothing: `claude-code`, `codex` and Relay remain coding agents.

## Routing per role and privacy mode

The mode is the stricter of the task's and the person's, as now (`registry.ts:643`;
`models/index.ts:691`). `permits()` runs before every call and the receipt check behind it, as now.

| Use | Candidates, in order | local-only | local-preferred | cloud-allowed |
|---|---|---|---|---|
| A conversation | The chosen chat provider; then, for a provider set to a role, the role's chain | Only a `none`/`local` chat provider; a remote one refuses before sending (`runner.js:284-289`) | The chosen provider; fallback (decision 8) only to local | The chosen provider; fallback to local, with a note |
| `triage-text`, `reasoner` | The role's local placement, then `models.cloud.provider` | Local only; down means wait | Local, then the cloud provider; a failed wake asks first (WoL ADR question 3) | Cloud provider first within budget, then local |
| `embedder`, `transcriber` | Local only (`models/index.ts:686, 692`) | Local | Local | Local |
| Coding-agent task | The task's named provider, else `default.coding-agent` | Only a local provider; else waits | Named provider only; no automatic vendor switch | Named provider only; no automatic vendor switch |
| Automation | n8n | As now | As now | As now |

Rules:

- **R1.** The cloud step of a role is one provider ref for all roles now (`models.cloud.provider`).
  Per-role refs are a later choice (open question 6).
- **R2.** A coding agent is never switched for another by itself. Two vendors' agents do different
  work at different prices; a down agent makes the task wait with the reason, and the person may
  retry it on another.
- **R3.** Nothing a model writes picks a provider, a model or an address. Changing providers stays a
  Settings action (`docs/evidence/agent-grounding.md:93`), and an enabled provider's address changes
  only with `confirm: true` (`registry.ts:358-364`).

## Keys through the vault and broker

For OpenRouter, as the pattern for every keyed HTTP provider:

1. The person enters the key in Settings › Providers › OpenRouter, sealed in their own client
   (`src/broker/seal.ts`); it never passes through chat or a plain setting.
2. The broker creates an item and an `http` binding: origin `https://openrouter.ai` exactly, scope
   `POST /api/v1/chat/completions` and `GET /api/v1/models`, inject `bearer`. The broker already
   suggests the standard class for `openrouter.ai` (`origin.ts:136-137`).
3. A standing consent with an hourly rate cap lets chat run without an approval per message (the
   broker otherwise asks for each use, `broker.ts:651`). The cap is the owner's (open question 4).
4. Core holds the ref. The provider's settings hold `api_key: secret://OPENROUTER_API_KEY`, which the
   registry maps to the ref. `send` is the broker's streamed `use`.

The broker change this needs, as its own PR before any keyed chat (`vault-broker.md:364`): a
streamed `use` for `http` targets. The response flows back in chunks, scrubbed of the injected value in
every form the broker hunts (`scrub.ts`), holding back at the end of each chunk as many bytes as the
longest form less one, so a value split across two chunks is still caught. The size cap becomes a
running total. Redirects stay refused (`http.ts` header). It is a mode of `use`, not an eighth verb.

For the CLIs: a `process` binding to the `claude` or `codex` binary by SHA-256, inject `env` (the
variable the CLI documents for API-key use), consent per task. `childEnv` stays as it is
(`child-env.ts:4-10`): the key is added by the launcher, in the child only.

Local Ollama has no key and never touches the broker.

Until the streamed `use` lands, the `openrouter` provider is built and tested against stand-ins only,
and the owner's OpenRouter key is not put into the legacy vault (open question 3).

## Cost and budget per provider

- **Before every remote call, chat included,** `budgetBlock` (`models/index.ts:1432-1455`) is checked.
  The direct chat handle gains the check the task path already has (`registry.ts:656-662`).
- **A reservation** of the call's maximum cost, as `#cloud` does (`models/index.ts:896-900`), for every
  priced remote chat call: prompt length over four, plus `max_tokens` (default 4096,
  `models/index.ts:61`) at the table's price. An HTTP provider without `max_tokens` set uses that
  default, so no remote chat call is unbounded.
- **One row per call** in `cloud_usage`, with `provider` set to the provider id (today it holds the
  egress string, `models/index.ts:917`). No schema change: the column exists. The Models screen
  groups by it for a per-provider total.
- **Pricing**, by `Impl.pricing`: `reported` uses the provider's cost; `table` prices tokens from the
  person's table (`models/index.ts:1414-1420`); `free` is local. With a budget set, unpriced usage
  waits, as now (`models/index.ts:1437-1441`).
- **CLI agents are counted after the run,** as now (`models/index.ts:1481-1488`). Their only live bound
  is `timeout_s`. The screen says so; nothing here claims a live cap on a provider-owned loop
  (`owner-priority-queue-2026-11-02.md:29`).
- **The caps meter** keeps metering the runner's calls (`runner.js:410`), now with real usage on the
  role path too. Merging its store with `cloud_usage` is out of scope (open question 12): the queue
  rules out a new spend schema as incidental wiring (`owner-priority-queue-2026-11-02.md:19`).

## Failure and fallback

| Failure | Chat | Ledger task | Never |
|---|---|---|---|
| Unreachable, 5xx, timeout before output | Next candidate under the routing rules, with a note and a receipt | Fails with plain words (`openai.ts:110-114`); the person retries | Fall back to an egress the mode forbids |
| Key refused (401/403) | Error in words (`openai.ts:80`); a problem opened | Blocked, not retried | Retry with the same key in a loop |
| Rate limited (429) | Error in words (`openai.ts:82`); no switch to another vendor without the routing rules | Blocked with `retry_after_s` from `Retry-After`, asked again by itself (`types.ts:75-76`; `registry.ts:668-684`), up to the busy limit | Hammer the endpoint |
| Over budget | Refused before sending, with the budget's words | Waits on the budget (`registry.ts:656-662`) | Go over by more than one call's maximum |
| Privacy forbids it | Refused before sending (`runner.js:284-289`) | Waits on local capacity (`registry.ts:654`) | Send with a warning |
| Break after output started | What arrived is all there is (`models/index.ts:717-719`) | Fails | Splice a second model's reply onto the first |
| Broker locked or in safe mode | "Nova's vault isn't running" (`vault-broker.md:137`) | Waits | Read the key some other way |
| CLI not installed | `not_installed` (`claude-code.ts:23-26`) | Can't be turned on (`registry.ts:401`) | Run another vendor's CLI instead |

Fallback for a chosen chat provider is new (migration step 7). It follows `infer()`'s rule: only
before the first token reaches the person (`models/index.ts:696-699`).

## Security

- **Egress.** New providers go through the same classifier (`registry.ts:240-283`). `openrouter`
  declares `remote:openrouter.ai`; its address is a `WHERE_KEYS` field (`registry.ts:49`), so moving
  it while enabled needs `confirm: true`. OpenRouter forwards each request to the model's own vendor:
  the receipt and the words name OpenRouter and say that it routes to the model's vendor (open
  question 5). Every call refuses redirects (`types.ts:128`; broker `http.ts`).
- **Key scope.** One key per provider, one exact origin, the two paths Nova calls, a standing
  consent with a rate cap, rotation through the broker's `rotate`. Core, models, logs, receipts,
  memory and the ledger see the ref only (`vault-broker.md:74`). A dedicated OpenRouter key with a
  spend limit set on OpenRouter's side is the owner's own action; Nova neither creates nor reads one.
- **Subscription login.** Own-login is never offered in onboarding or to another person. On the
  owner's own install it is an explicit, labelled opt-in (open question 1). The `claude -p` default in
  `config.js:15-21` stops being a silent default (decision 4).
- **What a provider may run.** A chat provider runs nothing: Nova applies its files through the JSON
  contract (`registry.ts:726-734, 816-824`). A coding agent runs in its task folder with today's limits
  (`claude-code.ts:30-45`; `codex.ts:31`; `cli.ts:52-66`; `child-env.ts`). Tests on what it wrote run
  only after the person's OK (`registry.ts:838-841`). The Agent SDK gets no more than `claude-code`.
- **A provider's output is untrusted.** Replies go through `parseContract` (`registry.ts:728`) and the
  runner's screen of outside content (`runner.js:533-534`). No reply can name a provider, model, key
  or address that Nova then uses.
- **No new listener.** Nothing here opens a port. The broker's streamed `use` is outbound only.

## Migration

Each step is one small PR, test first: the failing test lands in the same PR, before the code that
makes it pass. Each carries its LEDGER entry, independent review and ordinary exact-head CI, as the
queue requires (`owner-priority-queue-2026-11-02.md:14`). No step calls a real model.

| # | PR | Test written first | Depends on |
|---|---|---|---|
| P1 | `ChatHandle.call` returns usage on both paths | A role-path chat call's tokens reach the caps meter as reported, not estimated | none |
| P2 | `budgetBlock` and the reservation before a direct remote chat call | Over budget, a remote chat provider refuses before sending: stand-in 0 requests. Local chat unaffected | none |
| P3 | A `Send` seam in `openai.ts`: `complete` takes a sender, plain fetch by default | Every existing provider test passes unchanged; a keyed config is refused when the broker is on and there is no broker sender | none |
| P4 | Broker: streamed `use` for `http` | A canary split across chunk boundaries in every encoded form is scrubbed; running size cap; redirect refused; origin exact; abort ends the upstream request | none (broker track) |
| P5 | Providers' keys through the broker (`auth: broker-http`) | `provider-vault.test.ts` rewritten: the canary key reaches the stand-in and nothing in core, `process.env` included | P3, P4 |
| P6 | The `openrouter` built-in manifest and fields; the regression task `grounding.one-openai-provider` revised to version 3 in the same PR, so the fingerprint change is visible; the grounding briefing updated | Golden cases 1, 2, 12, 13, 19 | P5 |
| P7 | `models.cloud` as a provider ref, with the old shape read and migrated | An old `models.cloud` profile keeps working; a new one sends through the provider's `send`; receipts and budget unchanged | P6 |
| P8 | Chat fallback before output | Golden cases 4, 5, 11 | P7 |
| P9 | CLI key mode (`auth: broker-process`) for `claude-code` and `codex`; own-login as an explicit opt-in | Golden cases 15, 16 with `fake-claude.js` and `fake-codex.js` | P4 |
| P10 | No silent agent_cmd default for a fresh install | Golden case 18 | owner's answer to question 2 |
| P11 | Agent SDK evaluation, in an isolated worktree; merged only if E0-E6 pass and the owner says yes | E0-E5 in CI; E6 owner-run | P9; owner's answers to 7 and 8 |

## Golden cases

Each becomes one test. Stand-ins only (`scripts/stand-ins/fake-openai.js`, `fake-ollama.js`,
`fake-claude.js`, `fake-codex.js`), on loopback. "OpenRouter stand-in" means `fake-openai.js` behind a
test seam that makes the registry classify it as `remote:openrouter.ai`, so the remote rules are
exercised without leaving the machine.

| # | Case | Given | Expect |
|---|---|---|---|
| 1 | OpenRouter is off on a fresh install | A new home | `GET /providers` lists `openrouter`: installed, off, health `not_configured` with the key's words, egress `remote:openrouter.ai`. Zero requests anywhere |
| 2 | Local-only keeps OpenRouter out | `local-only`; `openrouter` on and chosen for chat | The runner refuses before sending, in today's words; no receipt; stand-in 0 requests; `check()` doesn't probe it (`registry.ts:311`) |
| 3 | Local first, local up | `local-preferred`; reasoner on Ollama stand-in; `models.cloud.provider = openrouter` | Ollama answers; OpenRouter stand-in 0 requests |
| 4 | Local first, local down | Case 3 with Ollama stopped | OpenRouter answers through its provider; the note says it went off the devices; receipt egress `remote:openrouter.ai`; a problem for the local fault |
| 5 | Cloud first, budget used | `cloud-allowed`; period budget spent | Local answers with the budget note; OpenRouter 0 requests |
| 6 | Direct remote chat over budget | `openrouter` chosen for chat; task budget spent | Refused before sending (P2); stand-in 0 requests; the words name the budget |
| 7 | Unpriced with a budget | `openrouter` with no price and no reported cost; a budget set | Waits with "Nova can't tell what … costs" (`models/index.ts:1437`) |
| 8 | The key never reaches core | A canary key in the broker; one chat call | The stand-in saw `Bearer <canary>`; core's env, logs, receipts, problems, profile and task folders have no trace of it |
| 9 | Key refused | Stand-in answers 401 | "openrouter.ai turned down the key" (`openai.ts:80`); not retried; a problem opened |
| 10 | Rate limited | A task; stand-in answers 429 with `Retry-After: 20` | Blocked with `retry_after_s` 20; asked again once after 20 s on a fake clock |
| 11 | Break after output | The stream stops after its first token | No fallback; the reply-broke-off words (`models/index.ts:718`) |
| 12 | Redirect | Stand-in answers 307 to another host | Refused with the redirect words (`types.ts:131-134`); the other host gets 0 requests |
| 13 | Moving an enabled provider | `PUT /providers/openrouter/config` with a new `base_url`, no confirm | Refused (`registry.ts:361`); nothing saved; neither address contacted |
| 14 | Usage counted once | One remote chat call | One `cloud_usage` row with provider `openrouter`, one caps line, the same token counts |
| 15 | Claude Code key mode | `claude-code` with `auth: broker-process`; `fake-claude.js` records its env | The child saw the key variable; core's env did not; the run's diff checked as today |
| 16 | Codex key mode | As 15 with `fake-codex.js` | As 15 |
| 17 | Own-login is opt-in | `claude-code` with no key and no opt-in | `not_configured`, with words that say a key is needed; nothing spawned |
| 18 | No hardwired runner | A fresh home, no agent_cmd in `nova.config.json`, no chat choice | Chat says no chat model is chosen and names Settings › Providers; nothing spawns `claude` |
| 19 | Grounding, revised | The `grounded` stand-in; "Add OpenRouter as a second provider, next to my local Ollama." | The reply names Settings › Providers › OpenRouter, keeps Ollama, doesn't claim it was added, doesn't ask for the key |
| 20 | The SDK can be removed | `claude-agent-sdk` absent from `IMPLEMENTATIONS` | Every suite passes; no file outside its adapter imports the package |

## Rejected alternatives

| Alternative | Why not |
|---|---|
| The Agent SDK as the primary chat adapter (the review's §6 item 1) | It makes one vendor's loop Nova's runner, which the owner ruled out. In process, its key would sit in core. It would be Nova's first runtime dependency. The review's own build order put it behind agent_cmd and measured first (`:254`) |
| A model gateway or router in front of the registry | A second abstraction beside `Impl`, which A1 rules out. ADR-8's amendments say an interface earns its place by a second adapter; this one has six already |
| OpenRouter for everything, Claude and Codex included | It throws away the coding CLIs' own tool loops and puts every model behind one company |
| OpenRouter's key in the legacy vault for now | Every new key there is one more to migrate, and the owner's rule is the broker. Building against stand-ins until the broker streams costs little |
| Any number of `openai-compatible` instances now | A bigger settings and UI change. One named built-in covers the owner's case. Later, on evidence (open question 10) |
| A native Anthropic Messages adapter now | A second HTTP shape to keep. Claude is reachable through `claude-code` and OpenRouter (open question 11) |
| Switching coding agents automatically when one is down | Different work at a different price, chosen by nobody. Waiting with the reason is the honest default |
| Keep `claude -p` as the silent chat default | It is the hardwired runner the owner ruled out, and for anyone but the owner it is the subscription login |

## Consequences

- One place to set OpenRouter. The Models screen's cloud model picks a provider instead of taking an
  address and key of its own.
- A remote chat provider can no longer spend past the cloud budget by being chosen directly.
- Keyed remote chat waits for the broker's streamed `use`. Until then OpenRouter exists, tested, but
  has no key. That is deliberate.
- The coding CLIs gain a key mode; the owner's own-login use continues only if the owner opts in.
- A fresh install starts with no chat model instead of `claude -p`. The owner's install is unaffected.
- The regression fingerprint changes once, visibly, when `grounding.one-openai-provider` is revised.
- The Agent SDK may never land. If it fails an eval, nothing else in this plan changes.
- Live caps on provider-owned loops remain a stated gap; this ADR doesn't claim to close it.

## Open questions for the owner

Each has the default this design recommends. **[Security]** marks the ones that change what leaves
the machine, who holds a key, or what runs.

1. **[Security, licensing] Own-login for `claude` and `codex`, and the `claude -p` agent_cmd: keep for
   your own install only, as a labelled opt-in, never offered to anyone else?**
   *Recommended: yes.* Key mode through the broker becomes the only path in onboarding.
2. **A fresh install's chat model: none until the person chooses one, or keep `claude -p`?**
   *Recommended: none until chosen,* with `recommend('chat')` offered first. Your `nova.config.json`
   keeps its agent_cmd.
3. **[Security] Enter your OpenRouter key only once the broker streams (P4, P5), and never in the
   legacy vault?**
   *Recommended: yes.* Everything before P5 runs on stand-ins.
4. **[Security] The OpenRouter binding's standing consent: how many calls an hour?**
   *Recommended: 120 an hour,* enough for a busy conversation with tools, low enough that a runaway
   loop stops within the hour; above it, each use asks.
5. **[Security] OpenRouter forwards requests to the model's own vendor. Is a receipt naming
   `openrouter.ai`, with words that say it routes onward, enough?** Your OpenRouter account's own
   data and routing settings stay yours; Nova doesn't read or change them.
   *Recommended: yes,* plus setting a dedicated key with a spend limit on OpenRouter's side yourself.
6. **One cloud provider for every role, or one per role?**
   *Recommended: one for now.* Per-role refs can come with evidence that a role needs a different
   model.
7. **[Security] The Agent SDK as a runtime dependency: allowed in an isolated eval worktree only,
   with merging a separate yes after E0-E5 pass?**
   *Recommended: yes.* It would be Nova's first runtime dependency.
8. **[Security] The Agent SDK's real-model scorecard (E6): run by you, with your key, under caps,
   or decided on stand-in parity alone?**
   *Recommended: run by you, bounded by caps.* Stand-ins can't show the SDK does better work.
9. **Chat fallback across providers (P8): only before output, never to a looser egress than the
   mode allows, with a note?**
   *Recommended: yes.*
10. **More than one `openai-compatible` instance (say, a second hosted service)?**
    *Recommended: not now.*
11. **A native Anthropic Messages adapter?**
    *Recommended: not now.* Revisit if E6 or the scorecards show a need.
12. **The two spend stores, `cloud_usage` and `workers/spend`: one store later, in its own ADR?**
    *Recommended: yes, a separate ADR,* since the queue rules out a new spend schema as incidental
    wiring.
