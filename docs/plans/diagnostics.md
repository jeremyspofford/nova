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

There are three layers, in this order. Each layer would be enough for the canaries on its own.
The three together are the design.

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
- `tests/core/diagnostics.test.ts`, `tests/acceptance/diagnostics.test.ts`, and the eval task.

## NOTES for Track 1

Written when the build is done; see below.
