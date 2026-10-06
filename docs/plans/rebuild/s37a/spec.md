# S37a — the MCP client: she uses the tools other services publish

**In short**

1. Nova connects to MCP servers over HTTP and uses their tools: GitHub today (CI runs and job
   logs), and later any app she installs that ships an MCP server.
2. Four fixed tools do it: `mcp_connect`, `mcp_disconnect`, `mcp_tools` (look up a server's
   tools and their inputs) and `mcp_call` (run one). A line in her prompt names each connected
   server and its tools.
3. You add servers on a new Settings tab, **Connections**, and so can she, with `mcp_connect`.
   A token is pasted once, never shown again, and never reaches her.
4. Every call is a span: server, tool, origin, outcome. A server's own error is a failed call.
5. Two guards: denying a connected server is corrected, and claiming a server said something
   with no call to it that turn is corrected.
6. The client is written in core on `httpx`, a few hundred lines. It speaks MCP 2026-07-28 and
   falls back to the older protocol when a server needs it. No new service.

Status: design approved in chat by the owner, 2026-09-30. Branch `slice/mcp-client`, worktree
`.worktrees/mcp`. This document is the contract the plan is written against.

## Why

The owner, 2026-09-30, listing what Nova should be able to do: install and configure
applications ("n8n, homeassistant or others"), configure connections and settings, watch CI/CD
pipelines, and do it on other devices. He then clarified that he does not want Home Assistant
or n8n installed: they are examples of the hard case, complex self-hosted apps, and what he
wants is the capability.

An integration in v4 today means writing a tool in `services/core/app/tools/`, moving the
registry pin and redeploying. Home Assistant (the community `ha-mcp` server, 87 tools), n8n
(an instance-level MCP server since 1.121) and GitHub (`github/github-mcp-server`, remote) all
publish their tools over MCP. One client makes every one of them hers without writing each.

What it does NOT do: install anything, watch CI on its own, or configure an app through files,
its web UI or its REST API. Those are the doing lane (`doing-things.md`: S30 jobs, S34 goals,
S37c events, S37d HTTP requests, S38 her browser).

## Owner decisions (2026-09-30)

- **She and you both connect servers.** A web page could talk her into connecting a server; that
  shows on the trace and is never blocked (`no-approvals.md`).
- **Tokens are stored like provider keys, for now:** a column in core's database, write-only,
  never returned by any route or tool, never in her context. They move into the encrypted store
  if the owner picks that in the doing-things questions (Q6). S41's backup bundle is already
  encrypted, so a backup does not expose them.
- **Four fixed tools plus a roster line**, not every server tool as a tool of her own: one
  87-tool server would drown a small local model on every turn. The same call S18 made for
  scripted skills (one `run_skill`, not a tool per script): the registry stays static and its
  pins keep their meaning.
- **The rest of the design, as presented in chat, approved.** First real test: GitHub, because
  CI fails on every `main` run today (run `36719466510`).

## Scope

In:
- Streamable HTTP servers, tools only.
- Protocol 2026-07-28 (stateless), with the 2025-era fallback (initialize and sessions).
- Auth: a bearer token and/or extra headers per server. No OAuth.
- The Connections tab, with a GitHub preset.
- Her four tools, the roster line, span facts, two guards, a tool-list-changed notice, evals.

Not in:
- stdio servers, which need node or uv beside core (v3 built `mcp-runner/` for that).
- OAuth flows, MCP resources, prompts, sampling, subscriptions and elicitation.
- Images and audio from tools: stated, not read (vision on tool results is later).
- Watching anything unprompted: that is S34 goals or S37c events.
- Nova as an MCP server for other clients.

## The design

### 1. The client (`services/core/app/mcp/client.py`)

Hand-rolled on `httpx`, which core already depends on. Measured 2026-09-30: the official Python
SDK (`mcp` 2.2.0) would add 12 packages to core, including a second HTTP stack (`httpx2`), and
it takes auth headers only through that stack's client. Its client API was rewritten in July
(v1 to v2). A tools-only client with static credentials needs little of it.

**Modern (2026-07-28)**, per request:
- One JSON-RPC request per POST, with `Accept: application/json, text/event-stream`,
  `MCP-Protocol-Version: 2026-07-28` and `Mcp-Method: <method>`. `tools/call` also sends
  `Mcp-Name: <tool>`, base64-encoded as `=?base64?…?=` when the name is not header-safe.
  Arguments whose schema carries `x-mcp-header` are copied into `Mcp-Param-{Name}`.
- `params._meta` carries `io.modelcontextprotocol/protocolVersion`,
  `io.modelcontextprotocol/clientCapabilities: {}` and `io.modelcontextprotocol/clientInfo`.
- The response is JSON or SSE, whichever the server chooses. From SSE, take the response whose
  id matches; `notifications/progress` goes to `ToolContext.progress`, so a slow call shows as
  moving in the bubble. A broken stream is re-sent once with a new id.
- `resultType`: missing means `complete`. `input_required` with only `requestState` is retried
  with it echoed, at most 3 times; anything else is a stated failure, because the client
  declares no capabilities.
- `tools/list` follows `nextCursor` up to 20 pages. Its `ttlMs` sets how long the cached list is
  trusted.

**Legacy (2025-11-25 rules and earlier)**: `initialize`, then `notifications/initialized`;
send `Mcp-Session-Id` if given, send the negotiated `MCP-Protocol-Version`, and re-initialize
once on a 404.

**Which one, found once per server:**
1. POST `server/discover`.
2. A discover result, or a recognised modern error (`-32020`, `-32021`, `-32022`), means modern.
3. Anything else means legacy. That includes a JSON-RPC error inside an HTTP 200, which is how
   Home Assistant's own `/api/mcp` answers.

The result is stored on the server's row (`protocol`), so the probe runs on connect, after a
failure, and never per call.

**Limits:**
- Connect and list: 15 s. A call: 60 s.
- A result handed to her is text, capped at 64 KiB. Past the cap she is told how much was left
  out and how to ask for less (for example GitHub's `tail_lines`).
- `structuredContent` is shown as JSON when there is no text block.
- An image or audio block is stated ("the server returned a 34 KB png; images from tools are not
  read yet"), never dropped silently.

**Failures are stated**, never raised as bugs: unreachable, refused (401/403, with the server's
words), timed out, not an MCP server, unsupported protocol, a tool that does not exist. Each
becomes a `ToolFailure` with the reason, so the model reads `Error: …` and dispatch marks the
call failed.

**The test seam** is the one the web tools already use: `app.state.peer_transports`, keyed by
origin, so tests mount an ASGI fake (see §8).

### 2. Storage (core migration `038_mcp_servers.sql`)

One table, `mcp_servers`:
- `id`, `name` (unique; lowercase `[a-z0-9_-]{2,32}`, the name she uses in calls).
- `url` (the full endpoint; the path can itself be a secret, since `ha-mcp` authenticates by a
  secret path, so only the origin is ever shown or traced).
- `token` (nullable; sent as `Authorization: Bearer`). `headers` (jsonb, extra headers, e.g.
  `X-MCP-Toolsets: actions`).
- `added_by` (`owner` or `nova`), and `added_turn_id` when she added it.
- `protocol` (`2026-07-28` or `legacy:<version>`, null until probed), `server_title` (from
  discover or initialize).
- `tools` (jsonb, the cached list: name, description, inputSchema, annotations),
  `tools_hash`, `tools_fetched_at`, `tools_ttl_ms`.
- `last_ok_at`, `last_error`, `last_error_at`, `created_at`.

`token` and header values are read only by the client, to make a call. No route or tool ever
returns them; routes return `has_token` and header NAMES. Numbering: `038` is the next free on `main`. S42b also has a `038`.
The migrations runner refuses an unrecorded file numbered below the highest applied one, so
whichever of the two lands second renumbers BEFORE it deploys (hub:primary agreed, 2026-09-30).

### 3. Her tools (`services/core/app/tools/mcp.py`)

| Tool | Does | `reads_only` | `ephemeral` |
|---|---|---|---|
| `mcp_connect(name, url, token?, headers?)` | Adds a server, probes it, lists its tools, and replies with the protocol and the tool names. A server that does not answer is NOT saved; the reply says why. A name already in use is REPLACED, and the reply says what it replaced (its origin and who had added it). | no | no |
| `mcp_disconnect(name)` | Removes a server and says which one and who had added it. | no | no |

Record, never refuse (`no-approvals.md`): she may replace or remove any server, including one
the owner added. When she replaces or removes one the owner added, a non-urgent notice says so,
with the old and new origins, so a page that talked her into re-pointing his GitHub is visible
in his Inbox and on the trace. Nothing asks and nothing blocks.
| `mcp_tools(server, query?)` | The server's tools with their inputs (JSON Schema). With `query`, only the tools whose name or description contains every word of it. Refreshes the cached list when its `ttlMs` has run out. | yes | yes |
| `mcp_call(server, tool, arguments)` | Runs one tool. `arguments` is validated against that tool's `inputSchema` with core's own `schema.validate` before anything is sent; a mismatch is a retryable refusal that includes the schema, so she can fix the call without a lookup. `isError: true` from the server is a failed call. | no | no |

- **Registry:** 43 → 47, and `reads_only` 22 → 23 (`mcp_tools`).
- **Not auto-run:** all four go in `live_facts.NOT_AUTO_RUN`, with the reason that the address or
  arguments are whatever someone connected or she chose, and the backend never calls a third
  party unasked.
- **Dispatch is untouched:** `mcp_call` is a registered tool whose executor calls the client.
  The `Tool` and `ToolContext` field sets do not change, so the `test_no_approvals` pins stay
  where they are.
- **Why `mcp_call` is not ephemeral:** it can change things (re-run a workflow, set an
  integration), and a turn that changed something must be remembered. An old reading that
  comes back through recall is handled the way device readings are (S40b's history stamps).

### 4. The roster line

`mcp.roster_line(pool)` sits beside `agents.roster_line` and `skills.roster_line`, and is added
to `chat.volatile_system_prompt`. It is read from the table each turn and never calls a server
(no network in the prompt path). With no server connected it is `None`, and the prompt is
byte-identical to today's. For each server it gives:
- its name and title;
- its tool NAMES when there are 12 or fewer, or the count plus "search with
  `mcp_tools(server, query)`";
- and, when the last call failed, when and why.

The servers' own tool descriptions are never in the prompt. She reads them in `mcp_tools`
results, which are third-party text like a fetched page.

### 5. The trace and masking

- Every `mcp_call` span carries meta `{server, tool, origin, protocol, is_error, bytes}`, and
  Activity shows it as `github · get_job_logs`. The origin is scheme, host and port, never the
  path.
- Every client call appends a fact `{"server": name, "reachable": bool}` to `facts_sink`. The
  guards read that fact; nothing reads prose.
- **Masking, before `_bounded`, in `chat._redact`:** a value whose key is credential-shaped
  (`token`, `password`, `secret`, `api_key`, `apikey`, `authorization`, `cookie`, or a header
  name containing `token`, `secret`, `key` or `auth`) is stored as `<masked:N chars>`. This is
  general, not only for MCP: it closes the S29 defect that a token in an argv reaches Activity.
  A test pins that no token bytes from an `mcp_connect` call reach `turn_spans`.

### 6. Guards (`services/core/app/guards.py`)

Both are pure, precision-first, append-only (the said-not-done ruling: a correction sentence,
never a redirect). Both take the live server list, read once in `chat.py` **after every
redirect has run** (`_mcp_server_refs`) — so a server an earlier redirect's `mcp_disconnect`
removed is not "connected" by the time these run, and a server it added is. Neither reads the
owner's message (the 2026-09-27 no-phrase-matchers ruling); both are silent on a turn whose
delegation may have run an agent (the agent's own calls are on its own turn, not this one).
A server's title counts as one of its names only when it looks like a proper name in prose —
two or more words, or a capital after its first letter (`_shaped_like_a_name`); a title like
"the" or "Files" would make a common word name the server, so such a server is matched by its
connection name alone.

- **`server_denial_check(reply, spans, servers)`**
  - Fires on a first-person, present-tense denial whose object is a connected server's name or
    title as a whole word ("I don't have access to GitHub", "I can't reach GitHub"). Judged only
    for a persona that holds `mcp_call` — an agent given none truly cannot reach one, so no
    server is "connected" from its point of view.
  - Silent when that server's last call failed or was disconnected this turn, or is already
    marked failing: then the denial is true. Also silent on questions and on a clause carrying a
    present-state qualifier ("right now", "currently", "because", "unless", …).
  - Correction: `"(GitHub is connected: mcp_call can reach it.)"`
- **`server_claim_check(reply, spans, servers)`**
  - Fires on a first-person past-tense read of a connected server ("I checked GitHub", "I looked
    at the GitHub run"), or an attribution ("according to GitHub", "GitHub shows"), for a server
    that answered no call this turn — "answered" means an ok `mcp_call` span, OR a call whose own
    `isError` is true (the server's own answer, never a failing server, so it backs the claim and
    the guard stays silent) — and whose name isn't among the arguments of an ok live-read call
    this turn (a web fetch, a search: reading its own words is not reading the server). Also
    silent on a clause carrying a past-tense qualifier ("earlier", "yesterday", "last time", …).
  - Correction: says a call to the server did not **succeed** this turn when one ran and failed
    ("No call to github succeeded this turn."); says none **ran** when none did at all ("No call
    to github ran this turn."); stays silent whenever the server answered.
- **Timing:** both get the timing sweep the family requires, for 50 KB replies and the worst
  case under a set time budget (the 15.4 s regex, 2026-09-12, is why).

### 7. The Connections tab and API

- **Settings → Connections** (slug `connections`, blurb "Services she can use through MCP, like
  GitHub."), shown in the desktop tabs and the mobile menu (the parity test moves).
- For each server it shows: name, title, origin, protocol, tool count (expandable to names and
  descriptions), last ok or last error with its time, and who added it.
- It can add a server (name, URL, token, extra headers), test it (probe plus tools list, shown),
  and remove it.
- **One preset: GitHub (CI)** fills `https://api.githubcopilot.com/mcp/` and
  `X-MCP-Toolsets: actions`, and says which fine-grained token to make (Actions: Read on the
  repository).
- The token field is write-only, like Providers. Checked at 393 px.
- **API:**
  - `GET /api/v1/mcp/servers` returns no token and no header values.
  - `POST /api/v1/mcp/servers` probes before saving, like provider verify-before-save.
  - `POST /api/v1/mcp/servers/{name}/test`.
  - `DELETE /api/v1/mcp/servers/{name}`.
- Every authenticated person sees every route, as elsewhere (`identity.py`).

### 8. When a server's tools change

On any refresh whose `tools_hash` differs from the stored one, the new list replaces the cached
one at once and a notice is filed. The notice is non-urgent and fingerprinted over the facts
`{server, added, removed, changed}`, never over a sentence. Nothing is disabled: v3 froze the
server until the operator re-approved it, which is an approval.

### 9. Reach

A server's address comes from a connect call, never from a page she read, so the public-only
rule `fetch_url` enforces does not apply. LAN and tailnet addresses are the normal case for an
app she installed. Every call's origin is on its span.

### 10. Evals (corpus 30 → 34, `suite_version` 17 → 18)

- **A new case field:** `mcp_servers`. A declared fixture server is never a row in the real
  table. Like `FixtureDevice`, the runner overlays it for that case alone, and its name must
  start with the fixture prefix.
- **The fake enforces the spec:** it answers only a well-formed modern request, with the headers,
  the `_meta` keys and a JSON-RPC body; anything else gets the spec's 400 error. A fake that
  accepts any request proves nothing (FakeAnthropic, S10-pre). A second fake speaks only the
  legacy handshake, so the fallback is tested both ways.
- **Cases:**
  1. `reads-ci-from-the-connected-server`: she calls `mcp_call` on the fixture server and names
     the failing job from its canned log.
  2. `does-not-disown-a-connected-server`: no uncorrected denial, and a call is made.
  3. `no-server-claim-without-a-call`: nothing is attributed to a server that was not called.
  4. `says-an-unreachable-server-is-unreachable`: the fixture refuses; she says so and invents
     no status.
- **Unit and route tests:** the client against both fakes (JSON and SSE; pagination; the ttl;
  `requestState`; `isError`; each stated failure), masking, the roster, the tab, the migration,
  and the pins.

## The walk (definition of done)

Deployed from `~/workspace/nova` on `main`, walked in the owner's words, each trace read by turn
id.

1. He adds GitHub on Connections with the preset and a fine-grained token (Actions: Read on
   `jeremyspofford/nova`). The tab shows the protocol and the Actions tools.
2. He asks "why is CI red on main?"
   - She calls `mcp_call` for the latest `main` run and its failing jobs' logs, and names the
     failing jobs and the first failing step from the real log.
   - The trace shows the spans with the token masked, and `turn_spans` holds no token bytes.
3. He asks her to connect a public MCP server that needs no token (candidate: DeepWiki,
   `https://mcp.deepwiki.com/mcp`, to confirm at plan time) and use it. The row reads
   `added_by: nova`.
4. He removes GitHub on the tab, then asks about CI again. She says GitHub is not connected,
   and invents nothing.

## Which line of code refuses when she is wrong

- A call to a tool that does not exist, or with arguments that do not fit its schema, is refused
  by `mcp_call` before anything is sent.
- A server's `isError` is a failed call, not a success with error text.
- Denying a connected server, or attributing something to one she did not call, is corrected by
  the two guards, both derived from the live server list.
- No token reaches her context, the trace or a route: write-only storage, and masking before the
  span is written.

## Pins that move

- `test_tools_registry`: 43 → 47 names; `reads_only` 22 → 23.
- `test_eval_corpus`: 30 → 34 cases; `suite_version` 17 → 18.
- Settings tabs: 5 → 6, plus the mobile parity test.
- Migration `038` (see §2 for the renumbering rule with S42b).

## Interplay

- **S42b (hub:primary):** Task 22 adds `machine_update` (registry 43 → 44). Task 21 edits the
  device tools. Task 23 adds an `updated_machine` claim and a capability phrase. Both lanes move
  the registry and migration pins. Whichever lands second renumbers once.
- **fix/said-not-done:** it will likely merge to `main` first. Its append-only correction shape
  is the one §6 uses. Rebase on it before the guards task.
- **S38, her browser:** Microsoft's Playwright MCP server is one of the options for the browser
  engine. If it is chosen, the browser's built-in tools call this client's library (`mcp.client`)
  directly, so the client exposes a plain `call(server, tool, arguments)` beside the tool
  executors.
- **Doing-things Q6:** if the encrypted store is chosen, `token` and header values move into it
  along with the provider keys.

## Known limits

- **A token typed into chat** is stored in the conversation like any message. The tab is the
  place for tokens. A general fix is S29's.
- **A token she obtains herself**, say from an install's output, has already passed through a
  tool result before `mcp_connect` stores it. Masking covers the connect call, not the earlier
  read.
- **Server tool descriptions and results are third-party text.** They can steer her the way a
  fetched page can. They are recorded as such, never refused (doing-things Q13).
- **Home Assistant's built-in `/api/mcp`** exposes only entities exposed to Assist, and adds no
  integrations. `ha-mcp` does both. Neither is installed, by the owner's choice.

## To confirm at plan time

- Which protocol versions GitHub's hosted endpoint accepts. The research found its open-source
  handler supports both eras, but the hosted endpoint was not probed.
- A public no-token MCP server for walk step 3.
- The exact fixture prefix and how the runner overlays a fixture server on
  `app.state.peer_transports`, for an eval turn only.
