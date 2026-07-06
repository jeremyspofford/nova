---
title: "Security"
description: "Authentication, authorization, sandboxing, and data privacy in Nova."
---

Nova is designed to run locally on your own hardware. This page covers the security mechanisms that protect your instance, your data, and your infrastructure from unintended agent actions.

## Authentication

### Admin secret

The admin secret (`ADMIN_SECRET` in `.env`) protects privileged operations like key management, pod configuration, service restarts, and factory resets. It is passed as a header:

```
X-Admin-Secret: your-admin-secret
```

The Dashboard stores the admin secret in `localStorage` and sends it with every request.

### API keys

API keys authenticate external consumers (IDE plugins, scripts, CI/CD pipelines). Keys use the format `sk-nova-<random>` and are hashed with SHA-256 before storage -- the raw key is shown exactly once at creation and can never be retrieved again.

```bash
# Create a key (admin only)
curl -X POST http://localhost:8000/api/v1/keys \
  -H "X-Admin-Secret: your-secret" \
  -H "Content-Type: application/json" \
  -d '{"name": "ci-pipeline", "rate_limit_rpm": 60}'
```

Keys can be passed via either header:

```
Authorization: Bearer sk-nova-...
X-API-Key: sk-nova-...
```

### Passwords & sessions

- **Passwords** are hashed with bcrypt (per-password salt, cost 12) and verified in constant time. They are never stored or logged in plaintext.
- **Sign-in is brute-force throttled** per client IP *and* per target email (sliding window), and the response time is identical whether or not an email exists — no account enumeration by timing.
- **Sessions** are 15-minute JWTs signed with a random 256-bit secret generated at first boot. **Refresh tokens are stored only as SHA-256 hashes** with rotation — a database leak does not yield usable sessions. Role changes and deactivation revoke tokens immediately (Redis deny-list).
- **Transport**: on a bare LAN, HTTP is plaintext — use [Tailscale or a Cloudflare Tunnel](/nova/docs/remote-access/) for any access beyond localhost; both give you encryption in transit.

### Trusted networks

Requests from trusted CIDRs (**loopback only by default**; add your LAN or tailnet ranges in **Settings → System → Trusted Networks**) skip login for the *user surface* — dashboard viewing, chat, the Inbox.

Network position never grants admin. Settings writes, secrets, feature flags, and recovery operations require the admin secret or an admin login no matter where the request originates — including requests proxied through the dashboard container.

### Development bypass

When `REQUIRE_AUTH=false` (the default), API key authentication is bypassed. The admin secret is always required for admin endpoints regardless of this setting.

## Rate limiting

Nova enforces rate limits using a Redis sliding window counter. Limits are applied at two levels:

| Level | Mechanism | Configuration |
|-------|-----------|--------------|
| **Per API key** | Requests per minute (RPM) | Set at key creation via `rate_limit_rpm` |
| **Per provider** | Daily request quota | Built into the LLM Gateway per provider |

When a rate limit is exceeded, the API returns HTTP 429 with a descriptive error message.

## Sandbox tiers

Sandbox tiers control what agents can access when executing tools. Each pod is configured with a sandbox tier that restricts filesystem access and shell execution scope.

| Tier | Filesystem access | Shell execution | Use case |
|------|-------------------|-----------------|----------|
| **Isolated** | None -- ephemeral only | Ephemeral container per invocation | Pure computation, API calls, text tasks |
| **Nova** | Nova installation directory at `/nova` | Path-constrained to `/nova` | Self-configuration -- updating settings, prompts |
| **Workspace** (default) | Scoped to `NOVA_WORKSPACE` at `/workspace` | Path-constrained to `/workspace` | Coding projects, file generation |
| **Home** | Your home directory — **read-only by default** (writing requires the Settings toggle *and* `NOVA_HOME_MOUNT=rw` in `.env`) | Path-constrained to `$HOME` | Reading dotfiles/configs; opt-in writes |

(The former **Host** tier — full filesystem, unrestricted shell — was removed in SEC-001: it was remote-code-execution-by-design against any prompt injection.)

The sandbox tier is enforced by the Orchestrator's tool execution layer. The `workspace` tier is the default and recommended for most use cases.

## Path traversal protection

All file operations validate paths against the configured workspace root. Attempts to access files outside the allowed directory (e.g., `../../etc/passwd`) are rejected before any filesystem operation occurs.

## Shell command denylist

The `run_shell` tool maintains a denylist of dangerous command prefixes that are blocked before execution. This provides a defense-in-depth layer on top of sandbox tiers.

## Data privacy

Nova is designed to run entirely on your own infrastructure:

- **No telemetry** -- Nova sends no usage data, analytics, or crash reports to any external service
- **No cloud dependency** -- all services run locally in Docker containers; cloud LLM providers are optional
- **Local storage** -- all data (memories, tasks, keys, configurations) is stored in your PostgreSQL instance
- **Secret masking** -- the Recovery Service masks sensitive values (API keys, secrets) when reading environment variables via the API
- **Whitelist enforcement** -- the Recovery Service restricts `.env` access to a whitelist of known Nova configuration keys

## Best practices

1. **Change the default admin secret** -- the first thing to do after installation
2. **Enable `REQUIRE_AUTH=true`** in production to enforce API key authentication
3. **Use the `workspace` sandbox tier** unless you have a specific need for broader access
4. **Keep backups** -- use the Recovery Service or `make backup` regularly
5. **Review API keys** -- revoke unused keys from the Keys page in the Dashboard
6. **Use Cloudflare Tunnel or Tailscale** for remote access instead of exposing ports directly
