# Nova configuration — layers, roles, and the personal pack
Owner direction + Muse design, 2026-11-03. Design input; build
slots after the wiring workstream (Skills page R4 is its door).

## 1. Three layers — NOT combined (owner asked; this is the call)
- **L0 Defaults** — ship inside Nova, versioned with releases,
  READ-ONLY at runtime. A new install is fully usable on
  defaults alone. Because nobody edits L0, an upgrade can
  replace it wholesale and can never clobber a user's setup.
- **L1 Instance (global)** — one per hub: devices and their
  roles, services, hub privacy posture, shared connectors,
  household membership. Set by the instance owner/admins.
- **L2 User pack** — one per person on the instance: everything
  personal (below). On a single-user instance L1 and L2 are
  both "yours" but stay separate: the pack must be exportable
  to another instance without dragging machine settings along.
Resolution: per-key overlay, L2 > L1 > L0. Every effective
value in Settings shows which layer set it (and Discuss-in-
context edits the layer that owns the key). Reset = delete the
overlay key; the default shines through again. Config changes
are ledger events with diffs — config is part of the receipts.

## 2. Roles (owner: "Roles too!")
- **Device roles** (exist; pairing-time, multi-select): thin
  client, hub candidate, compute, storage, capture source,
  general server.
- **User roles** (new, for multi-user instances): Owner
  (instance root; the only role that changes L1 membership),
  Admin (L1 settings, no membership changes), Member (own L2
  only), Guest (named shared surfaces only, no memory access).
- Hard boundary: one user's memory, mail, capture, and vault
  references are invisible to every other user, admins
  included. Shared things (household devices, shared boards)
  are shared because L1 says so, explicitly, item by item.

## 3. What L0 defaults contain (every install)
Orb-teal design package; semantic orb states; privacy posture
= balanced with local-only available and honoured; approval
tier tables as designed; notification service with quiet hours
22:00–07:00 and the Jev interrupt gate ON; morning board with
generic starter items (day brief, inbox triage, held items);
scout ON in Recommend tier; starter skills (§5); charter
defaults (no manufactured work/progress, plain-language
answers, anti-flattery). Nothing person-specific, ever.

## 4. A user pack — Jeremy's v1 (the worked example)
- **Morning board**: yesterday's standup draft + timecard
  skeleton from capture (numbers rule: standups may carry
  ticket/MR numbers, timesheets none; "delivered" only for
  merged work; 30-min increments rounded up); mail triage
  summary; today's calendar shape; held/problems digest.
- **Inbox module** (owner requirement): a scheduled review
  automation that reports (a) what's important and WHY (sender,
  thread state, deadline extracted — reasons, not just scores);
  (b) an ACTION LOG — receipts for everything Nova did: drafts
  created (drafts only; sending is a tiered owner act), deletes
  (to trash, batched, listed, undoable in the report window —
  an explicit owner instruction outranks any standing "never
  delete" policy), labels/moves per the owner's label scheme.
  Nothing happens to mail without a line in the log.
- **Career module** (owner requirement): (i) Job watch on the
  owner's standing filters (fully remote; DevOps/SRE/Platform
  IC; $150k+; established companies; no Kubernetes-core roles),
  deduped against the owner's tracker; each match graded with
  a written fit case (strengths, gaps stated honestly — no
  Kubernetes experience, Ansible beginner, certifications are
  study targets only, never presented as skills). (ii) Default
  resume kept current from the accomplishments log; per
  opportunity graded a good fit: tailored resume + cover
  letter + talking points + job summary/why-fit note, filed in
  the owner's per-company/per-role folder structure, delivered
  as real .docx/.PDF. (iii) Accomplishments engine: continuous
  collection from Jira, GitLab/GitHub, and capture
  (Screenpipe today, Nova native capture when it lands),
  under evidence rules — completed work only, sanitised across
  client boundaries, never fabricated — feeding the resumes,
  the portfolio site, and standups.
- **Connectors**: the pack lists which connectors are on
  (Gmail, Calendar, GitHub/GitLab, Jira, Instagram, Finances…)
  with per-connector scopes; keys live in the vault behind the
  broker, the pack holds references only.
- **Devices**: his roster with roles (Dell = compute/capture,
  mini-PC = hub/storage, MacBook = compute, phones = thin
  client/capture).
- **Personal rules**: anti-sycophancy charter; proactive hours
  09:00–21:30 ET; betting collaboration rules (DraftKings NFL,
  singles default, stake/profit/payout always shown).

## 5. Skills and rules Nova ships / can install
Install path is the scout's tiers (Recommend → Build →
Install-on-approval); nothing installs silently, ever.
- **ponytail** (owner, 2026-11-03: "a skill I want") — first in
  the evaluation queue; coding minimalism/YAGNI discipline for
  Nova's coding agents. Evaluate against the standard, then
  install on the owner's word (given).
- Starter candidates for the same evaluation: verify-before-
  completion (no "done" without evidence), systematic
  debugging (root cause before fixes), skill-authoring-to-the-
  open-standard, research-with-citations, the design slop gate
  (already a rule for UI PRs — becomes a skill), email triage
  (the pattern behind §4's inbox module, generalised).
- Rules (not skills — always on): deletion holds in backups;
  local-only never falls back to cloud; tier discipline for
  approvals; no silent installs; plain-language ledger entries.

## 6. Open for the owner (not blocking the design)
Pack storage: git-backed (diffable history) recommended.
Household/multi-user: build L2 separation now, ship Guest
role later? Career module: pack module (recommended) vs.
separate product surface.
