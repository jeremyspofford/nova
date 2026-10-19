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

*As built in M7 (ADR-095).* The sync channel is Hub-canonical (`docs/13` §2): there is no
account master key; the Relay carries replica traffic sealed end to end (`docs/22` §3.1) and the
web replica is sealed under a non-extractable key on the device. Two assets join the table:

| Asset | Threat | Mitigation |
| --- | --- | --- |
| One person's data on a shared Hub | A member, a removed member or a team agent reaches the owner's files, memory, connectors or machine | Account scoping on every route, an owner-only route list, a folder of its own for every non-owner account, public addresses only for non-owners, narrowing-only allow lists (§1.1) |
| Work on a cloud runner | A compromised runner lies to the Hub; a command escapes to the runner host or other tenants | The Hub trusts no path the runner reports and reads bounded answers; the runner sandboxes every command with process, memory, CPU, wall and disk limits, per-token command shares and no network by default (§7.4) |

### 1.1 Several people on one Hub (M7)

*As built in M7 (decision 5 of ADR-095; `packages/core/src/team`, `apps/hub/src/team.ts`).* A Hub
has one owner (the recorded owner row, the one test used everywhere: auth, sync, trust, operations
and consolidation) and may have members and team agents' identity accounts. Every
account-scoped route shows a caller only its own account's data; on top of that:

- **Owner-only routes.** A preHandler refuses any account that is not the owner, with 403
  `policy_denied` `{reason: owner_only}`, on the routes that administer the Hub or reach its
  machine (`OWNER_ONLY_ROUTES`; the list is in `contracts/hub-api.md` §1): settings, trust,
  network, Relay, devices, nodes, diagnostics, plugins and hooks installed for everyone, files,
  terminals, host folders, imports, Code environments, the cloud runner, external agent adapters,
  MCP bundles and the shared publish folder. A member may add remote MCP servers but never a stdio
  one. Members keep their own appearance, keyboard and onboarding preferences; `instructions.md`
  is the owner's alone. New Hub-administration routes must join the list: a route missing from
  it is open to members (scoped to their own account), so a review of each new area checks it.
- **Folders.** Every non-owner account's chats, runs and tools work in
  `<dataDir>/members/<id>/workspace`, never the Hub's workspace or configured roots, including tool
  calls with no thread (the policy sources are asked with thread id `''`). The browser's fallback
  profile and files folders and plugin drafts are per account.
- **Addresses.** A non-owner's provider base URLs and provider tests, MCP servers over http or SSE,
  MCP OAuth discovery and email servers are resolved, checked and pinned for the connection; a
  private, loopback or otherwise non-public address is refused (`private_address`;
  `packages/core/src/team/public-net.ts`; email keeps the TLS server name). `browser.allowLocalSites`
  is ignored for them.
- **Allow lists only narrow.** A non-owner's egress scope allow lists and browser site allow rows
  are intersected with `network.egressAllow`, so they can never add a host the owner did not allow.
- **Removal.** Removing a member revokes their sessions, closes their open sockets (4401
  `account_closed`) and event streams, disables their schedules, triggers, channel bindings and
  MCP servers, ends their MCP event and push subscriptions and stops their agents; turns, runs,
  triggers and sign-ins of a closed account are refused (`account_closed`).
- **Events.** Account-less system events (network, trust, Relay) go only to the owner's streams.
- **Shared threads** use an allow-list of built-in tools, not tainting (`docs/13` §7): nothing in
  them reaches the host, and another participant's words never run under the caller's authority
  (a message written offline is never answered in a shared thread, `docs/13` §2.3).
- **Team agents** run in their own identity account with credentials bound to it; each task runs
  in its own thread labelled by the requesting account (display names cut to one line), so tasks
  of different people never share history.
- **Bounded shares.** A non-owner may use at most half of the browser's slots and evicts only its
  own idle sessions; pending OIDC sign-ins are capped at 10 per address and 1,000 in all.
- **OIDC** binds the callback to the browser that started (`nova_oidc_binding`, HttpOnly,
  SameSite=Lax, 10 minutes, compared by hash in constant time), so a link or sign-in URL another
  person completes, or that leaks, is refused (`browser_mismatch`).

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
        | 'fallback'|'plugin'|'user_action'|'hook'|'reviewer';   // plugin, user_action: ADR-091
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

**Per-thread policy as shipped** (M5, ADR-092). Code sessions (the permission mode) and Work runs
(the autonomy level) are per-thread policy sources. The first source that knows a thread wins.
Its approval policy replaces the `tools.approvalPolicy` setting (Accept edits adds
`autoAccept: ['file_edit']`), its profile replaces the one in the request, and its roots replace
the settings' roots and project folders. The gate and the tool runtime read the same sources, so
the roots a tool runs with are the roots the gate checked. A source that throws denies every
call. The permission mode and the run id are recorded in the policy context and the audit
detail. Bypass needs `code.allowBypass` (security-relevant) and a container or micro-VM
substrate where the session's commands run (M6: never on another machine). When an Auto or Bypass condition lapses mid-session, the session runs with Manual's
axes. A sub-agent whose tool list holds only reading tools runs under `read-only`.

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

**Direct user actions** (ADR-091, refining the fallback above). When the signed-in user performs
an action directly in a Nova client, such as saving a file in the editor, the action is its own
confirmation: the call has actor `user`, the user's own instruction and no taint, so the engine
allows it at steps 4 to 6 without a card (`source: 'user_action'`). It still passes built-in
safety, managed policy, user rules and denies, the `confirm_at_action` and `handoff_required`
tiers and the network allowlist, and a policy change or a secret read still asks. This also
overrides `ask_always` and the user's own "ask" defaults, because the user just acted. Nothing
else counts as a direct action:

- A tool call from an MCP App (`POST /tools/:name/invoke` defaults to `initiator: 'app'`) has no
  user instruction, so under the default policy a call that is not read-only asks.
- A turn started by a stop hook's continuation carries provenance `hook`, is tainted and has no
  user instruction; the chat labels its message **Hook**. Its events use actor `system`, with the
  hook id as the turn's `trigger_ref`.
- Calls from an external MCP client (origin `mcp_client`) and from hooks (origin `hook`) never
  carry a user instruction.

**Turns Nova starts** (M5, ADR-092). Runs, schedules, goals, sub-agents and Code sessions start
turns whose text is stored as a user-role message labelled with its author (`run`, `schedule`,
`goal`, `subagent`, `system`), never as "You". Only text the user typed in a Nova client carries
the user's authority: a run objective entered in New run, a schedule's instructions, a redirect,
and the objective of a run proposed in a chat once the user presses **Start run**. A run the model
escalates on its own (`auto`), a sub-agent's task, a goal continuation and Nova's own messages
carry none and taint the turn; resuming or restarting a run keeps the authority it already had.
Context a mode adds that did not come from the user, such as the chat excerpt of an escalated run,
is wrapped as untrusted and taints the turn. The user's answer to `ask_user` comes back as an
untrusted tool result: in M5 it does not carry their authority for the rest of the turn.

**Memory reads only what the user typed** (M5, ADR-092). Memory consolidation reads Nova's replies
and only the messages the user typed into a conversation. Run objectives, schedule fires, goal
continuations, sub-agent tasks, hook continuations and Nova's own messages are skipped, so text the
user did not write never becomes a memory about the user.

### 2.3 Evaluation order

Steps 1–6 are deterministic: the first decisive rule wins, but `deny` and built-in safety
always win over `allow`.

1. **Built-in safety** (§2.2).
2. **Managed policy** (§10).
3. **User custom rules**, including command prefix rules (§3.1), most specific scope first;
   then remembered grants (§4.2).
4. **Per-tool defaults** and **per-plugin/MCP permissions**. Plugin permissions are enforced,
   never trusted as a grant (FR-045, ADR-091): a call that names a host the owning plugin did
   not declare is denied already at step 1 ("<host> is not a host this plugin declared"), and
   every http(s) and ws(s) URL in the arguments is checked, nested ones included. Hosts the
   plugin declared need no network-allowlist entry, because the user confirmed them at install.
   At this step the user's own defaults come first, then the plugin's per-tool and per-action
   defaults; a tool the plugin did not declare asks, and permissions that cannot be read deny.
5. **Approval policy** (§2.1).
6. **Fallback**: `deny` for unknown destructive tools; `allow` for read-only actions (below).

After the deterministic result:

7. **Hooks** (FR-197, ADR-068). A permission-request hook can tighten any decision, and may
   resolve an `ask` that came from step 3 or 4. It never changes a result from steps 1–2, a
   `handoff` or a `deny`. In M4 (ADR-091) the engine marks an `ask` **answerable** only when it
   came from a user rule, a per-tool default or the plugin's permissions and no built-in floor
   (a confirmation tier, intent provenance or the network allowlist) asks as well; the approval
   policy and managed policy are never answerable. The gate re-checks every answer: managed and
   user hooks may answer, plugin hooks only with `hooks.answersAsks`, project hooks never. A
   hook that errors, times out or cannot start denies (it fails closed), and a `tool.pre` hook
   that fails blocks the call before the gate runs. The decision records `source: 'hook'` and
   the hook id.
8. **Review**, which can only tighten; the final decision is the strictest of the results
   (`deny` > `handoff` > `ask` > `allow`):
   - the page-action classifier (FR-095) checks every write action on an external page in
     every mode; a flagged action becomes `ask`;
   - the **auto-reviewer** (FR-085, ADR-061, §6.1) checks each consequential action whose
     decision is still `allow` under the `review` approval policy, and write actions on sites
     set to "Auto approve with review" (`docs/11` §4.4).
9. A remaining `ask` becomes an approval (§4).

**Read-only actions.** An action is read-only when a built-in tool's own annotation says so, or
when the owner declared an MCP tool read-only in Settings (`userReadOnly`, `docs/08` §1) and its
action class, destructive hint and effects (declared and inferred) say nothing changes. Read-only
actions skip the intent-provenance and network-allowlist floors, are not sent for review, and
match `readOnly: true` rules, so an agent's proactive research (whose thread denies
`readOnly: false`, `docs/09` §8) may use them. At steps 4–6 the owner's per-tool and per-server
defaults still come first; only without one does the fallback allow. Hard denies (deny-listed
hosts, protected paths, secret access) apply as always.

Nova rejects an ordering in which a model reviewer runs before the user's custom rules or
stands in for the deterministic engine: the deterministic engine stays authoritative and
testable, and a model can only add caution (ADR-061).

An `allow` never changes the permission profile: the action still runs in the sandbox. When the
sandbox blocks a command, the failure returns to the agent. The agent may request a wider
profile for that one invocation, which is an `ask` like any other. Nova never retries a command
outside the sandbox on its own (ADR-059).

*As built in M7 (ADR-095).* Three seams joined the evaluation:

- **Tool limits per thread** run before the steps above and only deny: a sub-agent with a tool
  list is held to it plus `run.complete`, `tool.search`, `context.remaining` and `context.fresh`
  (FR-053); a shared thread offers only its allow-list; tools of plugins not connected to an agent
  are denied for that agent and the Code sessions it delegated; a delegated Code session keeps its
  agent's rules (a delegation whose rules are gone denies everything) and a paused agent's
  delegated work is denied until it resumes; in a cloud thread the Hub's own `fs.*` tools are
  denied (and so hidden).
- **`ruleTool`.** A request may carry a separate name that only the engine's rule matching reads.
  Browser site levels per project or agent use it (`browser.act:<kind>:<ref>`, `docs/11` §4.4)
  behind a policy preview, while hooks, tool limits, the approval card, audit and events still see
  `browser.act`; the auto-review escalation drops it, so a scoped "Always allow" never answers one.
- **The thread's own substrate.** The gate asks the sandbox router for the substrate of the
  request's own thread (`useSubstrate(accountId, threadId)`), so a cloud thread reports `cloud`,
  which is not isolated, and the isolation-dependent choices (Bypass) are not offered there.

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

*As shipped in M6 (ADR-093).* An always-on agent's rules are stored in `agent_rule`
([`agent-rule.json`](../contracts/schemas/agent-rule.json)), not `policy_rule`, because
`policy_rule` has no "when you say so" effect. The match names tools (names or globs), hosts,
action classes (`read`, `write`, `send`, `delete`, `execute`), effect classes and channels
(`<kind>:<conversation>`), hosts or channels but not both; a rule may carry a command prefix rule,
which may only act or ask and whose examples must pass. The gate's `useAgentPolicy` adds the
agent's rules and command rules to the **user** layer of the policy set for every thread the
agent owns: a rule that claims the managed layer is coerced to user, and a source that fails denies
the call ("the agent's rules could not be read"). `act_on_request` allows only when the call
carries the user's own instruction with no taint, so agent notes join only turns the agent starts
itself. The preview (`GET /agents/:id/rules/:ruleId/preview`) is best effort: it matches the
latest 500 calls by tool, host, channel or command word.

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
  Argon2id (user passphrase) + XChaCha20-Poly1305. The Hub chooses with `NOVA_SECRETS=keychain|vault`
  (default `vault`); the keychain backends are `secret-tool` (Linux) and `security` (macOS),
  with values passed only on stdin (ADR-090). Blobs are sealed with a per-Hub data key held in the
  same store.
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
- **Extension secrets in M4** (ADR-091). Literal env and header values in a plugin's MCP servers
  move to the vault as `secret://mcp/<id>/env/<NAME>`, and the stored plugin manifest
  (`plugin_install.manifest_json`) keeps only the references. A plugin's servers cannot be edited
  or removed outside the plugin (409 `plugin_owned`), so their configuration and vault entries
  always match the manifest the user confirmed; a manifest may itself reference
  only `secret://plugin/<pluginId>/…`. A bundle's sensitive settings (and env values or
  arguments that use one) go to the vault; a launch argument may reference only its own server's
  entries (`secret://mcp/<id>/…`), resolved at launch. Imported secrets use
  `secret://mcp/<id>/env/<NAME>`, `secret://plugin/<pluginId>/<key>/<NAME>` and
  `secret://import/<ref>/text/secret_N`.
- **OAuth tokens** for remote MCP servers (FR-047) are vault entries
  (`secret://mcp/<id>/oauth/…`); the database row (`mcp_oauth`) holds only the authorization
  server, the registration and the token state. Tokens refresh within 60 s of expiry or after a
  401, and signing out calls the server's revocation endpoint and deletes them.
- **Client tokens** for Nova's own MCP server are stored only as a SHA-256 hash (§15).
- **CI**: Nova's own scanner (`scripts/secret-scan.mjs`), built from the redactor's patterns plus
  private-key headers and token prefixes, fails the build on a finding; fixtures mark fake
  values with `secret-scan: fake` (ADR-090).

- **As shipped in M6** (ADR-093). The egress proxy injects credentials from
  `egress_credential` rows (`/api/v1/egress/credentials`; the value is a vault entry
  `secret://egress/<id>`, never returned): `bearer`, `basic` or a named header (never `Host`,
  `Cookie` or a hop-by-hop header), account-wide or bound to one run, session or agent. It
  terminates TLS with a per-Hub ECDSA P-256 CA in `<dataDir>/egress/` (key 0600; only the public
  certificate is served, `GET /egress/ca.pem`). HTTPS is decrypted only in `limited` mode, for a
  host with a bound credential or when a hook matches; without the CA, credentials go over plain
  HTTP only. Credential values are read per request, a vault failure sends the request without
  one, and values (and the basic-auth base64) are masked in response headers and bodies; the proxy
  asks for uncompressed bodies, and a body an upstream compresses anyway is not scanned. Git host
  tokens (`secret://code/githost/<id>/token`), SSH credentials of Code environments
  (`secret://code/environment/<id>/credential`), channel bot tokens and signing secrets
  (`secret://channel/…`), trigger webhook secrets (`secret://trigger/<id>`), MCP event signing
  secrets (`secret://mcp/<server>/events/<id>`), saved browser logins
  (`secret://browser/login/<id>`) and the `novad` management token
  (`secret://devices/<id>/management-token`) are vault entries; rows hold only references.
  Files that are not content-addressed, such as browser screenshots and the browser cookie state,
  are sealed with the data key and bound to a label (`writeSealedFile`), so one cannot be swapped
  for another.
- **As shipped in M6.5** (ADR-094). Every Hub key is a vault entry; rows hold only references:
  the Hub identity key (`secret://hub/identity`, Ed25519; its public half is in `trust_identity`,
  and a missing or different key makes the identity refuse to load rather than make a new one),
  the local CA's key (`secret://hub/ca/<id>/key`), the Hub's TLS keys
  (`secret://hub/tls/<id>/key`, `secret://hub/tls/mesh/<id>/key`), the Relay route token and the
  Hub's X25519 key for each Relay registration (`secret://relay/<registration id>/route-token`,
  `…/x25519`, imported non-extractable), the WireGuard private key
  (`secret://network/wireguard/<interface>/private-key`) and the mesh secrets the owner types or a
  Headscale pre-auth key (`secret://network/setup/<runId>/auth-key`, `…/headscale-api-key`,
  `…/preauth-key`). Keys of retired CAs, superseded certificates and replaced Relay registrations
  are deleted from the vault. Add Device codes are stored only as SHA-256 hashes salted with the
  pairing id (`device_pairing.code_hash`); device sessions are `auth_token` rows stored hashed like
  any session, tied to their device in `device_session`; an enrollment token Add Device grants is
  hashed in its own domain like the M2 and M6 ones. Mesh CLIs get secrets on standard input, in
  their environment or from a 0600 file (`docs/22` §6), never as arguments. A device keeps its own
  private keys: the Hub stores only its public key and certificate.
- **As shipped in M7** (ADR-095). New vault entries, with rows holding only references: the cloud
  runner token (`secret://cloud/runner/token`), the Web Push VAPID key (`secret://push/vapid`) and
  each browser subscription's auth secret, the approval-link key, the Relay registration token
  (`secret://relay/registration/token`; the setting accepts only `secret://relay/registration/…`, so
  it can never name another secret the connector would send), OIDC client secrets, team agents'
  provider and egress credentials, Telegram bot tokens, email passwords and Telegram webhook
  secrets (`secret://channel/…`), MCP `auth` values, schedule webhook signing secrets (shown once,
  never returned again) and external agent adapters' environment values (only
  `secret://agent-adapter/<id>/…`; any other reference is refused, `foreign_secret`, so an adapter
  cannot read another secret). Invitation tokens and the OIDC browser binding are stored only as
  hashes. **The idempotency store** (`docs/13` §2.3) never keeps an answer marked `no-store`,
  larger than 256 KiB or carrying a credential (a Nova token, a token-shaped string, a value under a
  key named like a credential), whatever the route says, and replay is opt-in per route; routes
  that hand out tokens send `no-store`. The SSH private key is copied only into a temporary private
  folder for the ssh client, and copies a crash left are removed at start.
- **Redactor bounds (M7).** The redactor runs in the Hub's and the shell's event loops, so its
  rules are bounded: the `pem` body cannot cross another BEGIN marker and is capped at 16 KiB,
  `url-credentials` is anchored on `://` with a scheme of at most 32 characters, `jwt` starts only
  at the beginning of a token run, and literals apply longest first. Every rule finishes in under
  50 ms on 2 MB of hostile input (`packages/security/test/redact-timing.test.ts`). Callers that
  redact page-supplied text clip it to twice its cap first (`docs/11` §4). Opaque tokens in URL
  paths (reset and magic links) are still not masked.

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

**As shipped in M6** (ADR-093): page content is a `page` source and every browser gate request
carries its taint, so nothing a page says authorizes an action. `browser.read` labels the page as
untrusted, and a page that looks like it carries instructions is audited once per URL
(`browser.injection_suspected`) and flagged to the model. Channel messages, trigger and MCP event
payloads, screen observations (origin `capture`), page tools' results, check summaries from a Git
host and `page.read` results are untrusted too.

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

**As shipped in M5** (ADR-092):

- The reviewer is one model call to `review.model` (security-relevant, default none) with no
  tools and a JSON-schema response format. With no tools it can read nothing beyond the context it
  is given, so it does not run in a sandbox. Its prompt is versioned `auto-review-1`. It sees the
  proposed action (tool, redacted arguments, effect classes, tier), up to 10 of the user's
  instructions for the run and a bounded summary of the turn; the resource, the taint and the
  rules that applied are not passed yet.
- It runs after hooks, only for an allowed `pre_approvable` call under `review`, and applies its
  ask, handoff or deny through `tighten`. 90 s per attempt, 3 attempts, no retry of a valid deny.
- **No reviewer model denies.** The Hub always wires the reviewer, and with no `review.model` it
  denies like a failed review. This replaces ADR-090's "asks every time". Auto cannot be picked
  without a reviewer model, and the Hub refuses to create an autonomous Work run without one
  (`validation`, `review_model_required`).
- `review.started` and `review.completed` are emitted. The verdict is stored on the approval row;
  **Allow once** on a reviewer card is recorded as an override. The audit actions
  `review.verdict` (model, attempts, latency, fail-closed), `review.override` and
  `review.breaker` use kind `review` (the M5 integration fixes added it).
- The breaker counts per run (per thread without a run) and only in memory. When it trips the call
  is denied, the turn stops, `review.breaker.tripped` is emitted and the user is notified; the run
  pauses with `review_breaker` and shows **Blocked** "Stopped by auto-review" rather than Needs
  input. Resuming resets the count.
- Recall and benign-denial measurement (FR-224) is not in M5.

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

**As shipped in M6** (ADR-093): detection is deterministic: a channel identity flagged as a bot,
an address the user marked (`/api/v1/external-agents`), a sign-off in the last three lines ("—
the billing agent") or self-identification. Inbound content from an external agent is never
accepted as a task (audited `external_agent.denied`, action `accept_task`, with its source and
evidence). Delegating or sending data is allowed when the counterpart is not an agent, or when the
user named it in the typed message of the thread's latest turn or `namedAgents`; otherwise it is
denied with cause `external_agent`. The browser applies it to form submits, uploads, Enter and
page tools on an agent-signed page; channels drop a message from one.

## 7. Sandboxing (FR-107)

- All agent execution occurs in a sandbox; unsandboxed execution is never the default and is
  never a fallback.
- Every execution runs under a permission profile (§7.1). The concrete sandbox profile is
  generated from it and the effective policy, and its hash goes into the audit event.
- The broker canonicalizes paths (rejecting symlinks/`..` escapes), pins DNS, limits
  resources, and caps output.
- Failure to create the sandbox fails closed (`docs/11` §10).
- *Through M4* (ADR-090, ADR-091) the substrate is a container. Exec tools, command hooks and
  terminals run in it; a terminal is a shell in the container, never on the Hub, and the
  commands typed in it are confined by the sandbox and the permission profile rather than
  checked one by one. Without a container runtime they fail closed (`sandbox_unavailable`; a
  failed `tool.pre` or `permission.request` hook blocks). MCP stdio servers, including those of
  plugins and bundles, are not sandboxed yet (M6); a bundle's confirmed permissions are recorded
  but do not yet confine its process.
- *In M5* (ADR-092) `test.run`, a Code session's terminals and a repository's commit hooks also
  run in that container, with network off for tests and hooks; without a container runtime they
  fail closed, and a commit then runs on the Hub with hooks disabled. Document outputs
  (`document.create`, `document.read`) run in the Hub process, not the sandbox: they only turn
  validated data into a file or a file into text, run no code and import nothing that reaches the
  network (a test enforces it). Nova's own Git calls never run repository hooks (FR-211).

- *In M6* (ADR-093) the substrates are a container and bubblewrap with seccomp on Linux
  (`docs/11` §2.5); `auto` picks a container engine first. Every sandbox's network is the egress
  proxy's socket only (§8). An agent's commands run on its computer's folder. A Code session in
  an SSH, WSL or device environment runs its commands on that machine under its user (a device's
  `novad` sandboxes them with bubblewrap and no network). macOS seatbelt, the Windows token
  sandbox and the micro-VM runner are not built. MCP servers, including those of plugins and
  bundles, still run outside the sandbox and the proxy, and `web.fetch` runs in the Hub process.

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

*As shipped in M6* (ADR-093): the substrates enforce the list with mounts, in every root and in
every folder from the root down to the command's working directory: `.git`, `.nova`, `.agents`
and shell startup files are bound read-only inside writable roots, and credential locations
(matched case-insensitively, `credentials*` prefixes included) and the Nova data directory are
hidden (an empty tmpfs, or `/dev/null` for a file) in every root; roots inside the data directory
(the workspace, an agent computer's home) are mounted after the hiding. Likewise the gate and the
tools' path policy let only the workspace and `<dataDir>/computers` through the data-directory
deny, and a thread still reaches only its roots. A `.git` file (a linked worktree or submodule) is
followed to its Git directory and common directory. Mount points cannot be renamed or deleted from
inside. Locations that do not exist when the command starts are not covered, because a mount point
would have to be created on the host. Nova's own commit that runs the repository's hooks passes
`gitWrite`: `.git` becomes writable except `config`, `config.worktree`, `hooks` and `info`, since
the Hub's own Git reads `.git/config` outside any sandbox and a sandboxed write there could make
it run a program (`core.sshCommand` and the like). So `git commit` or `git checkout` typed in a
terminal or run with `exec` fails read-only; commits go through the Code commit flow and the
`git.*` tools. On a device, `novad` refuses credential locations and its own data folder in every
grant and keeps the read-only locations read-only inside write grants; the Hub checks staged
device writes again, treating `.git` and the like as read-only anywhere in the path.

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

### 7.4 Cloud runner, scripts and external agents (M7)

*As built in M7 (ADR-095).*

- **The cloud runner** (`services/runner`, `contracts/rest-api.md` §5) sandboxes every command
  itself: bubblewrap (new namespaces, every capability dropped, a seccomp filter, system folders
  read-only, only the environment's own folders mounted; it refuses to run as root), else docker
  or podman (a non-root user, no capabilities, `--network none`, pids and memory limits, the program
  as the entrypoint so an image's own ENTRYPOINT never runs), else refusal. Per command
  RLIMIT_DATA, RLIMIT_CPU and RLIMIT_FSIZE; per sandbox a process limit and, where
  `systemd-run --user --scope` works, a cgroup with pids and memory limits; per Hub token 16 of the
  runner's 64 command slots. The Hub's state on the runner (`/nova`: shadow repositories, handoff
  bundles) is mounted only for the Hub's own programs, never for a command, so a command cannot
  rewrite its session's review baseline. Clones run inside the sandbox; repository URLs never carry
  credentials (refused by the Hub and the runner) and never name private or local hosts. The Hub,
  in turn, trusts no path the runner reports (only `/workspace` and below), hides its own file
  tools in cloud threads and reads bounded answers (96 MiB per answer, 5 MiB per artifact, 1 MiB per
  event).
- **Scripts** (`script.run`, FR-202, off by default) run in a QuickJS engine of their own, one per
  run, in a worker thread with heap and stack limits, an empty environment and a watchdog; there
  are no host globals and no module import. Every nested tool call goes through the tool runtime
  and the gate like a direct call, carries no user instruction (so a consequential call asks unless
  a rule or grant allows it) and inherits taint; `script.run` is never served to MCP clients.
- **External agents** (FR-203, off by default) run in the Code session's own sandbox with the
  folder read-only; a session whose sandbox has no substrate (an SSH, WSL or device session without
  one) is refused (`no_substrate`). Every file read, write and command the agent asks for runs as an
  `fs.*` or `exec.*` call through the gate with the `external_agent` taint; Nova never picks the
  agent's "always allow"; terminals are capped (8, 1 MiB each) and killed when the delegation
  ends, without waiting on an approval; turning the flag off stops running delegations and the
  host re-checks the flag before every request.
- **SSH environments** (FR-062, off by default): pinned host keys (a change needs the reset route),
  a helper checked by SHA-256 before every start and run by that absolute path, `--` before the
  host, quoted options, and remote writes that never follow a symlink (`docs/10` §2).

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

**As shipped in M6** (ADR-093):

- The proxy runs in the Hub, one session per sandboxed command (container environments' included)
  with its policy fixed when it opens. Effective mode: the narrowest of `network.egressMode`, the
  profile's network mode and each scope's (off < limited < allowlist); allow: `network.egressAllow`
  plus the scopes' lists; deny: `network.egressDeny` plus the scopes', and deny always wins. An
  effective `off` opens no session. Scope policies are set with
  `PUT /api/v1/egress/scopes/:kind/:id`; `agent`, `run` and `session` scopes are applied, `plugin`
  and `mcp_server` ones are stored only. The profile's own allow and deny lists are not passed to
  the proxy.
- Check order: mode `off`, then deny, then the allowlist, then `limited` methods; DNS is resolved
  only after these pass, and a name with any non-public answer is blocked. The allowlist is by
  host, so every port of an allowed host is reachable. Redirects are never followed. A dev-server
  grant (one host and port for one scope) passes a private address only when the session's
  policy sets `allowLocalBinding`. In M6 only an agent browser's session gets one: for a Code
  session's dev server, published from its sandbox through the dev-server bridge to the Hub's
  127.0.0.1 (`docs/10` §7), audited as `browser.devserver.granted` and `.revoked`. The bridge's
  Hub port has no token, like any natively run dev server: local processes on the Hub machine can
  reach it; other sandboxes, other computers' browsers and the Hub's fetch tools cannot.
- A refusal is 403 with `X-Nova-Block-Cause` and a plain-text body naming the host and how to ask
  for access; `policy` also covers a `block` hook and an inspected request whose `Host` differs
  from the tunnel's. Every decision is audited (kind `network`, actions `egress.request` and
  `egress.connect`); `GET /api/v1/egress/decisions` reads them back.
- Session listeners: a Unix socket the substrate bridges into the sandbox (0600 in a 0700 folder;
  0666/0711 when the Hub runs as root so a sandbox user can connect) and a loopback port that
  needs the session token (`Proxy-Authorization`).
- The gate reads `network.egressAllow` and `network.egressDeny`: a tool's network call to a
  deny-listed host is denied. Both lists take the proxy's own host patterns (at most 500); a
  stored list that fails them resolves to the default (none) instead of breaking every session.
- Gaps: the agent browser's session follows `network.egressMode` but no scope policy; SOCKS5 is
  not built; MCP servers and `web.fetch` bypass the proxy.

**As shipped in M7** (ADR-095):

- **Non-owners** (§1.1): their allow lists can only narrow `network.egressAllow`, and the Hub's own
  connections on their behalf (providers, MCP, OAuth discovery, email) reach public addresses only,
  pinned after resolution.
- **External agents** (FR-203, `docs/08`): the agent's process gets a policy built only from its
  adapter's declared hosts (the global mode and deny list still apply; session grants, the global
  allow list, credentials, hooks and local binding do not), and network is refused on a sandbox
  the proxy cannot enforce (`no_egress_proxy`).
- **The cloud runner does not pass the proxy.** Its commands run with network off unless the owner
  turns on `cloud.runner.unrestrictedNetwork` (and the turn's own mode is not `off`); with it on, a
  cloud command reaches the network directly from the runner host, with no allowlist, no
  private-address block and no egress audit. Proxying runner traffic through the Hub is not built.
- **Push** goes only to https endpoints on `push.webPushHosts` (instead of DNS pinning).

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
- M4 adds (ADR-091): plugin changes (`plugin.install`, `plugin.update`, `plugin.enable`,
  `plugin.disable`, `plugin.uninstall`), hook runs (`hook.<event>`) and hook trust changes,
  editor saves (`fs.write`, origin `ui`), terminals (`terminal.open`, `terminal.close`), client
  authorizations (`app_authorization.create`, `app_authorization.revoke`) and every call from an
  external MCP client (`client.call`, with the client id), bundle installs and updates
  (`bundle.install`, `bundle.update`, with the signature status), OAuth (`oauth.start`,
  `oauth.connect`, `oauth.failed`, `oauth.revoke`) and import runs (`import.applied`).
- M5 adds (ADR-092): run controls with kind `run` (`run.create`, `run.start`, `run.pause`,
  `run.resume`, `run.redirect` as an input hash, `run.cancel`, `run.budget.extend`,
  `run.plan.update`, and `goal.set`, `goal.update`, `goal.clear`, `goal.status`); schedules with
  kind `schedule` (`schedule.create`, `schedule.update`, `schedule.delete`, `schedule.fire`,
  `schedule.run_now`, `schedule.skip`) and webhook deliveries with kind `network`
  (`schedule.webhook`, resource the host); turns Nova starts (`turn.start`, kind `run`,
  `schedule` or `policy`, with the trigger, the author and whether the text carries the user's
  authority); Code sessions with kind `code` (`code.session.created`, `code.mode.changed`,
  `code.change.rejected`, `code.commit`, `code.review`); exec session kills (`exec.session.kill`);
  and reviewer verdicts, overrides and breaker trips (kind `review`, above).
- M6 adds (ADR-093) the kinds `agent`, `channel`, `computer`, `browser`, `screen`, `device` and
  `space`, every egress decision (kind `network`), egress scope and credential changes (kinds
  `settings` and `secret`) and the Code M6 actions; the full list is in `docs/06` §2 "audit &
  events". A denied action records its cause (`external_agent`, `password`, a tier refusal).
- M6.5 adds (ADR-094; the full list is in `docs/06` §2 "audit & events"): Add Device with kind
  `device` (`device.add.start`, `device.add.complete` with result `committed` or `denied` and the
  reason, `device.add.reveal` with `ok` or `denied` and `bad_reveal`, `device.add.approve`,
  `device.add.deny`, `device.add.expire` with what expired: `pairing`, `commit`, `request` or
  `grant`), `device.scopes.update`, `device.revoke` for every kind of device (compute nodes
  included) and `device.wake` with `via`; and with kind `network` the network panel
  (`network.change`, `network.rollback`), the setup assistant (`network.setup.consent`,
  `network.setup.apply`, `network.setup.rollback`), trust (`trust.change`, `trust.ca.create`,
  `trust.ca.rotate`, `trust.leaf.issue`, `trust.device.issue`, `trust.device.revoke`,
  `trust.mesh.store`) and the Relay (`relay.change`, `relay.pair` with decision `approved`,
  `denied`, `expired` or `refused` and its reason, `relay.revoke`). No code, nonce, token or key is
  ever in an entry; trust actions the Hub takes on its own are attributed to the owner account
  (none is written before setup).
- **As shipped in M7** (ADR-095). The M7 actions (sync, the cloud runner, channels and push, Code
  handoffs, merges, attempts, SSH host keys and delegation, members, OIDC and team agents, scripts
  and external agents, device TLS and the Relay registration token, browser levels and crashes)
  are listed in `docs/06` §2. No audit kind was added: sync uses `device`, the cloud runner
  `settings`, `code` and `run`, members and OIDC `auth`, team agents `agent`. Device TLS refusals
  are audited at most once an hour per device and reason. Team agents' actions carry the actor
  `agent:<id>`.
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
| Plugin tool call naming a host the plugin did not declare, also inside nested arguments | Denied at step 1; the plugin is disabled and the user notified |
| Plugin install without the sideload confirmation | Refused (`sideload_confirmation_required`) |
| Hook edited after trust; a `tool.pre` hook that errors or times out | The edited hook waits for re-trust; the failing guard blocks the call |
| Tool call from an MCP App | No user authority; asks under the default policy |
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
  port, accepts only the expected `state`, and closes after one request or 5 minutes. For
  remote MCP servers signed in from the web UI (M4, ADR-091) the redirect target is the Hub's own
  route `/api/v1/mcp/oauth/callback`: it needs no session because the `state` authenticates it,
  and the state is single-use, bound to the account and expires after 10 minutes.
- **No writes into other applications.** Nova never adds itself, its keys or its skills to
  another application's configuration, skill folders or startup files. The one exception is
  the extension bridge's native-messaging host manifest (`docs/11` §4.3): Nova writes only its
  own manifest, only when the user enables the bridge, and removes it on disable.
- **Exposing Nova's MCP server** to an external client is an explicit action in Settings →
  Integrations. It issues a per-client token scoped to named tools and resources (read-only by
  default), with an expiry; it is revocable, and every call is audited with the client id and
  passes the policy engine.
- **Nova's MCP server as shipped** (M4, ADR-091). The section is Settings → Apps & clients, and
  `mcpServer.enabled` (security-relevant, off by default) turns on when the first client is
  added. The token starts `nvm_`, is shown once and stored only as a SHA-256 hash; the default
  expiry is 90 days, and a token that never expires must be chosen explicitly
  (`expiresInDays: null`). `/mcp` answers 404 while the server is off, 401 `token_required` for a
  missing, wrong, revoked or expired token, and 403 for an `Origin` or `Host` that is not
  allowed. Calls pass the gate with origin `mcp_client` and no user instruction. Revoking a
  client or turning the server off ends its sessions at once; revoked authorizations are kept
  for the audit trail.
- Listeners bind only to configured interfaces. A port conflict produces a diagnostic and a
  fallback port, never a silent exit (FR-225).
- **Event streams and the handshake as shipped** (M5, ADR-092). The global event stream and the
  WebSocket deliver only the signed-in account's events and account-less system events; Nova is
  single-owner today, so this is defense in depth. `GET /api/v1/hello` stays public and says only
  what a client needs before sign-in. Server-request kinds are negotiated by an authenticated
  `POST /api/v1/hello`, whose `clientSessionId` the WebSocket names; an answer to a request
  aimed at another device is refused with 403 `policy_denied`.
- **Public receivers as shipped** (M6, ADR-093). Channel inbound deliveries, webhook triggers,
  MCP event deliveries and `novad`'s register, heartbeat and capability calls have no session;
  each authenticates by its sender's signature or token before the body is read
  (`contracts/hub-api.md` §1), with 5-minute replay windows and constant-time comparisons, and
  still passes the Host and Origin checks. A webhook trigger's event id, when sent, is part of its
  signature. Until M6.5 `novad` uses bearer tokens over LAN HTTP (`nvd_` enrollment, `nvc_`
  device credential, and a management token the device generates, kept in the vault). The
  management token starts `nvdm_`, distinct from Nova's MCP client tokens (`nvm_`); the Hub
  refuses registration with any other prefix and `novad` refuses a stored token without it, so a
  device enrolled before the change must be added again. The artifact content route
  answers with `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'` so the Inspector can
  frame it; site previews are sandboxed documents without same-origin; every other response keeps
  `X-Frame-Options: DENY`.
- **Public routes as shipped in M6.5** (ADR-094; the list `apps/hub/test/listeners.test.ts`
  enforces is in `contracts/hub-api.md` §1). Add Device's `complete` authenticates by the
  single-use code, `reveal` by the commitment and the device key's signature, and `status` by a
  fresh signature newer than the last poll; all three are rate-limited per client address, five
  wrong codes burn a pairing and typed codes have their own budget per account. The root
  certificate (`/api/v1/trust/ca.pem`, `ca.crt`), the signed identity statement
  (`/api/v1/trust/identity?nonce=`) and the `novad` builds (`/api/v1/agent/dist/:file`, 60 a
  minute per address) take no credential and hand out only public information whose integrity is
  its signature. The Relay adds no public route: tunnelled requests reach only `/api/v1` (never
  the WebSocket), carry the address `relay:<client id>` and authenticate by the client's own
  session, never by a route token. The Hub answers to its mDNS name and its direct public host only
  while each is in use. If the trust certificates cannot be read at start, the Hub binds plain HTTP
  to `127.0.0.1` only. Network setup treats loopback and forwarded requests as an unknown path
  (`docs/22` §6). `NOVA_NETWORK_TOOLS_FILE`, which names the programs network setup runs, can be
  set only by whoever starts the Hub, is logged when set, and stops the start when unreadable.
- **Known limitations (M6.5).** `novad` and compute nodes still talk to the Hub with bearer
  tokens over plain HTTP, so Add Device codes and granted tokens are visible on the LAN (the pin,
  the signed manifest and the Hub-signed confirmation protect integrity); device certificates are
  issued but nothing checks them (mutual TLS is M7; built, below). A device session from Add Device is a full
  owner session: its scopes are recorded, not enforced. The Relay has no forward secrecy (static
  X25519 keys per pairing; `docs/22` §3.1) and accepts any push token. The identity key cannot be
  rotated, the CA is replaced only on the owner's explicit request, and device certificates are
  not renewed. Network setup has no elevation and was exercised only
  against fake CLIs.
- **Public routes as shipped in M7** (ADR-095; same list). The signed one-use approval link of an
  approval email (GET shows, POST answers once; `no-store`, `no-referrer`, a strict CSP and no
  framing), the invitation join and preview (the one-use token; 10 a minute per address), the OIDC
  providers list, start and callback (the single-use state, the browser-binding cookie, then the
  ID token's checks; redirects only to fixed paths) and public profile cards (only opted-in cards
  while `team.publicProfiles` is on; 60 a minute per address). Telegram webhooks use the existing
  inbound route with the secret-token header the Hub generated.
- **Mutual TLS** (M7, FR-126). Over HTTPS the Hub asks every client for a certificate of its local
  CA without requiring one; the `novad` and compute-node routes check it and that it belongs to
  the caller (`certificate_*` refusals); `devices.tls.allowWithoutCertificate` (on for one release)
  decides whether a device without one is accepted. `novad` and compute nodes verify the Hub by
  its pinned identity statement on the same connection before they send anything, and present
  their certificate only after that check (`docs/22` §5). The Hub → `novad` management channel is
  still bearer tokens over plain HTTP (R-022).
- **Local runtime sockets** (M7, FR-128). `novad`'s local runtime listens on a 0600 Unix socket in
  a 0700 folder, and per user on `/run/user/<uid>/nova/runtime.sock` owned by that user (links and
  foreign files refused, never followed; `lchown`); a loopback address, when the owner opens one,
  needs a token, a loopback Host and no Origin unless allowed. It serves only the model routes and
  only while the Hub granted `local-runtime` (`contracts/hub-api.md` §4).
- **The desktop shell** (M7) runs its windows with context isolation, the sandbox, no Node and no
  webview; navigation stays on the Hub origin, web links open in the system browser, and every IPC
  payload is validated in the main process with the sender checked (`contracts/ipc-channels.md`).
  It pins the Hub before sending any credential and clears stored cookies when the identity
  changes; plain HTTP only to a Hub on the same computer.
- **Known limitations (M7).** The desktop shell's sender check compares the frame's URL rather
  than its real origin, so a Hub page served in a sandboxed opaque origin and opened top-level
  (a site preview or an MCP app UI) would get the bridge, and `setShortcut` accepts editing and
  system keys; excluded apps match only on the Linux AT-SPI path and a screenshot can fall back to a
  window whose title only contains the captured one; the shell clears stored Hub data only when a
  previous Hub is on record, and an Add Device link for another Hub replaces the current one after
  a generic Connect. A browser paired through the Relay holds its device token where page script
  can use it (sealed in IndexedDB, but weaker than an HttpOnly cookie). Cloud runner network, when
  the owner allows it, bypasses the egress proxy. The `fs.*` path fix covers cloud threads only:
  SSH, WSL and device sessions still use the remote folder as roots. A removed member's running
  channel pollers keep polling (their turns are refused) until a restart. The Relay still has no
  forward secrecy; device certificates are not renewed. A device session is still an owner
  session apart from its scopes: `offline-replica` and `local-runtime` are now enforced, the other
  scopes are recorded only.
