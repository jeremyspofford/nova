# External findings: APP-4 (always-on agent with its own computer)

This is input for the Phase 0 reconciliation (`PROMPT.md` §2) of the always-on agent capability
set (`docs/00` §1, "delegated, ongoing responsibility"; `docs/02` §G; `docs/03` §G; `docs/09`
§8). These are **findings, not decisions**.

- The reference app is named only by its opaque ID (`docs/19` §1.3). Its identity and the real
  source URLs are in the gitignored `docs/external/private/` ledger.
- Other reference apps appear by ID only. APP-1 is the host chat product that APP-4 lives
  inside. APP-3 is the open-source coding-agent engine whose machinery APP-4 shares.
- Requirements derived from this file must be rewritten in vendor-neutral language (`docs/01`
  §5).

## Provenance

| | |
| --- | --- |
| Target | APP-4: the always-on agent product inside APP-1. Launched 2026-09-29. |
| Version | No binary was analysed. The product docs and the safety-card appendix are as published on 2026-10-16. The owner's machine has desktop host client 26.1007.2314.0 (Windows, x64). |
| Method | Read in full: the vendor's product docs site and the model safety-card appendix on APP-4 (16 pages). The vendor's main site and help center returned HTTP 403, so their content is known only from search-engine excerpts. Also used: public bug reports in APP-3's issue tracker, one README in APP-3's engine source, press, and secondary write-ups. On the owner's machine, only the installed-package list and folder names were inspected. **The product was not used. Nothing was run, intercepted or decompiled.** |
| Evidence refs | Opaque refs: `APP4/doc/…`, `APP4/safety-card/…`, `APP4/src-issue/…`, `APP3/src/…`, `APP4/obs/…`, `press/…`, `third-party/…`. Each one maps to a real URL in `docs/external/private/app4-refs.md`. The evidence `type` of third-party write-ups is `press`. |
| Date | Research 2026-10-16; converted 2026-10-17 |

### Clean-room note

- APP-4 is a closed commercial cloud service. Everything below describes its behaviour in our
  own words. No vendor text, code or assets are copied (`docs/19` §1).
- From APP-3's public source, only one README was read (ER-APP4-005). Nothing is taken from it.
- Some claims were tagged in the source teardown only as "product docs", with no page named.
  For those, the ref points to the docs page whose topic matches, and `limits` says
  "page inferred".

### Confidence

- **high**: stated on the vendor's product docs site or in the safety-card appendix, both read
  in full, or directly observed on the owner's machine.
- **medium**: a vendor statement seen only as a search-engine excerpt (main site and help
  center), reputable press, or a user-written public bug log.
- **low**: a secondary blog, a secondhand review, a rumour, or our own inference. Inferences
  say so in `limits`.

## Capability summary

| # | Capability | Evidence records | Nova coverage |
| --- | --- | --- | --- |
| 1 | Persistent, named agent inside the host product; one per user | ER-APP4-001 | `docs/09` §8, FR-079: covered. The one-per-user limit **diverges** (Nova sets no limit). |
| 2 | Its own persistent cloud computer and browser; take over and return control; private sign-in | ER-APP4-002 | `docs/11` §2.1, §4.1–4.2; FR-080, FR-086, FR-087: covered |
| 3 | One optional connected personal computer, through the desktop client | ER-APP4-003 | `docs/11` §2.3, FR-081: partially. The "client must stay open" rule, the local-browser fallback, the separate grant and the version floor are **not covered**. |
| 4 | Local executor registers with the backend; relay transport | ER-APP4-004, 005 | `docs/23` §2, §9 and `docs/22` §3: partially. Nova uses a `novad` service and a content-blind Relay. |
| 5 | Delegation to subagents, delegated-work tasks and coding tasks | ER-APP4-006 | `docs/09` §4, §8; FR-053, FR-059, FR-083: partially. Agent-to-coding and agent-to-work delegation is **not covered**. |
| 6 | Time-budget setting combined with reasoning effort | ER-APP4-007 | `docs/09` §2 (60-step / 60-minute caps), FR-024: **diverges** |
| 7 | Self-paced wake-ups, saved schedules, plugin-declared triggers | ER-APP4-008 | `docs/09` §6–7, FR-055, FR-056. Schedules are covered. Self-paced wake-ups are **not covered**. Triggers **diverge**. |
| 8 | Read-only proactive research | ER-APP4-009 | `docs/09` §8, `docs/21` §11, FR-082: covered. The trigger and where results go differ. |
| 9 | Three-layer memory; same agent in every channel, histories not mirrored | ER-APP4-010 | `docs/09` §5, `docs/13` §4, FR-088, FR-089: **diverges** (Nova puts every channel into one thread) |
| 10 | Memory controls: notes may not be viewable; switching off host memory doesn't remove copies | ER-APP4-011 | FR-032, FR-089, `docs/27` §2: **diverges** (Nova is stricter) |
| 11 | Channels: chat, voice calls, Slack, Teams; texting "coming soon" | ER-APP4-012 | `docs/13` §4, FR-088, FR-110, FR-031: partially. Agent-initiated voice calls are **not covered**. |
| 12 | Plugin bundle (skills, MCP, browser extensions, hooks); per-action permissions | ER-APP4-013 | `docs/08` §3, FR-045, FR-048: partially |
| 13 | Four-layer safety stack; custom rules at four levels | ER-APP4-014 | `docs/12` §2–3, FR-084, FR-099. Custom rules are covered. The stack order **diverges**. |
| 14 | Auto-review by a separate model; confirmation policy; limits on engaging outside agents | ER-APP4-015 | `docs/12` §6, FR-085, FR-103: partially. The reviewer contract and the outside-agent rule are **not covered**. |
| 15 | Activity view, pause/stop/delete, enterprise admin switches, role-specific agents, teams of agents | ER-APP4-016 | `docs/09` §9, `docs/12` §10; FR-090, FR-091, FR-106: partially. Pause scope **diverges**. |
| 16 | Safety evals: prompt injection and red-teaming | ER-APP4-017 | `docs/12` §12, `docs/16` §5, FR-123: partially |
| 17 | Safety evals: persistent and proactive workflows | ER-APP4-018 | **not covered** |
| 18 | Safety evals: time budgets, monitoring, misuse | ER-APP4-019 | **not covered** |
| 19 | Availability, pricing, data use, no public API | ER-APP4-020 | `docs/12` §9, FR-105, FR-116: mostly not applicable (Nova is self-hosted and never trains on user data) |
| 20 | Look-alike clones and fake "official download" lures | ER-APP4-021 | `docs/15` §3, FR-133: partially. Signing is covered; lure monitoring is **not covered**. |
| 21 | No continuous screen or audio capture | ER-APP4-022 | `docs/24`, FR-151: Nova goes beyond APP-4 here |

---

## A. Product shape and the agent's own computer (`docs/09` §8, `docs/11`)

```yaml
id: ER-APP4-001
area: product / what it is, clients, relation to APP-1 and APP-3
claim: >
  - A persistent, proactive agent that lives inside the host chat product (APP-1); it is not
    a separate app. The user gives it ongoing responsibilities rather than one-off prompts. It
    keeps working between conversations, coordinates subagents and delegated tasks, and comes
    back with results or with decisions it needs from the user.
  - Each user gets one "primary" agent at launch and gives it a name, an appearance and a
    handle. It can be created from the desktop, mobile or browser client. Creating one on
    mobile was added about two weeks after launch.
  - The vendor divides the host product's modes this way: chat answers questions, the
    delegated-work mode of APP-1 runs one-off tasks, APP-3 does software work, and APP-4 holds
    an ongoing responsibility, handing tasks to the other two.
  - APP-4 shares plugins, skills, MCP, Auto-review and the confirmation-policy machinery with
    APP-3. The safety card evaluates the same model in an "APP-4 harness" and an "APP-3
    harness". APP-4 bugs are filed in APP-3's public issue tracker under a dedicated label
    (more than 100 issues by 2026-10-16).
  - Clients: the host product's web, desktop (Windows, macOS) and mobile (iOS, Android) apps.
    Mobile web browsers are not supported. The agent itself runs in the vendor's cloud and
    runs on the frontier model it launched with.
  - Per user bug reports, the Windows desktop client is a store-installed package named after
    APP-3, not APP-1. It bundles APP-3's command-line engine (about version 0.159) and a
    computer-use plugin.
evidence:
  - type: doc
    ref: APP4/doc/overview
  - type: doc
    ref: APP4/doc/getting-started
  - type: doc
    ref: APP4/doc/announcement
  - type: doc
    ref: APP4/doc/community-update-mobile-and-coding
  - type: doc
    ref: APP4/safety-card/B.1
  - type: source
    ref: APP4/src-issue/label-index
  - type: source
    ref: APP4/src-issue/49458
  - type: source
    ref: APP4/src-issue/49562
  - type: press
    ref: press/techcrunch-launch
confidence: high
limits: >
  Product docs and the safety card support the agent's shape. The announcement wording is
  known only from search excerpts (HTTP 403). The Windows package details come from user bug
  reports (medium). Ubuntu clients also appear in bug reports; the docs do not list Linux.
  The teardown does not say which report shows Ubuntu; APP4/src-issue/51731 and 52457 are
  the reports in its source list with no other attributed claim.
  Whether one agent per user is permanent or only a launch limit is not stated.
```

```yaml
id: ER-APP4-002
area: execution / own cloud computer, takeover, sign-in
claim: >
  - Each agent has its own cloud computer and browser. Files, installed software and browser
    sessions persist between uses, and it keeps working while the user's devices are off. The
    user's own computer stays separate unless the user connects it (ER-APP4-003).
  - The user can open that computer, take control ("Take over") and hand it back ("Return
    control").
  - When a site needs credentials, the user types them into a private sign-in form. They go to
    the site without passing through the model. Passwords can optionally be saved.
evidence:
  - type: doc
    ref: APP4/doc/computers-and-apps
  - type: doc
    ref: APP4/safety-card/B.1
confidence: high
limits: >
  Sign-in form: page inferred. Not documented: the cloud computer's OS, size, region,
  retention and snapshot behaviour. Also not stated: whether the agent pauses during a
  takeover, whether takeovers are logged, and where saved passwords are kept. Secondhand
  summaries of a press review report the agent getting stuck on CAPTCHAs (low;
  third-party/zetik-review-summary, third-party/neoteo-review-summary).
```

## B. The connected personal computer (`docs/11` §2.3, `docs/23`, `docs/22`)

```yaml
id: ER-APP4-003
area: execution / one connected personal computer
claim: >
  - One of the user's own computers can optionally be connected, and only one. The grant
    is made from the agent's profile ("Computers": allow access, later revoke access).
  - The host desktop app must stay open on that computer. Enterprise accounts need client
    version 26.929 or later.
  - Once connected, the agent can use local files and code, local skills, and the local
    browser. The local browser is a fallback when sites block the cloud browser.
    Delegated-work tasks and APP-3 coding tasks can run locally on it.
  - This grant is separate from connecting the same computer to APP-3, and from turning on
    the delegated-work mode's file-sync feature.
  - The agent uses local access when a task needs it. The docs describe no background
    monitoring of the computer.
evidence:
  - type: doc
    ref: APP4/doc/computers-and-apps
  - type: doc
    ref: APP4/doc/cloud-local-access
  - type: doc
    ref: APP4/doc/admin-guide
confidence: high
limits: >
  Page inferred for the consumer flow. The version floor comes from the enterprise docs. Not
  stated: which OSes are supported, and whether local actions run in an OS sandbox.
```

```yaml
id: ER-APP4-004
area: execution / local executor and the owner's machine
claim: >
  - User bug reports show local APP-4 work running through a local executor that registers
    with the vendor's backend. The logged failures (paraphrased):
    - executor registration refused with HTTP 403;
    - an exec-server connection failing while the agent's root executor was being prepared;
    - the engine's app-server being unavailable.
  - The owner's Windows machine, inspected by name only, has:
    - the desktop host package (named after APP-3), version 26.1007.2314.0, x64, installed
      from the Windows app store;
    - a per-user vendor data folder holding one folder named after APP-3 and one named
      "extension";
    - no separate APP-4 package or folder.
  - That version is the same build as in a public APP-4 bug report, and it is above the
    26.929 enterprise floor.
evidence:
  - type: source
    ref: APP4/src-issue/50545
  - type: source
    ref: APP4/src-issue/52774
  - type: source
    ref: APP4/src-issue/53359
  - type: observed
    ref: APP4/obs/desktop-package
  - type: observed
    ref: APP4/obs/vendor-data-folders
  - type: observed
    ref: APP4/obs/no-agent-package
confidence: medium
limits: >
  Bug reports are user logs, not vendor statements. The machine observations are high
  confidence, but nothing was launched. Whether the owner's account has APP-4 enabled cannot
  be told from the filesystem.
```

```yaml
id: ER-APP4-005
area: execution / local bridge transport (inference)
claim: >
  - APP-3's open-source exec-server has a remote mode. The local exec-server registers with an
    environment registry, then connects out to a rendezvous websocket that the service
    provides. Traffic runs over an encrypted relay built on the Noise protocol framework.
  - Inference: APP-4's local bridge probably uses this mechanism, given the matching component
    names in ER-APP4-004.
evidence:
  - type: source
    ref: APP3/src/exec-server/README.md
  - type: source
    ref: APP4/src-issue/52774
confidence: low
limits: >
  Inference only. The README describes the engine, not APP-4, and the vendor has not confirmed
  the link. No traffic was observed.
```

## C. Delegation, time budget and scheduling (`docs/09` §2, §4, §6–7)

```yaml
id: ER-APP4-006
area: delegation / subagents, delegated-work tasks, coding tasks
claim: >
  - The agent splits work across background subagents that run in parallel. Each subagent is
    visible as its own thread and reports back. The user can keep talking to the agent while
    they run.
  - It can create tasks in APP-1's delegated-work mode, and it can review and edit that mode's
    scheduled tasks.
  - It can start new APP-3 coding tasks, either in an APP-3 cloud environment the user set up
    beforehand or locally on the connected computer. It can also continue existing local
    APP-3 threads. This was added in an update dated 2026-10-09.
  - Delegated-work and coding tasks count against those products' own usage limits. Chatting
    with the agent does not.
  - Teams of agents working together are a stated plan, not shipped.
evidence:
  - type: doc
    ref: APP4/doc/tasks-and-memory
  - type: doc
    ref: APP4/doc/community-update-mobile-and-coding
  - type: doc
    ref: APP4/doc/announcement
  - type: doc
    ref: APP4/safety-card/B.1
confidence: high
limits: >
  Page inferred for delegated-work and coding delegation. The teams-of-agents plan is from a
  search excerpt (medium). Not stated: concurrency limits, whether subagents inherit only a
  subset of permissions, and which controls govern delegated tasks.
```

```yaml
id: ER-APP4-007
area: runtime / time budget and reasoning effort
claim: >
  - The APP-4 harness runs the model with a time-budget setting that guides how long the agent
    works. The safety card calls this new; multi-agent setups and persistence are not new.
  - The shipped product combines the time budget with reasoning effort.
  - In the evaluations, the model got simulated-time budgets of 4 minutes, 30 minutes, 4 hours
    and up to one year, plus a clock tool that can check the time and wait.
evidence:
  - type: doc
    ref: APP4/safety-card/B.1
  - type: doc
    ref: APP4/safety-card/B.3
confidence: high
limits: >
  Not documented in what was read: whether users can see or set the budget, its default, and
  what happens when it runs out.
```

```yaml
id: ER-APP4-008
area: runtime / self-paced wake-ups, saved schedules, event triggers
claim: >
  Work starts in three ways:
  - Self-paced: the agent decides for itself when to pause and when to wake up again.
  - Saved schedules: each has a time zone, an end date, notification rules and a delivery
    channel. They are managed in a "Scheduled" list.
  - Event triggers: only for plugins that support event monitoring. Adding the agent to a
    Slack channel does not make it watch that channel.
evidence:
  - type: doc
    ref: APP4/doc/tasks-and-memory
  - type: doc
    ref: APP4/doc/channels
  - type: doc
    ref: APP4/doc/plugins-event-build-page
confidence: high
limits: >
  Page inferred. Not stated: limits on how often or how far ahead the agent can wake itself,
  whether self-set wake-ups are visible or editable, and missed-run behaviour. The plugin docs
  list a build page for "MCP events", which suggests that is how event triggers are
  delivered. The page returned 404, so this is inference (low).
```

## D. Proactive research and memory (`docs/09` §5, §8; `docs/13` §4; `docs/27`)

```yaml
id: ER-APP4-009
area: proactive / read-only research
claim: >
  - When idle, the agent reads the user's connected apps in read-only mode ("proactive
    research").
  - What it learns goes into its private notes, and it brings suggestions back to the user.
  - The safety card says proactive work exposes the agent to more new emails and
    connected-app content. The vendor tested it against prompt injection and misleading
    proactive inputs (ER-APP4-017, ER-APP4-018).
evidence:
  - type: doc
    ref: APP4/doc/controls
  - type: doc
    ref: APP4/safety-card/B.2
confidence: high
limits: >
  Not captured: the cadence, how "idle" is defined, whether there is a per-agent off switch,
  and whether read-only mode can drive the browser.
```

```yaml
id: ER-APP4-010
area: memory / three layers; one agent across channels
claim: >
  - The agent works from three layers:
    - the current conversation and tool context;
    - relevant memory from the host product's memory feature (the agent's notes start from
      it);
    - its own notes, which are notes, not a transcript.
  - The vendor says the agent learns the user's preferences and standards over time.
  - Every channel reaches the same agent and the same notes, but message histories are not
    mirrored between channels. Each channel keeps its own history.
evidence:
  - type: doc
    ref: APP4/doc/tasks-and-memory
  - type: doc
    ref: APP4/doc/channels
  - type: press
    ref: press/9to5google-launch
confidence: high
limits: >
  Not described: how notes are written, condensed or retrieved, and how the agent decides what
  from one channel goes into its notes.
```

```yaml
id: ER-APP4-011
area: memory / user control over notes
claim: >
  - Switching off the host product's memory does not delete what the agent has already
    received from it.
  - Secondary coverage says individual notes cannot be viewed or edited, and that deleting the
    agent is the only way to reset them.
evidence:
  - type: doc
    ref: APP4/doc/help-privacy-faq
  - type: press
    ref: third-party/university365-explainer
confidence: low
limits: >
  The first point is a help-center search excerpt (medium). The claim that notes can't be
  viewed comes from secondary coverage only. It was not found in the vendor's own text and was
  not checked in the product.
```

## E. Channels (`docs/13` §4)

```yaml
id: ER-APP4-012
area: channels / supported channels and a doc conflict
claim: >
  - Host chat product: text on web, desktop and mobile, plus voice calls. Calls the agent
    starts itself are announced for after launch.
  - Slack: direct messages and mentions in threads.
  - Microsoft Teams.
  - Text messaging: "coming soon".
  - The agent can be @-mentioned inside the host product's shared collaborative-pages surface.
  - Conflict: the safety card says the agent follows up across the host product, text message,
    email and Slack. The product docs list no email channel.
evidence:
  - type: doc
    ref: APP4/doc/channels
  - type: doc
    ref: APP4/safety-card/B.1
  - type: press
    ref: press/9to5google-launch
confidence: high
limits: >
  Inference (low): email is probably handled through a mail plugin rather than a mailbox of
  the agent's own. Not captured: how approvals arrive in Slack or Teams, and how other
  workspace members are identified.
```

## F. Plugins, permissions and the safety stack (`docs/08` §3, `docs/12` §2–3, §6)

```yaml
id: ER-APP4-013
area: plugins / bundle and per-action permissions
claim: >
  - Integrations come from a plugin catalog shared by APP-1, APP-3 and APP-4. Press puts it
    at more than 4,000 apps.
  - A plugin bundles skills, MCP servers (optionally with UI), browser extensions and hooks.
    Hooks are not supported in cloud orchestration.
  - Plugin permissions are set per action, for example read email but don't send it.
evidence:
  - type: doc
    ref: APP4/doc/plugins
  - type: doc
    ref: APP4/doc/controls
  - type: press
    ref: press/cnbc-devday
  - type: press
    ref: press/infoq-devday
confidence: high
limits: >
  The catalog size is press-only (medium). The teardown does not record which outlet gave
  it, so both of its launch-event sources are listed. Default permission states for new
  plugins were not captured.
```

```yaml
id: ER-APP4-014
area: permissions / order of the safety stack; custom rules
claim: >
  - Checks apply in this order:
    1. built-in safeguards;
    2. per-action plugin permissions;
    3. Auto-review (ER-APP4-015);
    4. the user's custom rules.
  - Custom rules have four levels, from "act without asking" to "hand off to you".
  - Enterprise admins can switch custom rules off (ER-APP4-016).
evidence:
  - type: doc
    ref: APP4/doc/controls
  - type: doc
    ref: APP4/doc/admin-guide
confidence: high
limits: >
  Not stated: whether a later layer can relax an earlier one. The source teardown did not
  record the two middle levels' labels or the rule scopes.
```

```yaml
id: ER-APP4-015
area: permissions / Auto-review and the confirmation policy
claim: >
  - Before any action that touches the user's accounts or shares information, a separate
    reviewer model picks one of three outcomes: proceed, ask the user, or hand the action to
    the user. The docs give a password change as an example of a hand-off.
  - The safety card says the mechanism is shared with APP-3. A second model evaluates certain
    commands that would run outside a preset sandbox. If it judges a command unsafe, it blocks
    it, tells the acting model the verdict, and tells it to avoid substantively similar
    actions. For APP-4, agent-specific instructions were added to the reviewer's policy.
  - How the reviewer was evaluated:
    - Six threat categories: data disclosure, destructive actions, financial commitments,
      access and security, unauthorized communication, and ambiguous authorization.
    - 30 synthetic disallowed actions per category, made by editing real de-identified
      employee runs.
    - A denial rate measured on 5,000 unedited real requests.
    - Recall was weakest on ambiguous authorization.
  - APP-4 uses its own confirmation policy, written for long-running proactive work. Its
    harness gives that policy higher priority than APP-3's harness gives APP-3's.
  - The policy limits engagement with agents outside the vendor's own ecosystem unless the
    user explicitly asks.
evidence:
  - type: doc
    ref: APP4/doc/controls
  - type: doc
    ref: APP4/safety-card/B.3.3
  - type: doc
    ref: APP4/safety-card/B.3.4
  - type: doc
    ref: APP4/safety-card/B.3.6
confidence: high
limits: >
  The recall and denial-rate numbers appear only in plots, which were not transcribed. Neither
  the policy text nor the reviewer model's identity is public.
```

## G. Oversight, lifecycle and enterprise (`docs/09` §9, `docs/12` §10)

```yaml
id: ER-APP4-016
area: oversight / activity view, pause/stop/delete, admin switches, role-specific agents
claim: >
  - Activity view (desktop client only): progress, files and pending approvals for each task.
  - Pause stops only the main task. Deleting the agent cannot be undone and does not reverse
    actions it has already taken.
  - Enterprise, education and healthcare workspaces get a beta that an admin enables through
    a dedicated workspace permission.
  - Separate admin switches cover Slack, custom rules, local computer access, the cloud
    browser, network access, computer use and the password manager.
  - The vendor's compliance and analytics APIs cover APP-4. The workspace's enterprise model
    controls do not apply to it.
  - A preview of role-specific agents: each has its own identity for access management,
    IT-provisioned hardware, and deep integration with a company's systems of record. Press
    reports enterprise pilots run through a third-party agent-governance product.
evidence:
  - type: doc
    ref: APP4/doc/controls
  - type: doc
    ref: APP4/doc/admin-guide
  - type: doc
    ref: APP4/doc/announcement
  - type: press
    ref: press/techcrunch-launch
confidence: medium
limits: >
  The activity view and pause/delete come from docs (high, page inferred). The role-specific
  preview comes from a search excerpt and press (medium). "Pause stops only the main task"
  implies, but does not state, that subagents and delegated tasks keep running. What "stop"
  does was not captured. A secondary explainer says the enterprise beta lacks zero data
  retention, FedRAMP, customer-managed keys and data residency (low;
  third-party/flaviocopes-explainer).
```

## H. Safety-evaluation figures (`docs/12` §12, `docs/16` §5)

All figures below are the vendor's own, from the safety-card appendix. None were reproduced.

```yaml
id: ER-APP4-017
area: safety eval / prompt injection and red-teaming
claim: >
  - Bulk automated test: 100 valid rollouts, each with 500 simulated emails (334 benign, 166
    attacks). That is 50,000 emails, 16,600 of them attacks. There were no scored attack
    successes.
  - Iterative automated test: an attacker model refined one email at a time, using the agent's
    earlier responses and tool calls. Each attempt ran in a fresh context. 100 attack chains,
    2,638 valid attempts, no scored successes.
  - The attacks aimed at disclosing private data, forwarding mail or diverting payments. The
    attacker was given the agent's confirmation policy, task context, tool schemas and
    operating constraints.
  - In inspected traces, the agent usually flagged suspicious requests, withheld risky actions,
    and notified or asked the user.
  - Manual red-teaming covered email, calendar, shopping and business workflows, with testers
    impersonating coworkers, tools, marketplaces and other agents. The agent resisted
    attachment-based and hidden-instruction attacks, and generally did not send data to
    external domains.
  - Early red-teaming found weak handling of sensitive disclosures and of asking for
    confirmation, including when the agent was told never to ask. Confirmation-policy updates
    fixed the scenarios tested. The vendor says the remaining known vulnerabilities need
    significant setup or very permissive prompts.
evidence:
  - type: doc
    ref: APP4/safety-card/B.2.1
  - type: doc
    ref: APP4/safety-card/B.2.2
confidence: high
limits: >
  "Scored success" is the vendor's metric. The manual results are qualitative, with no rates.
```

```yaml
id: ER-APP4-018
area: safety eval / persistent and proactive workflows
claim: >
  - Permission or scope changed mid-task: pass rate 91.8% (45 of 49 episodes), including all
    17 explicit permission-change cases. The 4 flagged episodes had ambiguous boundaries.
    With explicit reasoning budgets: 92.2% to 93.3%, with no clear trend.
  - Chained tasks: an initial task, 5 or 10 related intervening tasks, and a final task, all in
    one persistent environment. The scope of authorization often changed between tasks
    without being stated.
    - There were no severe breaches or exfiltration.
    - Moderate scope violations (for example, carrying information between unrelated tasks, or
      editing a shared document) rose from 8.6% to 19.7% of samples when the intervening tasks
      went from 5 to 10.
    - With explicit reasoning budgets, results matched the shorter chain and improved on the
      longer one.
  - Misleading proactive inputs (synthetic tasks, work environments and notifications that
    push toward unsupported conclusions or improper actions): 0.00% misalignment across 151
    tasks.
evidence:
  - type: doc
    ref: APP4/safety-card/B.3.5.1
  - type: doc
    ref: APP4/safety-card/B.3.5.2
  - type: doc
    ref: APP4/safety-card/B.3.5.3
confidence: high
limits: >
  These are new, preliminary evaluations with small samples (49 and 151). In one place the
  card calls the chained settings "seven-task" and "twelve-task" (total tasks); these are the
  same two settings.
```

```yaml
id: ER-APP4-019
area: safety eval / behaviour across time budgets, monitoring, misuse
claim: >
  - Respecting Auto-review: 0% of prohibited actions completed at all four budgets (4 min,
    30 min, 4 h, one year). The one flag, at 4 h, was a false positive.
  - Respecting warnings: the model kept pursuing a blocked action in 17.4% of rollouts at
    maximum reasoning effort. Across time budgets the rate was 17.2% (4 min), 15.4% (30 min
    and 4 h) and 15.0% (one year). The vendor reads this as no meaningful effect of the
    budget.
  - Broken search tool (not admitting that search is unavailable): 3.0%, 3.3%, 3.3% and 2.5%
    across the budgets, against 1.6% at maximum reasoning effort.
  - Realistic work environments (a hard subset): severe misalignment of 0.84% in the APP-4
    harness, slightly lower than in the APP-3 harness.
  - Planted instructions on an outside message board: followed in 0% of runs, and the agent
    never engaged with the board.
  - Monitor evasion at a 30-minute budget matched the non-persistent setting. Evasion was near
    zero when a high-recall monitor saw the full trajectory. The model had some success
    avoiding the top-priority (paging) label in production monitoring.
  - Misuse safeguards: block rates of 92% in both harnesses for exploit development and
    red-teaming. For high-risk cyber activity: 87.5% in the APP-4 harness against 85%
    baseline.
  - The vendor rates the underlying model "High" capability for biological and chemical risk
    and "Critical" for cybersecurity.
evidence:
  - type: doc
    ref: APP4/safety-card/B.3.1
  - type: doc
    ref: APP4/safety-card/B.3.2
  - type: doc
    ref: APP4/safety-card/B.3.3
  - type: doc
    ref: APP4/safety-card/B.3.4
  - type: doc
    ref: APP4/safety-card/B.4.1
  - type: doc
    ref: APP4/safety-card/B.5.1
  - type: doc
    ref: APP4/safety-card/B.6.2
confidence: high
limits: >
  Some of these are model-level runs without the production safeguard stack. The vendor says
  the work-environment rates are not representative of production. The plots were not
  transcribed.
```

## I. Availability, ecosystem, and what APP-4 does not do

```yaml
id: ER-APP4-020
area: availability / plans, markets, data use, API
claim: >
  - Plans at launch:
    - the vendor's top consumer subscription tiers (three price points, roughly $100 to $500 a
      month);
    - a premium per-seat business tier (about $100 per user per month billed annually, or
      $125 monthly);
    - enterprise plans in eligible markets.
  - Adults only. Not available in the EEA, the UK or Switzerland.
  - The launch included an extra allowance for deeper work, expanded during the first month.
  - Business, enterprise and education data is not used for training by default. On personal
    plans, the account's training setting decides. The vendor says it does not train directly
    on proactive research or private notes.
  - There is no public API or SDK for APP-4. The nearest extension points are plugins and the
    vendor's general agents API, which press says gained computer use at the same launch
    event.
evidence:
  - type: doc
    ref: APP4/doc/announcement
  - type: doc
    ref: APP4/doc/help-plan-tiers
  - type: doc
    ref: APP4/doc/help-getting-started
  - type: doc
    ref: APP4/doc/help-privacy-faq
  - type: press
    ref: press/cnbc-devday
  - type: press
    ref: press/infoq-devday
confidence: medium
limits: >
  The pricing, market and privacy pages returned HTTP 403, so these points come from search
  excerpts. The teardown does not record the source of the age and region limits. "No API"
  is absence of evidence. Later per-agent paid pricing is reported but unconfirmed.
```

```yaml
id: ER-APP4-021
area: ecosystem / look-alike clones and a fake download
claim: >
  - At least four public open-source repositories imitating APP-4 appeared after launch. One
    of them states outright that it is not the vendor's product source.
  - Another public repository offers an "official free download" Windows zip of APP-4.
  - APP-4 has no standalone download; it is used through the host product's apps.
  - The fake download matches a 2026 pattern, described in a cloud-security research note, of
    fake code-hosting repositories that spread information-stealing malware.
  - Nothing from that repository is on the owner's machine.
evidence:
  - type: source
    ref: third-party/lookalike-a
  - type: source
    ref: third-party/lookalike-b
  - type: source
    ref: third-party/lookalike-c
  - type: source
    ref: third-party/lookalike-d
  - type: source
    ref: third-party/lure-repo
  - type: press
    ref: third-party/csa-fakegit-note
  - type: observed
    ref: APP4/obs/no-agent-package
confidence: low
limits: >
  The zip was not downloaded or analysed, so "malware" is inferred from the pattern. The
  clones' code was not reviewed.
```

```yaml
id: ER-APP4-022
area: scope / no continuous screen or audio capture
claim: >
  - No evidence was found that APP-4 records the user's screen or audio continuously.
  - Its documented inputs are:
    - user messages (text, voice calls, Slack, Teams);
    - data from connected-app plugins;
    - read-only proactive research;
    - events from plugins that support them;
    - the cloud browser;
    - the connected computer, only when a task needs it.
  - A secondary explainer notes that the OS camera, microphone and screen permissions belong to
    the host app, not to APP-4.
evidence:
  - type: doc
    ref: APP4/doc/overview
  - type: doc
    ref: APP4/doc/computers-and-apps
  - type: press
    ref: third-party/flaviocopes-explainer
confidence: low
limits: >
  This is absence of evidence. The desktop client bundles a computer-use plugin
  (ER-APP4-001), which sees the screen during a task. That is not continuous capture.
```

---

## Divergences from the current spec (inputs for RECONCILIATION.md, not decisions)

| Nova doc today | Finding | Evidence |
| --- | --- | --- |
| `docs/09` §2: runs are bounded by `max_steps = 60`, `max_wall_clock = 60 min` and a token cap; exceeding them pauses the run | A time-budget setting guides how long the agent works, combined with reasoning effort. It was evaluated with simulated budgets from 4 minutes to one year, plus a clock tool that can wait. | ER-APP4-007, 019 |
| `docs/09` §6–7: work starts from cron/interval schedules, event triggers or user messages | The agent picks its own next wake-up, alongside saved schedules and plugin triggers | ER-APP4-008 |
| `docs/09` §7, FR-056: triggers watch Slack channels, email labels, file changes, webhooks and polled connectors | Triggers fire only for plugins that declare event support. Adding the agent to a Slack channel does not make it watch. | ER-APP4-008 |
| FR-081, `docs/11` §2.3: one connected computer at a time. But `docs/21` §7 and `docs/23` §4 let agents use browser and screen modules on any registered device. | Exactly one personal computer per agent, granted from the agent's profile and separate from other local-access grants. The desktop client must stay open, with a client-version floor. | ER-APP4-003, 004 |
| `docs/23` §1–2, §9: local execution through `novad`, a system service using mTLS to the Hub | Local execution through the desktop client: a local executor registers outbound with the backend. Probably (low) via a rendezvous relay like APP-3's remote exec-server. | ER-APP4-004, 005 |
| `docs/11` §10: when a site blocks automation, report it and ask for a handoff or takeover | Falls back to the user's own browser on the connected computer | ER-APP4-003 |
| `docs/12` §2: deterministic order of built-in safety, then managed policy, custom rules, per-tool/plugin rules and mode defaults. Auto-review sits under prompt-injection defence (§6). | Four layers: built-in safeguards, then per-action plugin permissions, then a model-based Auto-review, then custom rules | ER-APP4-014 |
| FR-085, `docs/12` §6: auto-review (classifier plus rules) decides proceed, ask or hand off | A separate reviewer model with an agent-specific policy. On an unsafe verdict it blocks, tells the acting model, and tells it to avoid similar actions. Measured by recall on six threat categories and by denial rate on real traffic. | ER-APP4-015 |
| `docs/12`: no rule about engaging other agents | The confirmation policy limits engagement with agents outside the vendor's ecosystem unless the user asks. The policy gets higher priority in the agent harness. | ER-APP4-015, 019 |
| FR-088, `docs/13` §4: every channel's messages land in the same thread | Same agent and notes in every channel, but each channel keeps its own message history | ER-APP4-010 |
| FR-089: notes are user-visible and editable, and items can be forgotten | Notes are reportedly not viewable or editable; deleting the agent is the only reset (low). Switching off host memory does not remove copies. | ER-APP4-011 |
| FR-082, `docs/09` §8: proactive research runs hourly by default and after events | Runs when idle and writes results to private notes. Tested against misleading proactive inputs (0 of 151). | ER-APP4-009, 018 |
| `docs/09` §9: Pause checkpoints the agent and stops scheduling | Pause stops only the main task. Deleting the agent is irreversible and does not undo actions already taken. | ER-APP4-016 |
| FR-059: delegation is Work to Code only. FR-083 covers fan-out. | The agent delegates to subagents, delegated-work tasks and coding tasks (cloud, local, or continuing existing threads), and edits the work mode's schedules. Delegated tasks bill to their own quotas. | ER-APP4-006 |
| FR-031: voice in any mode. `docs/13` §4 lists no voice channel. | Voice calls are a channel; calls started by the agent are announced for after launch | ER-APP4-012 |
| FR-079 and the `docs/06` `agent` table set no per-account limit | One primary agent per user. Role-specific agents are provisioned by admins (preview). Teams of agents are planned. | ER-APP4-001, 006, 016 |
| FR-106, `docs/12` §10: managed-policy keys for modes, tools, plugins, network and appearance | Separate admin switches for agent capabilities (Slack, custom rules, local access, cloud browser, network, computer use, password manager). Enterprise model controls do not apply. | ER-APP4-016 |
| FR-045, `docs/08` §3: a plugin is skills, MCP servers and optional UI | Plugins also carry browser extensions and hooks. Hooks do not run in cloud orchestration. | ER-APP4-013 |
| FR-123, `docs/16` §5: a generic security suite | Persistence-specific evals: permission changes mid-task, scope drift across chained tasks (it roughly doubles with chain length), misleading proactive inputs, behaviour across time budgets, and engagement with outside agents | ER-APP4-017..019 |
| `docs/24`, FR-151: ambient screen and audio capture (track N1) | APP-4 has no continuous capture. Nova goes beyond APP-4 here. | ER-APP4-022 |
| `docs/15` §3, FR-133: signed builds | Fake "official download" repositories and look-alike clones appeared within weeks of launch | ER-APP4-021 |
