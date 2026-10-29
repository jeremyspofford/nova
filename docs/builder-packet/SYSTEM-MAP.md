# SYSTEM MAP — what exists and where it lives

## Canonical homes
| Thing | Home | Role |
|---|---|---|
| Nova application | `github.com/jeremyspofford/nova` | The ONLY Nova product repo. All Nova code lands here. |
| System blueprint & foundation | `github.com/jeremyspofford/nova-foundation` (singular) | Cross-system design, vault/spaces scaffold, registries, templates. NOT an application. |
| Relay | `github.com/jeremyspofford/relay` (private) | Standalone worker service (chat → supervised coding workers in git worktrees). Hardened as its own service; integrates into Nova later via adapter. Never rebuilt into Nova. |
| Legacy experiment | `github.com/arialabs/nova` | Python, dormant since Apr 2026 (OpenClaw-era). Reference only. Do not build on it. |
| Nova v2 / Cortex research | Aria Labs strand | Parked research. Cortex (sovereign memory protocol) may be consumed later as a dependency if the spec revives it. |
| Obsidian vault (canonical personal memory surface) | The user's long-standing vault | Human-facing shared memory (books: Personal, Employer, per-client). Nova reads/writes through defined interfaces; the vault is the user's, not Nova's runtime store. |
| Nova runtime home (`~/Nova`) | On the hub device | Runtime state only: config, ledger database, memory store, logs. Not a code repo. |

## The wider system (context, not build scope)
- **WorkLedger / Jeremy System** — the user's work-capture practice (Screenpipe capture → classification → timecard drafts, standups, accomplishments log). It is a *workflow Nova will host later*, not part of Nova core. Its evidence model is imported into Nova's verification design (see WORK-LEDGER-AND-VERIFICATION).
- **Career/job-search system** — stays outside Nova core: canonical career record in the vault, portfolio repo for resume source/evidence, tracker + Drive folders for applications. Nova gets a Career workflow later via connector.
- **Dotfiles** — separate machine-bootstrap repo (Stow + Mise). Environment baseline step in the roadmap; not part of Nova.

## Existing Nova code — two eras, one repo
- **Era 1 (Oct 16–20, 2026)** — TypeScript monorepo (originally "rea"): hub-and-spoke, spec-driven, milestones M0–M8 CI-green, extension SDK, Ed25519 device enrollment. Its history is in `origin/main`'s ancestry.
- **Era 2 (Oct 21–26, 2026)** — dependency-free JavaScript monolith: `agent_cmd` model/agent swap point, handoffs mailbox, token-file themes with `lint:tokens` / `check:themes` scripts, Stellar Map (PR #207), Gmail IMAP connector, markdown schedules. `origin/main` HEAD 04512c07 (Oct 26).
- You will inventory both eras against CAPABILITY-INVENTORY before deciding reuse per component. Reuse is per-component and evidence-based, never wholesale.

## Known hazards (do not make them worse)
- An Era-1-era worktree with a large volume of uncommitted desktop/capture work exists in the user's checkout. **Preservation is the user's decision — do not commit, move, delete, or clean it up.** Build in a fresh clone/worktree of `origin/main`.
- The user's local `main` is stale (Oct 17). Always branch from `origin/main`.
- Open GitHub items at packet time: PR #207 (Stellar Map, awaiting user review — do not merge), issue #208 (undecided — leave alone).

## Topology
- **Tier 1 — the hub**: an always-on low-power device (mini-PC class) runs Nova core; serves the PWA to all clients.
- **Tier 2 — spokes**: desktop (GPU-capable, Wake-on-LAN), laptop, phones, tablets — paired devices that run clients and, where capable, workers/capture.
- **Tier 3 — optional cloud**: relay/failover and cloud model providers, only as policy allows.
- GitHub is the source of truth for code and for this packet.
