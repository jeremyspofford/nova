# 28 — Glossary

Canonical terms used throughout the spec. Nova uses **plain names**; there is no metaphor
layer. Product brand: **Nova**. Domain: **arialabs.ai**.

## Roles & infrastructure

| Term | Meaning |
| --- | --- |
| **Hub** | The always-on canonical service: database, agent runtime, scheduler, policy, UI hosting, routing. |
| **Client** | A device that presents the Hub-served UI (browser/PWA, native desktop shell, mobile). Thin by default. |
| **Compute Node** | A device that serves inference, embeddings, media, browser, or code execution to the Hub. |
| **Relay** | A content-blind, end-to-end-encrypted forwarding service for off-LAN clients and push. |
| **Wake Helper** | An always-on device on the same LAN that can send WoL magic packets. |
| **`novad`** | The Nova device agent: a Rust supervisor plus signed, sandboxed modules. |
| **Mesh** | The device-to-device mesh transport (Headscale/Tailscale/NetBird/WireGuard). |
| **Transport** | A way roles reach each other: LAN, Mesh, Relay, or direct public. |
| **Trust path** | How HTTPS is trusted: Hub local CA, Mesh certificates, or native-shell pinning. |
| **Sealed mode** | Optional mode where keys stay in the secure enclave and plaintext is never written to disk; proactive work pauses while locked. |

## Domain objects

| Term | Meaning |
| --- | --- |
| **Thread** | A conversation. |
| **Project** | A container of threads, instructions, sources, and optional local folders. |
| **File** | A file or artifact inside a project. |
| **Agent** | A configured actor with instructions, tools, permissions, and a runtime. An **always-on agent** persists across sessions. |
| **Run** | A delegated multi-step Work task. |
| **Code Session** | A coding task bound to an environment + folder/repo. |
| **Environment** | Where a code session runs: local, cloud, SSH, WSL, container. |
| **Ambient Memory** | Opt-in screen/audio capture, OCR/transcription, and a searchable timeline. |
| **Automation** | A versioned trigger → condition → action rule. |
| **Entity** | A smart-home device/state (light, sensor, lock, …). |
| **Area / Scene** | A room grouping / a named set of entity actions. |
| **Catalog** | The signed registry of community extensions. |
| **Plugin** | A bundle of skills + MCP servers + optional UI. |
| **Skill** | A reusable instruction bundle (markdown). |
| **Connector** | An authenticated integration to an external service. |
| **MCP** | Model Context Protocol; how tools/resources are exposed. |
| **Tool** | A callable capability (built-in, MCP, plugin, or computer). |

## Governance

| Term | Meaning |
| --- | --- |
| **Policy Rule** | A declarative statement controlling when an action is allowed/asked/handed off/denied. |
| **Approval** | A user decision required before a gated action. |
| **Permission Grant** | A remembered approval scoped to an action/resource. |
| **Capability Declaration** | The document `novad` reports describing hardware/OS/services/models/limits. |
| **Audit Log** | The append-only, hash-chained record of every consequential action (`audit_event`). |
| **Learning Level** | L0 memory · L1 skills · L2 workflow optimization · L3 self-tuning · L4 code self-modification · L5 local fine-tuning. |
| **Guardrail** | The on-by-default protection that prevents the agent from modifying policy/safety/permissions/audit/signing/self-improvement gates. |

## Models & runtime

| Term | Meaning |
| --- | --- |
| **Provider** | An API source (Anthropic, OpenAI, Google, OpenRouter, local, OpenAI-compatible). |
| **Model** | A provider-native model id. |
| **Virtual Model** | A named preset that routes to a provider/model/params (single, fallback, cheapest, best). |
| **Reasoning Level** | `off`…`max`, mapped per provider. |
| **Mode** | Top-level surface: **Chat**, **Work**, **Code**, **Agents**. |
| **Routing Order** | Same device/LAN → capability → least-loaded → cost/energy → cloud. |

## Naming rules

1. Use these plain terms in UI, code, and docs.
2. Internal IDs are stable and independent of display text (`project`, `file`, `agent`, …).
3. The only product brand is **Nova**; no third-party product names appear in the spec.
4. If a themed name is ever introduced, it is a **display-layer** alias only (see §Naming in
   `docs/04`), never a code identifier.
