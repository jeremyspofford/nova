# 12 — Permissions, Security & Privacy

## 1. Threat model

| Asset | Threat | Mitigation |
| --- | --- | --- |
| Provider credentials | Theft via logs/DB/renderer | OS keychain only; never in renderer or model; redaction; secret scanning in CI |
| User files | Exfiltration by a malicious tool/plugin | FS scoping, sandbox, egress denylist, audit |
| External accounts | Unauthorized actions (send, purchase, delete) | Policy engine, approvals, built-in safety, spend caps |
| Local network | SSRF / scanning | Egress deny-by-default; private IP restrictions; DNS pinning |
| Prompt injection | Malicious page/email/doc steers agent | Untrusted labeling, instruction separation, action review, taint tracking |
| Plugin/MCP supply chain | Malicious code | Signature verification, declared-permission enforcement, sandboxing |
| Sync channel | Eavesdrop/tamper | E2E encryption (XChaCha20-Poly1305), signed device keys, Argon2id KDF |
| Audit log | Tampering | Append-only hash chain; verification tool |
| Update channel | Malicious update | Signed releases; rollback; staged rollout |
| Model output | Leaking secrets into context | Secret redaction; vault isolation; per-thread secret policy |

The design assumption is **zero trust in everything that is not the user or the core
process**: renderer, plugins, MCP servers, tool output, and remote content are all untrusted.

## 2. Policy engine (FR-099)

Location: `packages/policy`. Pure, deterministic, unit-testable.

```ts
interface PolicyContext {
  actor: 'user' | { kind: 'agent'|'agent'; id: string };
  scope: { kind: 'global'|'project'|'thread'|'run'|'session'|'agent'; ref?: string };
  mode?: 'chat'|'work'|'code'|'agent';
  autonomy?: 'ask_first'|'standard'|'autonomous';
  permissionMode?: 'manual'|'accept_edits'|'plan'|'auto'|'bypass';
  tool: ToolDescriptor;              // name, source, annotations
  args: unknown;
  resource?: { kind: 'path'|'host'|'account'; value: string };
  environment: { kind: string; trusted: boolean };
}

type Decision =
  | { effect: 'allow'; reason: string; ruleId?: string }
  | { effect: 'ask'; reason: string; ruleId?: string; scope: string }
  | { effect: 'handoff'; reason: string; ruleId?: string }
  | { effect: 'deny'; reason: string; ruleId?: string };
```

Evaluation order (first decisive rule wins, but `deny` and built-in safety always win over
`allow`):

1. **Built-in safety** (immutable): secrets exfiltration, purchases/account creation,
   CAPTCHA bypass, credential changes, system-destructive actions, unapproved file scope,
   unlisted egress, self-modification of safety settings.
2. **Managed workspace policy** (admin file).
3. **User custom rules** (most specific scope first).
4. **Per-tool defaults** and **per-plugin/MCP permissions**.
5. **Autonomy/permission-mode defaults**.
6. Fallback: `deny` for unknown destructive tools; `allow` for read-only built-ins.

Every decision includes a human-readable reason and, where applicable, a rule id — this is
the "why" shown in approval cards.

## 3. Custom rules (FR-084)

User-facing rules in Settings → Personalization → Permissions:

| Rule | Meaning |
| --- | --- |
| Take action without asking | allow for the matched scope |
| Take action when you say so | allow only while an explicit request is active; otherwise ask |
| Ask before taking action | ask each time (default for consequential actions) |
| Hand off to you | the agent cannot do it; the user must |

Rule shape:

```jsonc
{
  "scope": { "kind": "agent", "ref": "<agentId>" },
  "match": {
    "tool": ["email.send", "slack.post"],
    "resource": { "host": "*.customer.com" },
    "effect": ["external_communication"]
  },
  "effect": "ask",
  "label": "Ask before messaging customers",
  "priority": 50
}
```

Rules are **instructions the agent tries to follow**, not access grants: they cannot expand
app access or override built-in safety, and they cannot bypass required confirmations (e.g.,
using a saved login).

## 4. Approvals (FR-100)

- One consistent approval card across modes, plus an OS notification.
- Options: **Allow once**, **Always allow** (scoped, creates a `permission_grant`),
  **Deny**, **Hand off**.
- Shows: action, target, reason, scope, risk, and the rule that triggered it.
- Decisions are remembered per scope and revocable in Settings.
- Timeout pauses the run (default 24 h) rather than proceeding.

## 5. Secrets (FR-101)

- Storage: OS keychain via a cross-platform wrapper; encrypted-file vault fallback using
  Argon2id (user passphrase) + XChaCha20-Poly1305.
- Access: only `SecretBroker` in the core/agent process resolves values, and only for the
  duration of a call. Values are never returned to the renderer or included in model context.
- Redaction: a centralized scrubber removes known secret patterns (keys, tokens, bearer
  headers, connection strings) from logs, traces, tool results, and error reports.
- Injection: secrets are injected into tools via environment variables or an ephemeral
  header, never as model-visible arguments.
- CI: `gitleaks` (or equivalent) + a custom rule set; failing build on detection.

## 6. Prompt-injection defense (FR-103)

- **Instruction separation**: user/system instructions are a privileged channel; tool output,
  web pages, emails, and file contents are always wrapped in explicit `untrusted` delimiters.
- **Taint tracking**: data derived from untrusted sources carries a taint flag through the
  context; tainted content cannot directly trigger consequential actions without a policy
  check that treats it as untrusted.
- **Action review**: before consequential actions, an auto-review (classifier + rules) checks
  alignment with the user's request and standing instructions; mismatches force an approval.
- **Injection canary tests** in the security suite (FR-123) must fail safely.
- Tool output that appears to contain instructions is surfaced to the user as a suspicious
  finding, not executed.

## 7. Sandboxing (FR-107)

- All agent execution occurs in a sandbox; unsandboxed execution is never the default.
- Profiles are generated from the effective policy and hashed into the audit event.
- The broker canonicalizes paths (rejecting symlinks/`..` escapes), pins DNS, limits
  resources, and caps output.
- See `docs/11` for the substrate details.

## 8. Egress control (FR-102)

- Deny-by-default; explicit allowlists per scope; visible in Settings → Network.
- Local proxy enforces the list, strips tracking headers, and logs (method, host, status).
- New destinations prompt (if allowed by mode) or deny with a clear reason.
- Private/localhost ranges are restricted to dev-server verification.

## 9. Data controls & privacy (FR-105)

- **Telemetry is off by default.** When enabled: no content, no prompts, no file paths —
  only coarse counters, crash type, and performance. A local preview shows exactly what would
  be sent.
- **No training on user data**, ever; stated in-product.
- Retention defaults in `docs/06` §5; user-configurable; pruning never deletes pinned items.
- Export: `.nova` archive + JSONL audit export.
- Delete: soft-delete → 30-day recovery → hard delete; "delete everything" requires typed
  confirmation and purges keychain entries, blobs, and sync copies.
- Third-party request minimization: redact IP by default where the provider allows; document
  each provider's data handling and link to their policy.

## 10. Managed policy (FR-106)

An enterprise admin can drop a signed policy file at a managed location:

```jsonc
{
  "version": 1,
  "permissionModes": { "allow": ["manual", "plan", "accept_edits"], "denyBypass": true },
  "tools": { "deny": ["screen.*"], "ask": ["exec.run"] },
  "network": { "allow": ["*.corp.example"], "deny": ["*"] },
  "plugins": { "allowlist": ["com.corp.*"], "disableMarketplace": false },
  "telemetry": { "forceOff": true },
  "appearance": { "lockTheme": true, "theme": "corp-dark" },
  "sync": { "requireE2EE": true }
}
```

Managed policy overrides user settings for the listed keys and is shown as "managed by your
organization" in the UI. The file's signature is verified; unsigned files are ignored with a
warning.

## 11. Audit log (FR-104)

- Append-only `audit_event` with a hash chain (`prev_hash`, `hash`); a `verify` command checks
  integrity and reports the first break.
- Records: actor, kind, action, resource, input hash (not raw inputs by default), decision,
  result, and context ids.
- Exportable as JSONL for compliance; filterable by actor/scope/time in the Activity view.
- Sensitive raw inputs can be recorded only if the user opts in; defaults store hashes.

## 12. Security testing (FR-123)

| Test | Expectation |
| --- | --- |
| Policy bypass (crafted args, path traversal, symlink) | Denied + audited |
| Secret leakage (log/trace/error/tool result) | Redacted; no plaintext anywhere |
| Injection payloads (web/file/email) | Treated as data; no unauthorized action |
| Sandbox escape attempts | Blocked; process killed; audited |
| Egress to unlisted host | Blocked by proxy; clear error |
| Malicious plugin/MCP | Permission violation blocked; plugin disabled |
| Sync tampering | Signature/MAC failure; sync refuses payload |
| Update tampering | Signature failure; no install; rollback available |

## 13. Incident response

- A local "panic" action revokes all grants, disconnects channels, and stops all agents.
- On detected compromise: notify the user, disable the affected integration, rotate the
  relevant secret, and write a high-severity audit event.
- Crash/security reports are opt-in and scrubbed; the user previews the payload.
