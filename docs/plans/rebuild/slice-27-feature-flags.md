# Slice 27 — feature flags: what runs here, and how a feature grows up

Branch `slice/s27`, cut from `rebuild/v4`. The spec is committed now; the
implementation starts after S24 (threads) merges, because S24 rewrote
`chat.py`, conversations and the sidebar, which this slice also edits.

**Order:** after S24, before S25. S25 (the Inbox) is the first feature
born alpha under the workflow this slice defines.

**Behaviour-changing:** yes. Scripted skills goes dark on deploy until the
channel is moved to Beta, and that is the first step of the walk.

## Where this came from

Jeremy, 2026-09-16:

> "What I need, is that features can be toggled on and off. There will need
> to be an 'Advanced' or 'Administration' settings tab in Nova settings for
> this. It will eventually have two permission levels. 1) will need to be the
> developers who are working on nova features. Those features can be
> individually toggled or group toggles that hide an entire functionality of
> a feature including frontend, backend, containers, etc. 2) the other one
> will be the users of nova. They will be able to use the latest released
> version of Nova (which will be default and not provide any alpha or beta
> features), then they can turn on alpha or beta groups in batches."

And, once the first design was on the table:

> "it would be nice to have released features still togglable to be on or
> off … that way if we introduce a bug, we can turn the released feature
> off, work on a fix, then release the fix and turn the feature on with the
> fix deployment."

The design had already stopped at this door. `SURFACE_PRESET` is hardcoded
to `'advanced'` in `Sidebar.tsx` and `MobileNav.tsx`, "until a real
feature-flag source lands" (decisions-2026-09-15, item 9).

The workflow half answers a pattern the lane keeps paying for. Every one of
these came from work living on a branch until it was finished:

- two lanes built the same workspace delete independently (S15/S16, 09-11);
- the S23 spec was written and then could not be found on an unmerged branch
  (09-15);
- the rebuild/v4 fast-forward sat blocked behind a dirty S9 tree, and slices
  were deployed from branch commits instead of the mainline (09-07, 09-08).

## Decisions (2026-09-16)

Each was put to the owner as a question with a recommendation, and each
answer is his.

1. **Scope: the foundation first.** Later slices:
   - **B:** containers started and stopped by a switch. This needs the
     warden sidecar, the only docker-socket holder the architecture allows.
   - **C:** the engineer permission bound to people. This needs real roles.
   - **D:** declaring the rest of today's shipped features.
2. **Channels are one ladder.** Released is the default. Beta adds beta
   features. Alpha adds alpha and beta features. "Alpha without beta" is a
   combination nobody would test, so it does not exist.
3. **Until roles exist, a "Developer options" switch reveals the
   engineering controls.** It hides things and grants nothing; slice C
   binds it to an engineer permission.
4. **Nova reads and switches features when asked.** There are receipts and
   guards (see "Nova and the switches").
5. **Features merge dark and early** (see "The development workflow").
6. **Features are declared in core and applied live.** A switch takes
   effect without a restart.
7. **The registry is built for features as they are developed, not as a
   one-time list of today's app.** A new feature is declared in its slice's
   first commit. In the channel view, each in-development feature is listed
   only under its current stage, and released features are not listed at
   all. Releasing requires a changelog entry, and a test enforces that.
8. **Released features stay switchable, for engineers.** That page is the
   kill switch for a bug in something already shipped.
9. **The fix's deploy turns a killed feature back on.** Nobody has to
   remember to.
10. **Scripted skills is declared beta, not released.** S18's own close-out
    says the slice "has NOT been measured for the thing that motivated it",
    and it never had an owner gate.

## Why a flag is not an approval

The 2026-09-03 ruling stands: v4 makes no authorization decisions, and
`tests/test_no_approvals.py` is the line of code that refuses the day
someone rebuilds a gate. A feature flag does not cross that line, and this
is how it stays on the right side of it:

- **A flag removes software; it never judges a call.** When a feature is
  off, its tools are not in the registry. That is the same fact as a tool
  that was never written, and `dispatch` answers it the same way it answers
  any unknown name.
- **`dispatch`, `_run_tool` and `_dispatch_calls` are not edited.**
  `tools/__init__.py` gains no import. `test_no_approvals.py` passes
  **unedited**, and a diff of that file in this slice is a review-blocking
  defect.
- **An "off" sentence states configuration, the way `proactive_off`
  already does.** "Scripted skills is a beta feature and this instance runs
  the Released channel" is a fact. It never says she may not.
- **Nobody is asked anything.** There is no card and no pending state, and
  she can switch features herself when told to.

## What a feature is, mechanically

A feature is declared in `services/core/app/features.py`, the way settings
are declared in `SETTING_DEFS`:

```python
@dataclass(frozen=True)
class Service:
    name: str                                    # the compose service, e.g. "searxng"
    probe: Callable[[], Awaitable[str | None]]   # None = answering; words = why not

@dataclass(frozen=True)
class FeatureDef:
    key: str                  # ^[a-z][a-z0-9_]{1,39}$; stable forever, overrides are stored by it
    label: str                # "Scripted skills"
    description: str          # one plain paragraph, shown on both tabs and to her
    stage: str                # "alpha" | "beta" | "released"
    since: date               # the day it entered this stage
    group: str | None = None  # the key of the feature this one belongs to
    services: tuple[Service, ...] = ()
```

Rules, each pinned by a test:

- `group`, when set, names a declared feature, and group chains never loop.
- A member is never more mature than its group. A released member of a beta
  group would be dark on Released anyway, which only confuses.
- A group cannot be released while a member is still alpha or beta. The test
  names the member, so the fix is either to release it too or to clear its
  `group`.
- **Every feature, at any stage, controls at least one part.** A route, a
  tool, a check, a hook or a web binding all count (see "Tests"). A switch
  that turns nothing off would be a lie on the page.
- Every key a binding names is declared.

Anything not declared is core and always on: chat, auth, settings, memory,
conversations, governance, and the features system itself.

## Stages and the channel

| Stage | Means | Rank |
|---|---|---|
| `alpha` | Being built. Can break things, including chat. | 2 |
| `beta` | Its DoD has been walked on the live stack. Expect rough edges. | 1 |
| `released` | The owner said yes, the user docs are written, and there is a changelog record. | 0 |

The instance's channel is `released` (the default), `beta` or `alpha`, with
the same ranks. A feature's **channel default** is `rank(stage) <=
rank(channel)`.

## Instance state

Migration `031_features.sql` (030 is S24's):

```sql
CREATE TABLE feature_channel (
    singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    channel    text NOT NULL DEFAULT 'released'
               CHECK (channel IN ('released', 'beta', 'alpha')),
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO feature_channel (singleton) VALUES (true) ON CONFLICT DO NOTHING;

CREATE TABLE feature_overrides (
    key      text PRIMARY KEY,
    enabled  boolean NOT NULL,
    reason   text,
    kill_id  text UNIQUE CHECK (kill_id IS NULL OR kill_id ~ '^k-[0-9a-f]{6}$'),
    set_by   text NOT NULL,
    set_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (kill_id IS NULL OR (NOT enabled AND length(btrim(coalesce(reason, ''))) > 0))
);
```

There is no foreign key from `feature_overrides.key` to anything: the
declarations live in code. An override whose key is no longer declared is a
**stale override**. The API reports it separately with a remove action, and
resolution ignores it. It is never silently applied, and never silently
deleted.

Developer options is an ordinary setting: `features.developer_options`,
bool, default false, in `SETTING_DEFS`. It changes what the web app shows
and nothing else, so it writes no ledger event.

## Resolution

One pure function, `features.resolve(defs, channel, overrides) -> dict[str,
Resolution]`, walks groups before their members:

```python
@dataclass(frozen=True)
class Resolution:
    on: bool
    source: str             # "group" | "kill" | "override" | "channel"
    channel_default: bool   # what the channel alone would say
```

1. **The feature's own answer comes first.**
   - If it has an override, the override decides: `kill` when the override
     carries a `kill_id`, `override` otherwise.
   - Without one, the channel decides (`channel`).
2. **If that answer is on but its group is off, the feature is off**, with
   source `group`. An answer that is already off keeps its own source, so a
   killed member of an off group still reads as killed.

`channel_default` is always what the channel alone would say.

## Kills and fixes

- **Only switching a released feature off is a kill.** It requires a reason
  and mints `kill_id` as `k-` plus six hex characters; a collision with the
  unique index mints again. A released feature
  cannot be switched off without a reason: the API answers 400 in words,
  and her tool returns a retryable `Error:`.
- **Switching an alpha or beta feature off is a plain override**, and the
  reason is optional.
- **A fix is a `fixed` changelog record citing the kill** (see "The
  changelog"). At core startup, before the first apply,
  `features.clear_fixed_kills(pool)` deletes every override whose `kill_id`
  is cited by a `fixed` record for the same feature. It writes
  `feature.override_cleared` with actor `deploy` and the fix's summary. The
  deploy that carries the fix is what turns the feature back on.
- **A `fixed` record citing a kill this instance does not have does
  nothing.** That covers other installs, and kills already cleared.
- **An engineer can still clear a kill by hand** (for example after a false
  alarm) by setting the feature back to its channel default.

## The changelog

Changelog records are their own append-only list in code,
`services/core/app/changelog.py`. They are kept separate from the
declarations so that a feature later folded into its group, or removed,
keeps its history:

```python
@dataclass(frozen=True)
class ChangelogEntry:
    kind: str                 # "released" | "fixed"
    feature: str              # the feature key
    label: str                # the name at the time; history never reads today's registry
    on: date
    summary: str              # one or two sentences, for someone who uses Nova
    kill: str | None = None   # "fixed" only: the kill this fix clears
```

`CHANGELOG.md` at the repository root is **generated** from `ENTRIES`:
newest date first, released before fixed within a day, then by key. It is
regenerated with `cd services/core && uv run python -m app.changelog
--write`.

Pins:

- **The file must match.** `CHANGELOG.md` equals `render(ENTRIES)`, and the
  failure message prints the regenerate command. A release cannot land
  without its line.
- **Released features:**
  - every declared released feature has exactly one `released` record;
  - a `released` record for a declared feature requires that feature to be
    released.
- **Fix records:**
  - a `fixed` record has a non-empty summary;
  - its `kill` is None or matches `^k-[0-9a-f]{6}$`;
  - if its feature is declared, that feature is released.

## Enforcement in core

**The snapshot.**
- `features.apply(pool)` does three things:
  - it reads `feature_channel` and `feature_overrides` and resolves them;
  - it calls `tools.compose(frozenset(<keys that are on>))`;
  - it swaps in a new `Snapshot(channel, resolutions, overrides,
    stale_overrides, applied_at)`.
- `features.current()` returns that snapshot, and `features.is_on(key)`
  reads it.
- `apply` runs in the lifespan after migrations and `clear_fixed_kills`,
  before the sweeps and before the scheduler task starts (pinned). It runs
  again after every committed write.
- Until the first apply, the snapshot is the declarations resolved on
  Released with no overrides, which is the fresh-install answer. `REGISTRY`
  is the full declared set until then; only a test that imports the app
  without running its lifespan ever sees that.
- Core is one uvicorn process, so one in-memory snapshot is the whole truth.

**Routes.**
- `features.require(key)` is a FastAPI dependency. It answers 404 with
  `features.off_sentence(key)`, for example: "Scripted skills is a beta
  feature and this instance runs the Released channel. It is switched in
  Settings → Advanced."
- It is bound on a router (`APIRouter(dependencies=[...])`) or on a single
  route, and the dependency carries its key so the binding pin can find it.
- A write that is only partly a feature's (`PATCH /skills/{name}` with a
  `script` field) checks `features.is_on` inside the route and refuses with
  the same sentence.

**Her tools.**
- `tools/__init__.py` keeps every tool in `DECLARED`, and maps feature keys
  to tool names in `FEATURE_TOOLS`.
- `compose(on)` rebuilds `REGISTRY` in place: clear, then update,
  synchronously, so no coroutine ever sees it half built.
- A tool whose feature is off is not advertised; `dispatch` refuses it as an
  unknown tool; and the capability guard, which reads the live list, accepts
  "I can't do that" as true.

**Checks.**
- `Check` gains `feature: str | None = None`.
- In `checks._wrapped`, a check whose feature is off returns
  `CheckRun(ran=False, due=False, reason=<off sentence>)`. The digest then
  names it as not due, which is neither a gap nor quiet.

**Turn hooks.**
- Everything else a feature does runs behind `features.is_on(key)`, with a
  test per hook with the feature off.
- For Skills that means:
  - the roster line in her prompt;
  - the use ledger written at turn close (`skills.record_uses`).
- For Scripted skills: the SCRIPTED sentence and per-skill clause inside the
  roster line. With Scripted skills off, a scripted skill is listed as a
  plain skill, and the line never names `run_skill`.

**Her prompt.**
- `features.prompt_line(snapshot)` joins the volatile system prompt. It is
  None when every declared feature is on.
- Otherwise it names the channel and each feature that is off with why, and
  says the switches are in Settings → Advanced and in `set_release_channel`
  / `set_feature`.

**Agents.**
- An agent whose tool subset names a tool whose feature is off reads
  `[tool run_skill: off on this instance (Scripted skills)]`.
- It no longer reads `[tool run_skill: no longer exists]`, which would be
  false.

**No false success.**
- If `apply` raises after a write has committed, the route answers 500:
  "stored, but not applied: <reason>. Core applies it at its next start."
- The tool returns an `Error:` with the same words.

## Nova and the switches

Three tools in `services/core/app/tools/features.py`. They are core, and in
no feature. Their executors import `app.features` inside the function, the
same idiom `tools/agents.py` uses to stay out of the import cycle.

- **`list_features`** has `reads_only=True` and `result_kind="listing"`. It
  returns the channel, then one line per feature: label (key), stage,
  on/off, and why.
- **`set_release_channel(channel)`** moves the channel.
- **`set_feature(key, state, reason?)`** takes `state` in `on | off |
  default`:
  - `default` clears any override, a kill included;
  - `off` on a released feature needs `reason` and mints a kill.

Around them:

- **One writer.** Both write tools call the same `features` write functions
  the Settings API calls.
- **The receipt.** When a turn made a successful flag write, its reply ends
  with a line composed in code from those calls, whatever she wrote. For
  example: "Changed this turn: release channel Released → Beta." The
  executor records the change in `ctx.facts_sink`, so the line reads
  structured facts off the span, not prose.
- **Narration.** A new claim kind, `changed_feature`, is backed only by a
  successful write call in the same turn. "I turned on the beta channel" with
  no call is corrected. A plain state sentence ("web search is off on this
  instance") never fires.
- **Capability.** The capability guard's phrase table maps switching
  features and the channel to the two write tools, so while she holds them,
  "I can't change that" is contradicted. S12 showed that a tool missing from
  the phrase table gets disowned.
- **Eval turns.** An eval turn runs as a scratch person
  (`evals.runner.SCRATCH_PERSON_NAME`), but flags cover the whole instance.
  So both write tools return "Error: an eval turn runs in a scratch world
  with no instance of its own, so no feature was changed." This is the same
  isolation memory already has, and a fact about what can run, not a
  permission.
- **Eval cases.** A case whose predicates name a tool that is absent from
  the live registry scores **ungradeable**, with the feature named. It never
  fails.

## The ledger

Every write records a `governance_events` row in the same transaction:

| Kind | Meta |
|---|---|
| `feature.channel_set` | `from`, `to` |
| `feature.override_set` | `feature`, `on`, `reason`, `kill_id`, `was` (the resolution before) |
| `feature.override_cleared` | `feature`, `was`, `kill_id`, `fix` (the fixed record's summary, for `deploy`) |

**Actors:**
- a change made in Settings records the person's name, as `agents_api`
  does;
- a change Nova makes records `nova`, with `via: "chat"`, `turn_id` and the
  turn's `person` in meta;
- a kill cleared at startup records `deploy`.

The Governance page shows all three kinds.

## The web

**API.**
- `GET /api/v1/features` returns this body. Add `?services=1` to probe
  containers; without it, `answering` is `null` ("not checked").

  ```json
  {
    "channel": "released",
    "applied_at": "2026-09-20T14:02:11Z",
    "features": [
      {
        "key": "skills_scripted",
        "label": "Scripted skills",
        "description": "…",
        "stage": "beta",
        "since": "2026-09-12",
        "group": "skills",
        "on": false,
        "source": "channel",
        "channel_default": false,
        "override": null,
        "services": []
      }
    ],
    "stale_overrides": []
  }
  ```

  - `override` is `{"on", "reason", "kill_id", "set_by", "set_at"}` or
    null.
  - Each entry in `services` is `{"name", "answering", "reason"}`.
- `PUT /api/v1/features/channel` takes `{"channel": "beta"}` and returns the
  GET body.
- `PUT /api/v1/features/{key}/switch` takes `{"state": "on" | "off" |
  "default", "reason"?}` and returns the GET body.
  - An unknown key is a stated 404.
  - A released `off` without a reason is a stated 400.

**Store.**
- `stores/features-store.tsx` holds `FeaturesProvider` and `useFeatures()`,
  which exposes `{ ready, error, features, channel, isOn(key), refresh }`.
- The provider sits in the signed-in branch of `Gate`, around
  `ChatProvider`.
- It refreshes:
  - every 30 s while the tab is visible;
  - after its own writes;
  - when a chat turn's activity frames include `set_feature` or
    `set_release_channel`. So when she switches something in chat, the nav
    follows as her reply lands.
- **While loading:** `isOn` is false, gated nav entries are hidden, and a
  gated route shows a skeleton, never the off panel. Nothing is claimed
  either way.
- **When the read fails:** the app layout shows one line, "Could not read
  which features are on: <reason>", and a gated route shows the same reason.

**Nav, pages and parts.**
- `NavItem` gains `feature?: string`, filtered in `sidebarFilter.ts`. The
  mobile nav is built from `navSections`, so one binding hides an entry on
  desktop and phone alike.
- `presetVisibility` / `SurfacePreset` are left as they are: they belong to
  the mobile discussion, and `feature` sits beside them.
- `<FeatureRoute feature="…">` renders the page, or the off panel. The panel
  says "<Label> is turned off on this instance", gives why (the channel, the
  group, the override reason, or the kill and its id), and links to where it
  is switched.
- `<FeatureGate feature="…">` removes a part inside a page: the Script
  panel, or the Models page's link to measured results.

**Settings → Advanced** (tab `advanced`). Visible to anyone who can open
Settings.

- **The channel ladder.** Three choices, with their risk in words:
  - *Released* — only what has been released; the default;
  - *Beta* — adds features that work and have been walked on a real
    instance but are not released; expect rough edges;
  - *Alpha* — adds features still being built; they can break things,
    chat included; for people working on Nova.
- **What each choice adds.** Beta lists only beta-stage features and Alpha
  lists only alpha-stage features, each with its one-line description.
  Released features are not listed anywhere on this tab.
- **The divergence notice.** When any override or kill exists, a notice
  lists what differs from the channel and why. It is visible even with
  Developer options off; hiding the controls never hides a divergence.
- **The Developer options switch.**

**Settings → Feature flags** (tab `flags`, `requires: 'developer_options'`).

- **Where it appears.** The tab strip shows it only when Developer options
  is on. A bookmark to `/settings/flags` while it is off shows "Feature flags
  are shown when Developer options is on — Settings → Advanced". It never
  silently opens General.
- **Active kills come first.** Each shows the label, reason, who, when, and
  the kill id with a copy button, plus the instruction: cite this id in the
  fix's `fixed` record.
- **Three sections: Released, Beta, Alpha.** Members of a group sit
  indented under it when they share its stage. A member at a different stage
  is listed under its own stage, marked "in <Group>".
- **Each row** shows the stage, "since <date> (N days)", on/off and why, a
  three-way control (Channel default / On / Off), the description, and any
  containers. Choosing Off on a released feature asks for the reason, then
  shows the minted kill id.
- **Stale overrides** are listed last, each with a remove button.

**Phone.** Both tabs are rendered and checked at 393px wide; that is part
of done for anything touching `apps/web` (decisions-2026-09-15, item 9).

## Containers

- **Declaring them.** A feature lists the compose services it uses, and a
  test checks each name against `deploy/docker-compose.yml`.
- **What core can say.** Core holds no docker socket (rail 11), so it
  reports only what it can prove: whether the service answers. That reads
  "searxng: answering" or "not answering (connection refused)", never
  "running" or "stopped".
- **How it asks.** Each `Service.probe` is one request bounded at 2 s, and
  the probes run concurrently. They run only when a caller passes
  `?services=1`, so the 30 s poll never probes. For searxng the probe is a
  GET of the same base URL the `web_search` tool uses (`SEARXNG_URL`).
- **Off but still up.** A feature that is off while its service still
  answers says so on its row, and adds that stopping containers from here
  arrives with slice B.

## The first features

These are declared and fully bound in this slice. Every other shipped
feature stays unflagged until slice D.

| Feature | Key | Stage | Since | Parts |
|---|---|---|---|---|
| Web search | `web_search` | released | 2026-08-30 | tool `web_search`; service `searxng` |
| AI Quality | `quality` | released | 2026-08-31 | `evals_api` router; `/quality` nav entry and route; the Models page's measured-results link |
| Skills | `skills` | released | 2026-09-11 | `skills_api` router; `/skills` nav entry and route; tool `load_skill`; the roster line; `skills.record_uses` at turn close; the `skills` check family |
| Scripted skills | `skills_scripted` (group `skills`) | beta | 2026-09-12 | tool `run_skill`; `POST /skills/{name}/script/draft`; the `script` field of `PATCH /skills/{name}`; the roster's scripted sentence and clause; the Script panel |

The three released features get `released` changelog records dated from
their ship commits (a2b2274e, dca4559e, d6454eb3). They shipped before this
system existed, and the records say so in their summaries.

## The development workflow

The full workflow is written to `docs/plans/rebuild/feature-workflow.md`.
The rules that bind every session are added to `CLAUDE.md`.

1. **Declare first.** A slice's first commit declares its feature as alpha
   and wires its first part; the test refuses a feature that controls
   nothing. A change to how an existing feature behaves gets its own member
   feature, so the old behaviour stays the default until the member is
   promoted.
2. **Merge dark.** The slice branch merges to `rebuild/v4` whenever its
   suites are green, finished or not. Engineer instances (the live stack)
   run Alpha, so merged work is live and walked there. Released and Beta
   installs never see it.
3. **Rules for dark code.** A flag hides behaviour, not schema, so:
   - migrations are additive and harmless with the feature off, because
     they run on every channel;
   - a dark feature changes a released feature only through its own member
     flag;
   - a dark feature's container goes behind a compose profile named after
     it.
4. **Alpha → beta.** The feature's DoD has been walked on the live stack.
   The commit changes `stage` and `since`, and names the evidence (turn
   ids, spans).
5. **Beta → released.** This needs the owner's explicit yes, the user docs
   updated, and a `released` changelog record; the test refuses a released
   feature without one.
6. **A bug in a released feature.** Kill it, with a reason, and note the
   id. Commit the fix with a `fixed` record citing the id. The deploy clears
   the kill.
7. **Age is shown, not enforced.** The page says "alpha since 09-20 (12
   days)". No test fails because of the date.

## Tests

**Pure:**
- the resolution truth table: channel × stage × override × kill × group;
- kill clearing: only a `fixed` record for the same feature and id clears;
- declaration rules: key format, groups exist and never loop, member
  maturity, group release, and changelog pins.

**Binding pins:**
- every declared feature binds at least one part, and every bound key is
  declared. Bindings are collected from:
  - route dependencies on `app.routes`;
  - `FEATURE_TOOLS`;
  - `Check.feature`;
  - `features.is_on("<key>")` calls, found by AST over `app/`;
  - `feature="<key>"`, `feature: '<key>'` and `isOn('<key>')` in
    `apps/web/src`;
- every `Service.name` exists in `deploy/docker-compose.yml`
  (`tests/test_traces.py` already reads that file);
- the lifespan awaits `clear_fixed_kills`, then `apply`, before it creates
  the scheduler task (AST).

**Database:**
- GET, both PUTs, 404/400 in words, and stale overrides;
- each write and its ledger event commit or roll back together;
- `apply` after a write, and "stored, but not applied" when apply raises;
- startup clearing, with its `deploy` ledger row.

**Registry:**
- `compose` removes a feature's tools and restores them;
- `test_tools_registry` pins `DECLARED` names (+3 new tools, a deliberate
  move);
- `test_no_approvals.py` passes and is not in the diff.

**Checks:** a check whose feature is off is not due, with the reason, and
`quiet()` still tells the truth.

**Hooks:** each Skills and Scripted skills hook, with the feature off.

**Nova's tools:**
- the three tools;
- the receipt line;
- the `changed_feature` narration kind: fires with no call; silent on a
  state sentence; silent with a call;
- the capability phrases;
- the eval-turn refusal;
- ungradeable cases.

**Web (vitest):**
- the store: loading, error, refresh on her frames;
- nav filtering on both surfaces;
- `FeatureRoute`, `FeatureGate`;
- both tabs: the ladder lists by stage only, the divergence notice with
  Developer options off, kills first, the reason prompt and kill id,
  the bookmarked `flags` tab while off.

**Rendered:** both tabs at 393px in the Playwright image.

## Definition of done (walked, not tested)

On the live stack, in a real browser and a real chat:

1. **Deploy.**
   - Settings → Advanced shows Released, and the Beta choice lists
     Scripted skills.
   - The Skills page has no Script panel.
   - Asked to run a scripted skill, she says Scripted skills is off and why,
     and the trace shows `run_skill` was not in her tools.
2. **Switch to Beta.** The Script panel returns, and she runs a scripted
   skill; each step is a span.
3. **Kill Web search.** Turn Developer options on, then kill Web search
   with a reason on the Feature flags tab.
   - The row shows the kill id and "searxng: answering".
   - Asked to search the web, she says web search is off and why.
   - The Governance page shows the kill with its reason.
4. **Deploy the fix.** Build a walk-only commit, never merged, that adds a
   `fixed` record citing that kill id, and deploy core from it. Web search is
   back on, and the ledger shows `override_cleared` by `deploy` with the fix
   summary. Then redeploy from the slice head.
5. **Kill the Skills group.** It is released, so the page asks for a reason.
   - Skills leaves the nav on desktop and at 393px.
   - `/skills` shows the off panel, and the skills API answers 404 with the
     reason.
   - The next watch beat names the skills check "not due" with the reason.
6. **Ask her in chat to turn Skills back on.**
   - `set_feature` runs.
   - Her reply ends with the receipt line.
   - The nav returns as the reply lands.
   - The ledger names `nova` and the turn.
7. **Check Governance, then switch to Alpha.**
   - Governance lists every change above and who made it.
   - The live stack's channel is set to Alpha, and stays there: engineer
     instances run Alpha.

## Not in this slice

- Starting and stopping containers from a switch (B).
- The engineer permission bound to people (C). The web's role list
  (guest/viewer/member/admin/owner) does not match core's people roles
  (owner/adult/kid/guest), and C resolves that too.
- Declaring the rest of today's shipped features (D).
- Kills that ship to other installs in code. Every install is the owner's
  today.
- Any remote or central flag service. Flags never leave the box.
- Per-person flags, percentage rollouts, experiments.
- An eval case that switches flags. Flags cover the whole instance, and
  eval isolation is per person.
- An in-app changelog viewer (S16's updater).

## Coordination

- **Another session's tree.** `.worktrees/v4` (on `slice/s24`) holds
  another session's uncommitted edits to `Sidebar.tsx`, `AppLayout.tsx`,
  `color-palettes.ts` and `theme-store.tsx`. This slice edits the first two,
  so it merges after that work lands. It never builds or deploys from that
  tree; images come from this branch's commits (`git archive
  HEAD:<dir> | docker build`).
- **Migrations.** The slice uses 031. If S24 has not merged when
  implementation starts, the gap stays; gaps are permanent by the migration
  rules.
