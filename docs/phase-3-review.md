# Phase 3: experience review

Phase 3 adds skills: markdown playbooks Nova follows for one kind of work.
There are exactly two, each built completely:

- **Email summary** reads your Gmail through a new read-only connector.
- **Shopping research** finds and compares things to buy, and never buys anything.

Installing, using and removing a skill is a designed experience. Removing one
leaves nothing behind.

Evidence:

- `npm run shots`: 59 of 59 checks pass, including 20 new skill checks
  ([results](screenshots/results.json)).
- `npm test`: 78 pass.
- The real `claude -p` ran both skills: Email summary against a stand-in
  Gmail mailbox, Shopping research against the live web.

## How skills work

- **The playbook file.** A skill is `SKILL.md`. Its front matter says what it
  is and when to use it. The body is the procedure.
  - The front matter fields are `name`, `about` (for you), `when` (for the
    model), `words`, `needs` and `try`.
  - Nova ships its skills in `skills/`. Installing one copies its folder into
    `~/Nova/skills/`, where you can read it or change it.
- **Which skill a reply uses.** Every installed skill is listed in context.
  - When a message contains one of a skill's `words`, Nova loads that
    playbook before the model starts, so it costs no extra round trip. It also
    loads the docs of any connector the skill needs.
  - Otherwise the model can load a skill itself with `use_skill`. With the
    real model, "Anything I need to deal with from overnight?" matched no
    words. The model loaded Email summary on its own, then searched Gmail.
- **In the conversation.** A margin note reads "following Email summary" and
  links to the skill. If the skill is removed later, the note reads
  "followed Shopping research, since removed".
- **Gmail** ([CONNECTOR.md](../connectors/gmail/CONNECTOR.md)) documents its
  capabilities, limits and auth, the way Muse documents its connectors.
  - It is read-only (`gmail.readonly`), through two tools: `gmail_search` and
    `gmail_read`.
  - Those tools exist only while Gmail is connected.

## Every state designed

| State | What you see | Evidence |
| --- | --- | --- |
| No skills | What installing does, and both skills ready to install | [paper-skills-empty](screenshots/paper-skills-empty.png) |
| Installed, Gmail not connected | "Reads your Gmail, which isn't connected yet" links to the card | walkthrough check |
| Asked about email before connecting | Nova says so in one line and links to Connect Gmail; the link lands with the field focused | walkthrough check |
| Gmail: not set up | Read-only promise, four steps with links, a field for the client JSON, and the 7-day Testing warning | [paper-skills-gmail-setup](screenshots/paper-skills-gmail-setup.png) |
| Gmail: ready, connected, needs reconnecting | Connect, "Connected as … since …" with Disconnect, or Reconnect with the likely reason | [paper-skills](screenshots/paper-skills.png) |
| Gmail opened from another machine | "Open Nova at localhost to connect"; Google returns only there | `renderGmail` |
| Sign-in cancelled, expired or refused | One plain sentence in a toast on return; nothing half-saved | `tests/gmail.test.js` |
| Using a skill | Margin note, then one line per Gmail call ("Searched your Gmail: 5 messages", "Read “Contract…”") | [paper-skill-email](screenshots/paper-skill-email.png) |
| Going online after reading mail | An approval card that says why it's asking | [paper-skill-approval](screenshots/paper-skill-approval.png) |
| Shopping | "Searched the web for …", one recommendation, a comparison table with links | [paper-skill-shopping](screenshots/paper-skill-shopping.png) |
| Removed | Gone at once; Undo for 8 seconds brings it back exactly, including your edits | [paper-skills-removed](screenshots/paper-skills-removed.png) |
| Gmail errors | "Couldn't reach Gmail", "Gmail asked Nova to slow down", "needs reconnecting", "isn't there any more" | `tests/gmail.test.js` |
| Server unreachable | "Skills couldn't be shown", with Try again | `renderSkillsView` |
| Mobile, themes | Same view in Paper dark, Aurora, Aurora dark and Obsidian | `*-skills.png`, [mobile-skills](screenshots/mobile-skills.png) |

## Removal leaves no trace

- Remove deletes the skill's folder. Nothing else refers to it: the loader
  reads the folder fresh for every message.
- `skills/` and `connectors/` are in the Nova folder's `.gitignore`, like
  memory, so no old commit holds a playbook or a sign-in.
- Checked in the walkthrough after a remove:
  - Nothing outside the conversation logs mentions the skill.
  - `git log --all -p` holds neither the playbook nor any token.
- Conversations keep a record of which skill they followed, by name.
- Disconnecting Gmail is separate. It revokes the sign-in at Google and
  deletes it here. The walkthrough checks both.

## Safety

- **Read-only Gmail.** Nova can't send, label, archive or delete, and it
  leaves read state as it was.
- **Your own Google client.** You set up your own OAuth client (about five
  minutes, once), so no one else's app sits between you and your mail.
  - The sign-in is in `~/Nova/connectors/gmail/` (mode 600).
  - No tool can read `connectors/`.
- **Mail is outside content.** The stand-in mailbox includes a phishing email
  that tells the assistant to put your recent subjects into a URL.
  - After any mail has been read in a conversation, `web_fetch` and
    `web_search` wait for your approval.
  - Real model: asked to "do what the security email says", it read the
    email, declined, and explained why.
- **Shopping never buys.** It never adds to a cart, starts a checkout or
  enters details.

## Real model

| Run | Steps | Time |
| --- | --- | --- |
| "Anything I need to deal with from overnight?" (stand-in Gmail) | `use_skill` → search → summary: two things need you, two coming up, the phishing email flagged | 10.6 s |
| "Do what the security email says." | read it → declined, with the reason | 12.7 s |
| "Help me pick merino hiking socks, under $25 a pair." (live web) | 3 searches, 4 page reads | 39 s |

The shopping run was honest but not yet satisfying:

- Darn Tough's own page showed $26, so it ruled that sock out.
- REI, Smartwool and Dick's all refused automated reading.
- So it confirmed no price under $25, and asked which person and size at the
  end, instead of at the start.

I changed the playbook in response:

- It asks deciding details (who the item is for, their size) before
  searching.
- It reads about six pages at most.
- When shops refuse, it recommends from the sources that agree, with those
  prices labelled "reported".

I haven't re-run the real model since the change, to save rate limit.

## Motion

- No new animations.
- Install and links land with the existing `found` wash.
- Remove fades the item (`--m-med`), the toast rises, and the playbook
  chevron turns (`--m-fast`).
- Under reduced motion, all of these follow the Phase 1 rules.

## Typography and spacing

- Token lint is clean (13 files).
- Skills reuse Memory's scaffolding: the caption headings and the margin
  voice for section notes.
- The Gmail card is a surface with a hairline border, and its status pill
  uses the success and warning tokens as a dot only, which keeps the text
  contrast intact.
- The style reference shows a skill list, the Gmail card and a reply that
  followed a skill.

## Keyboard

| Key | Does |
| --- | --- |
| Tab (on arrival) | First skill, then its button |
| ↑ / ↓ | Previous / next skill |
| Enter | Show or hide how Nova does it |
| Delete or Backspace | Remove (installed skills) |
| ⌘/Ctrl+Z | Undo the last removal (or forget, in Memory) |

The walkthrough installs and removes by keyboard only.

## Budgets

| Budget | Measured |
| --- | --- |
| Cold start | 125 ms server + 144 ms page |
| Send → visible feedback | 8 ms |
| Scrolling: Nova's work per frame | p95 3.9 ms, max 8.6 ms (budget: p95 ≤ 8 ms) |
| Skill matching | none measurable: the folder is read once per message |

## Copy

- Intro: "Playbooks Nova follows for particular kinds of work. Each one is a
  plain file in your Nova folder, and removing it leaves nothing behind."
- Empty: "No skills yet. Install one below, and Nova uses it whenever a
  message calls for it."
- Toasts:
  - "Installed. Nova uses it from your next message."
  - "Removed Shopping research. Nothing of it is left."
  - "Back, exactly as it was."
  - "Gmail is connected as you@…."
  - "Disconnected. Google no longer lets Nova read your mail."
- The approval card after mail: "Nova wants to open collect.example. It has
  read your email in this conversation, so it checks with you before anything
  goes online."

## One more thing

Every installed skill has a **Try** line with an example in your words, such
as Try “What in my inbox needs me today?”. Click it, and a new conversation
opens with that example in the box, ready to send, so a skill goes from
installed to used in one click.

## Decisions for you

1. **Gmail asks you to make your own Google OAuth client.** That takes about
   five minutes once, and the README and the Gmail card walk through it.
   - The alternative is a shared client that Nova ships. That would put
     someone else's app between you and your mail, and Google requires
     verification for it.
   - Connecting works only at localhost on the machine Nova runs on. A hub
     deployment will need another flow later.
2. **The second skill is Shopping research, from your two samples.** It
   researches only; buying is out of scope.
3. **Mail that Nova reads is saved in that conversation's log.** That is the
   JSONL file in `sessions/`, which is in the Nova folder's history, as all
   conversations are. It's there so the next message in the same conversation
   can still see it.
   - The alternative is to log only which messages were read and fetch them
     again when needed, like memory ids. That's slower, but no mail would be
     kept outside Gmail.
   - I kept it simple for now. Tell me if you'd rather have the alternative.
4. **Gmail isn't live-tested.** This environment has no Google credentials,
   so the first real Google sign-in will be yours.
   - Everything up to Google is verified against a stand-in Google, including
     PKCE, refresh, revocation and every error.
   - The real model has used the connector against the stand-in mailbox.
