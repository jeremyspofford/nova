# 08 — Tools, MCP, Plugins & Skills

## 1. Tool runtime

A **tool** is a typed capability the agent can invoke. Tools come from four sources:
`builtin`, `mcp`, `plugin`, and `computer/browser`. All are registered in one registry with
a canonical namespaced name and a JSON Schema.

```ts
interface ToolDefinition {
  name: string;                  // canonical: "fs.read", "github.createIssue", "mcp:linear.search"
  title: string;
  description: string;
  source: 'builtin' | 'mcp' | 'plugin' | 'computer';
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;
  annotations?: {
    readOnly?: boolean;
    destructive?: boolean;
    idempotent?: boolean;
    requiresNetwork?: boolean;
    requiresUser?: boolean;       // e.g., password change, CAPTCHA
    costClass?: 'free' | 'metered';
  };
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

interface ToolContext {
  threadId?: string; runId?: string; agentId?: string; sessionId?: string;
  cwd?: string;                  // sandbox working directory
  policy: PolicyEngine;
  sandbox: SandboxClient;
  browser?: BrowserController;
  secrets: SecretBroker;         // resolves references on demand, never exposes values
  signal: AbortSignal;
  log: Logger;
}
```

### 1.1 Built-in tools (v1)

| Tool | Purpose | Annotations |
| --- | --- | --- |
| `fs.read` | Read a file (with size cap) | readOnly |
| `fs.list` | List a directory | readOnly |
| `fs.search` | Ripgrep-like search across allowed roots | readOnly |
| `fs.write` | Create/overwrite a file | destructive |
| `fs.edit` | Apply a structured patch | destructive |
| `fs.delete` | Delete within allowed roots | destructive |
| `exec.run` | Run a command in the sandbox | destructive, requiresNetwork* |
| `code.symbols` | Symbol/reference lookup in indexed repo | readOnly |
| `web.search` | Web search with citations | readOnly, requiresNetwork |
| `web.fetch` | Fetch a URL as markdown/text | readOnly, requiresNetwork |
| `browser.*` | Navigate/read/click/type/screenshot | see §5 |
| `screen.*` | Computer-use (observe/click/type) | requiresUser on first use |
| `image.generate` | Generate/edit an image | metered |
| `memory.read` / `memory.write` | Read/write scoped memory | write is destructive |
| `task.spawn` | Spawn a sub-agent/child thread | destructive |
| `schedule.create` | Create a recurring task | destructive |
| `ask_user` | Ask a clarifying question | readOnly, always allowed |
| `artifact.create` | Render a structured artifact | write |

*`exec.run` network access depends on the egress policy for the mode.

### 1.2 Tool result contract

```ts
type ToolResult =
  | { ok: true; content: ContentPart[]; meta?: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string; details?: unknown } };
```

Results are persisted as `tool_result` message parts and `tool_call` rows, and are always
labeled **untrusted** when fed back to the model (injection defense, FR-103).

## 2. MCP integration

### 2.1 MCP client (FR-042)

- Transports: **stdio**, **SSE**, **streamable HTTP**. One child process (or connection) per
  server; supervised with restart + backoff.
- Discovery: `tools/list`, `resources/list`, `resources/templates/list`, `prompts/list`.
- Capabilities: tools, resources (read/subscribe), prompts, sampling (opt-in), roots.
- Each server is sandboxed; file/network access is granted explicitly per server.
- Namespacing: external tools become `mcp:<serverId>.<toolName>`; resources are referenceable
  in `@`-mentions.
- Health view: status, uptime, last error, log tail, restart, disable (FR-043).

### 2.2 MCP server (FR-044)

Nova can expose itself over MCP with **explicit consent** and a scoped token:

- Tools: `nova.listProjects`, `nova.getThread`, `nova.search`, `nova.runTool` (allowlisted).
- Resources: project files (read-only), thread transcripts (chosen scope).
- Prompts: reusable skills exposed as MCP prompts.
- Every external call is audited and subject to the policy engine, as if made by a plugin.

### 2.3 Configuration

```jsonc
// mcp.json (managed in-app, secrets via keychain refs)
{
  "servers": {
    "linear": { "transport": "stdio", "command": "npx", "args": ["-y", "mcp-linear"],
                "env": { "LINEAR_API_KEY": "secret://connector/linear/token" },
                "policy": { "network": ["api.linear.app"], "fs": "none" } },
    "notion": { "transport": "http", "url": "https://mcp.notion.example/v1",
                "auth": "secret://connector/notion/token" }
  }
}
```

## 3. Plugins

### 3.1 Manifest (`.nova-plugin/plugin.json`)

```json
{
  "schemaVersion": 1,
  "id": "com.example.dev-tools",
  "name": "Dev Tools",
  "version": "1.2.0",
  "description": "Lint, test, and changelog helpers",
  "author": { "name": "Example", "url": "https://example.com" },
  "license": "MIT",
  "engines": { "nova": ">=0.5.0" },
  "permissions": {
    "network": ["api.github.com"],
    "fs": ["${project}"],
    "secrets": ["github.token"],
    "commands": true,
    "panels": ["dev-tools.sidebar"]
  },
  "skills": ["skills/review.md", "skills/changelog.md"],
  "mcpServers": {
    "dev-tools": { "transport": "stdio", "command": "node", "args": ["server.js"] }
  },
  "commands": [{ "id": "devTools.lint", "title": "Lint project" }],
  "ui": { "panels": [{ "id": "dev-tools.sidebar", "entry": "ui/panel.js" }] }
}
```

Rules:

- Plugins are sandboxed; declared permissions are enforced, not trusted.
- UI panels run in a restricted iframe/webview with a typed postMessage bridge only.
- Plugins cannot read arbitrary files, make undeclared network calls, or access secrets they
  did not declare.
- Signatures: the marketplace publishes a signed catalog; the app verifies before install.

### 3.2 Lifecycle

install → verify signature/license → resolve deps → place in `plugins/<id>/<version>/` →
register skills/commands/MCP servers → enable → (on update) migrate → (on uninstall) clean up
user data with confirmation.

## 4. Skills

A **skill** is a Markdown file with YAML front-matter plus optional assets/scripts.

```markdown
---
name: Code Review
description: Review a diff for correctness, security, and style.
when_to_use: When the user asks to review code or before committing.
allowed_tools: [fs.read, fs.search, code.symbols, exec.run]
model_hint: { reasoning: high }
---
## Instructions
1. Identify the diff scope.
2. Read changed files and surrounding context.
3. Report findings grouped by file with severity and a concrete fix.
4. Never apply changes without approval.
```

- Invocation: `/skill-name`, auto-selection by the router based on `when_to_use`, or `@skill`.
- Skills can be built-in, user-authored, or plugin-provided.
- A skill's `allowed_tools` further restricts the policy engine.
- The **Build a skill/plugin** flow (FR-050) generates and validates these files.

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

Every tool definition declares annotations; the policy engine combines:

1. Built-in safety rules (non-overridable).
2. Managed workspace policy.
3. User custom rules (per scope).
4. Per-tool defaults.
5. Per-plugin/MCP-server permissions.
6. Session/run autonomy level (Code permission mode; Agent rules).

Result: `allow | ask | handoff | deny` + a human-readable reason (FR-099/100).

## 7. Catalog & marketplace (FR-049)

- **Remote catalog** (`https://catalog.arialabs.ai/v1/index.json`) signed by the app
  publisher's key; supports plugin/skill/theme entries with versions, checksums, and
  compatibility.
- **Local catalog**: a directory in settings for offline/sideload installs.
- Search, categories, screenshots, changelog, permissions preview, install count/rating
  (ratings are local unless the user opts into sharing).
- Security: catalog signature verified; plugin signature verified; permission diff shown on
  update; automatic rollback on failure.

## 8. Namespacing & conflicts

| Source | Canonical name | Example |
| --- | --- | --- |
| Built-in | `<noun>.<verb>` | `fs.read` |
| MCP server | `mcp:<server>.<tool>` | `mcp:linear.createIssue` |
| Plugin | `plugin:<pluginId>.<tool>` | `plugin:com.example.dev-tools.lint` |
| Skill (as prompt) | `skill:<name>` | `skill:code-review` |

Collisions are impossible by construction. Display names are humanized, never used as keys.

## 9. Failure isolation

- Each MCP server / plugin runs in its own process or worker with CPU/memory/time limits.
- A crash restarts the server up to a limit; repeated failures disable it and notify.
- Tool timeouts are enforced centrally (default 60 s, per-tool overridable).
- A hanging tool is cancelled; the run continues with an error result unless the tool is
  required, in which case the run pauses for user input.
