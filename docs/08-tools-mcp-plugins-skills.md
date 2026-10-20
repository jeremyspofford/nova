# 08 — Tools, MCP, Plugins & Skills

## 1. Tool runtime

A **tool** is a typed capability the agent can invoke. Its descriptor is
`contracts/schemas/tool-descriptor.json`. Tools come from these sources: `builtin`, `mcp`,
`plugin`, `computer`, `browser`, `page` (tools a web page registers, `docs/11` §4.5) and
`device` (a device-local MCP tool reached through `novad`, FR-210). All are registered in one
registry with a canonical namespaced name (§8) and a JSON Schema. Skills (§4) and hooks (§4.1) are not
tools: a skill is loaded instructions, a hook is code the runtime runs on lifecycle events.

```ts
interface ToolDefinition {
  name: string;                  // canonical: "fs.read", "github.createIssue", "mcp:linear.search"
  title: string;
  description: string;
  source: 'builtin' | 'mcp' | 'plugin' | 'computer' | 'browser' | 'page' | 'device';
  serverId?: string; pluginId?: string; deviceId?: string; // owning server, plugin or device
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;
  annotations?: {
    readOnly?: boolean;
    destructive?: boolean;
    idempotent?: boolean;
    requiresNetwork?: boolean;
    requiresUser?: boolean;       // e.g., password change, CAPTCHA
    costClass?: 'free' | 'metered';
    action?: 'read' | 'write' | 'send' | 'delete' | 'execute'; // per-action permission class (FR-045)
  };
  userReadOnly?: boolean;            // MCP only: the owner declared it read-only (below)
  loading?: 'always' | 'deferrable'; // §1.4; built-ins are always 'always'
  deferred?: boolean;                // in a turn's listing: held behind tool.search (§1.4)
  ui?: { resourceUri: string };      // MCP Apps resource that renders this tool (§3.1, FR-198)
  timeoutMs?: number;                // 1,000 to 600,000; default 60,000 (§9)
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

interface ToolContext {
  threadId?: string; runId?: string; agentId?: string; sessionId?: string; turnId?: string;
  origin: 'model' | 'ui' | 'hook' | 'script' | 'mcp_client'; // who issued the call (audited)
  cwd?: string;                  // sandbox working directory
  policy: PolicyEngine;
  sandbox: SandboxClient;
  browser?: BrowserController;
  secrets: SecretBroker;         // resolves references on demand, never exposes values
  signal: AbortSignal;
  log: Logger;
}
```

MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) map
onto Nova's annotations but are **untrusted hints**: they can make a tool's default stricter,
never looser. An MCP or plugin tool with no explicit default is `ask` (§6).

**Owner-declared read-only tools.** Server annotations stay untrusted hints. The owner may mark
individual tools of an MCP server they added as **Reads only** (Settings → Tools & MCP → a
server's tools; `readOnlyTools` in `mcp-config.json`, matched like `enabledTools`). Nova then sets
`userReadOnly` on those descriptors. The declaration is only ever the owner's: it is never derived
from `readOnlyHint`, and a plugin's server never carries one. The policy engine honours it only
when nothing else it knows contradicts it: no write, send, delete or execute action class, no
destructive hint, and declared plus inferred effects of at most `network`. A tool named
`send_invite` or `delete_event` stays consequential whatever is ticked. Changes are audited with
the names added and removed. How the engine treats a read-only action is in `docs/12` §2.3.

### 1.1 Built-in tools (v1)

| Tool | Purpose | Annotations |
| --- | --- | --- |
| `fs.read` | Read a file (with size cap) | readOnly |
| `fs.list` | List a directory | readOnly |
| `fs.search` | Ripgrep-like search across allowed roots | readOnly |
| `fs.write` | Create/overwrite a file | destructive |
| `fs.edit` | Apply a patch in the Nova patch format (§1.3) | destructive |
| `fs.delete` | Delete within allowed roots | destructive |
| `exec.run` | Run a command in the sandbox; returns output after a yield time or a session id for a still-running process (FR-184) | destructive, requiresNetwork* |
| `exec.write` | Send stdin (or an interrupt/terminate signal) to a running exec session | destructive |
| `exec.poll` | Read new output and the exit status of an exec session | readOnly |
| `code.symbols` | Symbol/reference lookup in indexed repo | readOnly |
| `web.search` | Web search with citations | readOnly, requiresNetwork |
| `web.fetch` | Fetch a URL as markdown/text | readOnly, requiresNetwork |
| `browser.*` | Navigate/read/click/type/screenshot | see §5 |
| `screen.*` | Computer-use (observe/click/type) | requiresUser on first use |
| `image.generate` | Generate/edit an image | metered |
| `memory.read` / `memory.write` | Read/write scoped memory | write is destructive |
| `task.spawn` | Spawn a sub-agent/child thread with a role (`docs/09` §4; plugin roles §3.1) | destructive |
| `schedule.create` | Create a recurring task | destructive |
| `schedule.wake` | Set the agent's own next wake-up (FR-206: min interval 5 min, horizon ≤ 30 days, ≤ 24 self-set wakes per day) | write, audited |
| `goal.get` / `goal.set` / `goal.update` | Read the run's or agent's goal; set one only when the user asked for a goal; report progress or set a status the agent may set (FR-181, `docs/09` §2.1) | get readOnly; set and update write |
| `context.remaining` | Report tokens used and left in the context window and the compaction threshold (FR-183) | readOnly |
| `context.fresh` | Compact now and continue in a fresh context with a summary (FR-183) | readOnly |
| `tool.search` | Search deferred tools and load matches for the next model call (§1.4, FR-196) | readOnly, always allowed |
| `skill.load` | Load a skill's `SKILL.md` body and file list on use (§4) | readOnly, always allowed |
| `script.run` | Run a short script whose nested tool calls each pass the policy engine (FR-202; **flagged, off by default**) | per nested call |
| `ask_user` | Ask a clarifying question | readOnly, always allowed |
| `artifact.create` | Render a structured artifact | write |

*`exec.run` network access depends on the egress policy for the mode.

**Exec sessions (FR-184).** `exec.run` takes `{cmd, cwd?, tty?, yieldMs?, maxOutputTokens?}`.
It waits up to `yieldMs` (default 10 s, max 120 s) and returns either `{status: 'exited',
exitCode, output}` or `{status: 'running', sessionId, output}`. `exec.poll {sessionId,
yieldMs?}` returns output produced since the last read; `exec.write {sessionId, text?,
closeStdin?, signal?: 'interrupt' | 'terminate'}` writes to stdin. Rules:

- Output returned to the model is redacted (known secret values and secret patterns, FR-101)
  and capped at 10,000 tokens by default; the cap keeps the head and tail with an omission
  marker, and the full redacted output stays in the terminal pane.
- A run holds at most 8 open sessions; sessions are listed in the terminal pane, killed when
  the run is cancelled or ends, and run under the session's permission profile (FR-190).
- A session whose program is a shell or interpreter (for example `bash`, `zsh`, `pwsh`,
  `python`, `node` without a script) is classified as such by the policy engine, and each line
  sent to it with `exec.write` is evaluated as a new command under the prefix rules (FR-191).
  Writing to stdin never bypasses command rules.

**Goals (FR-181).** `goal.update` accepts progress notes and the statuses `complete` and
`blocked`. `blocked` is accepted only after the same blocker was reported on 3 consecutive
goal turns; `paused` only when the user asked for it in this thread; `usage_limited` and
`budget_limited` are set by the system only. Any other transition is rejected with
`goal.transition_denied`.

**Built-in document skills (FR-219).** `docx`, `pptx`, `xlsx` and `pdf` ship as built-in
skills (§4), not tools. They generate and read those formats with bundled libraries through
`exec.run` in a sandbox with network `off`, and return files as artifacts with previews
(`artifact.create`, FR-038).

*As shipped in M5 (ADR-092).*

- **Listings by thread.** Tools are listed per thread (`ToolListScope {threadId, mode}`). Work
  runs get `plan.set`, `plan.update`, `run.complete`, `goal.get`, `goal.set`, `goal.update` and
  `task.spawn`, `task.message`, `task.wait`, `task.list`, `task.cancel`; a sub-agent's thread gets
  only `run.complete`. Chats get `work.start` while `chat.escalation` is not `off`. Code threads
  get `git.status`, `git.diff`, `git.log`, `code.symbols`, `code.refs` and `test.run`
  (`docs/10` §4). A scheduled run can call `schedule.report` to say its notify condition did not
  hold. Every handler refuses calls outside its threads. The run tools change only Nova's own run
  state, so the gate treats them as read-only. `schedule.create` and `schedule.wake` arrive with
  agents (M6).
- **Asking the user.** The question tool is `ask_user {question, choices?, multiline?}`. It is
  listed only in Work runs and Code sessions and refuses in a chat, where the model asks in its
  reply. It sends a server-to-client request
  (FR-188) and waits up to `policy.approvalTimeoutMinutes`.
- **Exec sessions.** `exec.sessions` sets the yield time (default 10 s) and the output cap
  (default 10,000 tokens; the model can only lower it). At most 8 sessions per thread. A session
  belongs to its turn; when a run's turn ends normally the thread keeps it, and a run's sessions
  are killed when the run ends. `exec.write` passes the gate on every call, and writing to another
  thread's session is refused (`session_denied`). `GET /exec/sessions?threadId=` lists them and
  `DELETE /exec/sessions/:id` kills one.
- **Document outputs (FR-219).** `document.create {kind: docx|pptx|xlsx|pdf, title, content,
  artifactId?}` and `document.read {path | artifactId}` are built-in tools, not skills. They run
  in the Hub process: they only turn validated data into a file or a file into text, run no code
  and import nothing that reaches the network, so the sandbox's guarantees hold. Content is checked
  per format and errors name the field (`content.sheets[0].name: …`). DOCX takes headings, bold
  and italic runs, lists and tables on A4 or Letter; PPTX 16:9 slides with title, subtitle, nested
  bullets and speaker notes; XLSX typed cells, a bold frozen header row and column widths; PDF
  wrapped text, lists, tables that repeat their header and page numbers, in the PDF standard fonts
  (not embedded): characters outside Western European text print as "?", and the tool says how
  many and suggests DOCX. Office files are saved as artifacts of kind `file` with the Office media
  type, PDFs as kind `pdf`, and the title gets the extension. `document.read` reads only inside the
  turn's folders, never the data folder, returns untrusted text (at most 40,000 characters, files
  up to 25 MB) and reads files Nova did not write; a scanned or encrypted PDF gets a "cannot read
  this text" note. Previews are extracted on the Hub (`GET /artifacts/:id/preview`: 500 rows × 50
  columns per sheet, 200,000 characters) and shown in chat and on a run's result card.
- **Image generation (FR-030).** `image.generate {prompt, size?}` is listed only while a
  configured model can make images: the first image model whose provider adapter has an images
  call, and only local ones while `routing.allowCloud` is off. No adapter had an images call in M5
  (`Provider.generateImage` was the planned seam), so the tool was hidden everywhere; M7 adds one
  (below). A generated image is saved as an image artifact. Editing an image, a setting to choose
  the image model and the composer's **Generate image** entry point are not in M5.

*As shipped in M7 (ADR-095).*

- **Image generation (FR-030).** `OpenAICompatibleProvider.generateImage` calls the provider's
  `/images/generations` and asks for one image as base64 (`b64_json`; `gpt-image-*` models
  answer base64 without being asked). Sizes are `<width>x<height>`, each 64 to 4,096; the call
  times out after 180 s and an answer over 64 MiB is refused. A provider that answers with a URL
  instead of image data is refused ("returned a link instead of the image"): Nova does not fetch
  from a second host. The `openai` and generic `openai_compatible` adapters have the call;
  OpenRouter, Ollama and llama.cpp do not. Image models are recognised by name (`gpt-image*`,
  `dall-e*`, and `stable-diffusion`, `sdxl`, `sd3` or `flux`, with or without a `vendor/`
  prefix), so `image.generate` now appears whenever such a model is configured (still only local
  ones while `routing.allowCloud` is off). The tool takes `1024x1024`, `1024x1536`, `1536x1024`,
  `512x512` or `256x256`.
- **Generate image in the composer.** A chat's composer shows an image button while the Hub
  lists `image.generate` and the chat has a thread (availability is cached for 60 s). It offers
  Square, Landscape and Portrait (1024 × 1024, 1536 × 1024, 1024 × 1536) and sends the request as
  the user's own action (`POST /tools/image.generate/invoke` with `initiator: 'user'`, §6), so it
  passes the gate like a direct call and an approval or provider error is shown. The result
  appears from the Hub's artifact route. Editing an image and choosing the image model are still
  not built.

### 1.2 Tool result contract

```ts
type ToolResult =
  | { ok: true; content: ContentPart[]; meta?: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string; details?: unknown } };
```

Results are persisted as `tool_result` message parts and `tool_call` rows, and are always
labeled **untrusted** when fed back to the model (injection defense, FR-103).

### 1.3 Patch format (`fs.edit`)

`fs.edit` takes one text argument in the **Nova patch format**: a plain-text envelope that
adds, deletes, updates and moves files using context instead of line numbers, so a model can
write it without knowing exact positions.

**Structure.**

- A patch opens with the line `%%% patch` and closes with `%%% end`.
- Between them come one or more file sections, each opened by a marker line:
  - `%%% add <path>`: creates a file. Every following line until the next marker starts with
    `+`; the text after `+` is the file content.
  - `%%% delete <path>`: deletes a file. It has no body.
  - `%%% update <path>`: changes a file. It may be followed by `%%% move-to <path>` to rename
    it, and then by one or more hunks. An update needs at least one hunk unless it moves the
    file.
- A **hunk** starts with a line beginning `@@`. Text after `@@` is an optional **anchor**: a
  line that must exist in the file before the hunk and narrows where the hunk is searched.
  Several `@@ <anchor>` lines in a row narrow step by step (for example a class, then a method).
- Hunk lines start with a space (unchanged context), `-` (removed) or `+` (added). Context
  plus removed lines form the **old block**; context plus added lines form the **new block**.
- `%%% eof` directly after a hunk's last line asserts that the old block ends at the end of
  the file.

```text
%%% patch
%%% add docs/notes.md
+# Notes
+
+Release checklist.
%%% update src/server.ts
%%% move-to src/http/server.ts
@@ export function start
   const port = 3000;
-  listen(port);
+  listen(port, host);
@@ export function stop
   flush();
-  close();
+  close({ graceful: true });
 }
%%% eof
%%% delete src/legacy.ts
%%% end
```

**Grammar** (EBNF; `eol` is LF or CRLF):

```ebnf
patch    = "%%% patch" eol section { section } "%%% end" [ eol ] ;
section  = add | delete | update ;
add      = "%%% add " path eol { "+" text eol } ;
delete   = "%%% delete " path eol ;
update   = "%%% update " path eol [ "%%% move-to " path eol ] { hunk } ;
hunk     = "@@" [ " " anchor ] eol { "@@ " anchor eol } line { line } [ "%%% eof" eol ] ;
line     = ( " " | "-" | "+" ) text eol ;
```

**Leniency.** The parser ignores spaces and tabs before and after a marker and between a
marker keyword and its path, blank lines between sections, CRLF line endings, and a missing
final newline. Inside a hunk, an empty line counts as an empty context line. A line whose
trimmed text is a complete marker is always read as a marker; a context line that would read
as one must be replaced by another context line.

**Paths.** Paths are relative to the session working directory and use `/`. Absolute paths are
accepted only inside allowed roots. Paths that escape a root (through `..` or a symlink), and
protected paths (FR-190), are rejected.

**Applying.**

1. The whole patch is parsed and validated before anything is written.
2. Every touched path is evaluated by the policy engine (write, delete or move); one approval
   card shows the complete diff.
3. Hunks apply in order, each searched after the end of the previous one and after its
   anchors. Matching tries exact text, then ignoring trailing whitespace, then ignoring leading
   and trailing whitespace. The first level with exactly one match wins; no fuzzier matching
   is attempted.
4. If a file changed outside the session since the agent last read it, the patch is matched
   against the current contents and the decision escalates to `ask`, with the change noted
   (`docs/20` defaults).
5. The patch applies all-or-nothing (temporary files, then rename). Each file keeps its line
   ending style and final-newline state; new files use LF.
6. Success returns, per file, the operation, lines added and removed, and SHA-256 before and
   after (in `meta.files`).

**Rejected patches** return `{ok: false, error}` and change nothing. `error.details` carries
`line` (in the patch), `path`, `hunk` (index) and, for match failures, up to 3 `candidates`
(`{line, preview}`) nearest to the expected position, so the model can correct and retry.

| Code | Cause |
| --- | --- |
| `patch.syntax` | Malformed envelope, unknown marker, body line without a valid prefix |
| `patch.path_denied` | Path outside allowed roots, escaping a root, or protected |
| `patch.file_exists` | `add` or `move-to` target already exists |
| `patch.file_missing` | `update` or `delete` target does not exist |
| `patch.context_not_found` | An anchor or old block matched nowhere |
| `patch.context_ambiguous` | An old block matched more than once at the best level |
| `patch.binary` | Target is a binary file |
| `patch.too_large` | Patch over 1 MiB |

`fs.edit` also accepts a standard unified diff (`---`/`+++` headers, `@@ -a,b +c,d @@` hunks).
Its line numbers are treated as hints only; matching and errors follow the rules above.

### 1.4 Deferred tools and tool search (FR-196)

Large MCP and plugin catalogs crowd the context of small local models. Nova defers them.

- **Budget.** Before each model call the registry measures the enabled tools for the turn. If
  they exceed **40 tools or 8,000 schema tokens** (defaults; a model profile can lower or
  raise them), MCP and plugin tools become deferred. Schema tokens are counted with the active
  model's tokenizer, or estimated at 4 characters per token when none is available.
- **Always loaded:** built-in tools (including `tool.search`); tools named in an `@`-mention,
  and every tool of an `@`-mentioned MCP server; tools listed in an active skill's
  `allowed_tools`.
- **What the model sees.** `tool.search` plus one summary line per deferred source (for
  example "`mcp:linear`: 23 tools, deferred"), so it knows to search.
- **Search.** `tool.search {query, limit?}` (default 5, max 20) ranks deferred tools with
  BM25 over a document per tool built from the canonical name (split on `.`, `_`, `-` and
  camelCase), the title and the description. Ties break by canonical name. Ranking is local
  and deterministic, with no model or network call. The index is rebuilt when a server's tool
  list changes.
- **Loading.** Matches are returned (name, title, one-line description, score) and loaded for
  the next model call. They stay loaded for the rest of the thread until the next compaction.
  If loading would exceed the budget, the tools loaded longest ago by search are unloaded
  first; mentioned and skill tools are never unloaded.
- **Never listed:** tools disabled on their server, and tools that policy denies outright in
  the current scope. Loading a tool grants nothing: every call still passes the policy
  engine (§6).
- Searches and loads appear in the Activity trace.

### 1.5 Scripted tool calls (FR-202)

`script.run` lets the model write a short JavaScript program that calls other tools as
functions. The program runs in an isolated engine with no network, filesystem, timers or modules.
Each tool it calls is a nested call that the policy engine evaluates and the audit records as its
own tool call. The feature is off by default.

*As shipped in M7 (ADR-095; `packages/core/src/scripts`, `apps/hub/src/flagged.ts`).* The
security setting `scripts.enabled` (default off) lists `script.run`; while it is off the tool is
not listed and the script routes answer 404.

- **Engine.** Each run gets its own QuickJS engine (a fresh WebAssembly module) in its own worker
  thread, with heap and stack limits, an empty environment and a watchdog that can terminate it.
  The script is the body of an async function. `await tools.call("fs.read", {path: "a.txt"})`
  (or the same call through the tool's name as a property of `tools`) returns the tool's text
  result and throws an `Error` with a `code` when the call fails or is denied. `tools.names`
  lists the tools, `input` holds the `input` argument, and the `console.log` output and the
  returned value (as JSON) come back. Source is at most 50,000 characters.
- **Limits** (`scripts.limits`, a security setting): 5 s of CPU (`cpuMs`, 100 to 30,000),
  32 MiB of memory (`memoryMb`, 8 to 128), 20 nested calls (`maxCalls`, 1 to 100) and 20,000
  characters of log (`logChars`); the result is cut at 20,000 characters. Only time spent
  running script code counts, so waiting for a nested call's approval does not use the budget. A
  worker that runs past the budget plus 3 s with no call outstanding is terminated. The tool's own
  timeout is 600 s. Errors include `cpu_limit`, `memory_limit`, `stack_limit`, `syntax_error` and
  `script_error`.
- **Nested calls.** Each goes through the tool runtime exactly like a direct model call:
  validation, hooks, the gate with its asks, denies, grants and reviewer, the handler's timeout,
  its own `tool_call` row and its audit. The row points at the script's call through
  `parent_call_id`. Calls run one at a time; an ask pauses the script until the user answers, and
  a deny throws inside the script. Each nested call is also audited as `script.call`, naming the
  script's call. Taint from a result carries to every later call.
- **No user instruction.** The tool context does not expose the provenance of the script's call,
  so nested calls carry no user instruction: a consequential nested call asks unless a rule or
  grant allows it. A script cannot call the tools that drive the turn itself: `script.run`,
  `tool.search`, `skill.load`, `context.fresh`, `context.remaining` and `run.complete`.
- **Origin.** Nested calls record the script caller's origin, with `ui` recorded as `model` (a
  script started from the UI is still code the model wrote). The `script` origin of
  `ToolContext` (§1) is not recorded yet, because `tool_call` allows only four origins. *Since M8*
  (ADR-097, migration 0051) nested calls are recorded with origin `script`, and the gate treats
  them like a model's calls.
- **Not served to MCP clients.** `script.run` is itself read-only but calls write tools, so
  Nova's MCP server never serves it (§2.2).
- **Records and UI.** `script_run` keeps each run's status, error code, call count, CPU time and
  a SHA-256 of the code; the code itself is not kept. `GET /api/v1/scripts/runs?threadId=` and
  `GET /api/v1/scripts/runs/:id` list runs with each nested call, its status and the gate's
  decision. Settings → Experimental has the switch (it asks before turning on) and the limits; a
  Code session shows a **Scripts** tab while the flag is on. Runs are listed per thread only.

### 1.6 External agent adapters (FR-203)

A Code session can delegate a task to an external coding agent over an open agent protocol. Nova
accepts an adapter only when it routes every permission request to Nova's policy engine, and the
agent runs inside a Nova sandbox. Its file changes appear as Nova diffs. The feature is off by
default and managed policy can keep it off.

*As shipped in M7 (ADR-095; `packages/core/src/acp`, `apps/hub/src/flagged.ts`).* The security
setting `externalAgents.enabled` (default off) turns it on. While it is off, the adapter and
delegation routes answer 404, except reading and cancelling a delegation.

- **Protocol.** Nova is a JSON-RPC client of the Agent Client Protocol, version 1, over the
  agent's stdin and stdout; stderr is discarded. It implements the subset it needs: `initialize`
  (advertising file reads, file writes and terminals), `session/new` (the session folder and no
  MCP servers), `session/prompt`, `session/cancel` and the `session/update` notification, and it
  answers the agent's `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`,
  `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill` and
  `terminal/release`. An agent that answers with another protocol version is refused.
- **Adapters.** `POST /api/v1/agent-adapters` takes `name`, `command` (a program name or path,
  no spaces or shell syntax), `args`, `env`, `network` (declared hosts, at most 20) and
  `permissionRouting`. Only `client` (every request routed to Nova) is accepted; `agent` is
  refused with `permission_routing`. Env values go to the vault as
  `secret://agent-adapter/<id>/env/<NAME>`; a reference to any other secret is refused with
  `foreign_secret`, also when an older row already holds one. `GET`, `PATCH` and `DELETE
  /api/v1/agent-adapters/:id` manage an adapter. `POST /api/v1/agent-adapters/:id/check
  {sessionId}` starts the agent in that session's sandbox, runs only the handshake and records
  the result as `lastCheck`; the agent's name and version are redacted, stripped of the adapter's
  own secret values and clipped to 100 and 50 characters.
- **Delegations.** `POST /api/v1/code/sessions/:id/delegations {adapterId, prompt}` answers 202
  and starts one; `GET` on the same path lists them. Only the user starts a delegation: there is
  no model tool for it. One delegation runs per session at a time, for at most 2 h.
  `GET /api/v1/delegations/:id` and `POST /api/v1/delegations/:id/cancel` read and stop one. The
  agent's reply is kept redacted, at most 20,000 characters.
- **Operations through the gate.** Every file read, file write and command the agent asks for
  runs as Nova's `fs.read`, `fs.write`, `exec.run` or `exec.poll` in that session, through the
  tool runtime and the gate. The session's permission mode applies, and writes become the
  session's diffs. The calls carry the delegation as the user's instruction plus the taint
  `external_agent`, so rules that act on a request alone never apply to them. Paths must be
  absolute, and the tools keep them inside the session's roots.
- **Permission requests.** For kinds Nova then performs (read, search, edit, move, delete,
  execute), the engine's verdict on that operation is previewed: a deny rejects at once, and
  anything else is allowed because the operation itself still passes the gate, which asks when
  its rule says so. The other kinds (`fetch`, `think`, other) are decided by the gate itself as
  `acp.fetch`, `acp.think` or `acp.action`, with an approval when it asks. An allow always picks
  the agent's `allow_once` option and never `allow_always`: Nova's own grants decide what is
  remembered. If the engine fails, the request is rejected.
- **Sandbox.** The agent runs in the sandbox the session's commands are routed to, never on the
  Hub itself, with the session folder mounted read-only. A session whose environment runs
  commands without a sandbox (SSH, WSL, a device) is refused with `no_substrate`, and
  availability is checked on that same sandbox. Network is off unless the adapter declares hosts.
  Then the agent's egress policy is built from those hosts only: the global mode and deny list
  still apply, but session grants, the global allow list, injected credentials and hooks do not.
  Only the Hub's egress proxy can enforce that, so declaring hosts on a sandbox whose network does
  not pass it (a cloud runner) is refused with `no_egress_proxy`.
- **Terminals.** At most 8 per delegation, and at most 1 MiB of output kept per terminal (the
  newest), whatever the agent asks for. Every command the agent started is killed when the
  delegation ends, directly in the sandbox, without waiting on an approval. Environment variables
  the agent asks for on a terminal are ignored. *Since M8* (ADR-097) they pass only through an
  allowlist of names (`acp/env.ts`: `CI`, `TERM`, `LANG`, `TZ`, `LC_*`, colour, pager, language
  runtime and Git author names and the like; at most 32, values at most 4,096 characters, no control
  characters, vault references or anything the redactor would change), and they are run as leading
  `NAME=value` assignments the policy engine sees, so an allow rule for the bare command does not
  match and the user is asked.
- **Events and audit.** `delegation.started`, `delegation.updated` and `delegation.finished`,
  correlated by thread. `delegation.updated` is not persisted and is coalesced to at most one
  event per 250 ms: `message` and `thought` text joined (up to 4,000 characters each), at most 10
  `toolCalls` with the rest counted in `droppedToolCalls`, and `plan` when the agent updated its
  plan. Audit actions (kind `code`): `agent_adapter.create`, `.update`, `.delete` and `.check`;
  `delegation.start`, `.permission`, `.cancel` and `.finish`.
- **Turning it off.** Turning `externalAgents.enabled` off stops running delegations, which end
  `cancelled` with the reason recorded. The host also checks the flag before each request the
  agent makes, so a change that emits no event (managed policy) stops the agent at its next
  request. A stopped agent gets 10 s to end its turn.
- **UI.** Settings → Experimental has the switch (it asks before turning on) and the adapters:
  add with write-only secrets, check in a chosen session, turn off, edit and remove. A Code
  session shows an **Agents** tab while the flag is on: delegate, live activity and stop.

## 2. MCP integration

### 2.1 MCP client (FR-042)

- **Transports:** stdio, SSE (older servers), streamable HTTP. One child process (or
  connection) per server; supervised with restart + backoff.
- **Protocol.** Nova implements MCP protocol version **2025-11-25 or later** and negotiates
  the version during `initialize`. If a server answers with a version Nova does not support,
  the connection ends with an error naming both versions.
- **Client capabilities advertised:** roots (the folders granted to the server), elicitation
  (answered through server-to-client requests, FR-188), sampling (only when enabled for that
  server; policy-gated and charged to the run budget), the **MCP Apps UI extension** with the
  MIME type `text/html;profile=mcp-app` (FR-198), and the **events extension** when the
  negotiated protocol defines it and the Hub has a reachable webhook URL (§2.4).
- **Discovery:** `tools/list`, `resources/list`, `resources/templates/list`, `prompts/list`;
  list-changed notifications refresh the registry and the tool-search index (§1.4).
- **Isolation.** Each server is sandboxed; file and network access is granted explicitly per
  server. Remote servers are reached through the egress proxy (FR-193).
- **Namespacing:** external tools become `mcp:<serverId>.<toolName>`; resources are
  referenceable in `@`-mentions.
- **Health view:** status, uptime, last error, log tail, restart, disable (FR-043).

**Per-server settings.**

The fields below are those of `contracts/schemas/mcp-config.json` (one entry per server under
`servers`); unknown fields are rejected.

| Setting | Meaning | Default |
| --- | --- | --- |
| `transport` | `stdio` \| `sse` \| `http` (streamable HTTP) | required |
| `command` / `args` / `env` | Launch line for `stdio` (required for `stdio`); `env` values may be `secret://` references | — |
| `url` / `headers` | Endpoint and HTTP headers for `sse` and `http` (`url` required for them); secret header values are `secret://` references | — |
| `auth` | `secret://` reference to an API key or bearer token | none |
| `oauth` | OAuth 2 with PKCE (FR-047): `clientMetadataUrl`, `dynamicRegistration` (default `false`; not together with `clientMetadataUrl`) and `scopes` | none |
| `deviceId` | Run this `stdio` server on a device and reach it through `novad` (FR-210); not allowed for `sse`/`http` | Hub |
| `enabled` | Start and list the server | `true` |
| `required` | A session that uses this server fails to start with a clear error if the server is not ready, instead of continuing without it | `false` |
| `startupTimeoutMs` | Time allowed for `initialize` and the first `tools/list` (1,000 to 120,000 ms) | 30,000 |
| `toolTimeoutMs` | Per-call timeout (1,000 to 600,000 ms; overrides the central default, §9) | 60,000 |
| `enabledTools` / `disabledTools` | Allow list / deny list of tool names (`disabledTools` applies after `enabledTools`); a disabled tool is never listed to the model or found by `tool.search` | all enabled |
| `readOnlyTools` | Tools the owner declared read-only (at most 500, matched like `enabledTools`; §1); ignored for a plugin's server | none |
| `defaultApproval` | `allow` \| `ask` \| `deny`, the per-tool default for this server's tools (FR-048); never overrides built-in safety | `ask` |
| `deferred` | `true` keeps the server's tools behind `tool.search`, `false` always loads them (FR-196) | automatic (§1.4) |
| `policy` | `network` (hosts) and `fs` (`none` \| `read` \| `project`) granted to the server | none |

**Authentication (FR-047).** Remote servers that require OAuth are authorized with OAuth 2.1
and PKCE (S256). Nova discovers the authorization server from the server's protected-resource
metadata and registers itself with a **client metadata document** (`oauth.clientMetadataUrl`:
a client id that is an HTTPS URL served by the Hub) or, when the server offers it, **dynamic
client registration** (`oauth.dynamicRegistration: true`); the two are mutually exclusive in
one server entry, and `oauth.scopes` lists the scopes requested. Access and refresh tokens
are stored only in the keychain (FR-101; never in a config file), refresh automatically, and
can be revoked from the server's settings, which also calls the server's revocation endpoint
when it has one. API-key servers store the key in the keychain the same way and reference it
from `auth`.

*As shipped in M4 (ADR-091).* The client metadata document is served at
`/.well-known/nova-client.json` and is used when the authorization server accepts one and the Hub
has an HTTPS URL; otherwise Nova registers dynamically. Nova requests the scopes the resource
advertises (in M4 the API took no `oauth` settings; M7 adds them, below). The browser returns
to the Hub route `/api/v1/mcp/oauth/callback`, which needs no session because the single-use
`state` (10 minutes, bound to the account) authenticates it, then redirects to
`/settings/tools?oauth=ok|error`.
Tokens are vault entries `secret://mcp/<id>/oauth/…`, refreshed within 60 s of expiry or after a
401. A server that refuses an unauthenticated connection reports that it needs authorization;
its row in Settings → Tools & MCP shows **Needs sign-in** with **Sign in**, and later
**Reconnect** and **Sign out**.

*As shipped in M7 (ADR-095; `apps/hub/src/mcp.ts`, `packages/mcp/src/device-transport.ts`).* The
server API takes the three remaining fields of the table above.

- **`deviceId`** (stdio only). The server runs on that device and the Hub reaches it through
  `novad`'s MCP pass-through (FR-210), as the account's user, under the `mcp` grant the device's
  owner gave for that server. `command` is the server's name as the device lists it: the Hub never
  spawns a device server and never sends a device a command line; the device's own configuration
  starts it. A device still waiting for approval cannot be chosen, and every call refuses a device
  that is not active. A server the device lists with an error, or does not list, fails the
  connection. Device servers expose tools only; their resources and prompts are not listed.
  *Since M8* (ADR-097) they also offer resources and prompts: `novad` as built in M8 answers
  `POST /agent/v1/mcp/request` for five read-only methods (`resources/list`,
  `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get`) under the same `mcp`
  grant (`contracts/hub-api.md` §3); `resources/read` and `prompts/get` are audited as
  `device.mcp.request`. A `novad` without that route still offers tools only.
- **`auth`** (sse and http only, not together with `oauth`). The value goes to the vault as
  `secret://mcp/<id>/auth/header` and is sent as the `Authorization` header; a value with no
  scheme is sent as `Bearer <value>`. An empty string keeps the saved value, `null` removes it, and
  a `secret://` reference is refused. The server's view shows only `hasAuth`.
- **`oauth`** (sse and http only). `clientMetadataUrl` (https), `dynamicRegistration` and
  `scopes` now feed **Sign in**: dynamic registration skips the metadata document, another
  document replaces the Hub's own, and listed scopes replace the advertised ones. The view returns
  them as `oauthSettings`.

**Secrets in configuration.** Every secret value in `env`, `headers` or `auth` is a
`secret://` reference; OAuth tokens are never in the configuration at all. A secret entered
in the UI is written to the keychain and replaced by its reference on save. Plaintext secrets
found in imported or hand-edited configuration are migrated into the keychain and replaced by
references, and the user is told which keys moved (FR-200).

### 2.2 MCP server (FR-044, FR-192)

Nova can expose itself over MCP. Exposure is **off by default** and is granted **per client**
(ADR-075):

- **Adding a client** (Settings → Apps & clients) names the client and
  sets its scope: which `nova.*` tools, which projects, which thread scope, read-only or
  run-allowed, and an optional expiry (default 90 days). Nova issues a token for that client
  only, shows it once, and stores only its hash.
- **Nova never writes into another application's configuration.** It shows the URL or command
  and a configuration snippet for the user to paste into the client. It never detects other
  clients and registers itself, and never copies its skills into other agents' folders.
- **Transports:** streamable HTTP on the Hub (bearer token, `Origin`/`Host` checks per
  FR-192) and a stdio launcher (`nova mcp stdio`) that reads the token from an environment
  variable or file the user configures.
- **Tools:** `nova.listProjects`, `nova.getThread`, `nova.search`, `nova.runTool`
  (allowlisted per client). **Resources:** project files (read-only) and thread transcripts
  within the client's scope. **Prompts:** skills in scope, served on request as MCP prompts.
- Revoking a client token closes its open sessions at once. The client list shows last use.
- Every call is audited with the client id and evaluated by the policy engine as if made by a
  plugin. An `ask` reaches the user as an approval and is never auto-allowed. Requests from a
  client are never user-typed authorization (FR-189).

*As shipped in M4 (ADR-091).* Clients are added in Settings → **Apps & clients**, which also has
the `mcpServer.enabled` switch (adding the first client turns it on). A client's scope is its
tools (all or a list), its projects (all or a list), chat access (`none`, `read`, `read_write`),
`read_only` or `run_allowed`, and an expiry of 7, 30, 90 (default) or 365 days, or never (in
the API, `expiresInDays: null` never expires and leaving it out means 90 days). The token starts
`nvm_`; the page shows it once with the endpoint and a configuration snippet to copy. The endpoint is `/mcp` on the Hub (streamable HTTP):

| Request | Answer |
| --- | --- |
| Server off | 404 |
| Missing, wrong, revoked or expired token | 401 `token_required` |
| `Origin` or `Host` not allowed | 403 |

The tools are `projects.list`, `threads.list` and `threads.read` within the client's scopes,
plus the Hub tools its scopes allow, with characters MCP does not accept replaced (`mcp:x.y` is
served as `mcp_x.y`). A read-only client gets only tools whose action is a read; `tool.search`
is never served. Temporary chats are never shared, a client limited to some projects sees no
chat outside them, and `read_write` reads only until a write tool exists. Calls pass the gate
with origin `mcp_client` and no user instruction, and are audited as `client.call`. Resources,
prompts and the `nova mcp stdio` launcher arrive in M7 (below).

*As shipped in M7 (ADR-095; `apps/hub/src/mcp-server.ts`, `packages/mcp/src/launcher-main.ts`).*

- **Resources.** `resources/list` lists the client's chats (the 50 most recent in its scope;
  temporary chats never) as `nova://threads/<id>` when its chat access is not `none`. A transcript
  is Markdown, redacted and cut at 200,000 characters. `resources/templates/list` offers
  `nova://projects/{projectId}/files/{+path}` to a client with projects in scope: a text file in
  one of the project's folders, read-only, at most 1 MiB, never in the data folder. Files are read
  only from projects of the client's own account; the path is resolved once and opened with
  `O_NOFOLLOW`.
- **Prompts.** The account's active skills, offered only to clients whose tools include
  `skill.load` (or all tools). `prompts/get` returns the skill's body, with the optional `input`
  argument appended.
- **Gate.** Every read and prompt passes the gate like a tool call (as `threads.read`, `fs.read`
  or `skill.load`) and is audited as `client.call`. The list calls pass it too (as
  `threads.list`, `projects.list` and `skills.list`); a denied list comes back empty and is
  audited. Anything out of scope or denied reads exactly like something that does not exist.
- **Never served:** `tool.search` and `script.run` (§1.5).
- **Stdio launcher.** `nova mcp stdio [--url URL] [--token-file FILE]`
  (`packages/mcp/src/launcher-main.ts`) relays newline-delimited JSON-RPC between stdin and
  stdout and the Hub's `/mcp`, adding the client's token as a bearer token. The endpoint comes
  from `--url` or `NOVA_MCP_URL` and must be https (http only to this machine); the token comes
  from `NOVA_MCP_TOKEN` or a file (`--token-file` or `NOVA_MCP_TOKEN_FILE`). The launcher never
  prints or logs the token and holds no scope of its own: the Hub authenticates, scopes, gates and
  audits every call as it does for an HTTP client. No `nova` command is installed yet, so it runs
  as `node packages/mcp/src/launcher-main.ts mcp stdio`. *Since M8* it is `nova mcp stdio` of the
  `nova` command (`packages/cli`, ADR-097 D1).

### 2.3 Configuration

```jsonc
// mcp.json (managed in-app; secrets are keychain refs only)
{
  "servers": {
    "linear": { "transport": "stdio", "command": "npx", "args": ["-y", "mcp-linear"],
                "env": { "LINEAR_API_KEY": "secret://connector/linear/token" },
                "policy": { "network": ["api.linear.app"], "fs": "none" },
                "startupTimeoutMs": 20000, "toolTimeoutMs": 60000,
                "disabledTools": ["deleteIssue"], "defaultApproval": "ask" },
    "notion": { "transport": "http", "url": "https://mcp.notion.example/v1",
                // tokens live in the keychain (FR-101), never in this file
                "oauth": { "dynamicRegistration": true, "scopes": ["read"] },
                "enabledTools": ["search", "fetch"], "required": true }
  }
}
```

### 2.4 MCP event subscriptions (FR-201)

Servers that advertise the events extension can push events instead of being polled. Event
subscriptions are a trigger source for FR-056 (`docs/09` §7).

- **List.** Nova calls `events/list` and shows each event (name, description, payload schema)
  as a trigger source for that server.
- **Subscribe.** Enabling a trigger generates a per-subscription secret (32 random bytes,
  stored in the keychain) and a unique, unguessable webhook URL on the Hub, then calls
  `events/subscribe` with the event, any filter parameters, the URL and the secret. Nova
  records the subscription id and the server's refresh deadline (`refreshBefore`).
- **Refresh.** Nova renews the subscription before the deadline: at 80 % of the interval or
  10 minutes before it, whichever comes first. Failures retry with backoff. A subscription that
  lapses shows `lapsed` on the trigger and raises a notification; it never stays silently dead.
- **Unsubscribe.** Disabling or deleting the trigger, removing the server or uninstalling its
  plugin calls `events/unsubscribe` and deletes the secret. The webhook URL then answers 410.
- **Reachability.** The server must be able to reach the webhook URL. A remote server needs the
  Hub's public or tunnel URL. If no reachable URL is configured, enabling the trigger fails with
  an explanation.

**Delivery handling.** The webhook endpoint carries no Nova token, so each delivery is
authenticated by its signature (FR-192: no listener accepts unauthenticated requests).

1. Bodies over **256 KiB** are refused with 413 before parsing.
2. The signature is verified per Standard Webhooks: HMAC-SHA256 with the subscription secret
   over the message id, the timestamp and the raw body (`webhook-id`, `webhook-timestamp`,
   `webhook-signature` headers), compared in constant time. Timestamps more than 5 minutes
   away from Hub time, unknown subscription ids and bad signatures are rejected and logged
   (rate-limited).
3. Deliveries are **deduplicated by message id** for at least 7 days.
4. A valid delivery is queued durably and answered 2xx, then processed asynchronously.
5. The payload is **untrusted input** (FR-103). It starts a run or wakes an agent per the
   trigger's configuration, and can never count as authorization (FR-189).
6. Every delivery writes an audit event (subscription, message id, verdict).

### 2.5 MCP bundles (FR-199)

A single MCP server can be installed from an **MCP Bundle** (`.mcpb`): a zip file with
`manifest.json` at its root, in the open bundle format.

- **Manifest versions:** 0.2 to 0.4. Others are rejected with an error naming the version.
- **Fields read.** Required: `manifest_version`, `name`, `version`, `description`, `author`,
  `server`. `server.type` is `node`, `python`, `uv` (manifest 0.4 only) or `binary` (any other
  type is rejected with an error naming it), with `entry_point` and `mcp_config` (`command`,
  `args`, `env`, and per-platform overrides). Optional fields used in the install preview:
  display name, icon, homepage, repository, license, compatibility (platforms and runtime
  versions), declared
  tools and prompts, and privacy-policy links. Unknown fields are preserved and ignored.
- **User config.** `user_config` entries are typed `string`, `number`, `boolean`,
  `directory` or `file`, with title, description, required, default, and optional `multiple`
  and min/max. The install form is generated from them. Values marked `sensitive` go to the
  keychain and are stored as `secret://` refs; they are passed to the server through `env` at
  launch and never written to disk in plain text. A bundle that puts a sensitive value in
  `args` shows a warning in the preview (visible in process lists).
- **Template variables** in `command`, `args` and `env` expand to the bundle directory, a
  `user_config` value, the home directory and the path separator. Expansion produces argv
  elements; no shell is involved.
- **Runtimes.** `node` bundles run on the Node runtime Nova ships. `python` and `binary`
  bundles need a matching interpreter or platform build. `uv` bundles need the `uv` tool on the
  device, which builds the server's Python environment from the bundle's project file inside
  the bundle directory. Compatibility is checked before install.
- **Permission wrapping.** A bundle declares no permissions, so Nova proposes them: filesystem
  access only to the paths the user enters in `directory`/`file` fields (`read` or `write`,
  chosen in the form); network `none` unless the user adds hosts; secrets only for sensitive
  fields. The server runs sandboxed with exactly these grants (§2.1), and its tools default to
  `ask`.
- **Signatures.** A bundle is verified when it carries a valid signature from a trusted
  publisher key, or when it comes from a signed catalog entry whose checksum matches (§7). An
  unsigned bundle, or one signed by an unknown key, installs only after an **explicit sideload
  confirmation** and is labelled **Unverified** in lists, in its settings and in the audit log.
  Managed policy can require signatures or disable bundles.
- **Install record** (`installRecord` in `contracts/schemas/mcp-bundle-manifest.json`): server
  id, SHA-256 of the bundle, source (`catalog`, `registry`, `file`), signature status
  (`verified`, `unverified`), the confirmed permissions (`network`, `fs`, `secrets`), install
  time, enabled flag and non-sensitive user config.
- **Identity.** The server id defaults to the bundle `name`; on a collision the user picks
  another local id. Tools are exposed as `mcp:<id>.<tool>`.
- **Update** shows the user-config and permission diff; the previous version is kept for
  rollback.

*As shipped in M4 (ADR-091).* Settings → Tools & MCP → **Install a bundle** reads a `.mcpb` or
`.zip` file. The Hub checks paths and caps before it inflates anything: 50 MB upload, 10,000
files, 500 MB unpacked, 200 MB per file. A preview expires after 30 minutes. No publisher key
is trusted yet, so every bundle is **Unverified** and installs only with the sideload
confirmation (`confirmSideload`). Files go to `<dataDir>/mcp/bundles/<name>/<version>`; an update
replaces the server in place and keeps the previous version's folder. Only sensitive settings,
and env values or arguments that use one, go to the vault; launch arguments may reference only
the server's own entries (`secret://mcp/<id>/…`). The server is named after the bundle, and a
name another server already uses is refused (409) until a local id can be chosen. The file
permission is one choice for the folders and files the user entered: none, read, or read and
write. **Bundle servers are not sandboxed yet:** like every MCP server they run as in M3 (FR-107,
M6). The confirmed permissions are recorded in the install record and bound the domains of the
server's MCP Apps, but they do not yet confine the server process.

## 3. Plugins

### 3.1 Manifest (`.nova-plugin/plugin.json`)

A plugin bundles skills, MCP servers, lifecycle hooks, sub-agent roles, commands, browser
extensions and optional UI (FR-045). `${pluginRoot}` expands to the installed plugin folder.

```json
{
  "schemaVersion": 1,
  "id": "com.example.dev-tools",
  "name": "Dev Tools",
  "version": "1.2.0",
  "description": "Lint, test, review and changelog helpers",
  "author": { "name": "Example", "url": "https://example.com" },
  "license": "MIT",
  "engines": { "nova": ">=0.5.0" },
  "permissions": {
    "network": ["api.github.com"],
    "fs": ["${project}"],
    "secrets": ["github.token"],
    "tools": {
      "plugin:com.example.dev-tools.lint": { "action": "read", "default": "allow" },
      "plugin:com.example.dev-tools.openPullRequest": { "action": "send", "default": "ask" }
    },
    "actionDefaults": { "read": "allow", "write": "ask", "send": "ask", "delete": "deny" },
    "hooks": { "answersAsks": false },
    "browserExtensions": ["dev-tools-helper"],
    "ui": { "connectDomains": ["api.github.com"] }
  },
  "skills": ["skills/review", "skills/changelog"],
  "commands": ["commands/release.md"],
  "agents": ["agents/reviewer.md"],
  "hooks": "hooks/hooks.json",
  "mcpServers": {
    "dev-tools": { "transport": "stdio", "command": "node", "args": ["${pluginRoot}/server.js"] }
  },
  "browserExtensions": [
    { "id": "dev-tools-helper", "path": "extensions/helper", "browsers": ["chromium"] }
  ],
  "ui": {
    "entryPoints": [
      { "kind": "global", "resource": "ui://dev-tools/dashboard", "title": "Dev Tools" },
      { "kind": "thread", "resource": "ui://dev-tools/pr-panel", "title": "Pull request" },
      { "kind": "file", "resource": "ui://dev-tools/coverage", "extensions": [".lcov"] }
    ]
  }
}
```

**Components.**

- `skills`: skill folders (§4), registered as `skill:<pluginId>:<name>`.
- `commands`: Markdown command files, **converted to skills** at install (the file body becomes
  `SKILL.md`; the name is the front-matter `name`, else the first heading, else the file name).
  The converted skills are written under `<installDir>/.nova-plugin/commands/<name>/`.
- `agents`: **sub-agent role files** (Markdown with front-matter `name`, `description`,
  `tools`, optional `model_hint`; the body is the role's instructions). They become roles for
  `task.spawn`, named `<pluginId>:<role>`. A role's tools are a subset of the plugin's
  permissions and never more than the parent run's (`docs/09` §4).
- `hooks`: a path to a hooks file, or an inline array of hooks (§4.1). Hooks install untrusted
  and run only after trust by hash.
- `mcpServers`: servers configured as in §2.3. In M4 each becomes an MCP server named by its
  manifest key (`-2`, `-3` … on a collision) whose tools are `mcp:<server>.<tool>`; the plugin's
  permissions apply to them, matched by tool name (§8, ADR-091). Literal env and header values
  move to the vault, and the stored manifest keeps only their `secret://` references. A `node`
  server gets `NODE_PATH` pointing at Nova's own packages, so it can use the MCP SDK Nova ships.
  A plugin's server follows its manifest and changes only through the plugin: `PATCH` and
  `DELETE /mcp/servers/:id` answer 409 `conflict` with `details.reason: 'plugin_owned'`, its
  `McpServerView.pluginId` names the plugin, and Settings → Tools & MCP shows "From the plugin
  <id>; change or remove it in Plugins" with no Edit or Remove and its switches disabled.
- `browserExtensions`: extensions are **declared**, never installed silently. Each one is
  installed only after an explicit consent naming the browser profile. The agent profile is
  the default; the user's own profile requires the extension-bridge consent (FR-096).
  Uninstalling the plugin offers to remove them.
- `ui`: MCP Apps resources and their entry points (below).

**Rules.**

- Plugins are sandboxed; declared permissions are enforced, not trusted.
- Plugins cannot read arbitrary files, make undeclared network calls, or access secrets they
  did not declare. An undeclared request is denied, the plugin is disabled, and the user is
  notified (`docs/20` defaults). In M4 the gate denies a call that names a host the plugin did
  not declare ("<host> is not a host this plugin declared"), checking every http(s) and ws(s)
  URL in the arguments; disabling the plugin and notifying come later (ADR-091).
- **Per-action permissions.** Every tool declares an action class (`read`, `write`, `send`,
  `delete`, `execute`). The user can set defaults per class for the plugin (for example
  "allow read, ask send") and override them per tool (FR-048).
- A plugin hook may answer approval asks only if its manifest sets `hooks.answersAsks: true`
  and the permission preview showed this (§4.1).
- Signatures: every catalog source is signed and verified before install (§7). Until signing
  lands (M8) every plugin is unverified, so every install is a sideload (§3.2).

**UI: MCP Apps (FR-198, ADR-066).** Plugin and MCP-server UI follows the open MCP Apps
extension; there is no Nova-specific panel bridge.

- **Resources.** A UI is an HTML resource with MIME type `text/html;profile=mcp-app` at a
  `ui://` URI, served by the plugin's or server's MCP server. A tool links its UI through its
  tool metadata (`ui.resourceUri`). Nova caches resources by content hash and keys them by
  `(serverId, uri)`.
- **Sandbox.** Each UI renders in its own sandboxed iframe on a unique opaque origin. It has
  no access to the host DOM, cookies, storage or other frames. Top-level navigation, popups and
  cross-origin form posts are blocked. Nested frames are blocked unless the resource declares
  frame domains.
- **CSP.** The iframe's Content Security Policy is built from the resource metadata (connect,
  resource and frame domain lists) and defaults to no external origins. Declared domains are
  intersected with the plugin's or server's network permissions, so a UI can never reach
  further than its manifest allows.
- **Bridge.** JSON-RPC 2.0 over `postMessage` only. Nova checks the source window and validates
  every message against the schema. Host to UI: initialization (host context: theme tokens
  from `docs/14` §2.1, locale, display mode, container size), tool input and tool result
  notifications (with structured content), cancellation and teardown. UI to host: tool calls,
  messages to the conversation, model-context updates, link-open requests, display-mode and
  size requests.
- **Policy.** Every tool call from a UI passes the policy engine (origin `ui`) as the owning
  plugin or server. A UI can call its own server's tools and only those Nova tools its manifest
  grants. Approval cards render in Nova's own chrome, never inside the iframe. A UI's call
  carries no user instruction (`initiator: 'app'`), so a call that is not read-only asks under
  the default policy. In M4 a UI may run at most 4 calls at once, and Nova tools are refused even
  when the manifest grants them (fail closed, ADR-091).
- **Untrusted output.** Messages a UI posts are labelled as coming from that UI and never count
  as user-typed authorization (FR-189). They do only when the UI fills the composer and the user
  sends. Model-context updates are untrusted content, capped at 4,000 tokens (16,000 characters)
  per widget; the Hub keeps them in memory for the thread and drops them when the app closes.
- **Widget state** is split into model-visible and private parts. **Private state is never sent
  to the model** or to a provider, and it never leaves the browser: it is kept per widget
  instance in the client and is not stored on the Hub (ADR-091). A UI marks it with the Nova
  extension `_meta["nova/private"]`, on one content block or on a whole update; the host
  advertises the extension as `experimental["nova/private"]`. Nova-specific extras are
  namespaced extensions that a UI must feature-detect.
- **Display modes:** inline (a card, or a carousel for lists), fullscreen, picture-in-picture.
  The host chooses the final mode; phones show picture-in-picture as a bottom sheet
  (`docs/04` §2.9).
- **Entry points:** `global` (a full-page app opened from the sidebar), `thread` (a side panel
  beside one conversation, which receives only that thread's context) and `file` (a viewer or
  editor for listed file extensions; edits go through `fs.write`/`fs.edit` under policy).

### 3.2 Lifecycle

install → verify signature and checksum (unsigned: explicit sideload confirmation, labelled
Unverified, §7) → show the permission preview (network, filesystem, secrets, per-action tool
defaults, hooks, browser extensions, UI domains and entry points) → resolve deps → place in
`plugins/<id>/<version>/` → register skills (including converted commands), roles, MCP
servers, UI resources, and hooks (pending trust) → enable → (on update) show the permission
diff, ask for re-trust of any hook whose hash changed, migrate → (on uninstall) remove hooks,
roles, UI state and registrations, offer to remove browser extensions, and clean up user data
with confirmation.

**The install flow as shipped (M4, ADR-091).**

1. **Source.** A catalog entry, a folder on the Hub (the folder holding
   `.nova-plugin/plugin.json`) or a Git URL with an optional ref.
2. **Preview** (`POST /plugins/preview`) validates the manifest, records a digest of the whole
   folder and holds the result for 30 minutes. It writes nothing. The screen (`docs/04` §2.12)
   shows Verified or Unverified, the permissions in plain words, the permission changes on an
   update, the skills, the MCP servers and every hook with its event, command, timeout and full
   hash.
3. **Install** (`POST /plugins`) needs the preview id and, because no publisher is verified
   yet, `confirmSideload: true`; without it the Hub answers `validation` with
   `details.reason: 'sideload_confirmation_required'`. A folder that changed since the preview
   answers 409; an expired preview 410 `request_expired`. The request also names the hooks to
   trust now and whether to enable the plugin.
4. **Place and register.** Installs run one at a time. Files are copied to
   `<dataDir>/plugins/<id>/<version>/`; an update swaps the version folder atomically and rolls
   back on failure. Skills (with converted commands), sub-agent roles (`agent_role`), MCP servers
   (`mcp_server` rows with source `plugin`) and hooks are registered; the plugin's
   `plugin_install` row keeps the manifest with secret values replaced by references.
5. **Hooks** the user did not tick stay `needs_trust` (Settings → Plugins & skills → Hooks).
6. **Uninstall** removes the folder, the registrations, the plugin's servers and their vault
   entries.

An imported plugin (§4.2) takes the same path: choosing it on the import screen is the sideload
confirmation, and it is installed disabled. Signature checks, browser-extension install and a UI
for plugin secrets come later.

*As shipped in M8 (ADR-097 D2-D3; `packages/core/src/sdk`, `packages/core/src/market`).*

- **Signed bundles.** A plugin can now arrive signed: as a `.novax` (an extension, below) or from a
  verified catalog with a matching checksum (§7). The **D2 digest** of a set of files is the SHA-256
  over the sorted lines `"<path>\n<sha256 of the file>\n"` (paths relative, `/`-separated, never
  holding a control character); a `.novax` carries `META-INF/nova-signature.json` with the
  publisher's Ed25519 signature over `"nova-extension-v1\n"` + that digest
  ([`extension-signature.json`](../contracts/schemas/extension-signature.json)), and a catalog lists
  a folder's digest. A publisher in `plugins.trustedPublishers` makes it **Verified**; anything else
  installs only with the sideload confirmation, and a signature that does not match is refused.
- **Provenance.** `PluginService.install` takes `{verified, publisher, source, origin, via}` from
  the marketplace and the extension installer, so the `plugin_install` row and the `plugin.install`
  audit entry carry the real verdict, publisher and catalog. `POST /api/v1/plugins` never passes
  it: a folder or Git install stays Unverified ("Unverified: a plugin installed from a folder or Git
  is not signed by a publisher you trust…").
- **Extensions.** A plugin folder with `.nova-plugin/extension.json`
  ([`extension-manifest.json`](../contracts/schemas/extension-manifest.json)) is an extension: its
  code runs in the SDK's worker (`docs/14` §4.4) and its tools are `ext:<id>/<name>` with source
  `plugin`. It installs through `POST /api/v1/extensions` or the marketplace; one installed through
  `/api/v1/plugins` is adopted as an Unverified extension. An extension's plugin part (its skills,
  roles, MCP servers, hooks and UI) is an ordinary plugin.
- **Managed policy** may refuse a plugin by id or any unverified install (`policy_denied`
  `{reason: managed}`, `docs/12` §10); the installer checks it on every path.
- **Paths.** Uninstalling a plugin, or removing an unused version folder, refuses any path outside
  `<data>/plugins` before anything changes (an imported row cannot point elsewhere).
- **Not built:** browser-extension install and a UI for plugin secrets.

## 4. Skills

A **skill** is a folder containing `SKILL.md` (YAML front-matter plus Markdown instructions)
and optional supporting files such as scripts and templates. The layout follows the open
agent-skills format (FR-046, ADR-067), so skills from other tools work unchanged.

```text
code-review/
  SKILL.md
  scripts/collect-diff.sh
  templates/report.md
```

```markdown
---
name: code-review
description: Review a diff for correctness, security and style, with a concrete fix per finding.
when_to_use: When the user asks to review code, or before committing.
allowed_tools: [fs.read, fs.search, code.symbols, exec.run]
model_hint: { reasoning: high }
---
## Instructions
1. Run `scripts/collect-diff.sh` to identify the diff scope.
2. Read changed files and surrounding context.
3. Report findings grouped by file with severity and a concrete fix, using
   `templates/report.md`.
4. Never apply changes without approval.
```

**Front-matter.**

| Field | Required | Rule |
| --- | --- | --- |
| `description` | yes | What the skill does and when; 1 to 1,024 characters (empty is invalid); the validator warns under 20 characters |
| `name` | no | Defaults to the folder name; at most 64 characters of lowercase letters, digits and `-` |
| `when_to_use` | no | Extra guidance for auto-selection; at most 1,024 characters |
| `allowed_tools` | no | Restricts the tools available while the skill is active: a list, or a space- or comma-separated string. `allowed-tools` is accepted as an alias; a skill may not set both |
| `model_hint` | no | Reasoning or model preference, applied within the user's model settings: a string (at most 100 characters) or `{model?, preset?, reasoning?: off \| low \| medium \| high \| max}` |

Unknown keys (for example `license`, `metadata`) are preserved and ignored. Colons inside an
unquoted description are tolerated.

**Progressive disclosure.**

- Only a **catalog** (name and description) is injected into context, within **2 % of the
  context window, at most 10,000 tokens** (8,000 characters when the window is unknown). Over
  budget, descriptions are shortened to their first sentence; if the catalog still does not
  fit, the lowest-precedence entries are left out with a line saying how many skills are
  available through `/skills`.
- The **body** loads only on use: a slash command (`/code-review`), a mention (`@code-review`),
  or auto-selection, where the model calls `skill.load` based on the catalog.
  `skill.load {name, file?}` returns `SKILL.md` (or the named file) and the skill's file list.
  *Since M8* an agent's catalog lists only the skills of plugins connected to that agent (and
  `skill.load` refuses the others), like its plugin tools.
- Scripts in a skill never run on load. They run only through `exec.run` in the sandbox,
  under policy.
- A skill's `allowed_tools` further restricts the policy engine, and those tools are always
  loaded (§1.4).

**Roots and precedence.** Skills are discovered from these roots:

| Precedence | Root | Notes |
| --- | --- | --- |
| 1 | **Managed**: folder named by managed policy | Cannot be disabled by the user |
| 2 | **Project**: `.nova/skills/` and `.agents/skills/` in every directory from the repository root down to the working directory | Nearer directories win; `.nova/skills/` wins over `.agents/skills/` in the same directory; skipped in untrusted projects (as for FR-185) |
| 3 | **User**: the user skills folder in Nova's config directory | |
| 4 | **Plugin**: skills of enabled plugins, namespaced `<pluginId>:<name>` | A bare name resolves to a plugin skill only when nothing else has that name |
| 5 | **Built-in**: shipped with Nova (including the document skills, §1.1) | |

On a name collision the higher root wins (managed > project > user > plugin > built-in), and
the Skills page shows the shadowed entries. `.nova/` and `.agents/` are protected paths
(FR-190), so an agent cannot add or edit project skills or hooks from inside a session. New
skills come from the user, an install, an import (§4.2) or an approved L1 proposal (FR-170,
FR-178); memory consolidation never writes skills (ADR-069).

*As shipped in M4 (ADR-091).* Skills stay on disk; the database keeps only each skill's enabled
switch and import provenance (`skill_state`). The user root is `<dataDir>/skills`, which also
holds imported skills. Project skills come from `.nova/skills/` and `.agents/skills/` at the top
of each folder bound to the project (FR-035); the first folder wins a name. Skill ids are
`skill:<builtin|user|import|managed>:<name>`, `skill:<pluginId>:<name>` and
`skill:project:<projectId>:<name>`. A disabled skill drops out of precedence, so the next skill
with its name takes over. Settings → Plugins & skills → Skills lists them with their source and
what shadows them, and creates and deletes user and project skills. `/name` at the start of a
message loads the skill for that turn (the rest of the message is the request); `@name` does
too. `skill.load` is read-only and always allowed, and is offered only while the account has a
skill. A plugin skill marks the turn as tainted. `allowed_tools` are never deferred, but they do
not yet narrow the tool set. No built-in skills ship yet.

The **Build a skill/plugin** flow (FR-050) generates and validates these folders.

*As shipped in M5 (ADR-092).* From a conversation, the model writes a plugin draft with
`plugin.scaffold`. The draft goes to `<dataDir>/plugins-drafts/<id>/` (default id `local.<slug>`; a
new draft with the same id replaces the old one) and is checked with the installer's own loader. The
result gives the path and either the problems or the warnings; a draft that fails the check is kept
and reported, not hidden. The tool never installs: it tells the user to install from Settings →
Plugins & skills → Install from a folder, which goes through the normal preview and sideload
confirmation (ADR-091). Writing a draft is a write action that passes the gate like any other; the
draft itself is inert. An MCP server in the draft may use only references to the plugin's own
secrets as env values; anything that looks like a credential is refused, and an http or sse server's
host becomes a declared network permission. Generating skills on their own (FR-178) is not in M5.

### 4.1 Lifecycle hooks (FR-197, ADR-068)

A **hook** runs code at a lifecycle event. It can tighten what the agent does or add context,
and it never loosens built-in safety or managed policy.

**Sources.** Managed policy, the user hooks file (`hooks.json` in Nova's config directory;
`<dataDir>/hooks.json` on the Hub), the project file `.nova/hooks.json` (trusted projects only;
in M4, the top of each folder bound to a project, which counts as trusted), plugins (§3.1) and
SDK extensions (`docs/14` §4). Every dispatch re-reads and re-hashes the files first.

```jsonc
// .nova/hooks.json
{
  "hooks": [
    { "id": "format-on-edit", "event": "tool.post", "matcher": ["fs.write", "fs.edit"],
      "handler": { "type": "command", "command": ["node", ".nova/hooks/format.mjs"],
                   "timeoutMs": 30000 } },
    { "id": "no-prod-writes", "event": "tool.pre", "matcher": ["exec.run", "mcp:db.*"],
      "handler": { "type": "mcp_tool", "tool": "mcp:guard.check" }, "failClosed": true }
  ]
}
```

**Events and effects.**

| Event | Matcher subject | Allowed effects |
| --- | --- | --- |
| `session.start` | start reason (`new`, `resume`, `compacted`) | Add context |
| `session.end` | — | None (observe) |
| `prompt.submit` | — | Add context; block the prompt (the reason is shown to the user) |
| `tool.pre` | canonical tool name | Block the call; add context |
| `permission.request` | canonical tool name | Answer an eligible `ask` with allow or deny; add context |
| `tool.post` | canonical tool name | Add context |
| `compact.pre` | trigger (`pre_turn`, `mid_turn`, `post_turn`, `manual`) | Add compaction instructions |
| `compact.post` | trigger | Add context |
| `subagent.start` | role | Add context to the child |
| `subagent.stop` | role | Add context to the parent |
| `stop` | — | Request **one continuation per turn**, within the run budget |
| `interrupt` | — | None (observe) |

Matchers are glob patterns (for example `mcp:linear.*`). A hook without a matcher runs for
every occurrence of its event. Hook ids use lowercase letters, digits and `-`, unique per
source.

**Handlers.**

- `command`: a fixed argv (no shell), run in the session sandbox under the session's
  permission profile, with network off unless the hook declares hosts (plugin hooks stay
  within the plugin's network permissions). The event arrives as JSON on stdin: event, hook
  id, session, thread, run and turn ids, cwd, and, where relevant, the tool name, arguments,
  result or pending decision, with secrets redacted. The hook answers with JSON on stdout:
  `block {reason}`, `decision` (`allow` | `deny`, for `permission.request` only), `context`
  (text), or `continue` (text, for `stop` only). Empty output means no opinion.
- `mcp_tool`: calls a tool on a configured MCP server with the event as arguments. That call
  passes the policy engine with origin `hook`. Calls made by hooks do not fire hooks.
- Timeout: `timeoutMs` on the handler, default 30,000 (30 s), range 1,000 to 600,000 (10 min).
  Hooks run where the turn executes (Hub or node, `docs/21`).

**Trust.** Every hook is trusted by **content hash** before it runs. The hash is SHA-256 over
the canonical JSON of its definition plus the bytes of the script file it runs when that file
sits inside the plugin or project folder. A new or changed hook is listed as
`needs_trust` (Settings → Plugins & skills → Hooks) and does not run until the user trusts it
(`trusted`). Revoking trust (`revoked`) stops it at once. Managed hooks are trusted through the
policy channel.

*As of M8 (ADR-097).* A **plugin** hook's hash also covers the D2 digest of the plugin's files
(§3.2), leaving out only what the Hub reads and shows apart (the manifest, its hooks file, role and
command files, and the commands the installer writes): a script can import helpers its command line
never names, so an update that changes any file a hook could load needs trust again, while one that
only bumps the version or adds a role keeps the trust of hooks it did not touch. An **SDK hook** (an
extension's, `docs/14` §4.4) is stored with source `extension` and an `mcp_tool` handler on
`ext:<extensionId>/hooks/<hookId>`, answered by the extension's worker; its hash is SHA-256 over the
canonical JSON of `{hook: <definition>, bundle: <the bundle's D2 digest>}`, so every update of the
extension needs trust again. SDK hooks never answer asks, run only while the extension runs (a
stopped, refused or disabled extension's hook rows are turned off; one that cannot be reached fails
closed like any hook) and are allowed by the gate only while managed policy allows the extension and
its hook tool. Hooks in another assistant's plugin layout are converted when imported and arrive
untrusted (§4.2).

*As shipped in M4 (ADR-091).* Hook ids are `hook:<origin>.<hookId>`; a project hook is
`hook:project:<projectId>.<hookId>` and a plugin hook `hook:<pluginId>.<hookId>`. The hash leaves
out `enabled`. Plugin hooks can be trusted on the install screen. `HookView.changedSinceTrust`
marks a hook whose content changed after it was trusted; it waits for re-trust, and changing it
back does not trust it again. Trusting with a hash that is no longer current answers 409
`conflict`. Changing or revoking a managed hook, and switching off or deleting a non-user hook,
answer 403 `policy_denied`; deleting a user hook also removes it from `hooks.json`. A hooks file
that cannot be read keeps its rows and trust, but none of its hooks run and its guards block.
Every run emits `hook.started`, then `hook.completed`, `hook.blocked` or `hook.skipped`, and is
audited.

**Combining results.** Hooks matching one event run in parallel. Any block wins. For
`permission.request`, any deny wins over allow, and no answer leaves the `ask` in place. Added
context is appended in source order (managed, user, project, plugin, extension), then by hook
id, and is labelled with the hook's origin. It is untrusted content and never user-typed
authorization (FR-189).

**Limits.**

- A hook **never** overrides built-in safety (including `handoff_required` and
  `confirm_at_action`, FR-189), managed policy, a `deny` or a `handoff`. It never rewrites tool
  arguments or results, removes the sandbox, or reads secrets.
- A hook may answer an `ask` only when that ask came from a user custom rule, a per-tool
  default or the plugin's permissions, and never one raised by a built-in floor, managed policy,
  the approval policy or intent provenance (ADR-091). The engine marks such an ask `answerable`
  and checks the answer again. Only managed and user hooks may do this, plus plugin hooks whose
  manifest declares `answersAsks` (§3.1). Project hooks never may: project settings cannot
  change approval policy (`docs/14` §1).
- A `stop` continuation counts against the run budget and the per-turn step backstop
  (FR-182). It is ignored once a budget is exhausted. It starts a new turn with trigger `hook`;
  its message is shown labelled **Hook**, carries provenance `hook` and no user authority.
- **Hooks fail closed** (ADR-091, superseding this part of ADR-083). A hook that errors, times
  out or cannot start (for example, no sandbox) always blocks its `tool.pre` call and always
  denies at `permission.request`, whatever `failClosed` says. `failClosed: true` also blocks the
  prompt at `prompt.submit`. On other events a failed hook has no effect. Every hook run, its
  result and its duration are recorded in the Activity trace and the audit log.
- Added context over **2,500 tokens** is written to a file in the session's scratch folder (in
  M4, `<dataDir>/workspace/hook-context/<thread>/`); the model receives the first part plus the
  path, readable with `fs.read`.

### 4.2 Import from other assistants (FR-200)

Settings → Import brings a user's setup from other assistants and coding agents into Nova.
Import reads source files through `novad` on the device where they live (FR-210). It never
modifies the sources and never writes into the other application's configuration (ADR-075).

**Sources.**

- **Instruction files:** `AGENTS.md` and other instruction files the user selects or the
  importer recognizes from its list of known file names.
- **Skills:** `SKILL.md` folders.
- **MCP configs:** JSON files that map server names to a command, args and env, or to a URL.
- **Plugin folders:** plugin manifests in open or other common layouts.
- **Sub-agent definitions and commands:** Markdown files with front-matter.
- **Chat exports** (threads, projects, memories) in common open export formats.

**Mapping.**

| Source item | Becomes |
| --- | --- |
| Instruction file under another name | `.nova/instructions.md` in the same directory (merged into an existing one only after the preview) |
| `SKILL.md` folder | A user or project skill, unchanged |
| Command file | A skill (as in §3.1) |
| Sub-agent Markdown | A role file |
| MCP server entry | An `mcp.json` entry, **disabled** |
| Plugin folder | A Nova plugin with a generated manifest beside the original, **disabled** |
| Hooks | Hook entries in `needs_trust` state |
| Chat export | Threads marked `imported`, projects, and memory candidates in the review queue (FR-032) |

**Rules.**

1. **Preview first.** Before anything is written, the importer lists every item, its target,
   conflicts with existing names, secrets found (masked) and what will stay disabled. The user
   selects what to import.
2. **Dedupe.** Each item is hashed (SHA-256 of its normalized content) and recorded in an
   import ledger (source, item kind, hash, target id, time). Re-importing skips unchanged items
   and offers updates for changed ones.
3. **Secret migration.** Any secret in imported config (keys such as `*TOKEN*`, `*KEY*`,
   `*SECRET*`, `*PASSWORD*`, auth headers, or values that match known token patterns) moves
   into the keychain and is replaced by a `secret://` reference. The import report lists the
   keys that moved.
4. **Disabled until declared.** An imported plugin or MCP server stays disabled until its
   permissions are declared in Nova's terms and confirmed by the user. The importer proposes
   permissions from what the item references.
5. Imported content is untrusted until the user enables it. Imported memories are candidates,
   not saved facts.

*As shipped in M4 (ADR-091).* Import reads folders and files on the Hub itself
(`POST /import/preview` and `/import/apply`); reading other devices through `novad` arrives in
M6. It recognizes instruction files (`AGENTS.md`, `.<word>rules`, `*-instructions.md`, a
`<NAME>.md` inside or next to a `.<name>/` folder, or any file the user names), `SKILL.md`
folders, command files, plugin folders (Nova's layout or another `.<name>-plugin/` layout), JSON
with an `mcpServers` map, repositories as projects, `projects.json`, memories as JSON or text,
and chat exports as JSON or zip (message lists and message trees). Symbolic links are not
followed and every size is capped. Where M4 differs from the mapping above:

- An instruction file in the home folder or one of its configuration folders becomes the
  user's instructions in `<dataDir>/instructions.md`; the chat reads that file from M5, with
  instruction-file discovery (FR-185). Any other instruction file becomes the instructions of
  the project for its folder (one imported in the same run, one bound to that folder, or a new
  one).
- Imported memories are saved as active items with source `import`, which Settings → Memory
  lists for review and correction; there is no candidate state yet.
- Chat exports become chats marked as imported, keeping their original times.
- Imported MCP servers are inserted disabled with source `import`; imported plugins go through
  the plugin installer disabled (choosing them is the sideload confirmation, §3.2). Hooks in
  other plugin layouts are not imported yet; the item says so.
- Secret references: `secret://mcp/<id>/env/<NAME>` for MCP servers,
  `secret://plugin/<pluginId>/<key>/<NAME>` for plugin servers and
  `secret://import/<ref>/text/secret_N` for a token found in instruction text, which is
  replaced in place. A secret in an argument or URL becomes an env variable; a placeholder such
  as `${X}` is stored empty. Each case adds a note to the item.
- One `import_record` is written per item, grouped by an import id and naming its target. A
  failed item is recorded as failed and never blocks a retry; a name in use is imported under
  the next free name.


*As of M8 (ADR-097).* Archives (chat exports and other zips) are read with the bounded zip reader of
`documents/zip.ts` (overlapping entries, stored entries whose sizes disagree, data past the end and
ZIP64 are refused; each entry counts its larger size), allowing up to 65,535 entries because chat
exports hold many images; only JSON entries count toward the caps, and one that is too large is
skipped rather than refusing the archive. Hooks in another assistant's plugin layout are converted
and arrive untrusted.

## 5. Browser & computer tools (summary; detail in 11)

| Tool | Input | Output |
| --- | --- | --- |
| `browser.navigate` | url | status, title, final url |
| `browser.read` | selector? | text/markdown + DOM summary |
| `browser.click` / `browser.type` / `browser.select` / `browser.scroll` | selector/text | new state |
| `browser.screenshot` | fullPage? | image artifact |
| `browser.wait_for` | condition | ok/timeout |
| `browser.download` / `browser.upload` | path/selector | saved file |
| `screen.observe` | — | screenshot + accessibility tree |
| `screen.click` / `screen.type` | coords/text | result |
| `devserver.start` / `.stop` / `.stopAll` | cmd? | url/status |

All browser/computer actions are policy-gated and recorded in the Activity trace with
before/after screenshots.

## 6. Permission & policy integration

Every tool definition declares annotations. Each call is evaluated in this order:

1. Built-in safety rules (non-overridable), including the confirmation tiers (FR-189).
2. Managed workspace policy.
3. User custom rules (per scope).
4. Per-tool defaults and per-plugin/MCP-server permissions, including per-action defaults
   (FR-045, FR-048).
5. Session/run autonomy level (Code permission mode; Agent rules).

Steps 1–5 are the **deterministic** engine (`docs/12` §2). It is authoritative and its result,
`allow | ask | handoff | deny` with a human-readable reason (FR-099/100), is computed first.
Two later stages can adjust that result, and only in the ways stated:

6. **Lifecycle hooks** (`tool.pre`, `permission.request`; §4.1, ADR-068) can block a call
   (turning it into `deny`). They can answer an `ask` that came from step 3 or 4. They cannot
   change a result from step 1 or 2, a `handoff`, or a `deny`.
7. **Auto-reviewer** (FR-085, ADR-061), where the permission mode or agent uses it, reviews
   consequential actions last and can **only tighten** the decision.

The same evaluation applies whatever the call's origin: the model, an MCP Apps UI, a hook's
`mcp_tool` handler, a nested `script.run` call (§1.5), an external agent's operation (§1.6), or
an external MCP client. The origin is
recorded in the audit log. A skill's `allowed_tools` narrows the tool set further; loading a
deferred tool grants nothing. In M4 `allowed_tools` only keeps those tools loaded; narrowing
comes later (ADR-091).

**Direct user actions** (ADR-091, refining the FR-189 fallback). When the signed-in user performs
an action directly in a Nova client, such as saving a file in the editor, the action is its own
confirmation: the call has actor `user`, the user's own instruction and no taint, and steps 4
and 5 allow it without a card. Rules and denies from steps 1 to 3, the confirmation tiers, the
network allowlist, policy changes and secret access still apply. A tool call from an MCP App is
not such an action: `POST /tools/:name/invoke` defaults to `initiator: 'app'`, which carries no
user instruction.

## 7. Catalog & marketplace (FR-049)

- **Remote catalog** (`https://catalog.arialabs.ai/v1/index.json`) signed by the app
  publisher's key; supports plugin, skill, MCP server (registry entry or bundle), theme and pet
  entries with versions, checksums, and compatibility.
- **Git-hosted catalogs.** The user adds a Git URL and an optional ref. Nova clones it
  read-only with repository hooks disabled (FR-211) and reads `nova-catalog.json` at the
  repository root. Entries point to subfolders or to other repositories, pinned to a **commit
  SHA** recorded in the install record. A moved ref appears as an update, with the permission
  diff.
- **Local catalog**: a directory in settings for offline/sideload installs.
- Search, categories, screenshots, changelog, permissions preview, install count/rating
  (ratings are local unless the user opts into sharing).
- **Signatures for every source.** Remote, Git and local catalogs alike carry an index signed
  with Ed25519 (ADR-009) by a key in the user's trusted-publisher list, a SHA-256 checksum per
  artifact, and a publisher signature on each bundle. A missing signature, an unknown key or a
  checksum mismatch blocks a normal install. The item can then only be sideloaded, with an
  explicit confirmation, and is labelled **Unverified**. Managed policy can restrict catalogs
  and disable sideloading.
- Permission diff shown on update; automatic rollback on failure.

*As shipped in M4 (ADR-091).* Catalog sources are the `plugins.catalogs` setting (a folder on the
Hub, an https URL or a Git URL), plus the built-in sample catalog (`nova-sample`,
`examples/catalog`). A folder catalog reads `catalog.json` or `nova-catalog.json`; each entry
names a plugin id, name, version, description and its folder. A URL catalog's index is capped at
1 MB and its zip archives (same host, optional SHA-256) at 50 MB. A Git catalog is cloned
shallow with repository hooks off; https, ssh and git URLs only; without Git the Hub answers
400 `capability_missing`. Entries that point to other repositories, catalog signatures and the
remote catalog come later, so every entry is **Unverified** and installs as a sideload (§3.2).

*As shipped in M8 (ADR-097 D2; `packages/core/src/market`; the Marketplace in `docs/14` §5).*

- **Index.** `catalog.json` (or `nova-catalog.json`) keeps the M4 `plugins` list and adds `items`
  of every kind (`plugin`, `skill`, `theme`, `pet`, `mcp`) with card fields (author, publisher,
  categories, screenshots, changelog, declared permissions and components) and the artifact:
  `path` inside the catalog, `url` next to a remote index, `repo` + `commit` for a folder of
  another Git repository, or `server` for an MCP registry entry. `sha256` is a file artifact's
  checksum and `digest` a folder's (the D2 digest of §3.2, since the M4 reader already gave
  `sha256` the meaning of an archive checksum). Schema:
  [`catalog-index.json`](../contracts/schemas/catalog-index.json).
- **Signature.** `<index>.sig` ([`catalog-signature.json`](../contracts/schemas/catalog-signature.json))
  is `{v: 1, publisher, digest, signature}`: Ed25519 over `"nova-catalog-v1\n"` + the hex SHA-256
  of the index bytes, by a key the catalog pins (`plugins.catalogs[].publisherKey`) or one in
  `plugins.trustedPublishers`. The domain line keeps a catalog signature from passing for a
  bundle's (`"nova-extension-v1\n"`). Outcomes: `verified`; `untrusted` (a good signature by an
  unknown key, no pin); `unsigned` (no `.sig`, no pin); `invalid` (damaged, not matching, another
  key than the pinned one, or no `.sig` under a pin), which refuses the whole catalog. The
  built-in sample catalog is signed by a test key whose public half is pinned in code for that
  catalog only and never added to the trusted publishers; its private half is a test fixture
  (`packages/core/test/fixtures/market/sample-key.ts`, marked fake), and
  `packages/core/test/fixtures/market/sign-sample-catalog.ts` re-signs it after an edit (a test
  fails otherwise).
- **Git.** With `commit`, the Hub runs `git init`, fetches that one commit (`--depth 1`) and checks
  it out detached with `core.hooksPath=/dev/null` and `protocol.file.allow=never`, then requires
  `HEAD` to equal the commit; without it, a shallow clone of the ref. Git runs with a clean
  environment and a 120 s limit. The index and `.sig` are read only when they are regular files
  inside the checkout.
- **Remote.** https only; the index is the location (when it ends in `.json`) or
  `<location>/catalog.json`; artifacts must be https on the same host; at most 3 redirects, same
  host; 30 s per request; Content-Length and a streaming cap. Indexes are cached 5 minutes and the
  cache is dropped when `plugins.catalogs` or `plugins.trustedPublishers` changes.
- **Archives** are read with the bounded zip reader (`documents/zip.ts`, also used by `.novax`
  bundles and Office files): before anything is copied or inflated the central directory is
  walked, and an archive is refused when it has over 5,000 entries, a stored entry's two sizes
  disagree, the entries' compressed data add up to more than the archive, two entries share bytes,
  or it is ZIP64; each entry counts the larger of its sizes toward the 50 MiB per entry and 100 MiB
  in all. File names with a control character are refused, here and in folder digests.
- The sample catalog holds a plugin (`com.example.sample`), a third-party plugin
  (`com.examplelabs.release-notes`), an extension (`com.examplelabs.word-count`, a `.novax` signed
  by a made-up "Example Labs" key that is not trusted by default), a theme
  (`com.examplelabs.aurora`) and a skill (`standup`).

## 8. Namespacing & conflicts

| Source | Canonical name | Example |
| --- | --- | --- |
| Built-in | `<noun>.<verb>` | `fs.read` |
| MCP server | `mcp:<server>.<tool>` | `mcp:linear.createIssue` |
| Plugin (including its MCP servers) | `plugin:<pluginId>.<tool>` | `plugin:com.example.dev-tools.lint` |
| Skill | `skill:<name>` | `skill:code-review` |
| Plugin skill | `skill:<pluginId>:<name>` | `skill:com.example.dev-tools:review` |
| Sub-agent role | `role:<name>` / `role:<pluginId>:<name>` | `role:com.example.dev-tools:reviewer` |
| Page-registered tool (FR-208) | `page:<host>.<tool>` | `page:shop.example.com.addToCart` |
| Hook (trust list and audit id) | `hook:<origin>.<hookId>` (origin `managed`, `user`, `project`, a plugin id or an extension id) | `hook:project.format-on-edit` |
| UI resource | `(serverId, ui:// URI)` | `(dev-tools, ui://dev-tools/dashboard)` |

Collisions are impossible by construction: every kind has its own prefix; plugin ids are
reverse-DNS and therefore never equal `managed`, `user` or `project`; MCP server ids are unique
per Hub (a colliding install is renamed, §2.5). Skill and role names without a plugin
namespace resolve by root precedence (§4). Display names are humanized, never used as keys.

In M4 (ADR-091) a plugin's MCP server is an ordinary MCP server named by its manifest key, so its
tools are `mcp:<server>.<tool>` (the sample plugin's are `mcp:sample.fetch_status` and
`mcp:sample.panel_action`); the plugin's `plugin:<pluginId>.<tool>` permission entries match them
by tool name. Skill ids carry their source: `skill:user:<name>`, `skill:project:<projectId>:<name>`
and `skill:<pluginId>:<name>`. Project hooks are `hook:project:<projectId>.<hookId>`, because two
projects can use the same hook id. Nova's own MCP server serves Hub tools with `:` replaced
(`mcp:x.y` as `mcp_x.y`, §2.2).

## 9. Failure isolation

- Each MCP server / plugin runs in its own process or worker with CPU/memory/time limits.
- A crash restarts the server up to a limit; repeated failures disable it and notify. A
  `required` server that is not ready stops the sessions that depend on it with a clear error
  (§2.1).
- Tool timeouts are enforced centrally (default 60 s, per-tool and per-server overridable).
  Exec sessions use yield times and are killed when the run ends (§1.1).
- Hook timeouts are enforced per hook (§4.1); a timed-out `tool.pre` or `permission.request`
  hook blocks or denies, a timed-out `prompt.submit` hook blocks when it is `failClosed`, and
  any other timed-out hook has no effect.
- A hanging tool is cancelled; the run continues with an error result unless the tool is
  required, in which case the run pauses for user input.
