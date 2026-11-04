# Configuration schema and the three doors (proposed, 2026-11-04)

Design-first for config onboarding, per the owner's direction of 2026-11-04 and the config design
of 2026-11-03 (layers L0/L1/L2). The specimen is the styleguide entry `config-doors`
(`/styleguide?entry=config-doors`). Nothing is built yet; this page and the specimen are for the
owner's reaction.

## One store, three doors
- **Store.** Layered, resolved per key: L2 (your pack) wins over L1 (this hub), which wins over
  L0 (Nova's defaults, read-only, shipped with the release). Each effective value records the
  layer that set it. Each change is a ledger event with its diff. Reset means deleting the overlay
  key, so the default shows through again.
- **Import.** Upload a `nova.config.json` or a pack at onboarding or later. Nova validates it
  against the schema and shows it as a diff. Lines it can't use are listed with the reason, and
  nothing is applied from a file that doesn't validate. Applying writes overlay keys; export
  writes the same file back out. The file is only a format, never a second source of truth: after
  import, Nova does not read it again.
- **Form.** The guided setup asks a few steps of questions, then shows the answers as the same
  diff before saving. Afterwards Settings is generated from the schema: every key is editable,
  shows its layer badge, and has "Use the default" when an overlay set it.
- **Chat.** Nova proposes a change in the thread as the same diff, asked at that change's tier:
  tier 2 asks once; anything that loosens a gate is tier 3, confirmed every time (with the passkey
  on Nova's own screen, T2). It applies through the same validated path.
- **Secrets.** Only references (`secret://NAME`, resolved by the broker and vault) ever appear in
  config. A plaintext secret in an imported file is refused for that line, and the person is sent
  to where the secret belongs.

## Schema (first cut: what exists today, and where it moves)
Each key has a type, an owning layer, a change tier, and today's source. "Env" overrides remain
for operators and tests, and Health says when one is in force.

| Key | Type | Layer | Change tier | Today |
|---|---|---|---|---|
| `hub.home` | path | L1 | 3 (moves all data) | `nova.config.json` `home`, `NOVA_HOME` |
| `hub.host`, `hub.port` | host, 1–65535 | L1 | 3 | `host`, `port`, `NOVA_HOST`, `NOVA_PORT` |
| `hub.instance` | name | L1 | 2 | `instance`, `NOVA_INSTANCE` |
| `hub.mesh.url`, `.public_url`, `.transport`, `.address` | URL, enum | L1 | 3 (who can reach Nova) | `mesh_*`, `NOVA_MESH_*` |
| `hub.tls.cert`, `.key` | path (no key material) | L1 | 3 | `tls_cert`, `tls_key` |
| `agent.command`, `agent.egress` | argv, none/local/remote | L1 | 3 (where the conversation goes) | `agent_cmd`, `agent_egress` |
| `agent.exec_timeout_ms`, `agent.max_tool_steps` | int | L1 | 2 | same names |
| `user.timezone` | IANA zone | L2 | 1 | `timezone`, `NOVA_TZ` |
| `user.*`, `identity.*`, `tuning.*` | per profile section | L2 | 1–2 | core profile sections |
| `appearance.*` | per design system | L2 | 1 | profile `appearance`, `theme` |
| `privacy.*`, `policy.*` | posture, domain list | L2 (L1 for hub posture) | loosening is 3 | profile `privacy`, `policy` |
| `notifications.quiet_hours`, `board.morning` | range, list | L2 | 1 | L0 defaults (config design §3) |
| `providers.*`, `models.*`, `capture.*`, `backups.*`, `mesh.*` | per section | L1 | as their routes say today | profile sections and routes |
| `connectors.<id>.*` | scopes, `secret://` refs | L2 | 2; widening scope is 3 | connector settings, vault |

Validation messages name the key, the value and what is allowed, in plain words. An unknown key is
refused with the nearest known one ("Did you mean …?"), never silently dropped.

## Responsive and accessible (checked in the specimen test)
No horizontal scroll at any width in the owner's matrix, from the fold cover at 344 to desktop at
1920. Every control is at least 44px. axe is clean, ids are unique, nothing is hover-only. The
specimen test is `tests/ui/config-doors-styleguide.test.ts`, which shoots every door and state at
every size in Chromium and WebKit.

## Open for the owner
1. Is "Your pack / This hub / Default" the right wording for the layer badges?
2. Should the chat door also show its proposals in Settings as "pending changes", or only in the
   thread?
3. When a hub's own settings arrive in an imported pack (L1 keys in an L2 file), should they be
   refused, or offered as a separate hub change?
