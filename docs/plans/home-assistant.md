# Home Assistant — Nova manages the smart home

Implementation plan (authored 2026-07-24 with Fable). Status: PROPOSED — needs
Jeremy's sign-off. Goal: Home Assistant runs as an optional service in the nova
compose stack, Nova talks to it through HA's official MCP server integration,
a dedicated `home` agent actuates devices under guardian tiers (reads free,
routine actuation audited, strict actuation consent-gated), and the house shows
up in memory as a daily digest — not an event firehose. HA is NOT installed
anywhere today; this plan is the from-zero path.

## What exists (verified in code, 2026-07-24)

- **MCP client is fully built, but http transport is streamable-HTTP only** —
  `backend/app/mcp_client.py:24` imports `streamablehttp_client` and both
  `connect_and_list` (mcp_client.py:59) and `_http_call_tool`
  (mcp_client.py:131) use it exclusively. HA's MCP server integration serves an
  **SSE** endpoint (`/mcp_server/sse`), which is the older MCP transport — so
  today the README's HA example cannot actually connect. Tool-list hash
  approval exists (`tool_list_hash`, mcp_client.py:33-39 — name+description
  only, the prompt-injection surface).
- **README.md:239-243 already documents an HA registration curl**:
  `{"name":"home-assistant","transport":"http","url":"http://homeassistant.local:8123/mcp_server/sse","headers":{"Authorization":"Bearer <your-ha-token>"}}`.
  Two problems it inherits: the transport gap above, and the plaintext token.
- **mcp_servers.headers is PLAINTEXT JSONB** — migration `031_mcp_servers.sql`
  line 21 (`headers JSONB NOT NULL DEFAULT '{}'`), transport CHECK is
  `('http','stdio')` (line 17). `docs/plans/secrets-management.md` phase 1
  (`{{secret:NAME}}` references resolved in mcp_client at call time) is the fix
  and a HARD DEPENDENCY here — the HA token is never stored before that lands.
- **MCP grants are never implied** — `tools/registry.py:108-122`: even an
  agent with `allowed_tools = NULL` (all builtins) gets zero MCP tools; each
  needs `mcp:<server>/<tool>` or `mcp:<server>:*` per agent. Full tool names
  look like `mcp:home-assistant/HassTurnOn` (registry.py:81).
- **execute_tool is the single enforcement chokepoint** —
  `tools/registry.py:308`: grant check (315-317), then guardian rules
  (321-333: `rules.check` verdict; `block` returns without executing, `warn`
  logs + increments hit_count and the call PROCEEDS — warn is audit, not
  friction), then execution; the `mcp:` branch is registry.py:353-364.
- **rules.check semantics** — `backend/app/rules.py:58-77`: haystack is
  `tool_name + " " + json.dumps(args)` (line 61), so entity ids and `domain`
  values inside tool args are matchable by pattern; `target_tools` /
  `target_agents` filter first (67-70); block wins over warn (74-77). Schema in
  `migrations/014_rules.sql`: pattern, target_tools[], target_agents[],
  action CHECK `('block','warn')` (line 11), is_system rows are untouchable by
  agents (`tools/builtin.py:996-999`).
- **Consent rail** — `backend/app/consents.py:22-24`: DECIDE_TTL_MIN=10,
  USE_TTL_MIN=3, CREATE_LIMIT_PER_HOUR=6; `validate_and_use` (110-137) is
  check-and-burn, agent-bound, single-use. The `request_operator_confirmation`
  builtin (`tools/builtin.py:851-881`) currently **hard-codes kinds to
  `rule.delete|rule.weaken|rule.modify`** (line 858) and validates the subject
  as a rule name (862-869) — it must be extended for a home kind. The consents
  schema itself is extensible (`029_consents.sql`: "kind ... (extensible)").
  The burn pattern to copy is manage_rules delete (builtin.py:1000-1014):
  validate_and_use with a mechanically derived subject, never LLM judgment.
- **Destructive-capability precedent** — `migrations/045_memory_curator_agent.sql`:
  strict capabilities live on a dedicated tiny-toolset agent that does NOT
  fetch or ingest untrusted content, never on main; main gets a routing line
  appended to its prompt with an idempotency guard (045 lines 83-87).
- **Automations** — `migrations/013_automations.sql`: instruction + agent_name
  + interval_minutes (>= 5) + timeout_seconds (026); leader-gated 60s tick
  (`scheduler.py` tick: `instances.is_leader()` gate), `asyncio.wait_for` kill
  (scheduler.py:55), auto-disable after 5 consecutive failures with a
  notification (automations.py:172-178, scheduler.py:104-115). Reschedule is
  `next_run = now + interval` (automations.py:148) — a daily job drifts later
  by its own run duration; acceptable.
- **The digest pattern** — migration `026_automation_timeout_digest_fix.sql`:
  month-capped topic ("<Name> — <Month> <Year>"), search for it, `write_memory`
  with `item_id` + `append=true` sending only today's delta. Append path:
  `memory/memory.py:186-213`. `about:` frontmatter is consumed at index time
  (memory.py:400-401 arcs `about: user` to the operator node) but is NOT a
  parameter of `memory.write` (signature 184-190) or the write_memory builtin
  (builtin.py:36-57) — a small additive param is needed (mirror `author`).
- **Compose profile pattern** — `docker-compose.yml`: optional services use
  `profiles: ["<name>"]` (ollama:76 `["inference"]`, media:126, notify:145,
  voice:199/212), named volumes in the top-level `volumes:` block, and every
  published port binds `127.0.0.1` only.
- **Reverse channel already exists** — `backend/app/notify.py` has a provider
  registry (ntfy + webhook); HA-to-Nova triggers, if ever wanted, would be HA
  POSTing to a webhook — out of scope for v1, but the direction is not blocked.
- **Backups already reserve the slot** — `docs/plans/data-backups.md` lines
  22 and 40: once the home profile exists, the `ha_config` volume joins the
  backup bundle manifest. C3 delivers that delta.
- **Not this lane**: `docs/plans/device-activity-monitoring.md` is
  ActivityWatch / computer-usage telemetry. It does NOT cover smart home and
  nothing here depends on it — named only to prevent confusion.

## Design

### Install: compose service, profile "home" (LOCKED on-ramp)

New service in `docker-compose.yml`, matching the house pattern:

```yaml
  # Home Assistant (optional): docker compose --profile home up -d
  # IP-based devices only under WSL2 (see plan) — the on-ramp, not the
  # end state. Nova talks to it over the compose network via the HA MCP
  # server integration; moving HA to a dedicated HAOS box later changes
  # ONLY the mcp_servers.url, nothing in Nova.
  homeassistant:
    image: homeassistant/home-assistant:<pinned tag, see Decisions>
    profiles: ["home"]
    environment:
      TZ: ${TZ:-America/New_York}
    ports:
      - "127.0.0.1:8123:8123"
    volumes:
      - ha_config:/config
    restart: unless-stopped
```

Plus `ha_config:` in the top-level `volumes:` block. No `network_mode: host`,
no privileged, no device mounts — none of them work usefully under WSL2 anyway
(next section) and the stack norm is localhost-only binds. The backend reaches
HA as `http://homeassistant:8123` over the compose network (WSL2 breaks
`homeassistant.local` mDNS names; never use them). The operator reaches the HA
UI at `http://127.0.0.1:8123` (or via the tailscale profile later).

### WSL2 honesty (why v1 is IP-devices-only)

Stated plainly so nobody burns a session fighting it:

- **USB radios (Zigbee/Z-Wave dongles) are fragile on WSL2**: usbipd-win
  attach/detach plus often a custom WSL kernel with the right serial modules;
  survives neither reboots nor replug reliably. Not part of this plan.
- **mDNS/SSDP discovery across the WSL2 NAT boundary is unreliable**:
  broadcast/multicast from LAN devices does not reach the container, so HA's
  auto-discovery mostly finds nothing. WSL2 mirrored networking mode
  (`.wslconfig`, Windows 11 22H2+) improves this and is worth enabling, but do
  not depend on it — add integrations manually by IP.
- **Thread/Matter border routing is effectively a no-go** here.

So v1 targets **IP-based devices** (Wi-Fi lights, plugs, media players — added
manually by IP in HA's UI), which is enough to prove the whole loop. The
end-state for radios is a **dedicated HAOS box** (HA Green / Pi / mini-PC) on
the LAN — **LOCKED (Jeremy, 2026-07-24): compose service now, HAOS box
later.** Crucially, NOTHING in Nova changes when HA moves hosts: the
integration is network-based (HA's MCP server + a long-lived access token), so
migration = update `mcp_servers.url` to the box's LAN address, re-approve the
tool hash, done. The compose service is an on-ramp, not a dead end.

### Integration: HA's MCP server + one mcp_servers row

HA ships an official **MCP Server** integration (Settings > Devices & Services
> Add Integration > "Model Context Protocol Server"); it exposes HA's Assist
tools (HassTurnOn, HassTurnOff, etc.) plus a live-context read tool at
`/mcp_server/sse`. Nova-side registration (operator-only, as always):

```json
{"name": "home-assistant", "transport": "sse",
 "url": "http://homeassistant:8123/mcp_server/sse",
 "headers": {"Authorization": "Bearer {{secret:ha_token}}"}}
```

- **Transport gap**: add `sse` as a third transport — migration widening the
  `mcp_servers.transport` CHECK to `('http','stdio','sse')`, an `sse` branch in
  `mcp_client.connect_and_list` / `call_tool` using `mcp.client.sse.sse_client`
  (same `(read, write)` -> ClientSession shape as streamablehttp_client; the
  installed `mcp` package is 1.28.1 per mcp_client.py:11). Build-time check
  first: if the pinned HA version has grown streamable-HTTP MCP support, skip
  the new transport and use `http` — verify against the running HA, not docs.
- **Token**: a long-lived access token minted in the HA UI (profile > Security),
  stored as secret `ha_token` via Settings > Secrets. HARD DEPENDENCY:
  secrets-management.md phase 1 must be live first; the token is NEVER pasted
  into `mcp_servers.headers` as plaintext, not even "temporarily to test".
- **Tool-list hash approval applies as usual** — and note the operational
  consequence: an HA upgrade that rewords tool descriptions flips the server
  to `error` and the home agent goes dark until re-approval in Settings >
  Tools > MCP servers. That is the poisoning defense working as designed.
- Update README.md:239-243 to the new shape (sse transport, `{{secret:ha_token}}`).

### The `home` agent (new row, memory-curator precedent)

Migration INSERT (idempotent upsert like 045):

- name: `home`
- description: "Controls and reports on the smart home via Home Assistant:
  lights, switches, plugs, media, climate, locks, covers. Dispatch any request
  about house devices or house state here."
- model: `(SELECT model FROM agents WHERE name = 'skill-manager')` — the 045
  inheritance pattern; revisit per-role via model-eval-pipeline.md later.
- allowed_tools: `ARRAY['mcp:home-assistant:*']` — and nothing else in v1. No
  memory writes, no fetch_url/web_search (untrusted-content separation: an
  agent that actuates the house must not also swallow web content), no
  dispatch (depth cap at 1 strips it anyway, runner.py:27/442).
  `request_operator_confirmation` is added in C2 (it is a builtin, so it must
  be listed explicitly once allowed_tools is non-NULL).
- routing_keywords: `ARRAY['light','lights','lamp','switch','plug','thermostat',
  'temperature','climate','heating','garage','lock','unlock','door','cover',
  'scene','media','tv','speaker','house','home']`
- is_system: true
- system_prompt (core points, written out in the migration): read state before
  acting (use the server's live-context/state tool); actuate exactly what was
  asked, nothing speculative; strict domains (locks, garage/covers, alarm,
  climate setpoints, cameras) require operator consent — call
  `request_operator_confirmation(kind='home.actuate', subject=<entity or tool>,
  question=...)`, tell the operator you are waiting, and do NOT retry until
  their decision arrives; report what the tool actually returned and never
  claim an actuation the tool did not confirm (the 045 honesty rule, adapted).

Main gets a routing line appended with the 045-style idempotency guard
(`... AND system_prompt NOT LIKE '%home specialist%'`): house/device requests
dispatch to `home`.

### Guardian actuation tiers (from day one)

Three tiers, enforced at the chokepoint, seeded as `is_system` rules so agents
cannot weaken them (builtin.py:996-999):

1. **Reads: free.** State/context queries match no rule.
2. **Routine actuation (lights, switches, plugs, media, scenes): warn tier**
   (default — see Decisions). warn = logged + hit-counted at
   registry.py:330-331, call proceeds; it is an audit trail, not friction.
3. **Strict actuation (locks, garage/covers, alarm, climate setpoints,
   cameras): consent-gated.** Not plain `block` (that would make locks
   unreachable even with the operator standing there saying yes) — a new
   `confirm` rule action wired to the consent rail (guarded-actions-consent.md
   is the design lineage; 045 is the "strict capability off main" precedent).

**The `confirm` mechanism** (the one new moving part, all additive):

- Migration widens the rules action CHECK to `('block','warn','confirm')`;
  `rules.py` validation lists (105-116, 128-129) and check() ordering gain
  `confirm` (precedence: block > confirm > warn).
- In `execute_tool`, before execution: pop a reserved `_consent` key from args
  (so it never reaches the MCP server), and on a `confirm` verdict call
  `consents.validate_and_use('home.actuate', subject, consent_id,
  agent_name=ctx['agent_name'])`. **Subject is derived mechanically from the
  call** — `args['entity_id']` (first element if a list) if present, else the
  bare tool name — never agent-supplied, so an approval for `lock.front_door`
  cannot be spent on `lock.back_door` (the builtin.py:1003-1005 pattern). No
  valid consent -> return the standard "requires operator consent — call
  request_operator_confirmation(kind='home.actuate', ...) and wait" error.
- `_request_operator_confirmation` (builtin.py:851-881) gains
  `home.actuate` in its kind allowlist (line 858) and skips the rule-name
  lookup (862-869) for that kind — subject is an entity/tool string here.
- Flow end-to-end: "unlock the front door" -> main dispatches home -> home
  calls the HA tool -> confirm verdict, no consent -> home raises the card and
  says it is waiting -> operator approves in chat (10-min decide TTL) -> the
  decision message reaches the conversation -> home retries the same call with
  `_consent: <id>` -> burn (3-min use TTL, agent-bound, single-use) -> actuate.

**Seed rule rows** (same migration, both `is_system`, both
`target_agents = ARRAY['home']`, `target_tools = NULL` — the home agent has
only HA tools, and rules.py:61 matches entity ids/domains inside args):

```sql
('home-strict-actuation-consent',
 'Locks, garage/covers, alarm, climate setpoints, and cameras only actuate
  against a fresh operator consent (kind home.actuate).',
 '"domain":\s*"(lock|cover|alarm_control_panel|climate|camera)"|\b(lock|cover|alarm_control_panel|climate|camera)\.[a-z0-9_]+',
 NULL, ARRAY['home'], 'confirm', true),
('home-routine-actuation-audit',
 'Audit trail for routine device actuation (lights, switches, plugs, media,
  scenes) — logged and counted, never blocked.',
 '"domain":\s*"(light|switch|media_player|scene|fan)"|\b(light|switch|media_player|scene|fan)\.[a-z0-9_]+',
 NULL, ARRAY['home'], 'warn', true)
```

Patterns are a starting point — verify at build time against the ACTUAL
approved tool list and arg shapes (Settings > Tools > MCP servers shows both;
do not trust tool names written in any doc, including this one). False
positives on the strict pattern (a light literally named "lock office lamp")
cost one unnecessary consent card — the failure direction is safe.

### Context ingestion: pull, don't stream

Do NOT stream HA's event bus into Nova. A house emits thousands of state
changes a day; piping them at a 30-50 tok/s local model buys latency and noise,
not judgment. v1:

- **Pull-on-demand**: "is the garage open?" in chat -> main -> home agent ->
  MCP state read. Fresh, free-tier, no storage.
- **Daily house digest**: an automation on the `home` agent writes the delta
  into a month-capped topic — exactly the migration-026 pattern: title
  "House Digest — <Month> <Year>", search_memory for it, `write_memory` with
  `item_id` + `append=true` and a `## <Month> <day>, <year>` heading, tags
  `home, house-digest, digest`. New topic each month. The topic carries
  `about: user` provenance so it arcs to the operator's node in the atlas
  (memory.py:400-401 already consumes it) — which requires the small additive
  `about` param on `memory.write` + the write_memory builtin, mirroring
  `author` (memory.py:189, builtin.py:36-57). Digest write is the ONE
  narrow memory-write the home agent performs, and only via this automation;
  if that seam feels too wide, the fallback is a separate digest-writer flow —
  see Decisions.
- **Real-time HA-to-Nova triggers: deferred.** When wanted, the natural shape
  is HA's rest_command/webhook POSTing into a Nova endpoint (the notify.py
  webhook provider already proves the reverse direction) — a later phase, not
  v1.

**Design rule of thumb (state it in the agent prompt and the docs)**:
time/state-triggered device logic ("lights on at sunset", "off when nobody
home") belongs in HA natively — it is better at it and works when Nova is
down. Nova adds judgment, cross-source context, digest/memory, and voice.

### Example automations (automations table, agent_name = 'home')

- **evening-house-check** — interval_minutes 1440, next_run_at seeded to
  ~22:30 local: "Read the current state of all locks, garage doors, covers,
  and exterior lights. If every lock is locked and every garage/cover closed,
  reply 'all secure' and stop. Otherwise call notify_operator with exactly
  what is open/unlocked." (`notify_operator` must therefore be granted to
  `home` alongside the MCP wildcard — reads + notify only, still no memory.)
  Note: reads are free-tier, and notify_operator is how it reaches the phone;
  auto-disable after 5 failures already notifies (scheduler.py:104-115).
- **daily-house-digest** — interval_minutes 1440, seeded ~21:00: the digest
  instruction above (state summary: which devices were seen, anything
  unavailable, notable states). Daily reschedule drifts by run duration
  (automations.py:148) — minutes/day at worst, acceptable.
- **Morning brief**: not a new automation — a house-state section slots into
  the existing morning-brief/digest surface when that automation exists; the
  home agent's state reads make it a one-line instruction change there.

## Phases (each ends live-verified through :5173; changes left uncommitted, summarized)

Lane: branch `feature/home-assistant`, worktree `.worktrees/home-assistant`
inside the repo (never a sibling). One phase per session. Every migration uses
the next free migration number (re-check at build time; 050 is currently
contested between parallel lanes).

- **C1 — compose service + HA onboarding + MCP registration.**
  BLOCKED UNTIL secrets-management.md phase 1 is live (check for
  `backend/app/secrets.py` + `{{secret:` resolution in mcp_client before
  starting; if absent, build that first or stop). Add the `homeassistant`
  service + `ha_config` volume; `docker compose --profile home up -d`;
  complete HA onboarding at `http://127.0.0.1:8123`; add at least one real
  IP-based device (manual-by-IP — discovery will not find it, per the WSL2
  section) plus HA's Demo integration for fake lock/cover entities (needed to
  test C2 tiers without owning a lock); enable HA's MCP Server integration;
  mint a long-lived token, store as secret `ha_token`; add the `sse` transport
  (migration + mcp_client branch) unless the pinned HA speaks streamable-HTTP
  (check first); register the server with the `{{secret:ha_token}}` header;
  update README.md:239-243. **Verify:** HA UI reachable and onboarded; the
  real device toggles from HA's own UI; Settings > Tools > MCP servers shows
  home-assistant connected with its tool list hash-approved; the stored server
  row and a turn trace show only `{{secret:ha_token}}` / masked values, never
  the token.
- **C2 — home agent + guardian tiers + consent.** Migration: `home` agent row
  + main routing line + `confirm` action widening + the two seed rules;
  extend `request_operator_confirmation` kinds with `home.actuate`; the
  `_consent` pop + validate_and_use burn in the execute_tool MCP path with
  mechanically derived subject. **Verify:** through :5173 chat, "turn off the
  <real device>" actuates the physical device (watch it) and back on again;
  hit_count on home-routine-actuation-audit incremented; "unlock the front
  door" (Demo lock) produces a consent card INSTEAD of acting — approve it and
  the follow-up actuates; run it again and Dismiss — nothing actuates and the
  agent reports it was declined.
- **C3 — digest + evening check + backup manifest delta.** The `about` param
  passthrough (memory.write + write_memory builtin); the two automations
  seeded (migration or manage_automations, enabled); the data-backups.md
  manifest delta: `ha_config` volume joins the bundle (that spec's lines 22/40
  already reserve the slot — this phase makes it real on whatever backup code
  exists by then, or records the delta in that plan if the backups lane has
  not landed). **Verify:** force-run daily-house-digest (set next_run_at =
  now()); the month topic exists with today's dated section and `about: user`
  frontmatter, and appears in the atlas arced to the operator; leave the Demo
  lock unlocked and force-run evening-house-check — a push/ntfy notification
  arrives naming it; run again with everything secure — no notification.

## Decisions

- **LOCKED (Jeremy, 2026-07-24): HA Container in the nova compose stack now
  (profile "home", IP devices only), dedicated HAOS box on the LAN later for
  Zigbee/Thread radios.** The move is an mcp_servers.url change + hash
  re-approval; nothing else in Nova changes.
- **Routine-actuation tier: warn (default) vs free.** Default `warn` — it is
  zero-friction (audit-only, registry.py:330-331) and buys a hit-count audit
  trail for "who turned that on". Alternative: no rule at all. Jeremy's call;
  phase C2 ships warn unless overruled.
- **Digest cadence: daily at ~21:00, evening check ~22:30 (defaults).**
  Cadence and times are automations-table fields, trivially retuned in the
  Library > Automations tab.
- **HA version pin policy: pin an exact release tag** (e.g. `2026.7.x` —
  whatever is current at build time), never `latest`/`stable`; bump manually
  and expect the MCP tool-hash re-approval on upgrade. Alternative: track
  `stable` and accept surprise hash flips. Default: exact pin.
- **May the home agent read memory?** Default NO for v1 (toolset stays
  MCP wildcard + notify_operator + request_operator_confirmation + the digest
  write path). Add `search_memory` later only if real usage shows it needs
  house context ("the usual movie scene") — revisit with evidence.
- **Digest write seam**: default is granting `write_memory` to home and
  trusting the tiers + no-fetch toolset (device names are the only untrusted
  text it sees). If Jeremy wants the home agent fully memory-write-free, the
  alternative is routing the digest through main. Default: home writes it.

## Traps / risks

- **Transport mismatch is the first wall**: mcp_client.py speaks
  streamable-HTTP only (mcp_client.py:24/59/131); HA's MCP endpoint is SSE.
  Registering with today's code yields a connect error that looks like an auth
  problem. Fix the transport BEFORE debugging tokens.
- **Never store the HA token before the secrets lane lands.**
  mcp_servers.headers is plaintext JSONB (031 line 21). No "temporary" plain
  registration to test connectivity — that is exactly the gap
  secrets-management.md exists to close, and C1 is blocked on it.
- **WSL2 will eat a session if you fight it**: no mDNS (`homeassistant.local`
  resolves nowhere — use the compose DNS name `homeassistant` from the
  backend, `127.0.0.1:8123` from the browser), no auto-discovery of LAN
  devices (add by IP), no USB radios, no Thread. Mirrored networking mode is
  worth enabling but is an improvement, not a fix.
- **Do not invent HA tool names.** HassTurnOn etc. are illustrative; the
  authoritative list is what the server advertises and the operator
  hash-approves. Agent prompt and rule patterns get verified against that
  list in C2.
- **HA upgrades flip the MCP server to `error`** when tool descriptions
  change (mcp_servers.tools_hash, 031 lines 6-9). Expected; the fix is
  re-approval in Settings, and it means "the house stopped responding" after
  an upgrade is a two-click fix, not a bug hunt.
- **Consent subject binding must stay mechanical.** The executor derives the
  subject from args (entity_id else tool name) — if an agent could supply it,
  approval for one entity could be spent on another and the tier is theatre
  (same reasoning as builtin.py:1000-1014).
- **`_consent` must be popped before the MCP call** — leaking it to HA is
  harmless today but violates the reference-never-value discipline and would
  land consent ids in HA's logs.
- **The home agent never gets fetch/web/memory-read tools casually.** Device
  and entity names are attacker-influenced text if HA is ever compromised;
  keeping the toolset tiny (045 rationale) bounds the blast radius. Never
  grant `mcp:home-assistant:*` to main or ingestion.
- **Rules are regex over serialized args** (rules.py:61): strict-tier false
  positives (oddly named devices) cost a spurious consent card — fine; watch
  for false NEGATIVES if HA tools address devices by friendly name with no
  domain string in args — if so, tighten the agent prompt to always pass
  entity ids/domains, and extend the pattern. Check real call shapes in C2.
- **Containment invariants apply unchanged**: the seed rules are is_system
  (agents cannot weaken them; guardian consent-gates its own edits); staging
  stacks have automations off, so the evening check never actuates or
  notifies from a staging clone; nothing here touches compose/code in place —
  it all ships through the lane's worktree and Jeremy's merge.
- **Backups**: ha_config holds the HA SQLite recorder DB + credentials for
  device integrations — treat the bundle as secret-bearing (data-backups.md
  already does).
