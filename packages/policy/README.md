# @nova/policy

The policy engine (FR-048, FR-099, FR-189, FR-190, FR-191; `docs/12` §2-§4, §7): a pure,
deterministic `evaluate(context, policySet)` that returns allow / ask / handoff / deny with a
reason, the confirmation tier, the deciding source (`builtin`, `managed`, `rule`, `grant`,
`tool_default`, `approval_policy`, `fallback`) and the rule or grant id. 90 % branch coverage floor.

Evaluation order (`docs/12` §2.3):

1. **Built-in safety.** Hard denies (agents changing policy or reading secrets, external agents
   the user did not name, the `full` profile outside a VM or container, paths the profile denies
   or that lie outside the turn's roots, protected paths, hosts on the deny list) and the
   confirmation tier from the action's effect classes. `handoff_required` and
   `confirm_at_action` are floors that no rule, grant, default or verdict can pre-approve.
2. **Managed rules**, then 3. **user rules** (policy rules and command prefix rules, most specific
   scope first, then priority), then **remembered grants**. Any matching deny wins.
4. **User-set defaults** per tool, per MCP server or plugin, then per glob.
5. **Approval policy**: `ask_always`, `defaults` (with `autoAccept: ['file_edit']`), `review`,
   `never_ask`.
6. **Fallback**: Nova's read-only tools allow; everything else asks.

Intent provenance: only `provenance.userInstruction` authorizes. Without it a consequential action
asks unless a standing rule or grant covers it; any taint stops "act on request" rules. Hooks
(M4) and the reviewer (M5) plug in through `tighten`, which can only make a decision stricter.

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
