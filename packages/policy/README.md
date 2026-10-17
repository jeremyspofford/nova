# @nova/policy

The policy engine (FR-048, FR-099, FR-189, FR-190, FR-191; `docs/12` §2-§4, §7): a pure,
deterministic `evaluate(context, policySet)` that returns allow / ask / handoff / deny with a
reason, the confirmation tier, the deciding source (`builtin`, `managed`, `rule`, `grant`,
`tool_default`, `plugin`, `user_action`, `approval_policy`, `fallback`, `hook`, `reviewer`) and
the rule, grant or hook id. 90 % branch coverage floor.

Evaluation order (`docs/12` §2.3):

1. **Built-in safety.** Hard denies (agents changing policy or reading secrets, external agents
   the user did not name, the `full` profile outside a VM or container, paths the profile denies
   or that lie outside the turn's roots, protected paths, hosts on the deny list) and the
   confirmation tier from the action's effect classes. `handoff_required` and
   `confirm_at_action` are floors that no rule, grant, default or verdict can pre-approve.
2. **Managed rules**, then 3. **user rules** (policy rules and command prefix rules, most specific
   scope first, then priority), then **remembered grants**. Any matching deny wins.
4. **User-set defaults** per tool, per MCP server or plugin, then per glob; then the owning
   plugin's confirmed permissions (`context.plugin`, FR-045): its per-tool default, then its
   per-action default (`actionDefaults`); a tool the plugin did not declare asks. The user's own
   defaults and rules win over the plugin's.
5. **Approval policy**: `ask_always`, `defaults` (with `autoAccept: ['file_edit']`), `review`,
   `never_ask`.
6. **Fallback**: Nova's read-only tools allow; everything else asks.

An action the signed-in user takes directly in a Nova client (actor `user`, with their own
instruction and no taint: an editor save, a button they clicked) needs no card at steps 4-6:
acting is the confirmation (`user_action`). Floors still ask (`confirm_at_action`,
`handoff_required`, the network allowlist), rules and denies still apply, paths outside the
profile are still denied, and changing policy or reading secrets keeps its card. A call an MCP
App makes on its own carries no user instruction, so it keeps asking.

Plugin permissions are enforced, not trusted: a host a plugin tool would reach (its host
resource, or any `http(s)`/`ws(s)` URL among its arguments, `urlHosts`) that the plugin did not
declare is denied at step 1 ("<host> is not a host this plugin declared"); declared hosts need no
network-allowlist entry. The manifest's action class adds its effect class (a `send` tool is
confirmed every time).

Intent provenance: only `provenance.userInstruction` authorizes. Without it a consequential action
asks unless a standing rule or grant covers it; any taint stops "act on request" rules. The
reviewer (M5) plugs in through `tighten`, which can only make a decision stricter. Lifecycle hooks
(M4, FR-197) plug in through `applyHookAnswer`: a hook tightens anything but a deny or a handoff,
and answers an `ask` with allow only when the engine marked it `answerable` (it came from a user
rule, a per-tool default or plugin permissions, and no built-in floor asks as well) and the hook
may answer asks (user, managed, or a plugin's hook with `answersAsks`; the caller decides).

Modules:

- `classify.ts`: effect classes. Built-ins declare theirs; MCP, plugin, page and device tools get
  classes inferred from their name and description (purchase, messaging, deletion, install,
  credentials, accounts), which only ever adds classes. An MCP read-only hint never makes a tool
  read-only.
- `command.ts`: a shell-grammar parser without expansion, command prefix rules, wrappers and
  interpreters, load-time examples (`checkCommandRule`, `loadCommandRules`), `evaluateCommand`
  and the prefix an "Always allow" card suggests (`suggestPrefixRule`).
- `paths.ts`: canonical paths, the protected and credential locations (data, enumerated by the
  security suite) and `pathAccess`, which compares protected names case-insensitively.
- `profiles.ts`: the built-in profiles `read-only`, `workspace` and `full`, `extends` chains,
  token expansion (`:project`, `:tmp`, `:minimal`, `:home`) and canonical hashes.

The Hub's store, approval gate and routes live in `@nova/core` (`src/approvals`) and
`apps/hub/src/policy.ts`.
