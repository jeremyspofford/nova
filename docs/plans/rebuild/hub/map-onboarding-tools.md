## A. Onboarding wizard and Settings

**Steps, in order.** The order is fixed in `apps/web/src/pages/onboarding/steps.ts:25-34`: welcome, account, timezone, hardware, engine, model, downloading, ready.
- The account and timezone steps only appear on a fresh instance (`steps.ts:56,61`).
- The downloading step is dropped when the engine is `remote` or `cloud` (`steps.ts:64`).
- A run on an instance that already has an owner starts at hardware (`steps.ts:74-76`).
- Welcome's Skip button jumps straight to ready (`OnboardingWizard.tsx:127`).

**There is no local/cloud/hybrid mode choice.** The engine choice is `'ollama' | 'remote' | 'cloud'` (`apps/web/src/lib/api.ts:17`, `services/gateway/app/backends.py:20`). "Hybrid" only exists as the gateway's per-role routing chains (Settings → Models → RoutingSection), not as a wizard step.

**Backend route behind each step.** The browser only ever talks to core. Core forwards 1:1 to the gateway (`services/core/app/proxies.py:1-7`, `_forward` at `:87-107`).

| Step | Web call | Core route | Gateway route |
|---|---|---|---|
| account | `register` (`CreateAccount.tsx:28`) | `POST /api/v1/auth/register` (`api.ts:94`) | — |
| timezone | `putSetting('nova.timezone')` (`Timezone.tsx:39`) | `PUT /api/v1/settings` (`settings_store.py:287`) | — |
| hardware | `getHardware` (`api.ts:164`) | `/api/v1/system/hardware` (`proxies.py:110`) | `/admin/hardware`, which serves install.sh's `hardware.json` (`admin.py:45-57,102`) |
| engine | `getBackend`/`putBackend` (`ChooseEngine.tsx:62,90`) | `/api/v1/inference/backend` (`proxies.py:239,254`) | `GET/PUT /admin/backend`: checks the backend is live, then saves (`admin.py:592-612`) |
| model | `getSuggestion`, `putSetting('chat.model')` (`PickModel.tsx:54`) | `/api/v1/models/suggest` (`proxies.py:115`) | `/admin/suggest` |
| downloading | `pullModel`, `putSetting('chat.model')` (`Downloading.tsx:53,86`) | `POST /api/v1/models/pull` (`proxies.py:310`) | `/admin/pull` |
| ready | `streamChat` greeting, then `putSetting('onboarding.completed', true)` (`Ready.tsx:55,76`) | chat and settings | — |

**How the engine choice maps onto providers:**
- `PUT /admin/backend` is a legacy view over the `providers` table (`backends.py:1-10`).
- For `kind=ollama`, the URL always comes from the gateway container's `OLLAMA_URL` environment variable, never from a stored column (`backends.py:74-79`, `providers.py:82-91`). In compose it is set to `http://ollama:11434` (`deploy/docker-compose.yml:79`).
- The `ollama` adapter is only allowed on the built-in row. A remote ollama has to be added with `adapter=openai-chat` (`providers.py:128-132`), and then pull, VRAM and resident-model reads do not apply to it.
- **Consequence for the hub:** pointing the hub at the Dell today means changing an environment variable and restarting the gateway. It is not a setting.

**Re-running onboarding works.** Settings → Models has a "Re-run setup" button (`ModelsSection.tsx:566-584`). It writes `onboarding.completed=false` and refreshes (`SettingsPage.tsx:114-124`). The App gate then shows the wizard (`App.tsx:229-250`), which resumes at hardware.

**Settings tabs.** Defined in `apps/web/src/pages/settings/tabs.ts:20-46`: general, appearance, models, behaviour, devices. Sections per tab (`SettingsPage.tsx:184-256`):
- general: `GeneralSection` (timezone) and `AccountSection`
- appearance: `AppearanceSection` and `DisplayDiagnostics`
- models: `ModelsSection` (includes the active-backend card and Re-run), `ProvidersSection`, `RoutingSection`
- behaviour: `ProactiveSection` and `ResponseQualitySection`
- devices: `DevicesSection`

There is no inference-host or topology section.

**The setting registry** (`services/core/app/settings_store.py`):
- `SettingDef(key, type, default, description, validate)` at `:28-37`. The `validate` hook returns a problem string or `None`. Examples: `_timezone_problem` (`:40-49`), `_digest_at_problem` (`:52-66`).
- All definitions live in the `SETTING_DEFS` tuple at `:91-228`.
- Only `bool`, `str` and `int` types exist (`:234`). There is no list or dict type, so a host config (MAC, IP, broadcast address, URL) would need several string keys or a new type.
- `validated()` refuses unknown keys by name, then checks the type, then runs `validate` (`:242-262`).
- Values are stored in the `settings` table, upserted as jsonb (`:305-312`). Reads go through `read_value` / `read_values` (`:265-278`).
- `write_setting` has a side-effect hook: `beats.retimes_the_digest()` re-times the digest when a relevant key changes (`:319-327`). This is the pattern to copy for "reconfigure on write".
- The full key set is pinned in `services/core/tests/test_settings.py:~35-55` (`KNOWN_KEYS`, asserted at `:67`), so a new key must be added there.

**How a setting reaches the gateway.** The gateway keeps no settings (`proxies.py:67-74`). The only setting core passes along is the timezone, sent as the `X-Nova-Timezone` header (`peers.py:74`, read at `gateway/usage.py:55`). Everything else the gateway knows is in its own database (providers, routes, caps) or its environment (`OLLAMA_URL`). **There is no path today for a core setting to change where the gateway sends inference.** It would need either a gateway admin route that core calls on write, or a new provider-row field.

## B. Tools and honesty guards

**What a tool is** (`services/core/app/tools/base.py:120-173`). The fields are:
- `name`, `description`, `parameters` (JSON Schema), `executor(args, ctx) -> str`
- `ephemeral` (don't ingest the turn into memory)
- `result_kind` (e.g. `RESULT_KIND_LISTING`, `:28`)
- `reads_only` (a fact about the tool, not a gate; `:138-158`)
- `reports_spend`

**There is no `precheck` field** (it doesn't appear anywhere under `services/core/app`). There is also no `progress` field on the tool itself. Progress is `ToolContext.progress` (`:103`), used for example by `model_pull` at `tools/models.py:588`. `ToolContext.facts_sink` (`:76-92,92`) is how a failed call still reports a fact it established, such as `{"device","connected"}`.
- Failures: raise `ToolFailure`, and dispatch turns it into `Error: …` (`tools/__init__.py:280-281`).

**Registry.** `REGISTRY` is built from each module's `TOOLS` tuple (`tools/__init__.py:38-54,80-111`). Adding a tool means adding a `*module.TOOLS` line there.

**How a tool calls the gateway.** Two existing tools show the pattern:
- `inference_health` (`tools/inference.py:132-156`): `peers.client(ctx.app, peers.GATEWAY, TIMEOUT)`, then GET `/admin/vram`. Transport errors and `PeerUnconfigured` become a `ToolFailure` (`:136-144`).
- `route_explain` (`tools/route.py:56-87`): the same pattern, and it quotes the gateway's own error message on non-200 (`:77-82`).
- `tools/models.py` has a `_gateway` helper (`:62`) and `_send` (`:505`). It also shows how a tool writes a setting and reads it back: `settings_store.write_setting(...)`, then `read_value`, then `ToolFailure` if the value doesn't match (`models.py:695-706`). That is the pattern for a `set_inference_host` tool.
- **No tool can write arbitrary settings.** The only setting write from a tool is `chat.model`, via `model_pull`'s `set_as_chat_model` option.

**Tests that pin the tool registry:**
- `services/core/tests/test_tools_registry.py:115-185`: exact set equality over 39 names, with a history comment at `:72-114` (the convention is to add a "THIRTY-NINE -> N" note).
- `:501-547`: exact set of `reads_only` tools.
- `:550-571`: named tools that change things.
- `services/core/tests/test_live_facts.py:33-46`: every `reads_only` tool must be listed in either `live_facts.AUTO_RUN` (`live_facts.py:81-111`) or `NOT_AUTO_RUN` with a reason (`:115-125`).
- The system prompt names tools and has usage sentences (`chat.py:814-844`). Adding a guidance sentence for a new tool goes there.

**Guards** (`services/core/app/guards.py`; called from `chat.py:4256-4410`):
- **narration_check** (`:909-935`) checks completed-action claims. The claim kinds are in `_KIND_TOOLS` (`:66-74`): wrote_file, read_file, deleted_file, file_contents, fetched_url, pulled_model, removed_model. `stated_spend` is derived from `reports_spend` (`:77-96`). Target extraction per tool is in `_target_of` (`:870-890`). **There is no claim kind for "I woke X" or "I switched the inference host"**; one would need a new regex, a `_KIND_TOOLS` entry and a `_target_of` branch.
- **capability_claim_check** (`:1510`) uses the `_CAPABILITY_TOOLS` phrase table (`:1188-1364`). It only fires when the matching tool is in `available_tools`. There are no entries for `inference_health`, `route_explain`, or waking/switching hosts. A new tool needs a phrase entry plus `MUST_FIRE` cases in `services/core/tests/test_capability_guard.py:36-80`.
- **Deferral and offer classes** (`_OFFER_CLASSES`, `:1920-1928`). `_CHECK_DEVICE` (`:1832-1858`) matches GPU/VRAM wording, but its tools are only `device_info` and `device_run`. `inference_health` is not in that tuple. A "wake the Dell" instruction would need its own `_ActionClass`.
- **state_claim_check** (`:2344-2569`) guards claims about live device state. It only applies to paired device names and "the device", and only `device_*` spans or a `connected` fact in `facts_sink` count as evidence (`:2417,2511-2543`). If the Dell were paired as a novad device, "the Dell is offline" would already be covered. For a host that isn't a paired device, it doesn't apply.
- **stack_claim_check** (`:4616-4727`) is the main conflict with a sleeping GPU host. It fires on present-tense "ollama / inference / backend / gateway … offline / down / unreachable" whenever this turn's chat model answered (`:4646-4670,4687-4702`). It ignores tool evidence entirely. In the hub setup, a cloud or hub-local model could honestly say "ollama on the Dell is offline" after a status tool reported it, and the guard would wrongly correct it (the correction text is at `:4637-4641`). A carve-out is needed, backed by a status tool's `facts_sink` fact, in the same way state_claim uses `_determined_connectivity`.

**Eval corpus:**
- Cases are JSON files in `services/core/app/evals/cases/` (23 files), in the format documented at `evals/cases.py:17-39`.
- Predicates are listed in `KNOWN_PREDICATES` (`:55-65`): `tool_called`, `tool_succeeded`, `tool_not_called`, `guard_fired`, `guard_absent`, `reply_matches`, `reply_absent`. Example case: `does-not-report-a-passed-outage-as-current.json` (`suite_version` 13, uses `tool_called` and `guard_absent: stack_claim`).
- Pins in `services/core/tests/test_eval_corpus.py`: count is 23 (`:376-377`), `suite_version=={13}` (`:382`) and again at `:423`. The convention in the version history at `:188-230` is that adding a case bumps every file to 14 and adds a note to that history.
- **Evals call the real tools.** `evals/runner.py:1-60` replays through `chat._run_turn`, with only person and agent isolation. An eval case that wakes the host would really send the packet. There is no fixture for host state.

**S11 proactive checks** (`services/core/app/checks/__init__.py`):
- A `Check` has `name`, `describe`, `urgent`, `run`, `deadline_s` (`:121-139`). Urgency is set by the check and copied onto each finding (`:295-316`).
- Families are registered at `:391-410`: stack, work, money, review, skills, inference.
- `test_checks.py:220-237` pins the urgent set to exactly `stack.NAMES`.
- **Ollama reachability is already checked, and urgently.** `stack_ollama` (`checks/stack.py:218-241`, `urgent=True` at `:347-350`) reads the gateway catalogue's ollama source entry. `stack_chat_model` (`:264-331`, urgent) is related. If `OLLAMA_URL` points at a Dell that is asleep on purpose, these would send urgent 3am pushes. The check needs to know "asleep and wakeable" rather than "down".
- `inference_degraded` (`checks/inference.py:270-280`, `urgent=False`) reads GPU and speed data from the gateway's `/admin/vram`.

**The GPU readers assume the card is on the gateway's machine.** `/admin/vram` runs `nvidia-smi` inside the gateway container (`gateway/app/devices_vram.py:1-4`, `admin.py:188`). On a mini-PC hub with no GPU, `inference_health` and `inference_degraded` would only report "unreadable". The hardware step's `hardware.json` would also describe the mini PC, not the Dell.

**Wake-on-LAN and inference-host support do not exist.** A grep for wake/WoL/magic packet/inference_host/gpu_host across services, apps, deploy and install turns up nothing relevant.

## How to add inference_host_status / wake_inference_host / set_inference_host (derived from the above)

1. **New module** `tools/inference_host.py` with a `TOOLS` tuple, registered in `tools/__init__.py:80-111`.
   - The status tool: `reads_only=True`, `ephemeral=True`, and add it to `AUTO_RUN` or `NOT_AUTO_RUN` with a reason. It should append `{"host", "awake"}` to `ctx.facts_sink`.
   - The wake and set tools are not `reads_only`. Wake should report progress through `ctx.progress` while it polls for the host to come up.
2. **Settings.** Add string keys such as `inference.host_url`, `inference.host_mac` and `inference.wol_broadcast` with `validate` hooks. Update `KNOWN_KEYS` in `test_settings.py`. If the gateway needs a new admin route (e.g. `PUT /admin/ollama-url`), add the call inside `write_setting`, as the digest re-time does.
3. **Guards.**
   - Add `_CAPABILITY_TOOLS` entries for "wake the machine / switch the inference host".
   - Add a narration kind `woke_host` backed by the wake tool.
   - Give `stack_claim_check` an exemption when a status span established that the host is asleep.
   - Consider an `_ActionClass` for "wake the GPU box".
4. **Tests and evals.**
   - Update `test_tools_registry.py`: set 39 → 42, the `reads_only` pin, and the changes list.
   - Add a case, e.g. "is the dell up?" with `tool_called: inference_host_status` and `guard_absent: stack_claim`. Bump all 24 files to `suite_version` 14 and change the pins at `test_eval_corpus.py:376,382,423`.
5. **Proactive check.** Either make `stack_ollama` aware of hosts that are meant to sleep, or add a non-urgent `inference_host` check family. Adding any urgent check reddens `test_checks.py:220`.
6. **Chat walkthrough.** There are no built-in skills; skills are drafted from traces (`skills.py:1-37`). A guided setup would come from tool descriptions plus a guidance sentence in the system prompt (`chat.py:814-844`), and the status tool driving each step.