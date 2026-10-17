---
status: accepted
date: 2026-10-17
supersedes: ADR-090 (the "Sandbox until M6" bullet)
---

## Context
M6 built always-on agents, channels with event triggers, MCP event subscriptions and
notification routing, agent computers with the egress proxy and two sandbox substrates, the
agent browser, computer use with takeover and appshots, `novad` with the devices area, Code
environments, pull requests and the worktree registry, and spaces, sites, visualizations and
pets. Building them settled choices the spec left open. One supersedes part of ADR-090, two amend
bullets of ADR-083, one amends ADR-063, and the `novad` transport extends ADR-089. The full list,
with the known gaps, is the ADR-093 entry in
[`../20-decisions-and-defaults.md`](../20-decisions-and-defaults.md).

## Decision
- Agents run in the one chat loop (ADR-076) as sets of `agent` threads, with budgets per turn
  chain and no run row per wake. Their rules join the **user** layer of each of their threads'
  policy sets through the gate's `useAgentPolicy`; a rule that claims the managed layer is coerced
  to user, and a source that fails denies. Proactive research is a read-only turn whose approval
  requests cancel it, and its suggestions never count as the user's intent. An MCP tool is
  read-only for it only when the owner declared it so in Settings and nothing the engine knows
  contradicts that; a server's own hints never grant it.
- Channel text never carries the user's authority, not even the owner's own message in a private
  DM. ADR-083 counted the owner's private DM as user instruction; channel turns now carry
  authority `none` (origin `channel`). Trigger runs and wakes carry none either.
- Every sandbox reaches the network only through the egress proxy, one session per command,
  container environments of Code sessions included; a dev server's port leaves its sandbox only
  through a bridge to the Hub's loopback, reachable by the browser that holds its grant.
  HTTPS inspection is implemented with a per-Hub CA kept in the data directory; HTTPS is decrypted
  only for `limited` mode, a bound credential or a matching hook. This amends ADR-063: without the
  CA, `limited` blocks HTTPS and credentials are injected over plain HTTP only.
- The sandbox substrates are a container (Docker or Podman, always `--network none` with a
  forwarder to the proxy socket) and bubblewrap with seccomp on Linux; `auto` tries a container
  engine first. This replaces ADR-090's container-only sandbox with `NOVA_SANDBOX_NETWORK=open`.
  The micro-VM substrate is a stub behind its flag (ADR-065).
- Protected paths are enforced inside sandboxes with mounts: `.git`, `.nova`, `.agents` and shell
  startup files read-only in writable roots, credential locations and the data directory hidden.
  Nova's own commit with hooks may write `.git` except `config`, `config.worktree`, `hooks` and
  `info`. ADR-083 kept only `.git/hooks` and `.git/config` read-only for Git writes; the two new
  entries close paths by which a sandboxed write could make the Hub's own Git run a program.
- Computers are folders on the Hub, not long-lived containers; snapshots are folder copies. The
  cloud computer is a mock runner on the Hub in M6.
- The agent browser is Playwright-driven Chromium behind its own proxy session. The gate sees the
  browser tools as read-only and the service checks each action itself (`browser.site`,
  `browser.act`), so purchases, sign-ups and deletions are confirmed at the moment of action and
  page content never counts as the user's instruction. Site levels are user rules on
  `browser.act`.
- Computer use is off until enabled per computer; the Hub enforces tiers and grants; the kill key
  stops delivery before anything else and its stop survives a restart.
- `novad` talks to the Hub with bearer tokens over LAN HTTP until certificates arrive (M6.5), as
  compute nodes do under ADR-089: an enrollment token, a device credential and a management token
  the device generated. A `novad` device is never a compute node. Its crypto uses pinned,
  permissively licensed crates (`ed25519-dalek`, `sha2`) instead of hand-written code.
- Code pushes take the host token only through that one Git call's environment and never to an
  `http://` remote; protected and default branches need the user's typed confirmation and are
  never force-pushed; CI is polled. Remote environments run commands on their machine under its
  user, so Bypass is never available for them.
- Spaces version every page save and refuse stale bases; publishing a site is explicit, reversible
  and writes only into folders that carry Nova's marker. Visualizations reuse the `chart` artifact
  kind.

## Consequences
An owner who wants to drive an agent with authority types in Nova itself; a channel message from
them is a request the agent may act on only within its rules and the confirmation tiers. `git
commit` typed in a terminal fails read-only: commits go through the Code commit flow and the
`git.*` tools. Sandboxes on a Hub without the inspection CA cannot use `limited` for HTTPS.
Several pieces are built but not wired or not reachable in M6: the SSH transport, WSL, the local
browser fallback, the Hub's update key, real desktops and a real cloud runner. Proactive research
reads only the MCP tools the owner declared read-only, never plugin tools, and `web.fetch` and MCP
servers still bypass the proxy. These, and the rest of the "Not in
M6" list in the docs/20 entry, are follow-ups.
