# 01 — Reverse-Engineering Method (REA)

This document defines **how** the four source products were analyzed and how findings are
converted into clean, original requirements. It follows the REA ("Reverse Engineer Anything")
approach: *decompile → understand → recreate*, with evidence and stated limits for every
conclusion.

## 1. Source material

Analysis draws on:

1. **Public product documentation and help centers** (features, settings, keyboard shortcuts,
   permission modes, behavior contracts). This is the primary and safest source.
2. **Public marketing and changelogs** (capability intent, positioning).
3. **Lawful static analysis** of locally installed applications the user owns or is
   authorized to inspect, using tools such as REA (MCP/CLI), Ghidra/Hopper/IDA,
   `asar`/Electron inspection, Chrome DevTools, and network observation.
4. **Observable runtime behavior** on the user's own machine (UI flows, IPC calls, local
   file formats) captured lawfully.

> **Rule:** We only extract *functional and interface specifications*. We do not copy
> implementation, assets, or text. See `docs/19-legal-and-ethics.md`.

## 2. The REA loop

```
        ┌───────────────┐
        │  1. TARGET    │  pick a product + version + feature area
        └──────┬────────┘
               ▼
        ┌───────────────┐
        │  2. DECOMPILE │  static extraction: files, modules, routes, IPC,
        │               │  symbols, strings, metadata, source maps (if lawful)
        └──────┬────────┘
               ▼
        ┌───────────────┐
        │  3. UNDERSTAND│  follow code/data paths; trace a user action to its
        │               │  handlers and effects; capture runtime evidence
        └──────┬────────┘
               ▼
        ┌───────────────┐
        │  4. RECREATE  │  write an ORIGINAL functional spec + acceptance tests,
        │               │  then implement from the spec, not from the binary
        └───────┬───────┘
                ▼
        ┌───────────────┐
        │  5. EVIDENCE  │  attach proof + limits; mark confidence
        └───────────────┘
```

## 3. Evidence format

Every finding is recorded as an **Evidence Record** (ER) in the ledger. Required fields:

```yaml
id: ER-0042
target: APP-1                     # opaque target id; identities live in the private evidence ledger
version: "0.x.y (build 1234)"      # as observed; "documented" if no binary
date: 2026-10-16
area: Code / permission modes
claim: >
  Code sessions expose five permission modes: Manual, Accept edits, Plan, Auto, Bypass.
evidence:
  - type: documentation
    ref: private-evidence://APP-1/permission-modes-doc
  - type: ui_observation
    ref: artifacts/evidence/app1-code-permission-modes.png
  - type: runtime_capture
    ref: artifacts/evidence/app1-ipc-permission-select.json
confidence: high                     # high | medium | low
limits: >
  Bypass availability depends on plan and admin policy; behavior may differ by version.
maps_to: [FR-051, FR-052, FR-053]
```

Confidence levels:

- **high** — documented by the vendor and/or directly observed and reproduced.
- **medium** — inferred from multiple indirect signals.
- **low** — single observation or plausible inference; must be validated before it drives
  irreversible design.

## 4. Techniques

| Technique | Use | Tooling |
| --- | --- | --- |
| Static JS/Electron inspection | Routes, IPC channels, module boundaries, feature flags | Electron `asar` extraction, source maps, AST walk, REA JS extractor |
| Native decompilation | Not required for v1; used only if a feature is native-only | Ghidra / Hopper / IDA via REA |
| Runtime tracing | Map UI action → IPC → effect; discover local storage formats | DevTools, `strace`/`dtruss`, REA runtime capture |
| Network observation | Provider endpoints, streaming protocols, auth flows | mitmproxy on the user's own traffic, with consent |
| UI inventory | Exact flows, states, shortcuts, menus, dialogs | Screenshots + annotated flows |
| Document mining | Behavior contracts, defaults, limits | Vendor docs, help centers, changelogs |

## 5. Conversion to requirements

1. Cluster ERs by subsystem.
2. For each cluster, write a **capability statement** in vendor-neutral language.
3. Decompose into **numbered requirements** (`FR-*`) in `docs/03-functional-requirements.md`,
   each with: description, inputs, behavior, edge cases, acceptance test, priority.
4. Define **interfaces** in `contracts/` before implementation.
5. Implement **original** code that satisfies the requirement.

No requirement may reference a reference application's internal identifier, class name, or asset.

## 6. Coverage matrix

Track which source areas have been analyzed. `○` not started, `◐` in progress, `●` done.

| Area | App A | App B | App C | App D |
| --- | --- | --- | --- | --- |
| Conversation UX | ● | ● | ● | ● |
| Projects/memory | ● | ● | ● | ● |
| Agents / long-running | ● | ● | ● | ● |
| Always-on / scheduled | ◐ | ● | ● | ● |
| Coding / diff / PR | ● | ● | ● | ◐ |
| Browser / computer use | ● | ● | ● | ● |
| Permissions / approvals | ● | ● | ● | ● |
| MCP / plugins / skills | ● | ● | ● | ● |
| Voice / media | ○ | ● | ● | ◐ |
| Theming / personalization | ◐ | ● | ● | ○ |
| Sync / multi-device | ◐ | ● | ● | ● |
| Channels (Slack/Teams) | ○ | ● | ○ | ● |
| Cloud environments | ● | ● | ● | ● |

Marks reflect depth of public documentation available as of 2026-10-16; the agent should
update this matrix as it validates behavior.

## 7. Using REA during the build

The build agent may use REA (or equivalent) to answer *specific functional questions*
during development, e.g. "how does this app batch streaming deltas?" or "what is the shape
of this local config?" The output is always converted to an Evidence Record and then to a
vendor-neutral requirement or interface. Raw dumps are never committed unless small, lawful,
and free of proprietary content.

Commands (if REA is installed):

```bash
npx rea-agents setup          # register MCP server + workflow instructions
# then, from an agent: "inspect <path> and report the IPC channel list with evidence"
```

If REA is unavailable, fall back to documentation mining and lawful local observation.

## 8. Limits & ethics

- We do not circumvent DRM, license checks, or encryption.
- We do not analyze software we do not own or lack authorization to inspect.
- We stop when a finding is not necessary for interoperability or a clean-room reimplementation.
- We document uncertainty; low-confidence findings never become hard requirements without
  validation or a safe default.
