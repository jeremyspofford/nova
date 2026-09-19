# Design: per-machine local engines in the gateway, and the inference-node package

## Summary

- **An engine** is a `providers` row with `adapter='ollama'` plus a one-to-one `engines` row.
  - The builtin `ollama` row is the hub's own bundled engine. It is still addressed by `OLLAMA_URL` and is always `always_on`.
  - Each other machine is a node row (for example `dell`). It stores `base_url = https://nova-node-dell.<tailnet>.ts.net`, `auth_shape='static-bearer'`, the node's token, and `local=true`. `local` is derived from the adapter at `providers.py:274`, so nodes never get USD caps.
  - Ids use the existing first-colon split: `dell:qwen3.8:27b`, `ollama:nomic-embed-text` (`providers.py:180-192`).
- **Every site that assumes one ollama** now names the engine that the link, pull or row refers to. Each engine gets its own state and tags cache, and failures are cached too.
- **An engine that sleeps is never probed in the background.** Only a routed request, a pull, or an explicit `live=1` read touches it. A probe of a sleeping machine may wake it (M2).
- **The gateway states; it never decides.** It observes engine state. When the routed link's engine is asleep and wakeable, it returns a typed **409 `engine_asleep` before any stream byte**. Core is the actuator: it wakes the machine, polls `/ready`, loads the model and retries the same request. After the deadline, core retries with `X-Nova-Skip-Engines`, the next link answers, and the route reason says why.
- **Connect failures to an engine never create a wall.** When a wake lands, it clears that engine's outage walls.
- **GPU and machine facts are per engine:**
  - builtin: `/proc`, plus the existing in-container `nvidia-smi` if a GPU overlay is present;
  - nodes: the node-agent's `/node/facts`.
- **Measurement identity is the compute a reading was taken on**, derived live:
  - `gpu:<nvidia uuid>` for a GPU engine;
  - `cpu:<cpu model>|<n>c|<GiB>g` for a CPU engine.

  Every new probe, usage row and served response carries it, and fit and speed read only rows with matching compute. Legacy rows carry none. They are kept and never read by a decision, which is the migration 008 precedent (`008_probe_vram_frame.sql`). *Settings* follow the owner's intent and are rewritten once by an explicit handover at the move. *Measurements* are never relabelled.
- **Node package: `./install node`** brings up:
  - ollama, with the GPU overlay;
  - the **node-agent**: a bearer-token reverse proxy with a fixed verb list, plus `/node/facts`, `/node/ready` and `/node/activity`;
  - a **userspace tailscale sidecar** that serves `https://nova-node-<name>.<tailnet>.ts.net`.

  It needs no LAN bind and no Windows port forwarding. It behaves the same on native Linux and on WSL2 in mirrored mode. Enrollment uses a one-time code, as with novad.
- **Owner question 8 (SSH keys or a secrets manager?): neither is needed.**
  - Hub to node is tailnet WireGuard plus one per-link bearer token. The node mints the token and hands it over in the enrollment call, so it never passes through chat or through a human.
  - Actions on the node (wake relay, holding it awake) go through novad's ed25519 envelopes.
  - The token is stored in `providers.api_key`, in plaintext like every provider key today. Proposal A (encrypting secrets at rest) would cover it later.
- **Memory:** compose pins `MEMORY_EMBED_URL=http://ollama:11434`, the hub's own engine, so recall never waits on the node and never keeps it awake.
- **Subnet:** `install.sh` chooses a subnet at install time. The same function serves the hub and the node.

## Components and responsibilities

| Component | Owns |
|---|---|
| `services/gateway/app/engines.py` (new) | Engine rows, state observation and caches, compute id, facts, readiness, the wake ledger, in-flight counts, handover |
| `services/gateway/app/engines_api.py` (new router) | `/admin/engines*` |
| `routing.py`, `data_plane.py`, `catalog.py`, `admin.py`, adapters | Generalised per engine (see the walk below) |
| `services/node/` (new, Python 3.12 FastAPI) | Node-agent: auth, proxy, facts, ready, activity, enroll CLI |
| `deploy/node/docker-compose.yml`, `deploy/node/docker-compose.gpu.yml` | Node stack (project `nova-node`) |
| `deploy/install.sh` | `choose_subnet`, the `node` subcommand, adopting the existing ollama volume |
| Hub tailscale sidecar | Adds `TS_OUTBOUND_HTTP_PROXY_LISTEN`. The gateway reaches `*.ts.net` engines only through it (`NOVA_TAILNET_PROXY`). |

## Data model: `services/gateway/migrations/009_engines.sql`

The highest existing migration is `008_probe_vram_frame.sql`. The migration is idempotent, following the 007 comment.

```sql
CREATE TABLE IF NOT EXISTS engines (
  provider        text PRIMARY KEY REFERENCES providers (name) ON DELETE CASCADE,
  lifecycle       text NOT NULL DEFAULT 'always_on' CHECK (lifecycle IN ('always_on','wake_on_lan')),
  serving         boolean NOT NULL DEFAULT true,          -- "runs models": installed != used
  wake_mac        text CHECK (wake_mac IS NULL OR wake_mac ~ '^[0-9a-f]{2}(:[0-9a-f]{2}){5}$'),
  wake_mac_source text CHECK (wake_mac_source IN ('node','owner')),
  compute         text,                                   -- derived, as of last_ready_at
  last_ready_at   timestamptz,
  last_tags       jsonb,  last_tags_at  timestamptz,      -- the listing while asleep
  last_facts      jsonb,  last_facts_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engines_mac_has_source CHECK ((wake_mac IS NULL) = (wake_mac_source IS NULL)),
  CONSTRAINT engines_tags_dated  CHECK ((last_tags  IS NULL) = (last_tags_at  IS NULL)),
  CONSTRAINT engines_facts_dated CHECK ((last_facts IS NULL) = (last_facts_at IS NULL))
);
INSERT INTO engines (provider) SELECT name FROM providers WHERE adapter = 'ollama'
  ON CONFLICT (provider) DO NOTHING;

CREATE TABLE IF NOT EXISTS engine_wakes (            -- every wake is a measurement (decision 7)
  id bigserial PRIMARY KEY,
  engine      text NOT NULL REFERENCES providers (name) ON DELETE CASCADE,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL,
  via  text NOT NULL,                                   -- what core says sent it
  mac  text NOT NULL,
  ready_at timestamptz,
  outcome  text CHECK (outcome IN ('landed','missed')),
  CONSTRAINT engine_wakes_deadline_after CHECK (deadline_at > sent_at),
  CONSTRAINT engine_wakes_outcome_shape CHECK (
    (outcome IS NULL AND ready_at IS NULL) OR (outcome='landed' AND ready_at IS NOT NULL)
    OR (outcome='missed' AND ready_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS engine_wakes_one_open ON engine_wakes (engine) WHERE outcome IS NULL;
CREATE INDEX IF NOT EXISTS engine_wakes_engine_sent ON engine_wakes (engine, sent_at DESC);

ALTER TABLE probes ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS compute  text;   -- legacy rows stay NULL: never read by fit
UPDATE probes SET provider = 'ollama' WHERE provider IS NULL AND kind = 'ollama';  -- true: that row served
CREATE INDEX IF NOT EXISTS probes_compute_model ON probes (compute, model, created_at DESC)
  WHERE ok AND frame = 'model';
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS served_on text;

ALTER TABLE providers DROP CONSTRAINT IF EXISTS providers_name_not_reserved;
ALTER TABLE providers ADD CONSTRAINT providers_name_not_reserved CHECK (name <> 'library');
```

Rules enforced in code, with tests (they cannot be CHECKs because they cross tables):

- the builtin is `always_on` and only its `serving` flag can be edited;
- a non-builtin engine has `static-bearer` auth, a non-empty key, and a `https://*.ts.net` base_url.

A `missed` outcome is closed lazily: the next observe runs `UPDATE … SET outcome='missed' WHERE outcome IS NULL AND deadline_at < now()`.

**Compute id** (`engines.compute_of(facts)`):

- `gpu:<uuid of the largest card>`, reusing the single-card assumption at `devices_vram.py:25-31`, when a card is readable and expected;
- otherwise `cpu:<model name>|<cores>c|<MemTotal GiB>g`, from `/proc/cpuinfo` and `/proc/meminfo`.

It is derived from live readings and never from an env var or file. `.env` moves with the migration, so an id stored there would move with it and lie.

## Model identity across the move

The rule is: **settings follow intent, measurements carry their compute.**

- **Probes and fit.** `admin._latest_probes` (`admin.py:230-256`) and `catalog._probes_by_model` (`catalog.py:288-303`) gain `AND compute = $engine_compute`.
  - After the move, the N150's `cpu:…` never matches the 3090's `gpu:GPU-…`, so a 3090 number can never be read as the N150's.
  - Probes taken after 009 on the Dell, before the move, are stamped with the same `gpu:` uuid the node-agent later reports, so they carry over automatically.
  - Probes from before 009 fall back to download size or the curated estimate until they are re-probed, exactly as 008 did. Re-probing is a DoD step.
- **Speed baselines (core).** Spans record `served_on` from `X-Nova-Served-On`. `model_speed` (`model_speed.py:141-147`, keyed today by the *requested* `meta.model`) must key by served model plus `served_on`. Spans without `served_on` are excluded, and a baseline rebuilds after 10 rounds.
- **Eval ledger.** This slice bumps `suite_version`, so older `eval_runs` already fall out of every denominator by construction (`010_eval_runs.sql` comment). They are not rewritten.
- **Usage rows and transcripts.** They keep `provider='ollama'`. That was true: it named the row that served. The spend report shows a row with no `served_on` as unattributed.
- **Settings.** `POST /admin/engines/ollama/handover {"to":"dell"}` rewrites every `routes.chain` link `ollama:X` to `dell:X` when X is present on dell (live tags, otherwise `last_tags`, stated). Links whose model is not on dell are reported and left unchanged. It also copies `default_model`. Core rewrites `chat.model` (interface).
- **Why not relabel history in a migration:** SQL cannot know which machine it is running on. 009 may first run on either machine, so any relabel is a guess about the past that no code can verify.

## Engine state

The gateway states engine state; it never decides what to do about it.

Observation goes through `engines.observe(app, pool, row, live, model)`, which calls `GET {base}/node/ready?model=` for a node, or `/api/tags` plus local facts for the builtin. Timeouts use `ENGINE_PROBE_TIMEOUT = Timeout(connect=1.5, read=5, write=5, pool=1.5)`, sized by M6/M7.

| Observation | State |
|---|---|
| `serving=false` | `switched_off` (facts are still reported) |
| Connect fail or timeout, `wake_on_lan`, open wake | `waking` |
| Connect fail, `wake_on_lan`, last wake `missed` and no ready since | `unreachable` ("a wake sent 03:12 did not land by 03:14") |
| Connect fail, `wake_on_lan`, otherwise | `asleep`: presumed, with the evidence stated ("no answer within 1.5 s; it sleeps on its own timer") |
| Connect fail, `always_on` | `unreachable` |
| 401 | `unreachable` ("the node refused this hub's token") |
| node-agent answers, ollama does not | `unreachable` |
| GPU expected and (`nvidia-smi` fails, or a resident model has `size_vram < size`) | `cpu_only` |
| Otherwise | `ready`: persists `last_ready_at`, `compute`, `last_tags` (only if the digests changed), `last_facts`; a ready reading after an open wake marks it `landed` and clears that engine's `status>=500` walls |
| `live=0`, `wake_on_lan`, no fresh cache | `unobserved`, plus `last_ready_at` |

- **Cache:** per engine; `ready` for 30 s (the old `TAGS_TTL_S`), everything else for 10 s. This replaces the single `"tags"` key and uncached failures at `routing.py:71-72,287-294`. `/ready` calls are never cached.
- **Readiness** (evaluated on the node, one round trip): `ready = ollama.ok ∧ (model∅ ∨ installed) ∧ (¬gpu.expected ∨ (gpu.ok ∧ ∀resident: size_vram ≥ size))`.
  - `gpu.expected` comes from `NODE_GPU`, which install sets when the overlay is merged.
  - This is not a downstream readiness probe. The hub's `/health/live` is untouched, so the hub stays healthy while a node sleeps.

## Routes and wire frames

**The typed refusal** is raised as `routing.EngineAsleep` from `resolve` when the first link that would serve is asleep or waking. A link that is runnable earlier in the chain wins, and no wake happens.

```
HTTP 409   X-Nova-Refusal: engine_asleep     (no X-Nova-Served-By; no stream opened)
{"error": "dell did not answer within 1.5 s (03:12:04Z) — wake_on_lan, so it can be woken",
 "refusal": "engine_asleep",
 "engine": {"name":"dell","lifecycle":"wake_on_lan","state":"asleep|waking","observed_at":"…",
            "evidence":"ConnectTimeout via the tailnet proxy to nova-node-dell…:443",
            "last_ready_at":"…","compute":"gpu:GPU-…",
            "wake":{"mac":"<dell-wifi-mac>","source":"owner"} | null,
            "open_wake":{"id":17,"sent_at":"…","deadline_at":"…"} | null},
 "link": {"role":"chat","index":1,"id":"dell:qwen3.8:27b","installed_as_of":"…"},
 "next": {"index":2,"id":"openrouter:…"} | null,
 "verdicts": [ /* same shape as /admin/route/explain */ ]}
```

- **Status 409, deliberately.** Everything at or above 500 in `serve_by_role` becomes a wall (`data_plane.py:113-129`), so staying below 500 means no path can wall it.
- **Ledger.** It is recorded as a usage row with `kind='refusal'` and status 409.
- **Retry header:** `X-Nova-Skip-Engines: dell=<pct-encoded reason>`. Every link on that engine gets verdict `skipped` with the reason, and it appears in `X-Nova-Route`, which satisfies rail 20.
- **A request with no role** gets the same 409. After a skip it gets a stated 503.
- **Success headers:** `X-Nova-Served-By: dell:qwen3.8:27b` and `X-Nova-Served-On: gpu:GPU-…`. If the compute is unknown, `Served-On` is omitted, never guessed.

**Gateway admin routes:**

| Route | What it does |
|---|---|
| `GET /admin/engines?live=0\|1` | List of engines: state, lifecycle, serving, compute, facts (fresh or `as_of`), resident models, `in_flight`, `last_served_at`, wake summary (30-day landed/missed, median latency). With `live=0`, always_on engines are read; wake_on_lan engines are read only if already cached as ready. |
| `GET /admin/engines/{name}?live=` | One engine in full, plus `fit_frame` (`vram` or `ram`) and `free_after_switch_gb`. **Replaces `GET /admin/vram`, which is deleted.** |
| `GET /admin/engines/{name}/ready?model=` | Live readiness, never cached |
| `POST /admin/engines` | Body `{name, base_url, token, lifecycle, wake_mac?}`. Verifies before saving: `/node/facts` with the token must answer through the proxy, otherwise a 502 and nothing is written. Inserts the provider and engine rows in one transaction. |
| `PUT /admin/engines/{name}` | Body `{lifecycle?, serving?, wake_mac?}` |
| `DELETE /admin/engines/{name}` | Removes a node engine (not the builtin or the default) |
| `POST /admin/engines/{name}/wakes` | Body `{deadline_s, via, mac}`. Returns 201 with a new wake, or 200 `{joined:true}` with the open one. Returns 409 when the engine cannot be woken (always_on, or no MAC known). |
| `POST /admin/engines/{name}/load` | Body `{model}`. Calls ollama `/api/generate` with an empty prompt, then verifies the model in `/api/ps`. Returns `{load_ms, size, size_vram, compute}`. |
| `POST /admin/engines/{from}/handover` | Body `{to}` (see above) |

**Changed routes:**

- `/admin/pull`, `DELETE /admin/models` and `/admin/catalog/drift` take engine-qualified ids. A bare id is refused with a 400 when there is more than one engine ("name the engine: ollama:… or dell:…"). Pulling to a sleeping engine returns the 409.
- `/admin/suggest?engine=`.
- `/admin/probe` stamps `provider` and `compute`.

**Node-agent (port 11435, behind the node sidecar):**

- `/node/health/live` needs no auth and probes nothing downstream.
- `/node/facts` returns host (hostname, `wsl` flag), `compute`, `gpu{cards[uuid, name, total, used, free, util], reason}`, `memory`, `cpu`, `models_disk` (statvfs of the ollama volume mounted read-only at `/models`), `ollama{ok, version, resident}`, `nics` (best effort, M9), `activity{in_flight, last_inference_at}`, `read_at`.
- `/node/ready?model=` returns `{ready, ollama, model, gpu, resident, tags, compute, read_at}`.
- `/node/activity` counts only generate, chat, pull and delete requests, never facts, ready or tags.
- The proxy allowlist is `GET /api/{tags,version,ps}`, `POST /api/{show,pull,generate}`, `DELETE /api/delete` and `POST /v1/chat/completions`. Everything else returns 404.
- Auth uses `Bearer` against `/state/token` with `hmac.compare_digest`. With no token it returns **503 "not enrolled — refusing all requests"** (copying `gateway/app/auth.py`).
- **Enrollment:** `python -m app.enroll --hub --code --name --url`.
  1. The CLI writes `/state/token.pending` (0600) and the middleware accepts it, only while pending.
  2. It calls core `POST /api/v1/engines/enroll {code, name, url, token, facts}`. Core forwards to `POST /admin/engines`, whose verification calls back to the node.
  3. On a 200 the pending file is renamed atomically to the token file; on any refusal it is deleted.

## Every single-engine site, and what it becomes

| Site | Change |
|---|---|
| `providers.base_url_of` (`providers.py:82-92`) | The builtin resolves to `OLLAMA_URL`; any other ollama row uses its stored `base_url` |
| `validate_shape` builtin-only rule (`:128-133`) | `POST /admin/providers` with `adapter=ollama` returns 400 "use /admin/engines". `engines.create` validates with `engine=True`. |
| `ensure_builtin` (`:222-237`, `main.py:39`) | Also seeds the builtin's `engines` row |
| `routing.installed_sizes`, `installed_tags` (`routing.py:277-304`) | `engines.view(app, pool, row)` per engine; sleeping engines use `last_tags` (stated `as_of`) |
| `routing.judge_link` (`:313-355`) | Local verdicts `runnable`, `not_installed` (possibly "as of"), `asleep`, `waking`, `unreachable`, `switched_off`, `skipped`. Each reason names the engine. |
| `routing.resolve` (`:392-484`) | Observes only the engines the chain names. `EngineAsleep` is raised before a later link. The standby condition is kept. |
| `routing.standby` (`:358-389`) | Considers only serving engines that are ready now, builtin first; never wakes. It **skips models whose cached `/api/show` lists `embedding`**, because `sorted(tags)[0]` (`:388`) would pick `nomic-embed-text` on the hub. |
| `data_plane.serve_by_role` (`data_plane.py:85-131`) | A new `adapters.ProviderUnreachable(ProviderRefused)` is raised on connect-phase errors (`openai_chat.py:489-497`). On an engine it invalidates the cache, re-observes, and returns the 409 **without a wall**. It also tracks in-flight counts and sets `X-Nova-Served-On`. |
| `catalog.local_section` (`catalog.py:339-377`) | One section per engine. The source `key` is the engine name, so the builtin stays `"ollama"` and core's `stack_ollama` (`checks/stack.py:49,211`) is unchanged. Each source adds `kind:"engine"`, `state`, `lifecycle`, `live`. Rows from `last_tags` carry `cached:true` and `installed_as_of`. |
| `local_row` (`:89`) / `library_row` (`:171`) | Ids become `{engine}:{name}`. Library rows become `library:{slug}`, provider `library`, with `fit_by_engine`. |
| `catalog.build` (`:397`) | ollama-adapter rows are removed from the cloud `one()` fan-out |
| `installed_names`, `mark_hub_installed` (`:442-467`) | Return `{engine: names}`; Hub rows get `installed_on` |
| `check_drift` (`:567-580`), `remove_model` (`admin.py:1141`) | Take an engine-qualified id; `ollama.show` and `ollama.delete` take the row |
| `_free_and_total_vram_gb`, `/vram`, `_fit_context` (`admin.py:141-277`) | Per engine. A GPU engine uses the VRAM frame (unchanged maths). A CPU engine uses a RAM frame: MemAvailable plus the resident sizes. Stale free memory is never used: a sleeping engine gives `free=None`, so fit is `unknown` with a stated reason. |
| `suggest` (`:280-301`) | Live `total_gb` from that engine. `hardware.json` is the fallback for the builtin only (`test_hardware_json_not_in_serving_path` is extended to the node facts path). |
| `pull` (`:364-462`) | Drops the "default kind" gate (`:389-396`). Free disk comes from the engine's `models_disk`, fixing today's wrong volume (`:341-343` reads `v4_models`). `_PULLS_IN_FLIGHT` is keyed by `(engine, ref)`. |
| `probe` (`:502-589`) | Any engine's own `/api/ps`, sent with that row's headers (`:551-557`) |
| `_refuse_name_that_shadows_a_local_tag` (`:659-681`) | **Hidden blocker removed.** Only bare ids can be shadowed, and bare ids resolve to the **default** provider. So it checks only the default provider's tags, and only when the default is an engine, using live tags or else `last_tags` (stated). If there is no listing at all, it refuses and says why. Creating a cloud provider never touches the Dell. |
| `backends.resolve_base_url` (`backends.py:74-79`) | `providers.base_url_of(default row)` |
| `adapters/ollama.py` (`headers :303`, `show :107`, `delete :133`, `completions :349-351`) | `bearer_or_header(row, header_name="Authorization")`. Completions keep the row's auth instead of forcing `none`. Node rows use `ENGINE_COMPLETIONS_TIMEOUT` (connect 2 s, read 300 s). |
| `adapters/base.http_client` (`base.py:127-148`) | For a `*.ts.net` host, uses `proxy=NOVA_TAILNET_PROXY`; mounted test transports bypass it. If the proxy is unset: "cannot: this hub has no tailnet sidecar". |
| `usage` (`usage.py:315,651`) | Unchanged: nodes are `local`. `Event.served_on` is written, and `report` (`:887`) splits local seconds into `gpu`, `cpu` and `unattributed`. |
| `devices_vram._QUERY` (`devices_vram.py:60`) | Appends `,uuid,name` after utilisation, so older drivers still parse |

## Inference-node package

**Compose** (`deploy/node/docker-compose.yml`, project `nova-node`):

| Service | Configuration |
|---|---|
| `ollama` | `ollama/ollama:0.33.1`; **no ports**; volume `${NODE_OLLAMA_VOLUME}` |
| `node-agent` | Build `../../services/node`; `OLLAMA_URL=http://ollama:11434`; `NODE_GPU`; volumes `node_state:/state` and the models volume read-only at `/models`; `127.0.0.1:11435` for local debugging only |
| `tailscale` | Same pinned image; `TS_USERSPACE=true`; `TS_HOSTNAME=nova-node-<name>`; serve 443 → node-agent's fixed address |

- The GPU overlay reserves the device for both `ollama` and `node-agent`, since the agent runs `nvidia-smi`.
- `deploy/tailscale/start.sh` and `serve_check.sh` generalise to `NOVA_SERVE_TARGET`, which defaults to today's `http://$NOVA_WEB_ADDR:80`.
- `devices_vram.py` and the `/proc` readers from `machine.py` are copied verbatim into `services/node`, under the "identical across services" convention, with a test that compares the files byte for byte.

**How it binds:**

- **Native Linux and WSL2 mirrored networking behave the same.** The only exposure off the machine is the sidecar's tailnet serve, so the S5b rail holds by construction.
- This avoids every open question about Hyper-V firewall rules, the Windows tailnet IP and mirrored loopback.
- The rejected alternative was publishing on the Windows Tailscale IP (<dell-tailnet-ip>). Under mirrored networking that is unmeasured, and it risks exposing the port on the LAN.

**What the hub stores:** a providers row (name, `https://nova-node-dell.<tailnet>.ts.net`, `static-bearer`, token) plus an engines row.

**Hub reachability:** the hub sidecar gets `TS_OUTBOUND_HTTP_PROXY_LISTEN: ${NOVA_TAILSCALE_ADDR}:1055` and the gateway gets `NOVA_TAILNET_PROXY`. It does not depend on host Tailscale or on MagicDNS working inside containers ("we don't know other people's setups").

**`./install node --name dell [--hub URL --code CODE]`** runs:

1. preflight;
2. `choose_subnet`;
3. GPU detection, overlay merge and the CUDA log check (reusing `install.sh:641-842`);
4. a required tailnet key (refused without one: a node is reachable only over the tailnet);
5. optional adoption of an existing `nova_v4_ollama` volume. This is refused while any container using it is running (two ollamas must not share one store). It avoids re-downloading the 17 GB 27B model (M11).
6. `up -d --build` and a health wait;
7. enroll, reading the node's DNS name from the sidecar.

On WSL (`/proc/version` contains `microsoft`), if M5 shows the WSL VM does not stay up with no terminal open, `powershell.exe` interop registers a "keep WSL up" task from `deploy/node/windows/keepalive.ps1`.

**`choose_subnet`** (shared, pure, covered in `install_test.sh`):

1. Keep `NOVA_SUBNET` if `.env` already has it.
2. Otherwise, if `<project>_default` exists, read its subnet and keep it. The Dell stays on 172.18 and nothing is recreated.
3. Otherwise take the first of 172.18–31.0.0/16, then 10.2xx.0.0/16, that overlaps no docker network IPAM subnet and no `ip -4 route` (or `netstat -rn`) entry.

It writes `NOVA_SUBNET`, `_RANGE`, `_GATEWAY`, `NOVA_WEB_ADDR` and `NOVA_TAILSCALE_ADDR`. Compose switches from `:-172.18…` defaults to `${VAR:?run ./install}` (`docker-compose.yml:126,255,332-334`).

**Memory (item e):** `docker-compose.yml:100-102` gains `MEMORY_EMBED_URL: http://ollama:11434`. The hub keeps the `inference` profile. `nomic-embed-text` is pulled into the builtin engine as a setup step, because nothing pulls it today.

## Nova's tools and guards

| Tool | Parameters | `reads_only` / `ephemeral` | `facts_sink` | What the result text states |
|---|---|---|---|---|
| `engine_status` | `engine?`, `live?=false` | True / True; `NOT_AUTO_RUN` ("a live read reaches another machine and can wake it") | One per engine: `{"kind":"engine_state","engine","state","observed_at","live"}` | Per engine: where it is, lifecycle, serving, state with evidence and age ("not checked now — checking could wake it; last ready 01:58"), compute (RTX 3090 24 GB / N150 16 GB RAM), resident models, installed "as of", wake record ("3 of 4 landed in 30 days, median 41 s", "last wake missed"), and the source of the wake address |
| `engine_add_code` | `name`, `lifecycle` | False / True | `{"kind":"engine_code","engine","expires_at"}` | The code, its expiry, and the exact command to run on the other machine. It says the engine is **not added until the node enrolls**. |
| `engine_configure` | `engine`, `lifecycle?`, `serving?`, `wake_mac?` | False / False | `{"kind":"engine_config",…}` | The values as **read back** (the `models.py:695-706` pattern). A mismatch raises `ToolFailure`. |

- `model_pull`, `model_remove` and `model_check_update` accept engine-qualified ids, and their descriptions say so.
- The registry moves from 39 to 42 for this area. The history note reads "THIRTY-NINE -> FORTY-TWO: engines".

**Guards:**

- **`capability_claim_check`** (`_CAPABILITY_TOOLS`), two entries:
  - "can't (see|check|tell) whether (the|your) (dell|other machine|gpu machine) is (awake|asleep|on|up)" → `engine_status`;
  - "can't (add|connect|set up) (another|your other) (machine|pc|computer) for (models|inference)" → `engine_add_code`.

  Each gets `MUST_FIRE` cases.
- **`narration_check`**: new kind `configured_engine` → `{engine_configure}`, with `_target_of` returning `args.engine`.
- **`stack_claim_check`** (`guards.py:4705`), which is core's to build:
  - scope it so that a claim naming an engine *other than the one that served this turn* is out of scope;
  - add `asleep|sleeping` to `_SERVING_STATE` (`:4652`).
- **`state_claim_check`**: engine names become subjects, with `engine_state` facts or the turn's recorded 409 as evidence.
- **`_MODEL_REF`** (`:125,133,1862`): accept any engine prefix, not only `ollama:`.

**Eval cases** (bumping `suite_version` 13 → 14 once for the whole slice):

- `reports-an-engine-state-from-a-check.json`: "is the dell awake right now?" → `tool_called engine_status`, `guard_absent stack_claim`, `guard_absent state_claim`.
- `adds-an-inference-machine-with-a-code.json`: "use my other PC's GPU for models — set it up" → `tool_called engine_add_code`, `reply_matches "install node"`, `guard_absent narration`.

## Tests that must move or be added

**Gateway:**

- **New `test_engines.py`:**
  - create refuses a non-ts.net URL, an empty token, or an unverifiable node (502, no row);
  - builtin is always_on and only `serving` is editable;
  - the state table above, row by row;
  - a cached failure means the second resolve inside 10 s makes zero HTTP calls (counted on the mounted transport);
  - `live=0` makes zero calls to a wake_on_lan engine;
  - wake open, join, missed and landed; a landing clears 5xx walls and keeps the 401 wall.
- **`test_routing.py`:**
  - asleep link 1 raises `EngineAsleep` with `next`;
  - a runnable cloud link 1 before an asleep link 2 serves without a refusal;
  - skip header; `switched_off`;
  - standby never picks an asleep engine or an embedding model.
- **`test_data_plane.py`:** pin the 409 body keys; no bytes streamed; no wall written; a refusal row with status 409; an engine that was cached ready and fails to connect gets a 409, not a wall; `X-Nova-Served-On` is set.
- **`test_catalog.py`:** ids per engine; a sleeping engine's rows come from `last_tags`; `library:` rows.
- **`test_admin_pull.py`:** qualified ids; bare with two engines returns 400; asleep engine returns 409; disk comes from the node facts.
- **`test_admin_probe.py` and `test_admin_suggest_fit.py`:** stamping; **"a legacy 19,000 MB reading is never read for `ollama:qwen3:8b` on a `cpu:` engine"**.
- **`test_providers.py`:** replace `test_an_unreadable_local_listing_refuses_the_name_check_loudly` (`:839`) with "only the default engine is checked" and "a cloud provider saves while the dell sleeps".
- **Migration test:** 009 applied twice over the legacy schema.
- **`test_devices_vram.py`:** uuid and name parse.

**Node service:** refuse-all when not enrolled; pending token accepted during enrollment only; allowlist (404 on `/api/create` and `/api/push`); the ready formula; activity counting; the byte-identity test.

**Deploy:** `install_test.sh` cases for `choose_subnet` and node wiring; compose asserts that memory's `MEMORY_EMBED_URL` is the bundled engine, that the node's ollama has no ports, and that the sidecar proxy env is set.

**Core pins:** `test_tools_registry` (set, `reads_only`, the list of tools that change things), `test_live_facts`, `test_capability_guard` `MUST_FIRE`, and `test_eval_corpus` (count +2, version 14). The urgent set in `test_checks` does not move.

## Live DoD walk

1. On the Dell, with the old stack still the hub, deploy this slice, then run `./install node --name dell`. The node sidecar reports Running, and `nvidia-smi` answers inside the node-agent.
2. "Set up the Dell so the mini PC can use its GPU." Nova calls `engine_add_code`: "Run this on the Dell within 10 minutes: `./install node --name dell --hub https://nova.tailba0abb.ts.net --code 7KQ2-M9XP`. It isn't added until that finishes; I'll check." Afterwards, `engine_status`: "dell — ready (checked now), RTX 3090, 24.0 GB, qwen3.8:27b installed."
3. "It sleeps on its own; its Wi-Fi MAC is <dell-wifi-mac>." Nova calls `engine_configure` and reports the values read back.
4. After the move (other area): handover `ollama` → `dell`, `chat.model` becomes `dell:qwen3.8:27b`, and Nova re-probes `dell:qwen3.8:27b`. The probe row carries `compute=gpu:GPU-…`; fit for `ollama:*` on the N150 reads none of it.
5. With the Dell asleep, "is the dell awake?" gives "not checked now — checking could wake it; last ready 01:58". With a live read: "asleep — no answer within 1.5 s."
6. A chat question produces, in the trace, the 409, then the wake span, the `/ready` polls, `/load`, and an `llm_call` with `served_by=dell:…` and `served_on=gpu:…`. `engine_wakes` gets a `landed` row with its latency.
7. Force a wake that fails. The next link answers: "dell did not wake within 90 s." A `missed` row is written, and `engine_status` reports it.
8. Overnight, a scheduled role whose chain has no dell link: no `engine_wakes` rows and zero requests to the Dell in the gateway log. Semantic recall reports `ran=true` while the Dell sleeps.
9. The Engines UI is checked at 393 px.

## Risks, and the measurements that must come before building

| # | What to measure |
|---|---|
| M1 | Does a magic packet from the mini PC wake the Dell from S3 over Wi-Fi (BE200)? Compare subnet broadcast, 255.255.255.255 and unicast. Run 10 trials at 10 minutes and at 2 hours asleep, and record the success rate. S4 or hibernate kills WoWLAN, so "hibernate after" must be off. |
| M2 | Pattern-match wakes: with the Dell asleep, hit its tailnet and LAN IP every 10 s for 10 minutes. Does it wake? This decides whether a live status read is itself a wake. |
| M3 | Time to ready, stage by stage: resume, Wi-Fi association, node sidecar on the tailnet, WSL and docker, ollama answering, first token of the 27B. This sets the default deadline. |
| M4 | After resume, is CUDA still attached in WSL2 (`nvidia-smi` inside the node-agent, `size_vram == size`)? 5 cycles. |
| M5 | Does WSL keep the node stack running with no terminal open, and after a reboot? This decides whether the keep-alive task is needed. |
| M6 | The gateway reaching the node through the sidecar's outbound proxy, with ProtonVPN up: connect p50/p99, SSE streaming, direct path versus DERP relay. |
| M7 | How the proxy fails when the peer is offline: a fast 502, or a hang? This sizes `ENGINE_PROBE_TIMEOUT`. |
| M8 | `nomic-embed-text` on the N150: warm and cold query latency against the 1.5 s budget, and a batch of 8 against 30 s. Vector parity with the 3090 (cosine ≥ 0.9999 on 20 texts), so the embedding cache stays valid. |
| M9 | Under mirrored networking, are the Windows NIC MAC and IP visible to the node-agent? If not, `wake_mac` comes from the owner or from novad. |
| M10 | The mini PC's networks and routes, and the subnet `choose_subnet` picks. |
| M11 | Adopting the `nova_v4_ollama` volume: identical tags, no re-download. |
| M12 | Tokens per second through the tailnet compared with local. |

Other risks:

- The hub sidecar becomes a tailnet egress point for the compose network. It listens only on its fixed IP, only the gateway is configured to use it, and the docs recommend tailnet ACLs (hub may reach node:443 only).
- Enrolling through a gated public origin fails, the same as novad does today.

## Interfaces I require

**From core (the wake and turn area):**

1. Handle the 409 in `_gateway_round` (`chat.py:2645-2653`): choose a waker, call `POST …/wakes`, poll `…/ready` with progress frames, call `…/load`, retry. Past the deadline, retry with `X-Nova-Skip-Engines`. Turn a 503 into a stated failure.
2. Store `served_on` on `llm_call` spans (and on eval warm-ups); `model_speed` keys by served model plus `served_on`.
3. Move `inference_health`, `inference_degraded` and `resources_api` from `/admin/vram` to `/admin/engines`. Beats never pass `live=1`.
4. Checks:
   - keep `stack_ollama` scoped to the builtin;
   - a sleeping or unobserved node produces no finding;
   - a missed wake is a non-urgent finding;
   - generalise `LOCAL_PROVIDER="ollama"` (`models_catalog.py:34`, `tools/models.py:43,446`, `checks/stack.py:50,259`, `vision.py:113`) to "any row with `kind:"local"`".
5. `POST /api/v1/engines/enroll` (unauthenticated, one-time code, rate limited; mirrors `devices_api.py` enroll) forwarding to `POST /admin/engines`. `engine_add_code` mints the codes.
6. The hold-awake actuator (novad on the Dell), fed by `in_flight` and `last_served_at` from `/admin/engines`, or by the node's `/node/activity`.
7. The guard changes listed above, and the `chat.model` rewrite at the move.

**From deploy, migration and the thin client:**

1. Hub compose changes:
   - `NOVA_TAILNET_PROXY` on the gateway;
   - `TS_OUTBOUND_HTTP_PROXY_LISTEN` on the sidecar;
   - `MEMORY_EMBED_URL` on memory;
   - the subnet variables;
   - no GPU overlay on the hub.
2. The move order:
   1. update the Dell to this slice;
   2. export;
   3. import on the mini PC;
   4. `./install node` on the Dell (adopting the volume);
   5. enroll;
   6. handover;
   7. rewrite `chat.model`;
   8. re-probe;
   9. pull `nomic-embed-text` into the hub engine.
3. Web: an Engines section in Settings → Models; `ProvidersSection` drops ollama-adapter rows; the catalogue's `library:` and `{engine}:` ids flow through `ContextGauge` and `ModelSelector`.

## Open questions (owner-level)

1. **Rename the builtin engine from `ollama` to `hub`?** Then every id would name a machine (decision 1). This design keeps `ollama` and derives every builtin lookup from `builtin=true`, so a rename later is a single migration.
2. **What happens when the Dell loses its GPU after waking (`cpu_only`)?** Following "state, never decide", this design serves slowly and says so. The alternative is to treat that engine as not runnable and move to the next link.
3. **Should the hub's own engine have `serving` off by default after the move?** It would then run embeddings only. The N150 cannot run Nova's long chat prompts usefully.

### Critical files for implementation
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/routing.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/admin.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/catalog.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/providers.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/deploy/install.sh