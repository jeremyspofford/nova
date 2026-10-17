# 12 — Permissions, Security & Privacy

## 1. Threat model

| Asset | Threat | Mitigation |
| --- | --- | --- |
| Provider credentials | Theft via logs/DB/renderer | OS keychain only; never in renderer or model; redaction; secret scanning in CI |
| Network credentials | Theft by a compromised or injected sandbox process | Injected by the egress proxy, never present in the sandbox (§5, ADR-063) |
| User files | Exfiltration or tampering by a malicious tool/plugin | Permission profiles with protected paths, sandbox, egress allowlist, audit (§7) |
| External accounts | Unauthorized actions (send, purchase, delete) | Policy engine, confirmation tiers, approvals, auto-review, spend caps |
| Local network | SSRF / scanning | Egress deny-by-default; private-address blocking after DNS resolution; DNS pinning (§8) |
| Local listeners | Another local process or a web page drives the Hub or `novad` | Token or certificate on every listener; Origin/Host checks; 0600 sockets (§15) |
| Prompt injection | Malicious page/email/doc steers agent | Untrusted labeling, intent provenance, taint tracking, auto-review (§6) |
| External agents | Another AI agent steers a Nova agent or receives its data | External-agent rule (§6.2, FR-194) |
| Plugin/MCP supply chain | Malicious code | Signature verification, declared-permission enforcement, sandboxing |
| Sync channel | Eavesdrop/tamper | E2E encryption (XChaCha20-Poly1305), signed device keys, Argon2id KDF |
| Audit log | Tampering | Append-only hash chain; verification tool |
| Update channel | Malicious update | Signed releases; rollback; staged rollout |
| Model output | Leaking secrets into context | Secret redaction; vault isolation; per-thread secret policy |

The design assumption is **zero trust in everything that is not the user or the core
process**: renderer, plugins, MCP servers, tool output, other agents and remote content are all
untrusted.

## 2. Policy engine (FR-099)

Location: `packages/policy`. Pure, deterministic, unit-testable.

```ts
type ConfirmationTier = 'handoff_required' | 'confirm_at_action' | 'pre_approvable'; // FR-189
type Origin = 'user' | 'tool' | 'page' | 'file' | 'email' | 'channel' | 'mcp' | 'plugin'
            | 'memory' | 'capture' | 'external_agent' | 'system';

interface PolicyContext {
  actor: 'user' | { kind: 'agent'; id: string };
  scope: { kind: 'global'|'project'|'thread'|'run'|'session'|'agent'; ref?: string };
  // rules scoped to 'tool', 'plugin' or 'site' (policy-rule.json) match tool.name,
  // tool.pluginId and the resource host
  mode?: 'chat'|'work'|'code'|'agent';
  preset?: {                                   // labels for UI and audit only
    permissionMode?: 'manual'|'accept_edits'|'plan'|'auto'|'bypass';
    autonomy?: 'ask_first'|'standard'|'autonomous';
  };
  approvalPolicy: {                            // when to ask (ADR-059, §2.1)
    kind: 'ask_always'|'defaults'|'review'|'never_ask';
    autoAccept?: Array<'file_edit'>;
  };
  permissionProfile: { id: string; hash: string };   // what the sandbox allows (FR-190, §7.1)
  provenance: {                                // intent provenance (FR-189, §2.2)
    userInstruction?: { messageId: string; userId: string }; // typed by the authenticated user
    taint: Origin[];                           // untrusted origins that shaped the arguments
    namedAgents?: string[];                    // external agents the user named for this task
  };
  tool: ToolDescriptor;                        // contracts/schemas/tool-descriptor.json: name, source, annotations
  args: unknown;
  resource?: { kind: 'path'|'host'|'account'; value: string };
  environment: { kind: string; trusted: boolean;
                 substrate: 'os_sandbox'|'container'|'micro_vm'|'cloud' };
}

interface DecisionBase {
  reason: string;                              // the "why" on the approval card
  ruleId?: string;
  tier: ConfirmationTier;
  source: 'builtin'|'managed'|'rule'|'grant'|'tool_default'|'approval_policy'
        | 'fallback'|'hook'|'reviewer';
}
type Decision = DecisionBase & (
  | { effect: 'allow' }
  | { effect: 'ask'; scope: string; persistable: boolean } // false: no session/"always" option
  | { effect: 'handoff' }
  | { effect: 'deny' });
```

### 2.1 Approval policies and presets (FR-063, ADR-059)

The five permission modes and the agent autonomy levels are presets over two axes: an
**approval policy** (when to ask) and a **permission profile** (what the sandbox allows, §7.1).
The engine evaluates only the two axes; the preset name is recorded for display and audit.

| Approval policy | When the engine asks |
| --- | --- |
| `ask_always` | Every action that is not read-only and is not allowed by a rule or grant. |
| `defaults` | Per-tool defaults decide (read-only allow, consequential ask). `autoAccept: ['file_edit']` also allows file edits inside writable roots; they are captured as diffs. |
| `review` | Pre-approvable actions inside the profile are allowed; every consequential one goes to the auto-reviewer (§6.1), which can only tighten. |
| `never_ask` | An `ask` that comes from a tool default becomes `allow`. An `ask` from a user rule or managed policy, and the `confirm_at_action` and `handoff_required` tiers, still reach the user. |

| Preset | Approval policy | Permission profile |
| --- | --- | --- |
| Manual | `ask_always` | `workspace` |
| Accept edits | `defaults` + `autoAccept: ['file_edit']` | `workspace` |
| Plan (no source edits) | `ask_always` | `read-only` |
| Auto | `review` | `workspace` |
| Bypass | `never_ask` | `full` (VM or container substrate only) |
| Agent `ask_first` / `standard` / `autonomous` | `ask_always` / `defaults` / `review` | the agent's profile |

Auto cannot be selected while no reviewer model is configured. Managed policy can remove
presets (§10). `docs/10` §3 describes the user-facing behaviour of each mode.

### 2.2 Built-in safety, confirmation tiers and intent provenance (FR-189, ADR-062)

Built-in safety is immutable and evaluated first. It has two parts.

**Hard denies.** Secret exfiltration (secret values or vault content leaving through any
tool); writes to protected paths (§7.2, apart from its Git-tool rule); unlisted egress; any
request to run outside the sandbox or to remove it; CAPTCHA solving by the agent;
self-modification of safety, policy, audit or guardrail settings; and contact with an external
agent the user did not name (§6.2).

**Confirmation tiers.** Every other action is assigned one tier:

| Tier | Actions | Engine result |
| --- | --- | --- |
| `handoff_required` | The final step of a credential change; getting past a security warning or a paywall; CAPTCHAs | `handoff` |
| `confirm_at_action` | Purchases and payments; creating accounts, permissions, API keys or OAuth grants; installing software or browser extensions; deleting data outside the project or session scope; messages and posts to third parties unless a user-created standing rule names that recipient or channel | `ask` with `persistable: false`, at the moment of action. No rule, grant, hook or reviewer verdict can pre-approve it. |
| `pre_approvable` | Everything else | Evaluation continues (§2.3) |

The tier comes from the action's effect classes (the classes in
`contracts/schemas/policy-rule.json`), which the engine assigns from the tool descriptor (name,
source and annotations, including the `action` class), the resource, and, for browser and
screen actions, the page-action classifier (FR-095). If classification fails for an action with an external
effect, the stricter tier applies. A standing rule counts for the third-party-message exception
only if the user created or confirmed it in a Nova client; tools cannot create rules.

**Intent provenance.** Every context segment records its `Origin`. Only instructions that the
authenticated user typed or dictated and sent from a Nova client count as authorization
(`provenance.userInstruction`). Text that arrived through tools, pages, files, email, channels
(including the owner's own channel identity, `docs/13` §4), MCP servers, plugins, memory,
captures or other agents never does, even when it quotes or impersonates the user. A "take
action when you say so" rule (§3) is satisfied only by a user instruction in the current run
that asks for this action.

### 2.3 Evaluation order

Steps 1–6 are deterministic: the first decisive rule wins, but `deny` and built-in safety
always win over `allow`.

1. **Built-in safety** (§2.2).
2. **Managed policy** (§10).
3. **User custom rules**, including command prefix rules (§3.1), most specific scope first;
   then remembered grants (§4.2).
4. **Per-tool defaults** and **per-plugin/MCP permissions**.
5. **Approval policy** (§2.1).
6. **Fallback**: `deny` for unknown destructive tools; `allow` for read-only built-ins.

After the deterministic result:

7. **Hooks** (FR-197, ADR-068). A permission-request hook can tighten any decision, and may
   resolve an `ask` that came from step 3 or 4. It never changes a result from steps 1–2, a
   `handoff` or a `deny`.
8. **Review**, which can only tighten; the final decision is the strictest of the results
   (`deny` > `handoff` > `ask` > `allow`):
   - the page-action classifier (FR-095) checks every write action on an external page in
     every mode; a flagged action becomes `ask`;
   - the **auto-reviewer** (FR-085, ADR-061, §6.1) checks each consequential action whose
     decision is still `allow` under the `review` approval policy, and write actions on sites
     set to "Auto approve with review" (`docs/11` §4.4).
9. A remaining `ask` becomes an approval (§4).

Nova rejects an ordering in which a model reviewer runs before the user's custom rules or
stands in for the deterministic engine: the deterministic engine stays authoritative and
testable, and a model can only add caution (ADR-061).

An `allow` never changes the permission profile: the action still runs in the sandbox. When the
sandbox blocks a command, the failure returns to the agent. The agent may request a wider
profile for that one invocation, which is an `ask` like any other. Nova never retries a command
outside the sandbox on its own (ADR-059).

Every decision carries a human-readable reason, the tier, its source and, where applicable, a
rule id. This is the "why" shown on approval cards, and it is written to the audit event with
the permission profile hash.

## 3. Custom rules (FR-084)

User-facing rules in Settings → Personalization → Permissions:

| Rule | Meaning |
| --- | --- |
| Take action without asking | allow for the matched scope |
| Take action when you say so | allow only while a user instruction for this action is active (§2.2); otherwise ask |
| Ask before taking action | ask each time (default for consequential actions) |
| Hand off to you | the agent cannot do it; the user must |

Rule shape (`contracts/schemas/policy-rule.json`, stored as `policy_rule`, `docs/06` §2):

```jsonc
{
  "id": "rule_ask_customer_messages",
  "scope": { "kind": "agent", "ref": "<agentId>" },
  "match": {
    "tool": ["email.send", "slack.post"],
    "resource": { "host": "*.customer.com" },
    "effect": ["external_communication"]
  },
  "effect": "ask",
  "label": "Ask before messaging customers",
  "priority": 50,
  "enabled": true
}
```

Rules are **instructions the agent tries to follow**, not access grants: they cannot expand
app access or override built-in safety, they cannot pre-approve `confirm_at_action` or
`handoff_required` actions (§2.2), and they cannot bypass required confirmations (e.g., using a
saved login). Rules are editable, deletable and previewable: the preview lists recent actions
the rule would have matched.

### 3.1 Command prefix rules (FR-191)

A command rule matches the leading words of a command run through an exec tool and yields
`allow`, `ask` or `deny` with a justification. Command rules are **not** policy rules: each is a
`CommandRule` document (`contracts/schemas/command-rule.json`), stored in its own
`command_rule` table (`docs/06` §2) and listed beside the policy rules in Settings →
Permissions. A rule file holds a JSON array of them; there is no separate rule language.

```jsonc
[
  {
    "id": "rule_git_read",
    "scope": { "kind": "project", "ref": "<projectId>" },
    "tools": ["exec.run"],
    "pattern": ["git", ["status", "diff", "log", "show"]],
    "decision": "allow",
    "justification": "Read-only Git inspection inside the project.",
    "priority": 60,
    "matchExamples": ["git status", "git diff --stat HEAD~1", "git log -n 5 --oneline"],
    "notMatchExamples": ["git push origin main", "git commit -m wip", "gitk", "sudo git status"],
    "source": "user"
  },
  {
    "id": "rule_no_recursive_rm",
    "scope": { "kind": "global" },
    "pattern": ["rm", ["-r", "-rf", "-fr", "-R"]],
    "decision": "deny",
    "justification": "Use fs.delete: it lists the paths and can be undone from the session history.",
    "matchExamples": ["rm -rf build", "rm -r node_modules"],
    "notMatchExamples": ["rm build/app.o", "rmdir build"],
    "source": "user"
  }
]
```

| Field | Rule |
| --- | --- |
| `id`, `scope`, `pattern`, `decision`, `matchExamples`, `notMatchExamples`, `source` | Required |
| `scope.kind` | `global` \| `project` \| `thread` \| `session` \| `agent` (with `ref`) |
| `tools` | Exec tools the rule applies to; default `["exec.run"]` (lines sent with `exec.write` to a shell session are matched too, `docs/08` §1.1) |
| `pattern` | Token prefix, at least one element; each element is a literal word or a list of at least two alternatives |
| `decision` | `allow` \| `ask` \| `deny` (no `handoff`: a handoff comes from built-in safety, not from a command rule) |
| `priority` | 0 to 1000, default 100 |
| `justification` | Up to 500 characters, shown in prompts and denials |
| `hostExecutables` | Absolute paths a bare command name may resolve to besides the sandbox `PATH` |
| `source` / `pluginId` | `user` \| `managed` \| `plugin`; `pluginId` names the plugin |
| `enabled` | Default `true` |

Matching:

- Commands are split into words by a shell-grammar parser without expansion. Each `pattern`
  element is a literal word or a list of alternatives; the rule matches when the command's
  first words equal the elements in order.
- A compound command (`;`, `&&`, `||`, `|`, newline) matches an `allow` rule only if every part
  matches an `allow` rule. An `ask` or `deny` rule applies if any part matches it.
- A command that cannot be parsed with certainty (command or process substitution, `eval`,
  unbalanced quoting, here-documents with expansion) never matches an `allow` rule.
- Wrappers (`sudo`, `env`, `nice`, `timeout`, `nohup`, `xargs`, `sh -c`, `bash -c`, `cmd /c`,
  `powershell -Command`) are looked through when matching `deny` and `ask` rules, and never
  match an `allow` rule unless the rule names the wrapper.
- A bare command name in a rule matches that name resolved on the sandbox `PATH`, or an
  absolute path listed in the rule's `hostExecutables`; any other path does not match an
  `allow` rule.
- A `deny` justification should name the alternative; it is returned to the agent.

Load-time examples:

- Every command rule carries at least one `matchExamples` and one `notMatchExamples` entry
  (a command line, split with shell rules, or a pre-split word list).
- When the rule file loads, every `matchExamples` entry must match the rule and every
  `notMatchExamples` entry must not. One failure rejects the whole file: the previous version
  stays in effect and Settings names the failing rule and example.

"Always allow" on a command approval (§4.1) appends a `command_rule` at the chosen scope
(`alwaysScope.kind = prefix_rule` in `contracts/schemas/approval-decision.json`). The card shows
the prefix that will be saved and one command it will not cover; the approved command becomes
a `matchExamples` entry and the other command a `notMatchExamples` entry.

An `allow` rule decides only whether to ask. It never removes the sandbox and never widens the
permission profile (ADR-059).

## 4. Approvals (FR-100, ADR-060)

### 4.1 Decisions

| Option | Effect | Offered for |
| --- | --- | --- |
| **Allow once** (`allow_once`) | This call only | `pre_approvable`, `confirm_at_action` |
| **Allow for this session** (`allow_session`) | A grant that ends with the session or run | `pre_approvable` |
| **Always allow** (`allow_always`) | A persistent grant scoped to the tool, a command prefix rule (§3.1) or a network host; writes a `permission_grant` plus a `policy_rule` (tool or host) or a `command_rule` (prefix rule) | `pre_approvable`, unless managed policy disables persistent grants |
| **Deny and continue** (`deny_continue`) | The call fails; the user's optional reason returns to the agent as the tool result; the run continues | all tiers |
| **Deny and stop** (`deny_stop`) | The call fails; the run and its child work stop until the user's next message | all tiers |
| **Hand off** (`handoff`) | The user performs the action (takeover, FR-087); the agent waits | all tiers |
| *`timeout`* | Recorded by the system (`decidedBy: system`) when nobody answers before `expiresAt`; never sent by a client | — |

- One consistent approval card across modes, plus an OS notification.
- The card shows the action, target, reason, scope, tier, risk, provenance (whether the user
  asked for this), the rule or check that triggered it, and the reviewer's rationale if any.
- An approval can be answered from the card, a notification, a channel (`docs/13` §4) or as a
  server-to-client request (FR-188); exactly one answer resolves it. `confirm_at_action` and
  `handoff_required` approvals are answered only in a Nova client.
- **Timeout**: default 24 h. The outcome is recorded as the decision `timeout`
  (`contracts/schemas/approval-decision.json`) and the run pauses (status Needs input,
  `pause_reason = approval_timeout`). A timeout never counts as allow.
- After **Deny and continue**, an identical call (same tool and argument hash) in the same
  session is denied without asking again.
- A reviewer-denied action (§6.1) can be approved with **Allow once** only; the override is
  audited together with the verdict.
- Decisions are remembered per scope, listed and revocable in Settings → Permissions, and
  audited.

### 4.2 Time-boxed grants

Every `permission_grant` has an expiry (`expires_at`, null = until revoked). An expired grant
asks again.

| Grant | Default lifetime |
| --- | --- |
| Allow for this session | End of the session or run |
| Always allow | Until revoked |
| Computer-use app grant (FR-207) | 30 min, renewable from the indicator |
| Private-address (dev-server) access (§8) | End of the session |
| Extension-bridge host grant (FR-096) | Until revoked |

The card offers a shorter lifetime (15 min, 1 h, end of day). The panic action (§13) revokes
every grant.

## 5. Secrets (FR-101)

- **Storage**: OS keychain via a cross-platform wrapper; encrypted-file vault fallback using
  Argon2id (user passphrase) + XChaCha20-Poly1305.
- **Access**: only `SecretBroker` in the core/agent process resolves values, and only for the
  duration of a call. Values are never returned to the renderer or included in model context;
  tools see `secret://` references.
- **Redaction**: a centralized scrubber removes known secret patterns (keys, tokens, bearer
  headers, connection strings) from logs, traces, tool results, and error reports.
- **Network credentials are injected by the egress proxy** (ADR-063, FR-193). A secret binding
  (secret reference, host patterns, header or scheme) is declared by a connector, a plugin
  manifest or the user. The proxy adds the credential to matching requests after terminating
  TLS with a per-Hub CA; sandboxes trust only the CA's public certificate, and the CA key never
  leaves the proxy. Credentials never enter the sandbox: not in environment variables, files or
  arguments. The proxy removes the injected value from responses before they reach the
  sandbox. A request that cannot be inspected receives no credential.
- **Environment-variable injection** remains only for tools that cannot use a proxy (for
  example a database driver). It is declared per tool in the manifest, shown at install,
  audited on every launch, and the value is scrubbed from the tool's output.
- **Imported secrets** (FR-200): any secret found in imported configuration (MCP environment
  values, tokens, passwords) moves into the keychain and is replaced by a `secret://` reference
  before anything is written. The import preview shows how many secrets will move, with values
  masked.
- **CI**: `gitleaks` (or equivalent) + a custom rule set; failing build on detection.

## 6. Prompt-injection defense (FR-103)

- **Instruction separation**: user/system instructions are a privileged channel; tool output,
  web pages, emails, channel messages, captures and file contents are always wrapped in
  explicit `untrusted` delimiters.
- **Intent provenance** (FR-189, §2.2): only instructions the authenticated user typed count as
  authorization. Captured content can never directly trigger a consequential action (ADR-074).
- **Taint tracking**: data derived from untrusted sources carries its origins
  (`provenance.taint`) through the context. Tainted arguments cannot satisfy a "take action
  when you say so" rule, and the reviewer sees the taint.
- **External agents** (§6.2, FR-194).
- **Auto-review** of consequential actions (§6.1, FR-085).
- **Injection canary tests** and the persistence evals (FR-123, FR-224) must fail safely.
- Tool output that appears to contain instructions is surfaced to the user as a suspicious
  finding, not executed.

### 6.1 Auto-reviewer (FR-085, ADR-061)

| Aspect | Contract |
| --- | --- |
| Position | After the deterministic engine and hooks (§2.3 step 8). The verdict can only tighten. |
| Scope | Consequential actions still `allow` under the `review` approval policy; write actions on sites set to "Auto approve with review" (`docs/11` §4.4). The lighter page-action classifier (FR-095) covers external-page writes in every mode. |
| Input | The proposed action (tool, arguments, resource, effect classes, tier); the user's instructions for the run with their provenance; standing instructions and the rules that applied; a bounded summary of the run so far. Untrusted content stays inside untrusted delimiters. |
| Isolation | A separate model call in a sandbox with the `read-only` profile and network off (or `limited` over the parent's allowlist for read-only checks). It inherits no allow rules, grants or session approvals, cannot call write tools and cannot ask the user. |
| Output | Strict JSON validated against a schema, no extra fields: `outcome` (`allow` \| `ask` \| `handoff` \| `deny`), `risk` (`low` \| `medium` \| `high` \| `critical`), `userAuthorization` (`unknown` \| `low` \| `medium` \| `high`), `rationale` (≤ 1,000 characters). |
| Failure | 90 s per attempt; up to 3 attempts on timeout, malformed output or error, then `deny` (fail closed). A valid `deny` is not retried. |
| Circuit breaker | 3 consecutive denials, or 10 denials in the last 50 reviews of a run, interrupt the run (status Needs input) and notify the user. |
| On deny | The agent receives the rationale and an instruction to avoid substantively similar actions. |
| Override | The user can **Allow once** from the card; the override is audited with the verdict. |
| Sensitive actions | `handoff_required` actions always hand off; no verdict changes that. |
| Audit | Every review records the action hash, verdict, attempts, latency and reviewer model id. |
| Measurement | FR-224: recall per threat category (data disclosure, destructive actions, financial commitments, access and security changes, unauthorized communication, ambiguous authorization) on labelled disallowed actions, and denial rate on benign traffic, each with a regression threshold (`docs/16` §5). |

The reviewer's policy prompt is Nova's own and is versioned with the eval set that measures it.

### 6.2 External agents (FR-194)

- Content produced by other AI agents (email, chat, channels, pages, plugins, MCP servers,
  captures) is untrusted data.
- The engine treats a counterpart as an external agent when it is an agent-protocol endpoint
  (FR-203), an MCP tool or plugin annotated as an agent, a channel identity flagged as a bot,
  or an address the user or the reviewer marked as an agent.
- A Nova agent never accepts tasks from an external agent. Delegating to or sending data to
  one is allowed only when the user's instruction for the current task named that agent
  (`provenance.namedAgents`). Every other attempt is denied by built-in safety and audited
  with cause `external_agent`.

## 7. Sandboxing (FR-107)

- All agent execution occurs in a sandbox; unsandboxed execution is never the default and is
  never a fallback.
- Every execution runs under a permission profile (§7.1). The concrete sandbox profile is
  generated from it and the effective policy, and its hash goes into the audit event.
- The broker canonicalizes paths (rejecting symlinks/`..` escapes), pins DNS, limits
  resources, and caps output.
- Failure to create the sandbox fails closed (`docs/11` §10).

### 7.1 Permission profiles (FR-190)

A profile is filesystem entries plus a network block. Entries grant `read`, `write` or `deny`
on a path or on a token: `project` (the session's project roots), `tmp` (a per-session temp
directory), `minimal` (system libraries and toolchains needed to run commands), `home` (the
user's home directory). Profiles may extend one another; `deny` wins over `read` and `write`.

```jsonc
{
  "id": "workspace-net",
  "name": "workspace-net",
  "extends": "workspace",
  "filesystem": [
    { "path": ":project", "access": "write" },
    { "path": ":tmp", "access": "write" },
    { "path": ":minimal", "access": "read" },
    { "path": ":home", "access": "deny" }
  ],
  "network": { "mode": "allowlist", "allow": ["registry.npmjs.org", "pypi.org"] }
}
```

| Built-in profile | Filesystem | Network |
| --- | --- | --- |
| `read-only` | read `project` and `minimal` | `off` |
| `workspace` | write `project` and `tmp`; read `minimal`; everything else denied | `off` |
| `full` | write the whole guest filesystem | `allowlist` — only inside a VM or container substrate |

Network modes are `off`, `allowlist` and `limited` (§8). The network block also carries
`allow` and `deny` host lists, `socks5` and `allowLocalBinding` (dev-server access to private
addresses, still limited to granted hosts and ports, §8). Protected paths (§7.2) apply to every
profile, including `full`.

### 7.2 Protected paths

Inside writable roots, including when a whole drive is shared, these stay read-only or denied:

| Path | Access |
| --- | --- |
| `.git` | read-only |
| `.nova`, `.agents` (project config, rules, skills) | read-only |
| Shell startup files (`.bashrc`, `.zshrc`, `.profile`, PowerShell profiles) | read-only |
| The Nova data directory, including the vault and rule files | denied |
| Credential locations: `.ssh`, `.gnupg`, `.git-credentials`, `.netrc`, cloud CLI folders (`.aws`, `.azure`, `.config/gcloud`, `.kube`), package-manager credentials (`.npmrc`, `.pypirc`, `.cargo/credentials*`, `.docker/config.json`), browser profiles, OS keychains and credential stores | denied |

- Matching uses the canonical path, at any depth inside a writable root.
- Renaming or deleting an ancestor directory of a protected path is denied, so the path
  cannot be swapped out.
- Git writes go through the `git.*` tools (`docs/10` §4), not arbitrary commands: after policy
  allows the Git action, the broker runs that one invocation with `.git` writable except
  `.git/hooks` and `.git/config`, which stay read-only; repository hooks run only in the
  session sandbox (FR-211).
- The list is data in `packages/policy`; the security suite enumerates it (§12).

### 7.3 Substrates

| Platform | Default sandbox | Detail |
| --- | --- | --- |
| Linux | bubblewrap with namespaces, no-new-privs and seccomp | `docs/11` §2.5 |
| macOS | seatbelt, deny-by-default profile | `docs/11` §2.5 |
| Windows | restricted, write-restricted tokens with per-root capability SIDs (ADR-064) | `docs/11` §2.4 |
| Any | container, or the flagged micro-VM (FR-195, ADR-065) | `docs/11` §2.2 |

The Windows design, in summary: random capability SIDs per allowed root, saved once; folder
ACLs grant write only to those SIDs, and a root's SID is in the token only while that root is
allowed; hidden offline and online sandbox users created by a one-time elevated setup; a
private desktop per launch; firewall rules installed broad-then-narrowed so a mode change never
fails open; an optional OS container mode; kill-on-close job objects. AppContainer is not used.

## 8. Egress control (FR-102, FR-193)

Every sandbox, container and VM reaches the network only through the egress proxy. The proxy
runs in `sandboxd` on the machine that hosts the sandbox (for Hub-side runs, on the Hub) and
enforces the Hub's effective policy. It offers an HTTP(S) proxy and SOCKS5 for non-HTTP
clients; the substrate blocks every other route (`docs/11` §7).

| Mode | Behaviour |
| --- | --- |
| `off` | No route to the proxy; no network. |
| `allowlist` | Only allowed host patterns. Deny entries always win over allow entries. A bare `*` is rejected when the list loads; a wildcard is allowed only as the leftmost label (`*.example.com`). |
| `limited` | The allowlist, plus only `GET`, `HEAD` and `OPTIONS`. HTTPS is terminated by the proxy to check the method; HTTPS that cannot be inspected is blocked. |

- **Default**: deny. Explicit allowlists per scope (run, session, agent, plugin, MCP server),
  visible in Settings → Network. Destinations are approved through the card ("Always allow"
  scoped to a host) when the approval policy asks; otherwise the request is denied.
- **Private addresses**: the proxy resolves every hostname itself and pins the address for the
  connection. A destination that is, or resolves to, a private, loopback, link-local,
  carrier-grade NAT, unique-local or multicast address is blocked unless the permission
  profile sets `network.allowLocalBinding` (`contracts/schemas/permission-profile.json`) **and**
  a dev-server grant covers that host and port (§4.2). Redirect targets are checked as new
  requests.
- **Blocked responses**: HTTP 403 with `X-Nova-Block-Cause: allowlist | denylist | method |
  private_address | inspection | policy`, and a short body naming the host and how to request
  access.
- **Audit**: every decision, allow or deny, writes a structured `audit_event` (kind `network`):
  run, session and sandbox ids, method, host, port, resolved address class, mode, decision,
  cause, rule id, bytes in and out. Bodies and full URLs are not stored by default.
- **Credential injection** for allowed hosts (§5, ADR-063).
- **Credential-stripping hooks**: rules on inspected requests match host, method and path
  prefix and apply named actions (`strip_header`, `strip_cookies`, `block`); for example,
  remove `Authorization` from writes to a code host. Hooks can only tighten.
- A policy decider may turn an allowlist miss into an `ask`; nothing turns a deny into an
  allow.
- The proxy strips tracking headers. VM guests have IPv6 off.

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

## 10. Managed policy (FR-106, ADR-078)

An administrator delivers policy through an OS-protected channel, trusted because only an
administrator can write it, or as a signed remote policy:

| Channel | Location | Trust |
| --- | --- | --- |
| Linux | `/etc/nova/managed-policy.json`, owned by root, not group- or world-writable, in a root-owned directory | file ownership and mode |
| macOS | a device-management configuration profile for Nova's preference domain, or `/Library/Application Support/Nova/managed-policy.json` owned by root | OS profile management / ownership |
| Windows | the machine policy registry (`HKLM\SOFTWARE\Policies\Nova`) | registry ACL (administrators only) |
| Remote | delivered by the Hub to devices, or fetched by the Hub from an admin URL | Ed25519 signature by an admin key pinned through one of the channels above |

```jsonc
{
  "version": 1,
  "permissionModes": { "allow": ["manual", "plan", "accept_edits", "auto"], "denyBypass": true },
  "approvals": { "allowPersistentAlways": false, "approvalTimeoutHours": 8 },
  "tools": { "deny": ["screen.*"], "ask": ["exec.run"] },
  "builtInTools": { "deny": ["appshot.capture", "devserver.*"] },
  "mcp": { "servers": { "allow": ["corp-docs", "corp-tickets"], "deny": ["shell-anything"] },
           "allowUserAdded": false, "allowLocalStdio": false },
  "plugins": { "allowlist": ["com.corp.*"], "disableMarketplace": false, "requireSigned": true },
  "localSessions": { "enabled": true },
  "sshHosts": { "allow": ["*.build.corp.example"] },
  "workspaceFolders": { "allow": ["~/src", "/work"] },
  "browser": {
    "domains": { "allow": ["*.corp.example"], "deny": ["*.bank.example"] },
    "devProtocolMode": false, "extensionBridge": false
  },
  "egress": { "mode": "allowlist", "allow": ["registry.npmjs.org", "*.corp.example"],
              "deny": ["paste.example"] },
  "telemetry": { "forceOff": true },
  "telemetryExport": { "otlpEndpoint": "https://otel.corp.example:4318", "includeContent": false },
  "modelRouting": { "allowProviders": ["local", "corp-gateway"],
                    "endpoints": { "corp-gateway": "https://llm.corp.example/v1" } },
  "retention": { "threadsDays": 90, "auditDays": 365, "screenshotsDays": 7 },
  "agents": { "capabilities": { "computerUse": false, "channels": true, "selfSchedule": true,
                                "proactiveResearch": false, "externalAgents": false } },
  "ambient": { "allowed": true, "sources": ["screen"], "pixels": "deny",
               "exclusions": ["com.corp.hr"], "externalAccess": "deny" }, // full block: docs/24 §9.6
  "appearance": { "lockTheme": true, "theme": "corp-dark" },
  "sync": { "requireE2EE": true }
}
```

- Managed policy overrides user settings for the listed keys, and the UI marks them "managed by
  your organization".
- The Hub reads its host's channel and applies it to every run. Each `novad` reads its own
  device's channel and also enforces the Hub's policy.
- When several sources are present, the most restrictive value wins: allow lists intersect,
  deny lists merge, and a disabling switch wins.
- A file in a user-writable location, a file with wrong ownership or mode, and an unsigned or
  badly signed remote policy are ignored with a warning; the last valid policy stays in force.
- A policy from a trusted channel that fails to parse or validate fails closed: agent tools are
  denied and Diagnostics names the error until it is fixed.

## 11. Audit log (FR-104)

- Append-only `audit_event` with a hash chain (`prev_hash`, `hash`); a `verify` command checks
  integrity and reports the first break.
- Records: actor, kind, action, resource, input hash (not raw inputs by default), decision
  (with tier, source and rule id), result, permission profile hash, and context ids. Network
  decisions (§8), reviewer verdicts and overrides (§6.1), and grant creation, expiry and
  revocation (§4.2) are audited.
- Exportable as JSONL for compliance; filterable by actor/scope/time in the Activity view.
- Sensitive raw inputs can be recorded only if the user opts in; defaults store hashes.

## 12. Security testing (FR-123)

| Test | Expectation |
| --- | --- |
| Policy bypass (crafted args, path traversal, symlink) | Denied + audited |
| Write to a protected path (`.git/config`, `.nova/rules.json`, `~/.ssh/authorized_keys`, `.bashrc`) under `workspace` and `full`; rename of an ancestor directory | Blocked by the sandbox; audited |
| Command prefix rule file with a failing `match` or `notMatch` example | Whole file rejected at load; previous rules stay; Settings names the rule and example |
| Compound or wrapped command (`git status && curl …`, `sudo git status`, `$(…)`) against an allow rule | Not allowed by the rule; falls through and asks |
| Command allowed by a rule that writes outside the profile | Still sandboxed; write fails; no unsandboxed retry |
| "Always allow" or a standing rule for a `confirm_at_action` action (purchase, OAuth grant) | Not offered; rejected by the API; asks at the moment of action |
| Injected text that quotes or impersonates the user | Not authorization; "when you say so" rule not satisfied |
| Secret leakage (log/trace/error/tool result) | Redacted; no plaintext anywhere |
| Proxy-injected credential: sandbox reads its environment, files and process list and calls an echo endpoint | Credential never visible inside the sandbox |
| Injection payloads (web/file/email) | Treated as data; no unauthorized action |
| Reviewer timeout, malformed JSON or error | `deny` after 3 attempts; audited |
| Reviewer denials: 3 consecutive, or 10 of the last 50 | Run interrupted; user notified |
| Engagement with an external agent the user did not name | Denied + audited (`external_agent`) |
| Sandbox escape attempts | Blocked; process killed; audited |
| Egress to unlisted host | Blocked by proxy; 403 with cause `allowlist` |
| Hostname resolving to a private address (DNS rebinding) | Blocked; 403 with cause `private_address` |
| `*` in an egress allowlist | List rejected at load |
| `POST` in `limited` mode; uninspectable HTTPS in `limited` mode | 403 with cause `method` / `inspection` |
| Listener request without a token or with a wrong token (Hub HTTP and WebSocket, `novad` socket or pipe, MCP server endpoint) | Refused (401); nothing processed |
| WebSocket upgrade with a non-allowlisted `Origin` or `Host` | Refused (403) |
| Unix socket created by Hub or `novad` | Mode 0600, owned by the service user |
| Managed policy file writable by a non-admin; unsigned remote policy | Ignored with a warning; last valid policy stays |
| Malicious plugin/MCP | Permission violation blocked; plugin disabled |
| Sync tampering | Signature/MAC failure; sync refuses payload |
| Update tampering | Signature failure; no install; rollback available |

## 13. Incident response

- A local "panic" action revokes all grants, disconnects channels, and stops all agents.
- On detected compromise: notify the user, disable the affected integration, rotate the
  relevant secret, and write a high-severity audit event.
- Crash/security reports are opt-in and scrubbed; the user previews the payload.

## 14. New capability security (added)

**Ambient capture.** Off by default; per-source toggles; sensitive-app/site exclusions on by
default; on-device redaction; captures are untrusted input, never count as user intent
(FR-189) and can never directly trigger a consequential action (ADR-074); cloud OCR/STT only if
enabled per source and logged.

**Automations & smart home.** Physical-world actions (locks, alarms, garage, thermostats) are
high-risk and require approval or an explicit scoped standing rule; rate limits and loop
prevention; integration credentials in the keychain; managed policy can disable classes.

**Community extensions.** Signed catalogs/bundles, runtime permission enforcement,
dependency/secret scanning, report/takedown, and a fleet-wide kill switch (`docs/26` §5).

**Learning & self-improvement.** Guardrails on by default; the agent may not modify policy,
safety, permissions, audit, signing, or the self-improvement gates unless an administrator
explicitly disables the guardrail (audited). L4 changes are sandboxed, tested, staged, and
reversible; attempts to weaken guardrails are denied and logged high-severity.

## 15. Listener and integration hygiene (FR-192, ADR-075)

- **Every listener authenticates.** Hub HTTP and WebSocket endpoints, `novad` Unix sockets and
  named pipes, Nova's MCP server endpoint and any helper port require a token or a client
  certificate. Loopback is never treated as authorization: other local users, local processes
  and web pages can all reach loopback.
- **Local tokens** are 256-bit random values, stored in the keychain or a 0600 file readable
  only by the service user, compared in constant time, and rotated on demand and when `novad`
  is reinstalled.
- **Origin and Host checks.** A WebSocket upgrade or HTTP request whose `Origin` is present and
  not on the Hub's allowlist, or whose `Host` is not one of the Hub's configured names, is
  refused (this also defeats DNS rebinding). Native clients send no `Origin` and authenticate
  by token and certificate.
- **Sockets and pipes.** Unix sockets are mode 0600 in a 0700 directory owned by the service
  user. Named pipes are ACL'd to the user and the system account and reject remote clients.
- **One-shot callbacks.** An OAuth loopback redirect listener binds to `127.0.0.1` on a random
  port, accepts only the expected `state`, and closes after one request or 5 minutes.
- **No writes into other applications.** Nova never adds itself, its keys or its skills to
  another application's configuration, skill folders or startup files. The one exception is
  the extension bridge's native-messaging host manifest (`docs/11` §4.3): Nova writes only its
  own manifest, only when the user enables the bridge, and removes it on disable.
- **Exposing Nova's MCP server** to an external client is an explicit action in Settings →
  Integrations. It issues a per-client token scoped to named tools and resources (read-only by
  default), with an expiry; it is revocable, and every call is audited with the client id and
  passes the policy engine.
- Listeners bind only to configured interfaces. A port conflict produces a diagnostic and a
  fallback port, never a silent exit (FR-225).
