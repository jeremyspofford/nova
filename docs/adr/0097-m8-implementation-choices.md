---
status: accepted
date: 2026-10-19
supersedes: ADR-027 (i18next; D9 uses the platform's Intl)
extends: ADR-009 (Ed25519), ADR-019 (telemetry off by default), ADR-049 (signed community catalog), ADR-066 (MCP Apps), ADR-068 (hooks trusted by hash), ADR-075 (integration hygiene), ADR-078 (managed policy channels), ADR-091 (M4), ADR-095 (M7)
amends: `contracts/hub-api.md` §1 (third-party apps sign in with OAuth 2.0 code + PKCE instead of the device-code rows; new public routes; the route classification replaces the hand-kept owner list), `docs/12` §10 (the file is `managed-settings.json` with the format of `contracts/schemas/managed-settings.json`), `docs/16` §1 (OTLP over HTTP with JSON only and one content switch), `contracts/schemas/hook-config.json` (an `mcp_tool` handler may name an extension's hook tool) and `tool-descriptor.json` (`ext:` tools); closes R-032
---

## Context
M8 (Extensibility, Enterprise & Data Controls) built the extension SDK and the `nova` command
(FR-117, FR-044), the marketplace with signatures and permission diffs (FR-049), managed policy
(FR-106), data export, delete-all, import and retention (FR-105), spend caps and provider limits
(FR-116, FR-115), crash reports (FR-121), third-party app authorization (FR-222) and OTLP export
(FR-223), and carried in Telegram files and email OAuth (FR-110), the removed-member purge and member
mode (FR-217), device MCP resources and prompts, and the route classification that closes R-032.
It also built localization and right-to-left layout (FR-016, D9), the accessibility audit with its
fixes and a WCAG 2.2 conformance statement (FR-015), saved themes applied in full (FR-011) and the
spaces and sites carry-ins (page order and restore, a site's source preview, remote hosting targets;
FR-036, FR-037).

The lead fixed nine cross-area decisions before the build (D1-D9 below; where they and the spec
disagreed, they won). The builders recorded the choices the spec left open, and three security
reviews (access, data and policy, supply chain) found defects that were fixed before this ADR; their
outcomes are under "Security reviews". Code cites the sections as "ADR-097 D<n>". The details are in
`docs/14` §1.3, §2, §4-§7, `docs/26`, `docs/08` §3, §4.1, §7, `docs/12` §5, §7, §9, §10, §15,
`docs/16` §1, `docs/13` §4, §7, `docs/04` §1, §2.14-§2.16, §4.5-§4.6, `contracts/hub-api.md` §1,
`contracts/events.md` and the new schemas `extension-manifest.json`, `extension-signature.json`,
`catalog-index.json`, `catalog-signature.json`, `managed-settings.json` and `export-manifest.json`;
the entry in [`../20-decisions-and-defaults.md`](../20-decisions-and-defaults.md) links here.

## Decision

### D1. One `nova` command (FR-117, FR-044, FR-105)
1. **One workspace, one binary.** `packages/cli` (`@nova/cli`, bin `nova`, AGPL-3.0-or-later
   because it imports `@nova/core`) holds every subcommand: `nova init <dir>` (a new extension from
   the SDK's sample), `nova validate <folder|bundle>`, `nova pack <folder> [--key] [--unsigned]`,
   `nova keys generate|show`, `nova dev <folder> [--once] [--trust-hooks]`, `nova mcp stdio` (the
   existing launcher; this closes the M7 "no `nova` command" gap of FR-044) and
   `nova data export|import` (data controls, D5). Each subcommand is a function of its arguments and
   an I/O object, so tests run it in-process. Exit codes: 0, 1 (failure), 2 (usage).
2. **Credentials never on the command line.** The CLI reaches a Hub with `NOVA_URL` and
   `NOVA_TOKEN` (`NOVA_MCP_*` for the launcher, `NOVA_EXPORT_PASSPHRASE` or `--passphrase-file` for
   a passphrase; `--passphrase` is refused). `NOVA_URL` must be https, or http only to this machine.
3. **The publisher key** is Ed25519 in a PKCS#8 PEM file, by default
   `~/.config/nova/publisher-key` (`$XDG_CONFIG_HOME`, `%APPDATA%\Nova` on Windows,
   `NOVA_PUBLISHER_KEY` to override), folder 0700 and file 0600, never written under a folder with
   `.git` above it; `keys generate` refuses to overwrite without `--force`.
4. **Packing refuses secrets.** `validate`, `pack` and `dev` refuse a folder holding `.env` files
   (other than `.example`, `.sample`, `.template`) or a PEM private key, and leave out `.git` and
   `node_modules`. Packing is reproducible: sorted entries, fixed timestamps.
5. **`nova dev`** packs the folder unsigned and posts it to `POST /api/v1/extensions/dev` with the
   sideload confirmation, then watches the folder (300 ms debounce) and reloads on every change. A
   dev load is always Unverified, so a Hub that forbids unverified installs refuses it.

### D2. Extension bundles and signatures (FR-117, FR-049)
6. **`.novax`** is a zip of the extension folder (the M4 plugin format plus
   `.nova-plugin/extension.json`, [`extension-manifest.json`](../../contracts/schemas/extension-manifest.json))
   and `META-INF/nova-signature.json` `{v: 1, publisher, digest, signature}`
   ([`extension-signature.json`](../../contracts/schemas/extension-signature.json)). The **D2
   digest** is SHA-256 over the sorted `"<path>\n<sha256 of the bytes>\n"` lines of every other
   entry; the signature is Ed25519 over `"nova-extension-v1\n" + digest`. Keys travel as base64url
   of the raw 32 bytes; a fingerprint is the first 16 hex digits of the key's SHA-256. Bundles are
   read with the shared zip reader (`documents/zip.ts`): reading never runs anything.
7. **Verdicts.** A signature that does not match the files is `invalid` and refused outright, even
   with the sideload confirmation. A good signature by a key in `plugins.trustedPublishers` is
   Verified; by another key, or no signature, Unverified (installs only through the sideload
   confirmation and stays labelled). "Verified" is computed live, so removing a trusted key
   unverifies what it signed. `verifyBundle` in `packages/core/src/sdk` is the one implementation;
   install from a file, `nova validate` and the marketplace all use it, so they always agree.
8. **Catalog signatures** use the same file shape next to the index (`<index>.sig`,
   [`catalog-signature.json`](../../contracts/schemas/catalog-signature.json)) over
   `"nova-catalog-v1\n" + sha256(index bytes)`; the domain lines keep one kind of signature from
   passing for another. A catalog may pin a key (`plugins.catalogs[].publisherKey`) and, for Git, a
   commit (`commit`).
9. **No built-in publishers.** The sample catalog's public key is pinned in code for that catalog
   only and never added to the trusted publishers; its private half is a test fixture marked fake.
   The sample extension's "Example Labs" key is not built in either, because its private half is in
   the repository: the owner trusts it explicitly (as the tests do) or the extension installs
   Unverified. `app.ts` passes no built-in publishers to the SDK.

### D3. Extension runtime (FR-117)
10. **QuickJS in a worker thread** per account and extension, not Node's `vm`: the code has no
    Node, files, network or host objects, and only strings cross the boundary. Limits: 64 MiB heap,
    1 MiB stack, 2 s of CPU per entry into the engine (a delivered message or timer plus the
    promise jobs it starts, so an endless chain of jobs exhausts one budget), at most 100 timers and
    300 console lines a minute. A fault ends the worker; it restarts after 1 s, at most 3 times in
    10 minutes, then stays in `error`. The entry is an ES module that may import only its own files
    and a built-in `@nova/sdk`.
11. **No ambient authority.** The worker gets a `nova` object whose calls go to the Hub over a
    message port: commands, panels, tools, hooks, keybindings and menus only within what
    `extension.json` declares; `nova.net.fetch` only to declared hosts (public addresses, manual
    redirects, at most 8 requests in flight and 16 MiB being received at once, refused at once
    with `too_many_requests` or `fetch_budget` and never queued, 5 MiB a response); `nova.fs` only
    inside declared scopes (`${extensionData}` always writable, `${extensionRoot}` read-only,
    absolute paths read-only unless `write: true`; a scope inside, or containing, the Hub's data
    folder is refused at install with `fs_scope_refused`; links out of a scope are refused at run
    time); `nova.secrets.get` only for declared names (stored at
    `secret://extension/<account>/<id>/<name>`, every read audited; secrets stored under the
    earlier unscoped scheme during the build are orphaned, with no migration at this dev stage). Undeclared access is denied,
    audited as `extension.access.denied`, the extension is turned off and the owner notified (the
    existing plugin rule).
12. **The egress ceiling.** After the manifest's host check every fetch also passes the owner's
    `network.egressMode` and `network.egressDeny` narrowed by each managed layer's egress mode,
    deny list and allow list: `off` refuses everything, `limited` allows only GET, HEAD and OPTIONS,
    a deny entry wins, a host must be in every layer's allow list, and an unreadable policy refuses
    all. These refusals are audited (`extension.egress.denied`) and do not turn the extension off,
    since it declared the host.
13. **Tools** are `ext:<id>/<name>` with source `plugin`, so plugin scopes, agent plugin
    connections and plugin approval defaults apply; they reach models only when enabled per thread
    or agent like plugin tools. A tool keeps `readOnly` only when its declared action is `read`.
14. **Hook trust covers the code.** A plugin hook's hash covers its definition, the scripts its
    command line names and the digest of the plugin's files (all but the manifest, the hooks file,
    role and command files, which the Hub shows apart), so an update that changes a helper a trusted
    hook could load needs trust again; an update that only bumps the version or adds a role keeps
    the trust of hooks it did not touch.
    **SDK hooks** are rows in the hook table with source `extension` and an `mcp_tool` handler on
    `ext:<id>/hooks/<hookId>` (the hook-config contract is widened for it). The trust hash covers the
    definition and the bundle's D2 digest, so every update needs re-trust. The hooks area reaches
    them through the SDK's hook client and gate: the gate allows a trusted, registered hook's call
    (audited `extension.hook.run`) unless managed policy refuses the extension or its hook tool
    (`tools.allow`/`tools.deny`; audited `extension.hook.refused`). SDK hooks never answer asks, and
    fail closed when the worker is not running, so disabling, refusing or stopping an extension also
    turns its hook rows off.
15. **Panels** use the MCP Apps bridge (`ui://`, ADR-066): a panel's HTML file in the bundle, with
    CSP domains that must fall within the declared network permissions (`*` never covers one);
    `UiEntryPointView.domains` carries them to the App frame header.
16. **Themes and keybindings** are validated (themes against `theme.json` and the marketplace's
    plain-value rule) and offered through `GET /api/v1/extensions/contributions`; nothing an
    extension registers writes the user's settings. A theme needs no declaration (it cannot reach
    anything).
17. **Events** are observe-only: an extension may subscribe only to declared names or patterns
    among 21 observable events (chat messages, threads, turns, tool calls, runs, approvals,
    projects, schedules, agent status) and the aliases `thread.message`, `run.end`, `tool.call`.
    Observing chat messages is a sensitive permission.

### D4. Managed policy (FR-106)
18. **Sources, highest first:** a signed remote policy (its URL and Ed25519 key pinned in the local
    file), the OS-protected local file, and, in tests only, a layered test file. Local file: Linux
    `/etc/nova/managed-settings.json`, macOS `/Library/Application Support/Nova/managed-settings.json`,
    Windows `%ProgramData%\Nova\managed-settings.json`. Format:
    [`managed-settings.json`](../../contracts/schemas/managed-settings.json) `{version, serial,
    settings, restrict, remote}` (D4's name and shape, not the `managed-policy.json` sketch `docs/12`
    showed; `docs/12` §10 is amended).
19. **File checks.** Accepted only when it is a regular file owned by root, with no group or other
    write bit, in folders owned by root and not writable by others (unless sticky). A file owned by
    the Hub's user is ignored. A file that fails is ignored and reported, never partially applied.
    On Windows the file is ignored until an ACL check exists.
20. **The test layer.** `NOVA_MANAGED_SETTINGS_FILE` is honoured only with `NODE_ENV=test` or a Hub
    started with `--allow-test-policy`, and then as an extra layer over the protected file (which is
    still read), owned by the Hub's own user, shown as source `test`. It can only add restrictions.
21. **Remote policy.** An envelope `{v: 1, policy: <base64 of the document>, signature}` signed over
    `"nova-managed-policy-v1\n" + sha256hex(document)`, fetched over https only (no redirects, 15 s,
    2 MiB) every `refreshMinutes` (60). A lower `serial` than the one in force, or one below the local
    file's `minSerial`, is refused as a rollback. The last good copy is kept in
    `<data>/managed/remote-policy.json` and verified again on every read; `minSerial` in the
    root-owned file stops anyone who can write the data folder from swapping in an older copy. While
    a pinned remote policy has never verified, the policy fails closed; once one copy verified, an
    outage keeps it in force.
22. **Sources combine.** Every source's `restrict` applies (the most restrictive wins). For a
    security setting the applied value is the tighter of the policy's and the user's: allow-lists
    intersect, deny-lists merge, a disabling switch wins, ordered values take the tighter, retention
    caps take the smaller (null being the loosest), and `review.model` and
    `plugins.trustedPublishers` (when unverified installs are forbidden) are pinned. A value looser
    than the default is ignored and reported (`loosens`); a security key with no known direction is
    ignored (`unordered`, for example `relay.url`, the OTLP endpoint and the crash report endpoint).
    For other settings the remote value wins. Every key the policy touches is locked.
23. **Restrictions** reach every area through the `managed.restrict` setting (one `ManagedPolicy`
    service, typed getters through `managedRestrictions`): permission modes (Manual can never be
    denied; a refused mode runs as `ask_always` at the gate; an explicitly requested refused run
    autonomy is refused, a refused default falls back to Standard), tools, plugins, extensions, MCP
    servers (`userAdded: false` covers user, imported and bundle servers; `localStdio`), sessions
    (local and SSH, existing local sessions keep no roots), folders (every resolved root, permission
    profile entries included, narrowed in the gate and the sandbox's tool scope alike; Nova's own
    workspace is left), browser domains, egress (also forcing `cloud.runner.unrestrictedNetwork`
    off; with egress off, network tools and remote MCP servers are denied at the gate as well as at
    the proxy), telemetry export, routing (allowed provider kinds; image generation included),
    unverified installs and apps. Refusals are 403 `policy_denied` `{reason: managed}`, audited once
    as `managed.denied`.
24. **Fail closed.** A trusted source that does not parse or validate (an unknown key included)
    denies every agent tool and stops extensions; an ignored, refused or unreachable source keeps
    its last good policy.
25. **Precedence** (`docs/05` §8, `docs/14` §1.3): default → user global → user project (not for
    security keys) → managed policy, which locks. Environment variables configure the process and
    never override a setting. The managed area is the first one set up, so every other area reads
    its layer; `managed.policy.changed` reaches MCP, extensions, hooks (re-read without a restart)
    and OTLP. `GET /api/v1/managed` is readable by members (they see what governs them); reload is
    the owner's.

### D5. Data export, delete-all and import (FR-105)
26. **Export** is the whole Hub (`accountScope: hub`, owner only), streamed: a `.novaexport` zip
    from Nova's own ZIP64 writer (the zip library has no ZIP64, which would cap exports at 65,535
    files and 4 GB), with a lossless JSON-lines file per table, the data folder's files, and
    `manifest.json` last ([`export-manifest.json`](../../contracts/schemas/export-manifest.json)).
    Tables are listed from the migrated database, not a fixed list, so later tables travel without
    special handling; a test requires every stored table to be carried or on a named exclusion list.
27. **Sealing.** scrypt (N = 2^17, bounded on read) then AES-256-GCM in 1 MiB chunks (each chunk
    its own message; nonce = random prefix, chunk number, last-chunk flag; the header as associated
    data), so there is no 64 GiB limit and each chunk is verified before its plaintext is written.
    Only a sealed export carries the vault; it needs the Hub's name typed and is refused from a
    paired device's session (`hub_only`). Without a passphrase, secrets are listed to re-enter (never
    the Hub's own `secret://hub/`, `push/`, `relay/`), the Hub's key tables and what depends on them
    stay out (so paired devices are added again), and cookie jars are left out.
28. **Delete-all** needs the Hub's name typed, quiesces the Hub, keeps only the bare owner account,
    the owner row and the current session, runs `VACUUM`, makes a new data key and writes its audit
    entry as the first of the new log. `managed/` is kept: deleting the cached remote policy would
    loosen policy until the next fetch.
29. **Import** goes only into an empty Hub (setup and housekeeping rows only), checks the format, the
    schema version (older migrates forward through a staging database, newer is refused), every
    checksum, foreign keys and free disk space, and commits all or nothing after comparing every
    table with the vetted staging copy. An unsealed archive is unauthenticated, so: `secret://`
    references that would reach the Hub's own keys or a secret the archive does not carry are refused
    (`foreign_secret`); folder ids, blob paths and plugin and extension rows are checked
    (`unsafe_path`); stdio MCP servers, plugins and external agents come back disabled, hooks
    untrusted and every session but the importing one revoked (`restoredOff`); absolute paths under
    the old data folder move to the new one. The importing session stays signed in as the archive's
    owner. The Hub restarts in-process after delete-all and import.
30. **Retention** is per item (`retention.*Days`, null by default) with a daily sweep, never below the
    audit floor of 365 days. Pruning the audit log keeps an anchor (`audit_anchor`) and writes, in the
    same transaction, an audit entry that vouches for it; verification starts from the anchor and
    requires that entry, and nothing is pruned without an audit sink.

### D6. Third-party app authorization and OTLP (FR-222, FR-223)
31. **OAuth 2.0 authorization code with PKCE (S256 only)** for public clients, replacing the M4
    device-code sketch. An app registers itself (`POST /api/v1/apps/register`, Nova's or the RFC 7591
    body), the owner approves on `/authorize` (the web app), and the app redeems the code at
    `POST /api/v1/oauth/token`. Tokens are `nva_` (access 1 hour; refresh 30 days, rotated on every
    use), per app, scoped, revocable (`POST /api/v1/oauth/revoke`, Settings, `DELETE /api/v1/apps/:id`)
    and audited. The Hub publishes RFC 8414 metadata (`/.well-known/oauth-authorization-server`) and
    adds `iss` to every redirect (RFC 9207).
32. **Seven read-only scopes** (`account:read`, `projects:read`, `threads:read`, `runs:read`,
    `memory:read`, `notifications:read`, `usage:read`); no write scopes, because only instructions
    the user typed authorize actions (FR-189). Device scopes are not offered and tools stay with MCP
    clients. An app token reaches only the 23 GET routes of `APP_ROUTE_SCOPES` (each a member route,
    checked by the route test), only as a Bearer header; anything else is 403 `not_app_scoped` (or
    `insufficient_scope`), a token in a cookie is 401.
33. **Approvals are reused:** an approval is an `app_authorization` row of kind `app` (with an unused
    token hash, since the M4 table requires one), so the existing list, revoke route,
    `app.authorization.changed` and audit actions apply. Only the owner authorizes apps in M8. A
    second approval adds scopes; each token chain keeps only its own approval's scopes, narrowed by
    what the app is granted now.
34. **Redirects:** loopback `http://127.0.0.1` or `http://[::1]` on any port, or a private-use
    reverse-domain scheme; `localhost` and https are refused (the Hub sends no CORS headers, so a
    browser app could not call it anyway). Codes last 5 minutes and are burned by any failed
    attempt; reusing a code revokes what it issued, and presenting a used refresh token revokes the
    whole chain.
35. **Managed policy** can turn apps off (`restrict.apps: false`, which also turns `apps.enabled`
    and `mcpServer.enabled` off); `apps.enabled` off refuses registration, consent and tokens and
    stops every token at once.
36. **OTLP/HTTP with JSON** (no protobuf or gRPC dependency) of traces, metrics and logs to the
    owner's collector (https, or http to this machine), with header values in the vault; off by
    default. The redactor runs on everything; content attributes (and error and log messages that
    quote content) leave only when `telemetry.otlp.includeContent` is on, one switch rather than one
    per signal. Spans carry the route pattern, never the URL. A bounded queue (2,048 per signal),
    backoff from 1 s to 5 minutes with jitter honouring `Retry-After`, redirects refused, and a
    5-second bound on shutdown.

### D7. Route classification (closes R-032)
37. Every route the fully wired Hub registers is listed exactly once, by method and pattern, in
    `packages/core/src/team/routes.ts` as `public`, `owner`, `member`, `device`, `node` or `app`
    (`/mcp`); the web shell's static files are an explicit list (`WEB_SHELL_ROUTES`). The member guard
    reads this list; a route nobody classified is refused to members (fail closed), anywhere, not
    only under `/api`. The route test fails on an unclassified route, a listed route that no longer
    exists, a web-shell entry no longer served, an app-scoped route that is not a member route, or
    an owner route a member can reach. It found and fixed routes that only their services refused
    (invitations, member removal, OIDC providers, team-agent administration). Counts when this ADR
    was written: 26 public, 321 owner, 349 member, 9 device, 3 node, 3 app, plus 7 web-shell entries.
38. A member's view of what they are refused is `GET /api/v1/team/me/access` (the owner routes and
    their limits), which the web app uses for member mode and which fails closed when unreadable.

### D8. Not built in M8
39. A hosted remote catalog service (only the client), payment or paid extensions, install counts and
    shared ratings, crash reports to a vendor (only an owner-configured endpoint), full translations
    (D9 ships English, two pseudo-locales and one partial right-to-left locale).

### D9. Localization and right-to-left layout (FR-016)
40. **No dependency.** `@nova/i18n` (`packages/i18n`, same license as `packages/ui`) on the
    platform's `Intl`, replacing ADR-027's `i18next`; used by `apps/web`, `packages/ui` and
    `apps/desktop`. Messages are declared next to their code with `defineMessages(namespace, {…})`
    in an ICU MessageFormat subset (placeholders, plural with `#` and `=0`, select); the result is
    typed (a key without placeholders is a string, one with placeholders a function taking exactly
    those), ids are `<namespace>.<key>`, namespaces unique. Every read translates in the active
    locale, so text is read at render time; `richMessage`/`rich()` put elements (a link, a key cap,
    code) inside a translated sentence and pass strings and numbers through, so plural and select
    work inside it; never a sentence built from fragments, and a message with placeholders stays one
    literal (joining with `+` loses its typing). `fmt` formats
    numbers, sizes, dates, relative times, durations and lists in the locale (English keeps the forms
    the UI already showed).
41. **Locales**: `en` (the source), `ar` (a partial machine-drafted translation of the shell,
    palette, commands, onboarding, layout, settings navigation and Appearance, chat, the language
    picker, marketplace, extensions and `packages/ui`; missing messages fall back to English with
    English plural rules; Hub stays "الـ Hub" and Nova stays Latin), and the pseudo-locales `en-XA`
    (accented, about 35 % longer, bracketed) and `ar-XB` (right to left, mirrored with bidi
    controls), generated at run time. Catalogs are JSON per locale and namespace in
    `apps/web/src/i18n/locales/`, loaded lazily (the desktop shell reads the same folder; a packaged
    desktop build will need to copy it).
42. **The setting** `appearance.locale` (`system` by default, else `en`, `ar`, `en-XA`, `ar-XB`), a
    person's own preference. The provider sets `<html lang dir>`; a change remounts the shell under
    the locale key (drafts that matter are persisted). Settings → Appearance → Language lists
    languages by their own names in two radio groups (languages, then "For testing"), radios rather
    than a select. The desktop shell follows the Hub's setting while signed in (re-read on sign-in
    and `settings.changed`) and the operating system's languages otherwise; its pages get their
    words, `lang` and `dir` over the `shell.text` IPC call and event.
43. **Guards.** `npm run i18n:check` (in `npm run lint`) collects every `defineMessages` call with the
    TypeScript compiler API, verifies the committed English catalog `catalog.en.json`
    (`npm run i18n:write` rewrites it), fails on duplicate ids, translations of keys that no longer
    exist and placeholder mismatches, and prints each locale's coverage. The ESLint rule
    `nova-i18n/no-literal-ui-text` (a local plugin) forbids JSX text and literal text props (and the
    same keys in menu, tab and option objects) in the folders of `I18N_CONVERTED` in
    `eslint.config.js`, which each extraction added; it covers `packages/ui`, `apps/desktop` and
    every web area. Every converted area has a test that
    renders it in `en-XA` and fails on visible text or an accessible name that is not
    pseudo-localized (`@nova/i18n/testing`), plus `ar` tests of the right-to-left shell.
44. **Right to left.** Logical CSS properties only, checked by `apps/web/test/rtl-css.test.ts` with
    an allowlist keyed by file and selector (centring, a context menu at the pointer, a floating
    picture-in-picture app, chart labels over an unmirrored drawing, a remote screen thumbnail);
    direction-bearing icons mirror (`MIRRORED_ICONS`); code, terminals, paths, URLs and key caps stay
    left to right and isolated; user content takes `dir="auto"`; arrow keys and drags in tabs, trees
    and splitters follow what the user sees; `e2e/rtl-layout.spec.ts` checks core screens in `ar-XB`
    and `ar` at desktop, tablet and phone sizes (`docs/04` §4.5).
45. **Hub-originated text stays English in M8** (error, notification and status messages, details
    and reasons, permission lines, diagnostics, audit fields; the web keeps mapping error codes to
    its own words), and JSON-RPC errors to MCP apps are protocol text; MCP apps are told
    `navigator.language`, not Nova's locale. Moving Hub text into messages is an M9 gap.

### Extensions as shipped (S)
46. **Licenses.** `@nova/sdk` and the sample are Apache-2.0 (types and a test host only, no
    dependencies), so an extension under any license can use them; `@nova/cli` is AGPL-3.0-or-later.
    No new runtime dependency (QuickJS was already used by `script.run`).
47. **Install paths.** `POST /api/v1/extensions/preview` then `POST /api/v1/extensions` (from an
    uploaded `.novax` or a bundle or folder on the Hub), `nova dev` (one request, signature `dev`),
    and the marketplace. A plugin installed through `/api/v1/plugins` that contains `extension.json`
    is adopted as an Unverified extension. `PluginService.install` takes a provenance argument
    (`{verified, publisher, source, origin, via}`) so the plugin row and the `plugin.install` audit
    entry carry the real verdict; the plugin routes never pass it.
48. **Publisher change.** An update signed by another key than the installed one (or none) shows
    `publisherChange` and installs only with `acceptPublisherChange: true`, which clears the
    extension's secrets and data as for a new install (audited `extension.publisher.change`). The
    check runs on every path: `/api/v1/extensions`, `nova dev --accept-publisher-change`, the
    marketplace (`requires.publisherChangeAcceptance` in the preview, `acceptPublisherChange` on
    install, refused with `{reason: publisher_change_confirmation_required, from, to}` before anything
    changes) and `/api/v1/plugins` (a plugin install over a signed extension, even a plain plugin,
    through the extension installer's guard; the plugin preview warns first; audited with
    `via: plugins`). Unsigned to signed is not a change.
49. **Kept bundle and rollback.** Each install keeps its signed bytes at
    `<data>/extensions/bundles/<account>/<id>.novax`; a failed update restores them, verified again,
    so the verdict follows today's trusted publishers (a removed key brings it back Unverified, and
    under `unverifiedInstalls: false` the rollback is refused and recorded `rolledBack: false`).
50. **Tamper check.** A worker starts only when the installed files still match the recorded digest;
    otherwise it does not start, shows status `error` with the reason and is audited
    `extension.tampered` until it is reinstalled. Bundles holding `.git`, `.env` files or PEM
    private keys are refused by `nova validate`, `pack`, `dev` and the install path.
51. **Uninstall** always deletes secrets; it removes the data folder only with `?removeData=true`.
52. **Policy refusal.** A refused extension (deny lists for extensions or plugins, unverified while
    `unverifiedInstalls` is false, an unreadable policy) stays installed, shows `stopped` with the
    reason, is audited once as `extension.refused`, and starts again when the policy allows it
    (`reapplyPolicy` on `managed.policy.changed` and on changes of trusted publishers). The owner's
    own `network.egressMode: off` also cuts extension network.
53. **`sdk.enabled`** (default on) stops every worker and turns extension hook rows off; while it is
    off (at start too, and through any install, enable or adoption meanwhile) the rows stay off, and
    turning it on puts each hook back in its trust state, so a stopped extension's fail-closed hook
    never blocks tool calls. A fetch response that is dropped gives its bytes back to the budget at
    once.
54. **Validation** loads the entry in a throwaway engine, because QuickJS's compile-only mode is
    unreliable in the binding used.
55. **FR-198 and FR-200 backends.** Extension panels are entry points served from the bundle, with
    their domains; hooks in other assistants' plugin layouts are converted on import and installed
    untrusted.

### Marketplace as shipped (T)
56. **A bad catalog signature refuses the whole catalog** (nothing listed, nothing installed, no
    sideload); a catalog that pins a key and has no signature counts as bad (a stripped signature is
    a downgrade). Unsigned or untrusted catalogs list Unverified items.
57. **Verified** = a verified catalog, a matching checksum and, for a `.novax`, a signature by a
    trusted publisher; the earlier "catalog vouching" for bundles was dropped so the marketplace and
    the extension installer always agree. An extension shipped as a folder or zip is never Verified.
    Registry entries and `.mcpb` bundles are verified by the catalog and the checksum.
58. **Checksums:** files use `sha256`, folders a separate `digest` (the D2 digest), because the M4
    reader already gives `sha256` the meaning of an archive checksum.
59. **Diff acceptance** is needed only when permissions are added or changed (the client echoes the
    diff's hash); a diff that only removes is shown. Permission lines carry a `detail` (a tool's
    action and default, an MCP server's command, arguments, approval default and policy, a hook's
    handler), and a different detail is a changed permission.
60. **Updates:** a newer version, or the same version from the same catalog with a different checksum
    (a moved Git ref, a republished item).
61. **Where installs land:** plugins and extensions through their installers with the marketplace's
    provenance (`source: catalog`, `origin: <catalog>/<id>@<version>`, `via: <catalog>`), skills as
    `skill:import:<id>`, themes into `appearance.customThemes` (their version kept in the market
    record, since the theme schema has none), pets under `<data>/market/pets/<id>`, MCP registry
    entries as remote servers and `.mcpb` through the bundle installer. A failed install of any kind
    puts back what it replaced.
62. **Ratings** stay on the Hub (`shared: false`); there is no rating service.
63. **Who an item is from.** An item with no author of its own shows none (never the publisher name
    a catalog claims); the publisher line names only a trusted or pinned key, else its fingerprint.
    Removing a theme that `appearance.customTheme` names clears that setting first, so reinstalling
    it does not bring it back into use. One plain-value rule for theme tokens (`SAFE_THEME_VALUE` in
    `@nova/shared`) serves the marketplace, the SDK and saved themes. Import scans of other
    assistants' archives go through the bounded zip reader too (up to 65,535 entries, only JSON
    entries counted, an oversized entry skipped).

### Managed policy as shipped (U)
64. **Locked implied settings:** `code.allowBypass` off and the `tools.approvalPolicy` ceiling when
    Bypass (and Auto) are refused, `network.egressMode` and `network.egressDeny`,
    `cloud.runner.unrestrictedNetwork` off, `telemetry.otlp.enabled` off,
    `routing.allowCloud` off, `code.ssh.enabled` off, `apps.enabled` and `mcpServer.enabled` off,
    `market.allowSideload` off and `plugins.trustedPublishers` pinned, and the folder rules over
    `tools.roots`.
65. **Writes refused by the settings route:** any `managed.*` key and policy-restricted values of
    `code.permissionMode`, `code.folderModes`, `runs.autonomy`, `agents.autonomy` and
    `tools.approvalPolicy`.
66. **Catalogs** are matched by id and location; a `publisherKey` or `commit` either side pins is kept,
    and a catalog the two pin differently is dropped. `privacy.crashReports` and `sdk.enabled` can
    only be turned off.
67. **Bundle launch.** Changing the command, arguments or transport of an MCP server installed from a
    bundle is always refused (400 `bundle_launch`), with or without a policy.
68. **The egress allow list is a ceiling, not a locked value.** A policy's egress allow list
    (`restrict.egress.allow`, or `network.egressAllow` under `settings`, which joins its source's
    restriction) no longer locks the owner's `network.egressAllow`. The hosts in force are the
    policy's while the owner's list is unset or empty (an empty list counts as unset, or an owner who
    cleared it could never get back to the policy's hosts), else the owner's hosts that every policy
    list covers (wildcards count). They apply at the gate (outside: refused as `managed`, not asked),
    in the browser and in the egress proxy (scope grants, profile hosts and external agents' hosts
    kept within them too); the settings route refuses owner hosts outside the ceiling; `GET
    /api/v1/egress` and the `egress` section of `GET /api/v1/managed` show them with a note. `allowlist`
    is the loosest mode that is not off and `limited` uses the same hosts, so no owner mode is looser
    than the policy's; deny lists still add up. (J10 found the intersection with an empty owner list
    left agents no hosts.)
69. **Three more rules.** `apps.openRegistration` can only be turned off;
    `privacy.crashReportEndpoint` is pinned to the policy's value (`''` forbids sending anywhere; this
    never loosens privacy, since `privacy.crashReports` can only be turned off);
    `team.removedMemberPurgeDays` is pinned (fewer days keeps less of a departed member's data, more
    days is a hold for export or legal review: neither direction is safer for every organization, so
    the administrator fixes the number). `sites.remoteTargets` can only be turned off.
70. **Every security setting is decided.** `packages/core/test/managed-rules.test.ts` fails when a
    security setting has neither a rule in `SECURITY_RULES` nor a place on the list of keys with no
    safe direction (addresses, paths, tokens and similar values, which a policy cannot set and which
    are reported `unordered`), so a new security setting cannot slip through unlocked.

### Data controls as shipped (V)
71. **Spend caps** are per account and provider kind, by UTC day or month, with a warning share
    (default 80 %) and a hard stop (default on). Each in-flight call reserves its likely cost (the
    provider's recent average, at least 1 % of the cap), so concurrent calls overshoot by at most one
    call. A capped target is dropped from the route, so a fallback on another provider still runs;
    when none is left the reply stops with `over_budget` `{reason: spend_cap, provider}` and "Raise
    the cap in Settings → Profile & usage". Each alert fires once per period. "Clear usage data"
    carries the period's spend over, so it never resets a cap. Image generation honours caps and
    managed provider limits and records its usage. Compute nodes have no cap.
72. **Provider limits** (FR-115) are what providers report (plan, limit, last limit error, this
    month's spend), kept in `provider_account.entitlements`; Nova never invents them.
73. **Crash reports** hold no message text: relative, redacted stack frames only; the body sent is
    exactly the preview.
74. **Free disk** is checked before decrypting and before staging an import (`disk_full`, nothing
    written).
75. **One account's export** (for a removed member, before the purge): the same format with
    `accountScope: {accountId}`, built on a private copy of the database from which everything that
    is not the account's is deleted, so nothing else can leak and the Hub is never touched. Which
    rows travel is decided by walking the schema (rows naming the account and the rows hanging off
    them at any depth, its account row, files and folders; never other accounts' rows, Hub-wide
    tables, its words in another account's shared chat, team-agent tasks or secrets), so a later
    table follows the same rules. Never sealed (a passphrase is refused, `account_scope`), only the
    references its rows hold are listed to re-enter, audited `data.export` with
    `scope: {accountId}`; an import refuses it (`account_scope`): it is for keeping, not restoring.
    `GET /api/v1/team/removed/:id/export` serves it (`team.useExporter(datactl.memberExporter)`).

### Apps, OTLP, channels and team as shipped (X, Y1, Y2)
76. **Registration hardening:** 10 registrations an hour per address, at most 100 waiting, each
    lapsing after 1 hour; `apps.openRegistration` (default on) lets the owner close self-registration
    (`registration_closed`); the owner's own registrations skip the limits and do not lapse.
    `GET`/`DELETE /api/v1/apps/pending` list and remove every registered app nobody authorizes.
77. **The Hub never forwards its own codes.** A loopback redirect whose path is under `/api`,
    `/node`, `/agent`, `/boot`, `/mcp` or `/.well-known` (`hub_path`) or on one of the Hub's ports
    (`hub_address`) is refused at registration and at consent (`redirect_uri_reserved`); the email
    OAuth callback exchanges a code only when `iss` is absent or names the mailbox's own
    authorization server and not the Hub; the MCP OAuth callback refuses an `iss` naming the Hub.
78. **App calls** are audited as one `app.calls` entry per app per hour (counts by route, at most 50);
    refusals are audited one by one (`app.call`).
79. **Telegram files** are downloaded only after every check, when a turn will start, under a 20 MiB
    cap applied to the stated size, the size Telegram reports and while reading. Photos and documents
    pass the upload checks (there is no virus scanner) and become thread attachments; voice and
    video notes are kept but are not model input. Files go out only if the reply did, at most 10,
    redacted when they are text; in a shared conversation files the privacy check cannot read count
    as private.
80. **Email OAuth (XOAUTH2)** uses the owner's endpoints as fixed settings, with no discovery; the
    client secret is optional and sent in the body; tokens and the single-use state live in the vault
    (no table); refreshes run one at a time within 60 s of expiry; a refused refresh token sets the
    mailbox to `expired`. Signing out, removing the last binding or removing the member who owns it
    revokes the tokens at the provider. The callback is its own public route.
81. **Removed members** are kept `team.removedMemberPurgeDays` (30) for export, then purged by an
    hourly sweep or at once on the owner's request: every table with an `account_id` and the rows
    hanging off it, their blobs, vault entries named by their row ids and their folders. The account
    row (personal fields cleared), the member row, the audit chain and usage rows (detached from their
    chats) stay. Their words in someone else's shared chat are replaced with a fixed text and their
    files removed, keeping the chat's shape (the assistant's answers stay; they may quote the member).
    The purge commits the rows and records what is left to clean in one transaction (`cleaning`), so
    an interrupted cleanup is finished by the next sweep. A failed purge is retried a day later.
82. **Agents' skills** follow their plugin connections (`skill.load` too); `script.run`'s nested
    calls are recorded with origin `script` and gated like model calls; ACP terminals pass
    environment variables only through an allowlist of names, as leading assignments the policy
    engine sees; device MCP servers also offer resources and prompts through five read-only methods
    of `novad`'s `/agent/v1/mcp/request` under the existing `mcp` grant.

### Accessibility (A, FR-015)
83. **One sweep, no exclusions.** `e2e/a11y-sweep.spec.ts` runs axe with every WCAG 2.0-2.2 A and AA
    rule and fails on any impact over every surface, Settings section and main dialog, in a member's
    view, at phone size, in forced dark and both high-contrast themes, plus probes for what axe
    cannot check (keyboard walk and focus return, focus ring, target size, drag alternatives,
    reduced motion, reflow at 320 px, text spacing, paste and autofill, live regions, placeholder and
    field-edge contrast, lock notes). Each probe was shown to catch an injected fault.
84. **Timing and overlays.** A toast with an action never times out and every toast holds while
    hovered or focused; tooltips can be hovered and Escape closes them wherever focus is; a backdrop
    closes only on a press that starts and ends on it; focus returns to an opener disabled while it
    worked. These change `@nova/ui` for every caller.
85. **Drag alternatives** are menu items and buttons, not new gestures: Make larger/smaller on panes,
    Make taller/shorter on the bottom panel, and the picture-in-picture Move button cycling corners.
    The picture-in-picture corner resize stays the browser's own handle (Inline and Full screen are
    the click alternatives).
86. **Lock notes** name their source and are linked to their control everywhere through one provider
    (`ManagedLockNotes`) and a `setting` prop on locked fields, instead of hand-written notes.
87. **Contrast** gets a derived `--u-control-border` token (3:1 field edges in every theme) and
    placeholders use the muted text color; each page names the tab "<page> - Nova".
88. **Conformance** is stated per criterion in `docs/04` §4.4: supported except 1.4.10 (320 px reflow
    verified for chat and Settings only), 3.1.2 (English fallback in the partial Arabic locale has no
    `lang="en"`) and 3.3.8 (approving a device means typing its code; a compare-and-confirm
    alternative needs a security decision), which are partial; 1.2.x, 1.4.2 and 2.5.4 do not apply.
    3.2.2 is supported: after a language change focus returns to the chosen option and the change is
    announced in the new language once the Hub saved it.

### Saved themes in full (P, FR-011)
89. `appearance.customTheme` (not security-relevant) names the saved theme in use; it replaces
    `appearance.theme` and is applied token for token over its base (the theme's `extends`, else its
    variant's; `system` follows the device). A theme may set only the color roles (hex, so contrast
    can be checked), the four radii and the two fonts, each passing `SAFE_THEME_VALUE`; spacing, type
    size, motion and layering tokens are ignored, so a theme cannot undo text size, reduced motion
    or the layout. The accent, background and text overrides and the user's own fonts still go on
    top (a managed accent stays). **Use** sets the base, clears the overrides and the fonts the theme
    sets and skips managed keys; body text under 4.5:1 asks first and never blocks; choosing a base,
    an accent or a color by hand (and Toggle theme) stops it; an id no longer saved is ignored. The
    resolved look is cached in the browser and applied before settings load.

### Spaces and sites (Z, FR-036, FR-037)
90. **Pages** are reordered in one write of the whole order (`PUT /spaces/:id/order`; a stale list is
    `order_stale` and the Hub's order stands). Deleting asks the Hub what goes with the page
    (versions, comment threads and replies, proposals that end rejected, sites whose next build
    leaves it out); a deleted page is kept until its space is deleted (no retention sweep) and can be
    restored where it was with its history and comments, while rejected proposals stay rejected.
91. **Changing a site's source** previews the build from the new source against the latest version
    (files added, changed, removed, unchanged) without storing anything; Save stays off until it ran.
92. **Remote hosting targets are WebDAV**: https (plain http only to this machine), 30 s per request,
    no redirects, no new dependency. Files go into a temporary collection and one MOVE swaps them in;
    Nova replaces or removes only a folder carrying this site's `.nova-site` marker. Credentials are
    write-only in the vault (`secret://sites/target/<id>/credential`).
93. **Egress.** Every request passes the egress mode and deny list (with their managed values)
    narrowed by managed policy's own layers, whose allow lists intersect; the owner's
    `network.egressAllow` is not required, because a target the owner set up counts as its own allow
    entry (as an extension's declared hosts do); `limited` refuses publishing and an unreadable
    policy refuses everything (`egress_denied`, audited `site.egress.denied`).
94. **`sites.remoteTargets`** (security, default on; managed policy can only turn it off): off refuses
    adding, checking, planning and publishing to targets, while taking a site down from one still
    works.
95. **Failures change nothing.** The upload happens before the publish is recorded. When moving or
    unpublishing cannot remove an old remote copy the operation goes ahead and `leftBehind` says
    where it is; when unpublishing must put an earlier version back on a target that refuses, was
    removed or is turned off, the unpublish fails as a whole.
96. **Targets in use.** A target's address cannot change, and it cannot be removed, while a site is
    live on it; removal is a soft delete, so publish history shows it without a name. A zip publish
    is shown as not reversible. The publish dialog asks for a plan first (where, which files, what is
    replaced or taken down, whether it can be undone, whether egress allows it).
97. `/sites/targets` reuses the web's `sites` route with the id `targets` (site ids are UUIDv7, so
    they cannot collide); members get the owner-only notice and no Publish buttons.

### Web (W)
98. The Marketplace is a sidebar page with a Catalogs tab that holds the Catalog settings; the
    composer's + menu is "Apps and more"; Settings sections are "Extensions", "Authorized apps",
    "Managed policy", "Data" and "Telemetry export"; a locked control names its policy source; an
    extension switch reads "Run <name>" and the SDK switch "Run extensions"; Tools & MCP,
    Notifications and Channels gain a member mode. Details in `docs/04` §1 and §2.14-§2.16.
99. **Follow-ups (W12).** The cap-reached link reads `details.reason: spend_cap` (the old sentence
    match only for replies stored without details); a sealed export asks for the Hub's name; every
    data refusal has plain words; Settings → Authorized apps lists registered apps by name
    ("Registered, not allowed") with Remove; the message log lists each entry's files with their
    state (Kept with the chat, Sent, Held back, Not delivered, Not kept); one managed-policy client
    and lock note everywhere; a "From extensions" menu at the foot of the sidebar; changed permissions
    are worded part by part from their details, never raw JSON, and anything that lets an item do more
    without asking is marked **Sensitive**; a change of publisher must be ticked ("I accept the new
    publisher; delete its stored secrets and data") in the extension, marketplace and plugin dialogs;
    the providers list says a key is set only when the vault holds it.

### Journey J10
100. `e2e/j10-extension-governance.spec.ts` drives the M8 exit criteria through the web UI on a fresh
    Hub each: the SDK sample installed unverified with its command, panel and tool working, an
    undeclared host refused before any request (one `extension.access.denied`, the extension off),
    off and on removing and restoring its command and tools; a test policy locking Bypass and
    egress with the source shown, refused writes as `managed`, and a stricter file applied on
    "Check for changes" (an unverified extension stopped); export without and with a passphrase,
    delete-all and a sealed import whose re-export matches table by table and file by file; and the
    demo (Arabic right to left, the Aurora theme and the Release notes plugin from the sample
    catalog). It fixed the plugin wording of the extension-violation notice, and its follow-ups (W13)
    made a stopped extension say why (`ExtensionView.stopped`: `managed` with the policy part,
    `managed_unreadable`, `sdk_off`), show a command's result in words (a string, a `message` or
    `text` field, a flat object on one line, else **Show the result**), say what vouches for a
    Verified marketplace item (`vouchedBy`), let the plugin preview carry `publisherChange`, and name
    who wrote each message of a shared chat (`author`, on user messages of shared threads only).
    **Decision:** the managed source named on a stopped extension comes from the web's managed policy
    view (`GET /api/v1/managed`), because the `managed.restrict` setting the SDK reads does not record
    which source each restriction came from.

### Migrations
101. 0045_sdk (`extension_install`), 0046_market (`market_install`, `market_rating`), 0047_managed
    (comment only: policy lives in files), 0048_datactl (`spend_cap`, `spend_alert`, `retention_sweep`,
    `audit_anchor`), 0049_appauth (`app_client`, `app_consent`, `app_code`, `app_token`),
    0050_channels_m8 (`channel_message_file`), 0051_team_m8 (`member_purge`; `tool_call` rebuilt so
    `origin` allows `script`), 0052_sites_m8 (`site_target`; `site_publish` rebuilt for the `remote`
    kind with `target_id`).

## Security reviews
Three reviews ran against the uncommitted tree; none found a critical issue.

- **Access** (app authorization, route classification, member reads, purge, OTLP, channels): one
  medium defect. A member could steal an owner-approved app code through the Hub's own loopback
  callback (register an app whose redirect is the Hub's email OAuth callback, get the owner to
  approve, and have the Hub post the code to the member's token URL). Fixed by item 77. Low: content
  could reach OTLP with `includeContent` off (extension log text in the message, error messages);
  fixed by moving extension text to `content.text` and treating `message` as content. Hardening done:
  the route list's fail-closed gap outside `/api` (the web-shell list), registration limits and
  lapsing, aggregated call audit, a bounded OTLP shutdown, purge cleanup that survives a crash,
  mailbox tokens revoked at removal, and redaction of a purged member's words. Verified sound: the
  app-token gate across all routes, PKCE and token handling, the consent page's cross-site
  protection, and that the classification loosened no route.
- **Data and policy** (export, import, delete-all, retention, managed policy): 13 defects, none high,
  all fixed: a crafted unsealed archive could make the Hub hand out its own keys through imported
  `secret://` references (item 29); an imported plugin row could delete folders outside the data
  folder (path checks on import, uninstall and extension folders); managed folder rules missed
  permission-profile entries and the sandbox's tool scope; `unverifiedInstalls: false` was bypassable
  with a self-trusted key (`plugins.trustedPublishers` pinned); a denied extension kept running
  (refusal at start, on policy change, in the hook gate and in fetch); `userAdded: false` missed
  imported and bundle servers; unsealed exports carried browser cookies; delete-all and export
  missed `extensions/` and `market/`; image generation bypassed caps and provider limits; egress did
  not reach the cloud runner's network or remote MCP tools; five security settings had no tightening
  rule; existing local sessions ignored `sessions.local: false`; `quiesce` was not wired. Hardening
  done: import restores executable and trust state off and revokes sessions, sealed exports need the
  Hub's name and a Hub session, the audit anchor is bound to the chain, the remote policy fails
  closed until verified and has `minSerial`, the test policy is a layer, chunked AEAD, spend
  reservations, crash frames without message lines, free-disk checks and `nova data` refusing plain
  http.
- **Supply chain** (bundles, catalogs, the extension runtime): eight defects. Fixed: zip size caps
  bypassable through stored entries and shared payloads (high; the layout check of `documents/zip.ts`,
  and the old catalog unzip moved onto it); the update diff missing approval-relevant changes
  (details on every line); another publisher taking over an installed id and its secrets (item 48,
  through `/api/v1/extensions` and `nova dev`); unbounded `nova.net.fetch` (8 in flight, 16 MiB);
  control characters letting a signed listing stand for fewer files; a pinned catalog downgraded by
  removing its signature; a `/` filesystem scope passing the data-folder check (containment by real
  path both ways); plugin command-hook trust that hashed only the files a hook's command line names
  (a plugin hook's hash now also covers the digest of the plugin's files, leaving out only what the
  Hub reads and shows apart: the manifest, its hooks file, role and command files and the commands
  the installer writes; an update that changes any file a hook could load needs trust again).
  Hardening done: extension theme values, `nova pack` refusing keys and `.env`
  files, Git catalog files read only inside the checkout, untrusted signers never named from the
  catalog (an untrusted signer is shown by its key fingerprint), one CPU budget across promise jobs, a digest check at worker start, chat-message events
  marked sensitive, extension secrets scoped by account, and managed tool rules in the SDK hook gate.

## Consequences
An extension can add commands, panels, tools, hooks, themes, keybindings, menus and status items with
only the permissions it declared, and a signed one from a trusted publisher installs Verified from a
file or a catalog; everything else is visibly Unverified and needs the sideload confirmation. An
organization can lock settings and restrict what Nova may do through a root-owned file or a signed
remote policy that only tightens and fails closed. A Hub's data can leave and come back losslessly,
with secrets only under a passphrase, and an archive cannot smuggle in trust it was not given. Apps
read a user's data through narrow, revocable tokens, and telemetry reaches only the owner's own
collector. The price: more owner-only routes and settings, a Hub-wide export (no per-account export
yet), extensions that run in an interpreter rather than Node (no npm packages at run time), and
policy files that need root to install.

## Known limitations
- Extensions: `nova init` copies the sample from the repository (it works only in a checkout);
  `@nova/sdk` is not published.
- Marketplace: no pet or MCP item in the sample catalog; install counts and shared ratings are not
  built; a moved Git ref without a pinned commit is read at its current head; the install dialog
  for an item signed by a publisher the owner has not trusted names the key's fingerprint, not the
  name the catalog claims (by design).
- Managed policy: no macOS configuration profile or Windows registry channel, and the Windows file is
  ignored until an ACL check exists; per-agent capabilities, ambient capture and appearance locks
  from the `docs/12` sketch are not restrictions; running MCP servers are re-checked on a policy
  change but that path is untested against a real network server.
- Data controls: device replicas are not told about delete-all or import; device, MCP client and app
  tokens are restored valid by an import; the import upload has no free-disk check of its own.
- Apps: the registration limiter keys on the client address without trusting a proxy, so behind a
  tunnel everyone shares one bucket; the collector URL may name an internal https address (owner
  only); only the owner can authorize apps.
- OTLP: only the Hub's own spans (one per request), four metrics and its logs are exported; provider
  and tool spans are not produced yet; log message bodies and string fields are redacted but not
  removed when content is off.
- Channels: no Telegram album merging, no files out on email or Slack, no voice transcription; the
  redirect URI the web shows uses the page's own address.
- Team: members cannot configure their own providers.
- Sites: WebDAV is the only remote target kind; deleted pages are never swept.
- Localization: text the Hub writes stays English (D9, item 45); `ar` is partial; arrows written
  into messages ("Settings → Devices") point right in right-to-left text, and English text not yet
  extracted shows its sentence punctuation at the wrong end there; a context menu opens to the
  pointer's right in right-to-left; a chat reply takes one direction for the whole reply; MCP apps
  are told `navigator.language`, not Nova's locale.
- Accessibility: 1.4.10, 3.1.2 and 3.3.8 are partly supported (item 88); screen-reader smoke
  tests on real assistive technology remain a release-checklist item.
