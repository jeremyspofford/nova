# Managing machines — linux, windows, macos

**Status:** spec'd 2026-08-07, DECIDE answered same day. Answers ROADMAP #43.
Nothing exists today: `grep -rniE 'ssh|remote.?exec' backend/app` returns three
hits and none of them execute anything. The only ssh-shaped code in the repo is
`capability_claims.py:86` — the verifier that catches her *claiming* she can do
this.

## The jobs, in Jeremy's words (2026-08-07)

> "open up a browser and navigate it, review browser developer tools if
> debugging nova or other applications it's written. if it doesn't have a tool
> it needs, download it/install it and configure it. If i need to investigate
> my computers environment, such as the network, environment vairables, etc.,
> nova should be able to do that. it should be able to use the terminal so it
> should be able to ssh to other machines or wake them on lan, or configure our
> computer to be able to do that. it should be able to navigate my emails,
> calendar, etc."

## The one thing I will not pretend

**"It should be able to use the terminal" has no mechanical guard.** There is
no line of code that can refuse `rm -rf /` from free text. That is not a
missing feature, it is the reason `workloads.py` withholds `pods/exec`
("getting a shell in it is arbitrary code with that pod's identity") and the
reason ROADMAP #43 originally recommended refusing anything terminal-shaped.

My first version of this plan answered that with a per-machine verb
allow-list. **That was the wrong answer to the question actually asked** — a
menu of verbs somebody else wrote is not "manage all fully", and it fails the
same test Jeremy applied to compose profiles on 2026-07-29: a capability she
was handed, not one she has.

So the containment moves from **what she may type** to **whose machine she is
typing on**. That is a real boundary, it is enforced by the operating system
rather than by a model's judgement, and it happens to fit the job list better.

## Four shapes, because the jobs are four different problems

### 1. Her own workstation — full shell, no restrictions

A container she owns. Real terminal, real package manager, a real browser
(Playwright + Chrome DevTools Protocol), and permission to install whatever
she decides she needs. **No allow-list, no consent card, no verb table.**
`rm -rf /` in there destroys her own workspace and nothing else.

This is what answers "use the terminal", "install what it needs", and
"browser + devtools" — completely, not partially. It is also where the
existing `e2e` browser image already points (use the `mcr` Playwright image;
`node:alpine` has no WebGL).

Debugging Nova's own frontend is the worked example: navigate to `:5173`,
open a CDP session, read console errors and failed network requests, and
report them with the evidence attached.

Blast radius is the container plus whatever it can reach on the network —
which is why egress from it is the thing to shape (the two existing egress
verbs are the model), not the commands.

### 2. Your machines — SSH, bounded by a real OS account

**DECIDED (Jeremy, 2026-08-07): a dedicated `nova` account per machine, with
sudo rules he chooses.** Not his own user.

That choice is what makes this tractable: she gets a full terminal *as that
user*, so "manage fully" is true within a boundary the OS enforces and the
operator can dial. `systemctl restart nginx` if the sudoers rule says so;
`cat /home/jeremy/.ssh/id_rsa` refused by file permissions, not by Nova.
Revocation is `userdel -r nova`. Audit is `journalctl _UID=`.

- Key material lives in the `secrets` store, materialised **only** in the
  sidecar — never in the backend, which is the process a poisoned page talks
  to.
- The `machines` registry (migration 117) is **operator-write-only**, modelled
  on `mcp_servers._CREATE_ONLY_FIELDS`. She may read it and use it; she may
  not add a machine or change its credential. Same rule
  `device-activity-monitoring.md` already states.
- Provisioning the account is the operator's step, per machine. It cannot be
  automated away and the registry UI should say so rather than let it be
  discovered.

### 3. Network facts need no shell

Wake-on-LAN is a magic packet — a MAC address and a UDP send, with no command
string anywhere. Host discovery, reachability, ARP/lease reads: narrow tools
with typed arguments. These are cheap, safe, and cover "wake them on lan" and
most of "investigate my network" without touching a terminal at all. Build
them as tools, not as shell invocations, because a typed tool is auditable and
a shell line is not.

### 4. Email and calendar are OAuth, not a terminal

Scoped tokens through the MCP client (already shipped) or `http_call` tools
with `{{secret:...}}` resolved late. Never a shell, never IMAP passwords in a
config file. Read scopes first; write scopes (send mail, create events) are a
separate decision and should arrive later and deliberately.

## Build order

1. **Her workstation** — the container, the browser, the shell. Highest value,
   lowest risk (nothing of his is reachable from it yet), and it is the thing
   that makes her useful at debugging her own work.
2. **`machines` registry** (migration 117) — operator-only writes. Lands and
   gets reviewed before a single byte of exec code exists.
3. **`machine-control` sidecar** — own container, no docker socket, no DB, no
   `NOVA_AUTH_TOKEN`, one credential. Ships the shared-bearer-token pattern
   (`NOVA_MACHINE_CONTROL_TOKEN`, unset = every request refused) **from its
   first commit**, so it does not inherit the open hole in `git-landing` and
   `inference-control` (repo-review item 1, ROADMAP #44 — both currently
   accept unauthenticated requests from any container on the compose network).
4. **SSH exec through it**, as the `nova` account, full command strings.
5. **WoL + network reads** as typed tools.
6. **Email/calendar** via MCP.

## Wiring the existing containment

Not one of these is new work; the verbs just need adding:

- `registry.ACTOR_TOOLS` — the write verbs, so the injection fence disarms
  them on any turn that touched fetched text.
- `_UNTRUSTED_SOURCE_TOOLS` — command **output**. A remote host's stdout is
  somebody else's bytes; same argument that put `workload_logs` there. This
  matters more here than anywhere: a webpage rendered in her browser is
  attacker-controlled text by definition.
- `scopes.GOAL_SCOPED_TOOLS` + `READ_ACTIONS` so reads never raise a card.
- A NEW `machine-tender` agent — **never `main`**, which holds `db:*` and the
  web. That arrangement is what migration 075 already broke once.
- `capability_events` on every run; per-machine action and wall-clock budgets.
- Decide deliberately whether the new tool names join `capability_claims`'
  "machine access" / "shell" satisfier sets. Derived, not hardcoded — today
  nothing satisfies them, which is exactly what keeps her honest about not
  having this, and that must flip in the same change that gives her the
  capability.

## The trap worth restating

`manage_tool_hosts` has no port column — approving a host approves every port
it listens on. If machine control is ever expressed as an `http_call` against
an agent daemon rather than a first-class tool, it lands inside `main`'s blast
radius by default and bypasses every gate named above. It must be a real tool.
