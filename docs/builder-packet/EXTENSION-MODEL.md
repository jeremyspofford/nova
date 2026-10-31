# EXTENSION MODEL

Nova's capabilities grow through extensions, never through core forks. If a feature needs core changes to exist, that is a design smell — escalate it.

## Kinds
- **Connector** — talks to an external service (Gmail, Home Assistant, a bank feed). Owns auth via the vault (through the Credential Broker: `docs/plans/vault-broker.md`), sync, and event emission.
- **MCP server (wrapped)** — an external MCP server registered with the host; tools are namespaced, permissioned, and auditable like native ones.
- **Plugin** — in-process capability (a new triage rule set, a renderer, a summarizer).
- **Skill pack** — Claude-format `SKILL.md` skills plus optional resources: procedures Nova can load per task.
- **Agent adapter** — wraps an external AI (CLI, SDK, API) behind the task envelope (CONTRACTS §1).
- **Automation adapter** — webhook bridges to n8n / Zapier / Make and similar; Nova can trigger and be triggered.
- **Design system** — a UI package (DESIGN-SYSTEM §4). Same lifecycle as every other extension.

## Manifest and lifecycle
Every extension ships the manifest of CONTRACTS §4. Lifecycle: **discover → review permissions → install (sandboxed) → health check → enable → update (versioned, same pipeline as ADR-9) → disable → remove**. Removal follows the manifest's `on_remove` exactly: delete its data, keep what it promises to keep, export what it promises to export, revoke its secrets and event subscriptions. A removed extension leaves no residue — no orphaned schedules, triggers, or tokens.

## Permissions
Declared, least-privilege, shown to the user in plain language at install and on any permission change (a change is a new review, Tier 2+). Runtime enforcement: an extension can only touch the data scopes, network egress, and device actions it declared. Egress by extensions appears in context receipts.

## The foundry (Nova builds extensions)
Nova may author its own extensions for a user need: generated in a sandbox worktree, manifest generated with it, tests + health check required, installed disabled, enabled only after the user's approval tier is satisfied. Foundry output is ordinary extensions — removable, auditable, identical in kind to hand-written ones. The foundry never writes to core.

## Compatibility
Extensions declare a Nova compatibility range. Nova refuses or sandboxes extensions outside range. Breaking contract changes ship as new major contract versions with a compatibility window, never as silent breakage.
