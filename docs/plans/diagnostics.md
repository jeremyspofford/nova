# Plan: the diagnostics bundle, redacted by construction (Amendment 2026-10-31-B Part 6, first bullet)

Track 3, branch `diagnostics/bundle`. The scope is the diagnostics bundle only. The integrity scrub
in Part 6 folds into Track 1's Health work, and is not built here.

The amendment asks for one-click diagnostics:
- a downloadable bundle of versions, health state, recent logs and config;
- secrets REDACTED by construction: values replaced with a fixed marker, the way Home
  Assistant's diagnostics do it;
- canary-secret tests that prove no secret pattern survives;
- a bundle created locally and NEVER sent anywhere by Nova. The person chooses what to do with
  the file.

The owner adds one more requirement: personal content is left out too.

## The rule, plainly

**Counts and states, never content; names of secrets at most, never their values.** The bundle
says *how many* memories, conversations, captured events, tasks and receipts there are, and *what
state* each part of Nova is in. It never holds:
- memory text;
- conversation or chat transcripts;
- captured screen, audio or accessibility text;
- task titles or goals, which come from the person's words;
- the person's name or address;
- any secret value.

## What the bundle is

It is one JSON document, `nova-diagnostics-<YYYY-MM-DD>-<HHMM>.json`, built in memory and
returned as the response to one request. Nova never writes it anywhere and never sends it
anywhere. It is built by `src/core/diagnostics/index.ts` (`buildDiagnostics(core, o)`), and holds
these sections:

| Section | Holds | Built from |
|---|---|---|
| `about` | Nova's version and build, instance kind, node role, platform, architecture, Node version, time zone set or not, when the bundle was made. The home path is shown as `<home>` | options and `core.mesh.role` |
| `health` | `core.health()`: every check's state and its words | the health route's own data |
| `config` | the person's settings by section, with secret-named keys and `secret://` references replaced, and the `user` section (the person's name and address) replaced by the marker | `core.profile.all()` |
| `vault` | how many secrets per kind (`connector`, `provider`, `capture`, `infra`, `network`, …), where the key lives. Never a name past its kind, never a value | `core.vault.status()` and `list()` |
| `providers` | each provider's id, class, state, where it sends data, health in words, and model; its config keys with their values replaced where secret-named | `core.providers.list()` |
| `models` | devices with hardware and runtime, roles, and installed models by name and digest; the cloud model's name and address, with its key shown only as set or not | `core.models.view()` |
| `capture` | each source's kind, device, status, its plain-words detail, and whether a key is saved; how many events there are, by kind | `core.capture.sources()` and `status()` |
| `connectors`, `devices`, `network`, `infra` | names, kinds, states, where each sends data, whether a token is saved | the modules' own views |
| `work` | ledger counts by state and by worker; memory, receipt, trigger and extension counts | `counts()` |
| `problems` | open and recent problems: when, source, message, and detail clipped to 2,000 characters | `core.log.problems()` |
| `logs` | the last 500 lines of `logs/nova.log`, with time, level, source and message only. A line's data fields are dropped, since they can carry content | the log file |
| `redaction` | the marker, the rule above, and how many values and keys were redacted | the builder itself |

## Redaction, by construction

There are three layers, in this order. They overlap, but no single layer is enough on its own.
- **The allow-list** keeps vault values out, because nothing reads them.
- **The value layer** catches a secret that a log line or a problem's detail quotes, which the
  allow-list has to include.
- **The key layer** catches a secret written into a config field.

The mutation tests in the evidence show the gaps: with the shape patterns turned off, three
planted secrets survive.

1. **Allow-list.** Each section is built from named fields of Nova's own views, not by dumping
   objects. Content-bearing fields are never read: memory, sessions, capture events, task titles
   and goals, briefs.
2. **Keys (the Home Assistant pattern).** Any key that names a secret is replaced by the fixed
   marker `**REDACTED**`, whatever its value. The pattern is the one `log.ts` uses (`key`,
   `token`, `secret`, `password`, `auth`, `cookie`, `private`, `credential`) plus `api_key` and
   `session`. Any `secret://NAME` reference is also replaced.
3. **Values (the backstop).** Before anything is returned, every string in the bundle is scrubbed.
   - **Known secrets.** Every value Nova knows as a secret is replaced wherever it appears, in
     each of its forms:
     - **The forms:** plain, case folded, base64 (both alphabets), hex and URL-encoded.
     - **Vault values:** every one, and the fields of the ones that are JSON.
     - **Environment fallbacks:** every `NOVA_SECRET_*` variable.
     - **Keys on disk:** the mesh identity's private keys, and the vault key file.
   - **Secret-shaped strings.** These are replaced by pattern:
     - `Bearer …`;
     - credentials in a URL (`//user:pass@`);
     - JWTs;
     - common token prefixes (`sk-`, `ghp_`, `xox?-`, …).

A redacted value is replaced by `**REDACTED**`. **The redaction never fails open.** If the builder
can't read the vault's values, the bundle is still built, without the value layer, and says so in
`redaction.warnings`. Layers 1 and 2 still hold.

## Local only

- The route returns the bundle as an attachment (`content-disposition`) to the person's own
  browser, at `person` access, through the console or a paired device the person uses.
- Nova has no code path that uploads it, mails it or attaches it anywhere.
- It isn't kept on disk.
- The tests check both.

## Canary coverage (`tests/core/diagnostics.test.ts` and the eval task)

A canary is planted in every place Nova keeps a secret:

| # | Where Nova keeps it | How it is planted |
|---|---|---|
| 1 | the vault, generic | `vault.put('provider/EXAMPLE_TOKEN', …)` |
| 2 | a provider's API key | `providers.configure('openai-compatible', {api_key: 'secret://…'})` with the value in the vault |
| 3 | the cloud model's key | `models.setCloud({…, api_key: 'secret://…'})` plus the vault |
| 4 | a connector token (Home Assistant) | vault `connector/home-assistant/TOKEN` |
| 5 | Gmail's saved sign-in (JSON) | vault `connector/gmail/…`, a JSON value with token fields |
| 6 | the Screenpipe API key | `capture.configure(src, {api_key})` |
| 7 | an M10d network target token | `network.createTarget` + `setToken` |
| 8 | an M10d infrastructure secret | `infra.createProject` + `setSecret` |
| 9 | a browser sign-in | vault `browser/…` |
| 10 | the backup recovery key | vault `nova/backup-key` |
| 11 | the decision service's cloud key | vault, under the name its settings use |
| 12 | an n8n callback token (shown once, stored hashed) | the token `configure('n8n', …)` returns |
| 13 | an environment fallback | `NOVA_SECRET_EXAMPLE_ENV` |
| 14 | the mesh identity's private keys | `mesh/identity.json`, read from disk |
| 15 | the vault's own key | `vault/key` |
| 16 | a secret in a log line | `log.write` with an environment-only canary in the message, and with `Bearer <canary>` |
| 17 | a secret in a problem's detail | `log.problem(…, {detail: 'token=<canary>'})` |

The test proves that none of these values survives anywhere in the bundle, in any form: plain,
case folded, base64, base64url, hex or URL-encoded.

**Personal content canaries:**
- a memory's text;
- a conversation's message (through the whole server, `createNova`);
- a captured screen item;
- a task title and goal;
- the person's name.

None of these may appear either.

**What must still be there** (so the bundle isn't simply empty):
- the version;
- every health check;
- counts that match what was planted;
- the providers by id;
- the Screenpipe source's status;
- the network target's and infra project's names;
- log lines.

**The eval task.** `safety.diagnostics-no-canary` in the REGRESSION suite. It plants the canaries
in a whole Nova, then grades the bundle. Its outcome doesn't depend on the model, like the other
safety invariants. It runs only where the core can build a bundle; the harness builds it with
`buildDiagnostics` until Track 1 wires the route.

## Files (owned)

- `src/core/diagnostics/index.ts`: the builder, the redaction, the scrub and the route function.
- `src/core/index.ts`: one additive export line, which the boundary rule needs. It is not wiring.
- `tests/core/diagnostics.test.ts`: a full core, with every secret store and the personal content.
  A whole Nova, chat included, is covered by the eval task `safety.diagnostics-no-canary`, which
  runs in `npm test`'s regression gate.
- `src/core/README.md`: one row.

## Limits, said plainly

- **The value layer knows only what Nova keeps.** A secret Nova never stored, quoted raw in a log
  line, is caught only if it is secret-shaped: Bearer, URL credentials, a JWT, a token prefix or
  `token=`. A bare random string in free text that Nova has never seen can't be told from any
  other word.
- **What stays in the bundle:**
  - Machine identifiers that aren't secrets: hostnames, IP addresses, GPU names, model names.
  - Names the person gave (a network target's, an infra project's, a provider's model). These are
    configuration, the way Home Assistant's diagnostics keep them.
  - MAC addresses and serials are redacted.
  - Problem messages and log messages are Nova's own words. Some quote what a service said; they
    pass the value layer, and a problem's detail is clipped to 2,000 characters.
- **A keychain-held vault key isn't read.** It isn't in Nova's home, and nothing in the bundle could
  carry it. A file-held key is read, and checked against.
- **Era 2's state is counts only.** Conversations, schedules and skills come from the server's
  `era2` callback (NOTES §2). Without it, they are missing, not guessed.

## NOTES for Track 1

**What this branch touched outside its own module:**
- an additive export line in `src/core/index.ts`, not wiring;
- a row in `src/core/README.md`;
- the eval task in `tests/evals/tasks/regression.ts`, the manifest, and the negative-control
  exception in `tests/acceptance/evals-regression.test.ts`.

### 1. The route (`src/core/index.ts`, `createCore`)

```ts
import { buildDiagnostics, diagnosticsRoutes } from './diagnostics/index.ts';
// in the route table, after the health route:
...diagnosticsRoutes(() => buildDiagnostics(core, { home: o.home, version: o.version, commit: self.build(), instance: o.instance, era2: () => era2Counts?.() ?? {} })),
```

`core` is the object `createCore` returns. Build it first and add the route after, or pass a
getter. That gives `GET /api/v1/diagnostics` at the default `person` access.
- **The response:** the bundle as JSON with
  `content-disposition: attachment; filename="nova-diagnostics-YYYY-MM-DD-HHMM.json"` and
  `cache-control: no-store`.
- **Nothing is kept.** It is built per request, and never stored or sent.
- **Optional test:** check through the API that it answers the console and refuses `public`.

### 2. Era 2's counts (`src/server.js`)

Hand the core a counts-only callback, the same way `core.self.attach` gets Era 2's state:

```js
core.diagnosticsEra2 = () => ({ conversations: store.list().length, schedules: runner.schedules.list().length, skills: runner.skills.installed().length });
```

Use whatever hook shape you prefer (`createCore` option, `attach`). It must return numbers
only.

### 3. Health: "Download diagnostics" (`ui/js/surfaces.js` `renderHealth`)

At the end of the Checks panel, after the version line:

```js
<p class="settings-note">A file with Nova’s versions, health, settings and recent log, for getting help. Every secret is replaced by **REDACTED**, and none of your memories, conversations or captured text is in it. Nova doesn’t send it anywhere: you choose what to do with it.</p>
<p><a class="btn small" href="/api/v1/diagnostics" download data-action="download-diagnostics">Download diagnostics</a></p>
```

- **Method:** a plain GET link is enough. The route is a GET, so it needs no `X-Nova` header.
- **On a paired phone:** a device's session cookie carries it. Check that `person` access lets the
  person's paired devices download it, or decide whether only the console should.
- **Tokens only.** Add a UI test that the link is there, and that the file it returns parses and
  contains `"marker":"**REDACTED**"`.

### 4. LEDGER

The plain-language "What changed" entry:

> **What changed (2026-10-31): a diagnostics file for getting help.**
> - **What it is:** Nova can put together one file with its versions, the state of each of its
>   parts, its settings and its recent log, to share with whoever is helping you. It is the
>   **Download diagnostics** button in Health once the button is in place.
> - **Secrets:** every password, key and token is replaced by **REDACTED** before the file is
>   made.
> - **Your own things:** your memories, conversations and captured screen or audio text are never
>   in it, only how many there are.
> - **Where it goes:** Nova never sends it anywhere. It is a file for you to keep, share or
>   delete.

The decision entry:

> **2026-10-31 (Amendment B Part 6: the diagnostics bundle).** Branch `diagnostics/bundle`, plan
> `docs/plans/diagnostics.md`.
> - **The builder:** `src/core/diagnostics/`.
> - **The rule:** counts and states, never content.
> - **Redaction,** in three layers: an allow-list, secret-named keys (Home Assistant's
>   `**REDACTED**` pattern), and every known secret value in six encodings plus secret-shaped
>   strings.
> - **Local only:** built per request, never stored, never sent.
> - **Canaries:** planted in every place Nova keeps a secret, and in personal content. None
>   survives (`tests/core/diagnostics.test.ts`, eval `safety.diagnostics-no-canary`).
> - **Not built here:** the integrity scrub, which is Track 1's Health work.
> - **Limits:** in the plan.

### 5. ROADMAP-AND-GATES and CAPABILITY-INVENTORY

- **Roadmap:** Amendment B Part 6's first bullet is delivered (the bundle). The integrity scrub
  and the disk-health signals are still open, on Track 1.
- **Inventory row:**

| Capability | Where | Verified by |
|---|---|---|
| One-click diagnostics bundle, redacted by construction (no secret, no personal content, local only) | `src/core/diagnostics/` | `tests/core/diagnostics.test.ts`, eval `safety.diagnostics-no-canary` |
