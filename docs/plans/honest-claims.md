# Honest claims: user-facing copy matches the evidence (owner decision, 2026-10-31)

Branch `copy/honest-claims`. The owner's decision, verbatim:

> THE 17 UNPROVEN CLAIMS. Both, split by audience:
> - Any claim a USER can see (UI copy, onboarding, docs aimed at users) gets SOFTENED NOW to what
>   the evidence supports. The Amendment B closing rule is not deferred: unproven capability claims
>   do not stand in user-facing text while evals are pending.
> - All 17 go into the eval harness backlog (Track 3) as named eval cases, prioritised by how
>   load-bearing the claim is, each marked with the claim it would prove. When an eval passes, the
>   strong wording may return, citing the eval.
> - Internal design docs keep the claims but mark them UNPROVEN inline, so nobody quotes them as
>   settled.

(The register counted 18 unbacked claims; the owner's "17" is the same list.)

## 1. How the copy was softened

The rules for every rewrite:
- **Absolutes go.** "Never", "every", "always", "nothing leaves" and "encrypted" stay only where a
  regression eval backs them.
- **Structural facts stay.** For example, Gmail has no tool to send or delete.
- **Conditions are named.** For example, "unless you've switched that on".
- **Settings are described, not outcomes guaranteed.** For example, "starts turned off" instead of
  "nothing is captured".
- **No feature changed.** Only words did, in DESIGN-SYSTEM's plain voice.

**The false claim.** "Every shell command waits for the person's approval before it runs"
(`system/system_prompt.md:4`) now says what the code does. A command asks unless
`~/permissions.md` lets commands run without asking, and a command that follows outside content
asks even then. The same false claim was in the exec tool's doc (`src/tools.js`) and the workspace
README template. It also had a cousin in the model's briefing: "Anything that can't be undone
always asks" (`src/core/self.ts`). The irreversible check only adds a confirm to a card, and with a
yes in permissions.md no card is shown.

**Model-facing text counts.** The system prompt, the briefing and the tool docs are repeated to the
person, so they were softened too. One register entry is an instruction to the model, not a claim
to the person: "Never promise to check back or remind them later unless a schedule will do it". It
stays as it is, with its eval named (`claim.no-promise-without-schedule`). Softening an instruction
would change behaviour, not words.

**Backed by the narrower words.** Three privacy claims now say what
`privacy.local-only-stays-local` shows, "Model calls stay on your own devices", so the suite backs
them (`local-only-privacy`):
- `privacy.never-falls-back-to-cloud`;
- `setup.local-only-nothing-leaves`;
- and their copies.

Their strong words wait for `claim.local-only-no-cloud-fallback` and
`claim.local-only-nothing-leaves`.

## 2. Every claim, old and new

Line numbers are the new text's. P is the priority: 1 for safety, privacy and approvals; 2 for a
capability the person relies on; 3 for the rest.

### The register’s 18 unbacked claims (and the partly backed local-only one)

| id | where | was | now | eval | P |
|---|---|---|---|---|---|
| `sites.no-passwords-in-chat` | `ui/js/sites.js:48` | “Never type a password into chat. Nova never asks for one there.” | “Never type a password into chat; save it here instead.” | `claim.never-asks-for-site-password` | 1 |
| `prompt.no-promise-without-schedule` | `system/system_prompt.md:8` | “(kept: an instruction to the model)” | “Never promise to check back or remind them later unless a schedule will do it” | `claim.no-promise-without-schedule` | 3 |
| `setup.change-by-telling` | `src/core/setup.ts:182` | “you can change any answer later just by telling me” | “you can change most answers later in Settings” | `claim.setup-answers-change-by-telling` | 3 |
| `setup.checks-its-welcome-note` | `src/core/setup.ts:197` | “I’ll write a short welcome note into your workspace and check it myself.” | “I’ll write a short welcome note into your workspace. (Yes or no.)” | `claim.setup-welcome-note-verified` | 3 |
| `memory.read-before-reply` | `ui/js/view.js:495` | “Nova reads this before every reply.” | “Nova uses this in its conversations with you.” | `claim.memory-recalled-next-conversation` | 2 |
| `readme.forget-every-backup` | `README.md:190` | “Forgetting something removes it from every backup too” | “Forgetting something is carried into Nova's backups too” | `claim.forget-reaches-backups` | 1 |
| `setup.local-only-nothing-leaves` | `src/core/setup.ts:194` | “Local-only means nothing leaves this machine.” | “Local-only means my model calls stay on your own devices.” | `claim.local-only-nothing-leaves` | 1 |
| `privacy.never-falls-back-to-cloud` | `ui/js/surfaces.js:422` | “Nothing leaves this machine. Never falls back to the cloud.” | “'Local-only', 'Model calls stay on your own devices.'” | `claim.local-only-no-cloud-fallback` | 1 |
| `setup.local-only-chat-off` | `src/core/setup.ts:192` | “With local-only, chat stays off until you add a local model; everything else works.” | “With local-only, chat stays off until you add a local model.” | `claim.local-only-everything-else-works` | 3 |
| `connections.vault-encrypted` | `ui/js/connections.js:76` | “Their passwords and tokens stay in Nova’s vault, encrypted.” | “Their passwords and tokens are kept in Nova’s vault.” | `claim.vault-encrypted-at-rest` | 1 |
| `capture.nothing-until-on` | `ui/js/capture.js:176` | “Nothing is captured until you turn a source on, and the top bar shows whenever anything is. Capture stays on your own devices.” | “Each source starts turned off, and the top bar shows when capture is on. What is captured is kept on your own devices.” | `claim.capture-nothing-before-consent` | 1 |
| `approvals.outside-changes-ask` | `ui/js/view.js:861` | “Everything Nova can do that changes something outside the conversation asks you first.” | “Each kind of step that changes something outside the conversation starts at Ask first.” | `claim.outside-changes-ask-first` | 1 |
| `prompt.every-command-approved` | `system/system_prompt.md:4` | “Every shell command waits for the person's approval before it runs.” | “A shell command waits for the person's approval before it runs, unless ~/permissions.md lets commands run without asking; a command that follows outside content asks even then.” | `claim.untainted-command-asks-by-default` | 1 |
| `schedules.work-on-its-own` | `ui/js/view.js:711` | “Work Nova does on its own, at times you choose.” | “Work you set Nova to do at times you choose.” | `claim.schedule-runs-unattended` | 2 |
| `gmail.read-draft-organize` | `ui/js/view.js:548` | “Nova can read your mail, save drafts and organize it: archive, labels, read or unread. It never sends or deletes anything, and every change waits for your OK” | “With Gmail connected, Nova has tools to read your mail, save drafts and organize it” | `claim.gmail-read-draft-organize` | 2 |
| `gmail.asks-before-online` | `connectors/gmail/CONNECTOR.md:25` | “Once mail has been read in a conversation, Nova asks the person before going online for the rest of it” | “After mail has been read, Nova's outbound guard asks the person before a request that would carry something of theirs out.” | `claim.outbound-guard-after-mail` | 1 |
| `readme.helpers` | `README.md:101` | “Nova can hand a long piece of work” | “Nova has a `delegate` tool for handing a long piece of work” | `claim.helper-runs-and-reports` | 2 |
| `models.recommends-per-job` | `ui/js/models.js:98` | “Here is what each can do, and what Nova recommends for each job.” | “Here is what each can do, with a suggested model for each job.” | `claim.model-recommendation-fits-job` | 2 |
| `readme.never-edits-itself-live` | `README.md:115` | “Nova never edits itself live.” | “Changes to Nova don't go straight into the running copy.” | `claim.change-pipeline-before-live` | 2 |

### Extra claims found, softened and registered

| id | where | was | now | eval | P |
|---|---|---|---|---|---|
| `capture.forget-for-good` | `ui/js/capture.js:285` | “It is deleted here, from backups and from the standby, and Nova won’t take it in again.” | “Nova deletes it here and passes the forget on to its backups and the standby, so it isn’t taken in again.” | `claim.forget-reaches-backups` | 1 |
| `readme.forget-no-copy` | `README.md:44` | “so a forgotten memory leaves no copy behind” | “so a forgotten memory leaves no copy in that history” | `claim.forget-leaves-no-copy` | 1 |
| `memory.dropped-candidate` | `ui/js/app.js:1006` | “Dropped. Nova never saw it.” | “Dropped. It isn’t in Memory.” | `claim.dropped-candidate-unseen` | 2 |
| `skills.removed-nothing-left` | `ui/js/app.js:1108` | “Removed ${name}. Nothing of it is left.” | “toast(`Removed ${name}.`, { undo: true });” | `claim.removed-skill-leaves-nothing` | 3 |
| `skills.remove-leaves-nothing` | `ui/js/view.js:617` | “removing it leaves nothing behind.” | “removing it deletes its folder.” | `claim.removed-skill-leaves-nothing` | 3 |
| `setup.local-only-summary` | `src/core/setup.ts:69` | “'local-only': 'everything stays on your devices'” | “'local-only': 'my model calls stay on your devices'” | `claim.local-only-nothing-leaves` | 1 |
| `approval.privacy-row` | `ui/js/components.js:357` | “'local-only': 'Nothing leaves this machine.'” | “'local-only': 'Model calls stay on your own devices.'” | `claim.local-only-nothing-leaves` | 1 |
| `briefing.local-only` | `src/core/self.ts:379` | “(local-only: nothing leaves your devices;” | “(local-only: model calls stay on your devices;” | `claim.local-only-nothing-leaves` | 1 |
| `computer.local-only-refusal` | `src/core/computer/index.ts:558` | “your Nova is local-only: nothing leaves this machine, so the command didn’t run.” | “your Nova is local-only, so the command didn’t run.” | `claim.local-only-nothing-leaves` | 1 |
| `models.no-cloud-everything-local` | `src/core/models/index.ts:1165` | “No cloud model is set, so everything runs on your devices.” | “'No cloud model is set here.'” | `claim.no-cloud-model-all-local` | 1 |
| `setup.local-preferred-always-says` | `src/core/setup.ts:70` | “local first, cloud only when local can’t do it, and I’ll always say when” | “local first, cloud only when local can’t do it, and each cloud call is recorded” | `claim.local-first-says-when-cloud` | 2 |
| `sites.vault-encrypted-one-site` | `ui/js/sites.js:41` | “Sign-ins stay in Nova’s vault, encrypted, and are typed only into the site they belong to.” | “Sign-ins are kept in Nova’s vault, each saved for the site it belongs to.” | `claim.sign-in-typed-only-on-its-site` | 1 |
| `gmail.secret-location` | `connectors/gmail/CONNECTOR.md:29` | “what Nova keeps stays in `~/connectors/gmail/`, outside history, and Nova never shows it to you.” | “what Nova keeps is in Nova's vault, outside history, and isn't shown to you.” | `claim.gmail-secret-not-shown` | 1 |
| `devices.computer-cant-read` | `ui/js/components.js:214` | “It can’t read your conversations.” | “It isn’t given your conversations.” | `claim.device-agent-cant-read-conversations` | 1 |
| `setup.capture-sees-nothing` | `src/core/setup.ts:15` | “I see nothing on your devices unless you turn capture on in Settings › Capture.” | “Capture is off until you turn a source on in Settings › Capture.” | `claim.capture-nothing-before-consent` | 1 |
| `capture.local-only-pull` | `src/core/capture/capture.ts:878` | “Your privacy setting is local-only, and capture stays on your own devices, so Nova won’t pull from it.” | “Your privacy setting is local-only, so Nova won’t pull capture from outside your devices.” | `claim.capture-stays-on-devices` | 1 |
| `tools.exec-approved` | `src/tools.js:121` | “The user approves every command before it runs.” | “The user approves each command before it runs, unless permissions.md lets commands run without asking.” | `claim.untainted-command-asks-by-default` | 1 |
| `workspace.commands-with-approval` | `templates/home/workspace/README.md:4` | “Commands Nova runs (with your approval) start in this folder.” | “Commands Nova runs (with your approval, unless you let commands run without asking) start in this folder.” | `claim.untainted-command-asks-by-default` | 1 |
| `prompt.outside-changes-wait` | `system/system_prompt.md:6` | “waits for the person's OK on a card that shows exactly what will happen, so write” | “asks for the person's OK on a card that shows exactly what will happen, unless ~/permissions.md lets that kind of step go ahead” | `claim.outside-changes-ask-first` | 1 |
| `tools.drafts-approved` | `src/tools.js:205` | “The person approves every draft.” | “The person approves each draft, unless permissions.md lets drafts go ahead.” | `claim.outside-changes-ask-first` | 1 |
| `tools.organize-approved` | `src/tools.js:217` | “The person approves every change. Nothing is deleted.” | “The person approves each change, unless permissions.md lets changes go ahead.” | `claim.outside-changes-ask-first` | 1 |
| `tools.schedules-approved` | `src/tools.js:239` | “The person approves every schedule.” | “The person approves each schedule, unless permissions.md lets schedules go ahead.” | `claim.outside-changes-ask-first` | 1 |
| `context.schedules-approved` | `src/context.js:44` | “the person approves both. Before” | “the person approves both, unless permissions.md lets them go ahead” | `claim.outside-changes-ask-first` | 1 |
| `skills.runs-still-ask` | `ui/js/view.js:630` | “Anything a skill would run still asks you first.” | “Anything a skill would run follows the same switches in Settings › Without asking.” | `claim.outside-changes-ask-first` | 1 |
| `readme.skills-still-ask` | `README.md:58` | “anything it would run still asks first” | “anything it would run follows the same switches in Settings as everything else” | `claim.outside-changes-ask-first` | 1 |
| `readme.switches-anywhere` | `README.md:96` | “switched on, Nova does that without asking, anywhere, and Activity shows each time” | “switched on, Nova does that without asking, and Activity shows each time. A command that follows outside content still asks.” | `claim.untainted-command-asks-by-default` | 1 |
| `briefing.irreversible-always-asks` | `src/core/self.ts:257` | “Anything that can’t be undone always asks.” | “When a step asks, one that looks like it can’t be undone needs an explicit confirm.” | `claim.irreversible-step-asks` | 1 |
| `card.outside-always-asks` | `ui/js/view.js:147` | “After reading something from outside, Nova always asks first.” | “After reading something from outside, Nova asks first for this.” | `claim.outbound-guard-asks` | 1 |
| `ha.asks-every-time` | `src/core/connectors/home-assistant.ts:361` | “'Turn things on and off, after asking you first, every time.'” | “'Turn things on and off, after asking you first.'” | `claim.home-changes-ask-first` | 1 |
| `gmail-connector.organize-asks` | `src/connectors/gmail-connector.js:65` | “'Archive, label and mark messages read or unread, after asking.'” | “Archive, label and mark messages read or unread, after asking, unless you turn that off in Settings.” | `claim.outside-changes-ask-first` | 1 |
| `automations.nothing-unlisted` | `ui/js/surfaces.js:404` | “Nothing runs that isn’t listed here” | “Rules Nova runs on its own. Each can be paused or removed.” | `claim.nothing-runs-unlisted` | 2 |
| `readme.gmail` | `README.md:61` | “Email summary reads your mail, saves drafts and organizes it” | “Email summary has tools to read your mail, save drafts and organize it” | `claim.gmail-read-draft-organize` | 2 |
| `gmail.connector-about` | `connectors/gmail/CONNECTOR.md:3` | “Nova reads it, saves drafts and organizes it; it never sends or deletes.” | “it has no tool to send or delete.” | `claim.gmail-read-draft-organize` | 2 |
| `gmail.connector-every-draft` | `connectors/gmail/CONNECTOR.md:9` | “Every draft and every change waits for the person's OK” | “Each draft and change asks for the person's OK on a card that shows exactly what will happen, unless ~/permissions.md lets it go ahead.” | `claim.outside-changes-ask-first` | 1 |
| `skills.email-never-sends` | `skills/email-summary/SKILL.md:3` | “It never sends anything.” | “It has no way to send mail.” | `claim.gmail-read-draft-organize` | 2 |
| `skills.shopping-never-buys` | `skills/shopping/SKILL.md:3` | “It never buys anything.” | “It researches; you buy.” | `claim.shopping-never-buys` | 2 |
| `readme.helpers-wait` | `README.md:105` | “waits for you on any step that needs your OK” | “takes only the steps Settings lets it take without asking” | `claim.helper-runs-and-reports` | 2 |
| `readme.self-writes-wait` | `README.md:120` | “Anything Nova writes for itself waits for your confirmed OK, every time.” | “Anything Nova writes for itself is set to wait for your confirmed OK.” | `claim.change-pipeline-before-live` | 1 |
| `changes.every-change-tried` | `ui/js/changes.js:100` | “Every change to Nova is tried on a copy first” | “A change to Nova goes through these steps: tried on a copy first, tested, released as a version, and watched live before it stays.” | `claim.change-pipeline-before-live` | 2 |
| `tasks.nothing-done-unchecked` | `ui/js/surfaces.js:163` | “Nothing is done until Nova has checked the evidence” | “A task shows Verified only after Nova has checked its evidence” | `claim.verified-only-with-evidence` | 2 |
| `setup.always-says-wrong` | `src/core/setup.ts:188` | “I’ll always tell you when I think something’s wrong” | “Telling you when I think something’s wrong isn’t adjustable.” | `claim.says-when-something-wrong` | 3 |
| `settings.always-says-wrong` | `ui/js/surfaces.js:435` | “Nova always says when it thinks something’s wrong” | “Telling you when Nova thinks something’s wrong isn’t adjustable; this is how it says it.” | `claim.says-when-something-wrong` | 3 |

### Reviewed and kept

These are accurate by construction:
- **Status lines read from live state:** "no sources set up; Nova sees nothing on your devices"
  (`src/core/self.ts`) is said only when no source exists.
- **Setup's first-task card:** "Your first task, checked by Nova:" (`ui/js/setup.js:55`) shows only
  for a task that reached done, which needs verification, with the evidence beside it.
- **Gmail's "never" list** (Send email, Delete email; `src/connectors/gmail-connector.js`): there is
  no tool for either.
- **Home Assistant's "never" list:** every service call is a ledger task at tier 2 or 3. It lost
  "every time" from its "can" line, since standing approvals exist.
- **Code comments and API route summaries:** they are not shown to the person. One false comment
  in `src/tools.js` ("exec … always asks first") was corrected anyway.
- **Rules and requirements in the packet** (OPERATING-RULES' "local-only never falls back", the
  smart-home plan's tiers): they state what must hold, not what holds today.

## 3. Internal docs marked UNPROVEN

Each mark is inline: `**UNPROVEN** (no eval yet: claim.<slug>)`. The owner's verbatim inputs are
untouched: `INPUT-*`, `AMENDMENT-*`, the `nova-*-design-*.md` notes and the research docs.

| File | Where | Claim | Eval |
|---|---|---|---|
| `docs/builder-packet/CAPABILITY-INVENTORY.md` | Memory row | "real forgetting (including backups)" | `claim.forget-reaches-backups` |
| `docs/builder-packet/CAPABILITY-INVENTORY.md` | Capture row | "consent off by default per source and per device" | `claim.capture-nothing-before-consent` |
| `docs/builder-packet/CAPABILITY-INVENTORY.md` | Local models row | "one recommendation per role … with the trade-off in words" | `claim.model-recommendation-fits-job` |
| `docs/builder-packet/CAPABILITY-INVENTORY.md` | Local models row | "local-only never reaches the cloud (…)" | `claim.local-only-no-cloud-fallback` |
| `docs/builder-packet/CAPABILITY-INVENTORY.md` | Gmail row | "the same reads, drafts and organizing, never sending or deleting" | `claim.gmail-read-draft-organize` |
| `docs/builder-packet/CAPABILITY-INVENTORY.md` | Backups row | "forgetting carried into both" | `claim.forget-reaches-backups` |
| `docs/builder-packet/CAPABILITY-INVENTORY.md` | Vault row | "AES-256-GCM at rest in `home/vault/` (0600)" | `claim.vault-encrypted-at-rest` |
| `docs/plans/M7.md` | Requirements | "Forgetting holds in backups, as M2 established." | `claim.forget-reaches-backups` |
| `docs/plans/M7.md` | As built | "A forget reaches every folder Nova ever backed up to." | `claim.forget-reaches-backups` |
| `docs/plans/M5.md` | As built (M5b) | the vault, "AES-256-GCM over the name → value map …" | `claim.vault-encrypted-at-rest` |
| `docs/plans/M5.md` | As built (M5b) | "Era 2's Gmail unchanged in behaviour, its secrets in the vault" | `claim.gmail-secret-not-shown` |
| `docs/plans/vault-broker.md` | The store, today | "`src/core/vault.ts`: one AES-256-GCM file" | `claim.vault-encrypted-at-rest` |
| `docs/plans/vault-broker.md` | Where values are today | "all values in one AES-256-GCM file" | `claim.vault-encrypted-at-rest` |

## 4. The register and the closing rule

- **The register, `tests/evals/claims.ts`.** Each softened claim records four things:
  - its new words (`text`), re-found in its file;
  - its old strong words (`strong`), which must not be in its file;
  - the eval case that would prove them (`eval`, `claim.<slug>`);
  - a priority.

  An instruction to the model is `kind: 'instruction'`. It is reported, and the closing rule
  doesn't apply to it.
- **The report, `checkClaims`.** It sorts each claim as backed, softened, instruction, unbacked or
  drift. A softened claim whose strong words come back without an eval backing them is drift. The
  report now reads: 71 claims, 16 backed, 54 softened, 1 instruction, **0 unbacked in user-facing
  text**. The full report is in `docs/evidence/evals.md`.
- **The closing rule, `tests/core/evals.test.ts`.** This is the eval plan's NOTES §4, turned on
  for user-facing copy. CI fails when:
  1. any claim in the register is unbacked and not softened;
  2. any softened claim's strong words appear in any user-facing file (`USER_FACING`), not only
     its own. These files are:
     - the README;
     - the system prompt, setup, the briefing, the charter and the tool docs;
     - the connector manifests;
     - every file under `ui/`, `connectors/`, `skills/` and `templates/`.
- **When an eval passes,** its tag goes in the claim's `needs` and the strong words may return. The
  check then finds them backed.

### Track 3's backlog: the named eval cases, by priority

| eval case | P | would prove |
|---|---|---|
| `claim.capture-nothing-before-consent` | 1 | `capture.nothing-until-on`, `setup.capture-sees-nothing` |
| `claim.capture-stays-on-devices` | 1 | `capture.local-only-pull` |
| `claim.change-pipeline-before-live` | 1 | `readme.never-edits-itself-live`, `readme.self-writes-wait`, `changes.every-change-tried` |
| `claim.device-agent-cant-read-conversations` | 1 | `devices.computer-cant-read` |
| `claim.forget-leaves-no-copy` | 1 | `readme.forget-no-copy` |
| `claim.forget-reaches-backups` | 1 | `readme.forget-every-backup`, `capture.forget-for-good` |
| `claim.gmail-secret-not-shown` | 1 | `gmail.secret-location` |
| `claim.home-changes-ask-first` | 1 | `ha.asks-every-time` |
| `claim.irreversible-step-asks` | 1 | `briefing.irreversible-always-asks` |
| `claim.local-only-no-cloud-fallback` | 1 | `privacy.never-falls-back-to-cloud` |
| `claim.local-only-nothing-leaves` | 1 | `setup.local-only-nothing-leaves`, `setup.local-only-summary`, `approval.privacy-row`, `briefing.local-only`, `computer.local-only-refusal` |
| `claim.never-asks-for-site-password` | 1 | `sites.no-passwords-in-chat` |
| `claim.no-cloud-model-all-local` | 1 | `models.no-cloud-everything-local` |
| `claim.outbound-guard-after-mail` | 1 | `gmail.asks-before-online` |
| `claim.outbound-guard-asks` | 1 | `card.outside-always-asks` |
| `claim.outside-changes-ask-first` | 1 | `approvals.outside-changes-ask`, `prompt.outside-changes-wait`, `tools.drafts-approved`, `tools.organize-approved`, `tools.schedules-approved`, `context.schedules-approved`, `skills.runs-still-ask`, `readme.skills-still-ask`, `gmail-connector.organize-asks`, `gmail.connector-every-draft` |
| `claim.sign-in-typed-only-on-its-site` | 1 | `sites.vault-encrypted-one-site` |
| `claim.untainted-command-asks-by-default` | 1 | `prompt.every-command-approved`, `tools.exec-approved`, `workspace.commands-with-approval`, `readme.switches-anywhere` |
| `claim.vault-encrypted-at-rest` | 1 | `connections.vault-encrypted` |
| `claim.dropped-candidate-unseen` | 2 | `memory.dropped-candidate` |
| `claim.gmail-read-draft-organize` | 2 | `gmail.read-draft-organize`, `readme.gmail`, `gmail.connector-about`, `skills.email-never-sends` |
| `claim.helper-runs-and-reports` | 2 | `readme.helpers`, `readme.helpers-wait` |
| `claim.local-first-says-when-cloud` | 2 | `setup.local-preferred-always-says` |
| `claim.memory-recalled-next-conversation` | 2 | `memory.read-before-reply` |
| `claim.model-recommendation-fits-job` | 2 | `models.recommends-per-job` |
| `claim.nothing-runs-unlisted` | 2 | `automations.nothing-unlisted` |
| `claim.schedule-runs-unattended` | 2 | `schedules.work-on-its-own` |
| `claim.shopping-never-buys` | 2 | `skills.shopping-never-buys` |
| `claim.verified-only-with-evidence` | 2 | `tasks.nothing-done-unchecked` |
| `claim.local-only-everything-else-works` | 3 | `setup.local-only-chat-off` |
| `claim.no-promise-without-schedule` | 3 | `prompt.no-promise-without-schedule` |
| `claim.removed-skill-leaves-nothing` | 3 | `skills.removed-nothing-left`, `skills.remove-leaves-nothing` |
| `claim.says-when-something-wrong` | 3 | `setup.always-says-wrong`, `settings.always-says-wrong` |
| `claim.setup-answers-change-by-telling` | 3 | `setup.change-by-telling` |
| `claim.setup-welcome-note-verified` | 3 | `setup.checks-its-welcome-note` |

35 eval cases.

## 5. Limits

- **The register is curated, not discovered.** The claims came from three sweeps:
  - the eval track's sweep;
  - a search of the UI, onboarding and user docs for the same assertions in other words;
  - a search for other absolutes ("never", "always", "every", "nothing", "encrypted", "only")
    about privacy, approvals, forgetting, capture, mail and changes.

  The closing rule can't find a new claim made in new words. New copy that claims a capability
  needs a register entry, and reviewers hold that.
- **What "backed" means here.** A claim is backed only by a regression eval. Many softened claims
  are true in the code, and unit tests prove it, for example the vault's encryption and forgetting
  carried into backups. They are softened because the eval suite doesn't show them. That is the
  owner's rule, not a finding that they are false. The ones found false or stale say so in their
  register note:
  - the shell-command claim;
  - "anything that can't be undone always asks";
  - the retired "going online after reading mail" switch;
  - the Gmail secret location;
  - the helper "waits for you";
  - "Removed … nothing of it is left", which was shown with an Undo.
- **Some wording was kept as an instruction.** It is the one instruction to the model about promises
  and schedules.

## 6. LEDGER "What changed" (for the coordinator to insert at merge)

**What changed (2026-10-31, honest claims):**
- Nova's screens, setup questions and help text now promise only what Nova's own tests can show.
  For example, Settings says model calls stay on your devices under local-only, not that "nothing
  leaves this machine".
- One sentence was wrong, and it's fixed. Nova told itself that every command waits for your OK. In
  fact a command runs without asking if you've switched that on. A command that comes after Nova
  reads something from outside still asks.
- Nothing works differently. Only the words changed.
- Each stronger promise is written down with the test that would prove it. When that test passes,
  the stronger words can come back.
- A check now stops any new unproven promise in what you read, before it ships.
