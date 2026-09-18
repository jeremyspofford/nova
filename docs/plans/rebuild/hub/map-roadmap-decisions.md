All paths are relative to `/home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff`. The one exception is the master plan, at `/home/jeremy/.claude/plans/what-i-need-is-wobbly-beacon.md` (called MP below).

## 1. ROADMAP.md: status and what is next

- **Shipped:** S01–S05b, S09, S10/S10a/S10pre, S11–S19, S22, S24, S25, S28. **Parked:** S23. **Unbuilt:** S26, S27 (`docs/plans/rebuild/ROADMAP.md:22-23`).
- **Order of work** (`ROADMAP.md:32-39`): manifest, S24, S25 and S28 are done. **S26, the quality corpus, is NEXT, with "Nothing built, nothing spec'd"** (`:38`). S27 feature flags is "deliberately last" (`:39`).
- **Item 0 comes before S26 and is not a slice.** The full core suite wedges at about 12%, so "no slice can show a full-suite green" (`:41-57`).
- **Proposal A, secrets at rest: "High ROI. Recommended next after S26."** Provider keys are plaintext at `services/gateway/migrations/003_providers.sql:22`, and there is no `cryptography` import in the gateway (`ROADMAP.md:210-231`).
- Other proposals: B MCP client (`:233-253`), C a second person (`:255-280`), D backups (`:282-295`), E Vault (`:297-302`), F rejected (`:304-322`).
- **Onboarding already exists and must not be re-proposed** (`:200-203`). It is an 8-step wizard: Welcome, CreateAccount, Timezone, HardwareDetection, ChooseEngine, PickModel, Downloading, Ready.
- Change-model UI and re-run onboarding shipped in S2e T1 (`docs/plans/rebuild/slice-02e-carries.md:3-4`). "Re-run setup" clears `onboarding.completed` (`apps/web/src/pages/settings/SettingsPage.tsx:114-122`). These were first raised as gaps in `slice-01-carries.md:45-50`.
- **The one standing item that touches this feature directly:** "Watching stops when the machine sleeps (S11). WSL-on-Windows host; nine of twelve hours had no pass... **Where Nova runs is a bigger question than that slice.**" (`ROADMAP.md:161-163`; also `slice-11-carries.md:51-55`).
- **Housekeeping** (`ROADMAP.md:326-340`):
  - README.md describes v3, not v4.
  - `main` carries both codebases.
  - CI does not run on `main` (it triggers on `rebuild/**` only).
- **Nothing in ROADMAP.md mentions** multi-host, remote inference hosts, Wake-on-LAN or power, a hub topology, or hardware requirements.

## 2. Locked decisions in the master plan that apply

MP is a "FINAL DRAFT for owner approval, 2026-08-27" (MP:3). Its register is the owner's decisions of 2026-08-27 (MP:20).

- **Topology, decision 8** (MP:40-43): "one home server + thin clients first; federation-ready seams from slice 1 (configurable URLs, authenticated links, externalized state, outbound-dialing actuators)." The hub-and-thin-client ask fits this directly.
- **Packaging, decision 4** (MP:23): "compose-first with k8s-ready seams; k8s is optional slice 20." S20's DoD is "fresh k3s install passes the S1 DoD unchanged" (MP:495-496).
- **Cloud stance, decision 5** (MP:33-37): "user mode switch local-only / cloud-only / hybrid... Hybrid escalation policy is owned by OUR inference gateway... local-only mode degrades loudly, never silently routes to cloud."
  - Rail 20 is "No silent cross-mode inference fallback" (MP:267).
  - The fallback chain says "local-only mode fails loud" (MP:151-154).
- **Cross-cutting rules** (MP:116-124):
  - Per-link bearer tokens, refusing everything when unset.
  - "Core settings store is the only writable runtime config; env is bootstrap-only."
  - Health checks call only `/health/live`, and "readiness probing downstream readiness is a review-blocking defect."
  - "127.0.0.1 binds; cross-host = tailnet."
  - "Compose profiles decide what's installed; the mode switch (gateway runtime state) decides what's used — flipping modes never redeploys."
- **Rails:** 10 "A service with no token refuses everything"; 12 "Readiness never probes downstream readiness"; 5 "An unverifiable step fails loudly"; 9 "GPU-minutes ≠ USD; unmetered recorded as unmetered, never zero" (MP:238-267).
- **The gateway owns** the mode switch, engine lifecycle and model catalog. `novad` is "per-machine... dials core outbound WSS" (MP:81, 85).
- **Hardware:** the model pin is a 27B-class model at 4-bit "for the 24 GB target" (MP:50-51). **No hardware-requirements document exists in v4.** A grep of `docs/plans/rebuild`, `deploy`, `install` and `apps/web/README.md` found nothing.
- **S6, daemon for macOS and Windows** (MP:335-338): ".pkg+launchd, Windows service + session helper + MSI/winget, .deb/.rpm, server-gated signed self-update." It is **unbuilt**: not in the shipped list, and out of scope in `slice-05-daemon.md:216`.
- **Superseded:** decision 9 (earned autonomy, MP:44-46) and every consent or grant passage in MP. The owner removed them on 2026-09-03 (`docs/plans/rebuild/no-approvals.md:1-30`).
- **Numbering drift:** MP's slice numbers do not match v4's. MP's S12 is browser automation; v4's S12 is agents. S06–S08 and S20–S21 as MP defines them were never built.

## 3. Mode switch, remote ollama, live resources: what shipped

- **The local-only / cloud-only / hybrid mode switch is NOT built.** Outside the memory service's "hybrid recall", there is no `local_only`, `cloud_only`, `hybrid` or `inference_mode` identifier in `services/` or `apps/web/src`.
  - S10 shipped owner-set **roles with ordered fallback chains** instead: "past a cap, fall back to local and say so" (`slice-10-spend-routing.md:12-17, 55-68`).
  - Docs still refer to "S10's mode switch" as where routing around a busy card belongs (`ROADMAP.md:141`; `slice-22-carries.md:101-105`; `slice-22-live-resources.md:157-159`).
- **Walls:** a 5xx (for example, a sleeping remote ollama) walls **that model** for 60 s, then 5 min, then 30 min. Codes 401/402/403/429 wall the whole provider for 1 h, 6 h, 24 h (`services/gateway/app/routing.py:59-67`; `data_plane.py:112-125`). Something must clear or avoid the wall after a wake.
- **Remote ollama:** S1 had a `remote` backend kind for "any OpenAI-compat/ollama URL", with one backend active at a time (`slice-01-spine.md:80-83`).
  - S10pre turned this into provider rows, and the old `remote` row was kept (`slice-10pre-carries.md:10-17`).
  - The builtin `ollama` row resolves its address live from the `OLLAMA_URL` env var (`slice-10pre-providers.md:105`).
  - `OLLAMA_URL: http://ollama:11434` is hard-set in `deploy/docker-compose.yml:79`.
  - The bundled ollama sits behind `profiles: ["inference"]` (`deploy/docker-compose.yml:215`).
  - Rail 20 is pinned: no silent substitution (`slice-10pre-providers.md:84-88`).
- **Live resources (S22):** the gateway reads VRAM by running `nvidia-smi` **inside the gateway container** (`slice-22-live-resources.md:57-60`).
  - `hardware.json` is used only for the install-time tier suggestion (`:78`).
  - The ruling is "State, never decide", so nothing routes around a busy card on its own judgement (`:45-49`).
  - **Inference from the docs:** on a hub with no GPU this path finds nothing. The remote box's VRAM would need a new source, for example novad or ollama's `/api/ps`.
- **S23, the serving runtime, is parked.** "Every number in it was measured on this host" (`ROADMAP.md:179-182`), meaning the Dell.

## 4. S5b tailnet: the only remote-access design

- **Rails** (`slice-05b-tailnet.md:255-264`; MP:323-325): "the tailnet is the ONLY non-loopback exposure (no LAN bind, no public port)", apart from the explicit tunnel or funnel.
  - It shipped one origin, `https://nova.tailba0abb.ts.net`, with fixed-address IPAM (`slice-05b-carries.md:9-15`).
- **DoD items still owed by the owner:** 1, 4, 6 and 7 (`slice-05b-carries.md:51-61`).
- **Carries that affect a new hub** (`slice-05b-carries.md:63-83`):
  - S8 must give core provenance for identity headers, because `core:8000` is reachable directly.
  - The rate limiter keys on the sidecar IP.
  - `--profile` on the CLI replaces `.env`'s `COMPOSE_PROFILES`.
- **GPU overlay trap** (`slice-05b-carries.md:85-100`): the GPU reservation lives in the separate overlay `docker-compose.gpu.yml`. A bare `-f` brought ollama up on CPU. `COMPOSE_FILE` must be absolute, and install dies unless ollama reports the GPU library.
- **Inference, not in any doc:** a WoL magic packet is a LAN broadcast and cannot cross the tailnet. So a hub that wakes the Dell needs a LAN path, which sits next to the "tailnet is the only exposure" rail.

## 5. Unmerged design: `doing-things.md`

Branch `claude/nova-autonomous-capabilities-c25b5c`, commit `25f29ba6`, dated 2026-09-18. It is **not merged into HEAD**. Its status line is "DESIGN, waiting on owner decisions. **Nothing here is built.**" (`:3-4`).

- **The stack host is already a paired novad device** (`:33-38`). "`DELL-XPS-8950` is paired, novad dials `http://localhost:3000` through the web container" (`:48-49`). Linger is off, so novad dies at logout (`:99-102`).
- **S29–S37 are proposed** (`:3-4`), and the design says "Next core migration: 035. Next slice: S29." (`:128-129`).
- **S30** (`:322-349`) adds `hands.py`, "the seam CODE uses to touch the host... with **the stack host derived from `NOVA_STACK_HOSTNAME`**". It also re-points the daemon at core `:8000` and enables linger.
  - **Moving the stack to the mini PC changes which device is the stack host.**
- **S31** is signed daemon self-update; core builds novad for two architectures (`:350-363`). This is the MP S6 self-update piece, Linux only.
- **S33** is deploy by SHA. The ollama compute line `library=CUDA` is part of the read-back (`:394-420`). **That assumes a GPU on the stack host.**
- **S38+** is left unspecced (`:469-481`), including "*Every device:* macOS and Windows daemons; screen, clipboard...".
- **"What this design cannot do: Work while the host sleeps.** WSL2 stops the VM when the last terminal closes; the stack, the daemon and every job stop with it, and no row records that the box was off." (`:727-729`). This is the problem the hub solves.
- **Its open questions that overlap the hub** (`:535-603`):
  - Q1, where her hands on the host live.
  - Q2, which tree she deploys from.
  - Q4, blue/green "on this one box". Q4 cites "a second ollama on one card or a shared gateway" (`:569-583`); a second machine changes the premise.
  - Q6, secrets store.
- Open defect: "The scheduler never reads `person_busy`, so a firing contends with his chat for the one card" (`:703`).
- The design never mentions WoL, a mini PC, or a separate inference host.

## 6. v3 prior art (mine only)

- **The owner already stated this topology in v3:** *"eventually i intend to have the ollama service run only on my dell that has the gpu and maybe most other services on my mini pc. may have a vm in the cloud or database or storage solution..."* (`docs/plans/capability-acquisition.md:164-166`; again at `:494-497`, with k3s across the Dell and the mini PC at `:178, 191-196`).
  - That document is marked "v3 only — not carried" (`docs/plans/README.md:38`). Its approval designs are off-limits; the topology quote is still the owner's own words.
- **WoL was spec'd in v3** (`docs/plans/machine-management.md:82-89, 112`): "Wake-on-LAN is a magic packet — a MAC address and a UDP send, with no command string... Build them as tools, not as shell invocations." It was never built.
- **Per-host secret key** (`docs/archive/NEXT-v3.md:102-105`): with no `NOVA_SECRET_KEY` set, v3 generated one per host, and "a second instance sharing this Postgres will not decrypt those rows. Set it in `.env` before the Dell or the mini PC joins."
- **Multi-backend endpoints** (`docs/plans/named-inference-endpoints.md:1-12`): superseded by the provider registry, but it keeps the `host.docker.internal` and 11434-shadow traps.

## 7. Constraints the new feature must respect

1. **No authorization decisions** (`no-approvals.md:13-28`). WoL or proxying must not add a "may I wake it?" click. `test_no_approvals` fails on any gate (`CLAUDE.md:189-193`).
2. **Her capability, not the operator's** (`CLAUDE.md:131-171`). Setup and walkthroughs need registered tools (a wake tool, an inference-host status or probe tool); a registered tool moves the pinned `test_tools_registry` set. "The moment I reach for `docker`, `tailscale`... that is a capability she is missing."
3. **Runtime config goes in settings or provider rows, not env** (MP:118-119). `OLLAMA_URL` is env today.
4. **"Flipping modes never redeploys"** (MP:123-124). But local inference on the hub is the install-time `inference` compose profile, so the toggle conflicts with that rule unless both options are installed.
5. **Local-only fails loud; no silent fallback to cloud** (rail 20). A sleeping Dell must produce a stated wait or wake, not a quiet chain fallback to cloud.
6. **Readiness never probes downstream** (rail 12). The hub stays healthy while the Dell sleeps.
7. **Per-link bearer tokens** (MP:116; rail 10). Ollama has no auth, so a link from the hub to the Dell needs one.
8. **Cross-host traffic goes over the tailnet only** (`slice-05b-tailnet.md:263-264`). The WoL LAN broadcast needs an explicit carve-out.
9. **"State, never decide"** on busy or asleep cards (`slice-22-live-resources.md:45-49`).
10. **Live facts, never stale files** (`slice-22-live-resources.md:36-44`). `nvidia-smi` in the gateway container is useless on a hub with no GPU.
11. **Gateway walls** (`routing.py:59-67`) interact with wake latency.
12. **Every DoD is walked live in the running app**, and web changes are checked at 393 px (MP:273; `decisions-2026-09-15.md:176-182`).

## 8. Open owner questions that overlap

- **Order of work:** item 0 (the suite wedge), then S26 next, then S27 last. Proposal A (secrets) is recommended after S26. doing-things Q0 asks where its lane fits (`ROADMAP.md:32-57, 210`).
- **"Where Nova runs"** is explicitly deferred (`ROADMAP.md:161-163`).
- **Routing around a contended card** is described as "S10's mode switch... a conversation" (`slice-22-carries.md:101-105`), and the mode switch itself does not exist.
- **The mobile application** is a future in-depth discussion (`decisions-2026-09-15.md:121-126`), as is the `SURFACE_PRESET` hardcode (`ROADMAP.md:108-112`).
- **S27 flag-first:** its workflow "applies to every slice after it" (`decisions-2026-09-15.md:268-269`), and flag-first "without fail" is still open (`:192-238`).
- **Carried items:** S16's `./install update` is still a stub (`slice-01-carries.md:63-67`), and S8 must give core provenance for identity headers (`slice-05b-carries.md:77-80`).
- **MP items never built:** S6 (macOS and Windows daemons, self-update) and S20 (k8s).
- **doing-things Q1, Q2, Q4, Q6** are unanswered.

## 9. Next slice number and naming

- **Convention:** `docs/plans/rebuild/slice-NN-<kebab-topic>.md`, with a two-digit number. Letter suffixes mark inserted slices (`02b`–`02f`, `05b`, `10a`, `10pre`). A close-out goes in `slice-NN-carries.md`, and branches are named `slice/sNN`. Register the slice in the ROADMAP index table (`ROADMAP.md:352-380`) and the order-of-work table (`:32-39`).
- **Numbers already taken:**
  - S01–S28: S26 is reserved with no doc; S20 and S21 were used only as branch names (`origin/slice/s20`, `origin/slice/s21`, eval fixes; see `slice-22-carries.md:97`).
  - **S29–S37 are claimed by the unmerged doing-things design**, which also reserves **S38+** as an unnumbered range of substrates, including macOS and Windows daemons.
- **Recommendation:**
  - To avoid colliding with that design, use **S38** (it opens the "substrates" range, next to "every device") or **S39**, whichever is free.
  - If the owner drops doing-things, the literal next free number on `main` is **S29**.
  - The owner should confirm the choice.