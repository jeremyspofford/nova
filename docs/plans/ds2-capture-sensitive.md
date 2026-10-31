# Plan: capture-sensitive, capture screening job 1 (DS2)

**Sources:**
- The owner's decision on screening capture-derived text, `docs/builder-packet/INPUT-2026-10-31-CAPTURE-SCREENING-DECISION.md` (binding), as recorded in the Decision Service ADR §2.1, `docs/plans/decision-service.md`.
- DS1 and DS2 (`docs/plans/ds1.md`, `docs/plans/ds2-ingest-v2.md`), and v2's lessons.
- TypeSafe's Agent Skill and live docs (question-writing rules; the Jev 1.13 jaggedness page: no counting, no numeric judgments).
- The capture code as it is on main: `src/core/capture/` (read, not edited).

**Track:** Track 2, a side PR. It owns the template, its eval and its tests, this plan, and `docs/evidence/capture-sensitive-eval.md`. **There are no consumers yet.** Capture indexing and archiving calling the template, the timeline showing a "sensitive" verdict, and the records are all Track 1's; see **NOTES for Track 1**.

## Order of work

1. **The template and its rule** (this commit): `src/core/decision-service/templates/capture-sensitive.ts`, plus the small service extensions it needs. **No eval case exists yet.**
2. **The eval, before any run:** the cases, manifest, scoring, harness and runner. Its SHA is recorded in the evidence and the verdicts.
3. **The real run** on both Tev1 sizes. The verdicts are recorded. A failure is evidence only, reported plainly.

## What exists in capture today (deterministic), and the gaps

**What exists, all in `rules.ts` and `capture.ts`:**
- **Private and incognito windows** are dropped before anything is stored, recognised by window title in the major browsers' common languages.
- **The person's own exclusions** (by app, site, space or time) keep events out.
- **Pause, per source and for everything.**
- **Retention** (`retention_days`, default 14) deletes old capture.
- **Before a capture item is promoted to memory,** it passes the ingest gate and the `capture-promote` triage.

**The gaps, as NOTES for Track 1 (no capture code is edited here):**
- **No built-in list of sensitive apps.** Password managers and banking apps are excluded only if the person adds them. The owner's decision says known sensitive apps and windows are paused or excluded with no model call "per the capture design". The template carries such a list for its own deterministic step (below), so items from those apps are excluded at indexing even if they were stored. Capture should **drop them at intake**, the way it drops private windows.
- **No secret detection on captured text.** Text is stored as captured, up to 20,000 characters. The template's pattern detectors redact before indexing; storage itself is unchanged.
- **No indexing step separate from promotion.** The decision says job 1 runs "before they are indexed into memory or archived". Today the nearest point is promotion. Where job 1 is called (intake, promotion, and any future archive or index) is Track 1's wiring.

## The template: `capture-sensitive` v1

**Deterministic first** (the owner's decision), in the template's `precheck`, which runs before any model:
1. **A known sensitive app excludes, with no model call at all.** That means a password manager by name (1Password, Bitwarden, LastPass, KeePass, Dashlane, Keeper, Proton Pass, Keychain Access, and others), a banking app (an app whose name has the word "bank"), or a banking site (a host label such as `bank`, `banking` or `…bank`). It is best effort, and the person's own exclusions come first. A known false positive: a food bank's site counts as banking, so it is kept out of the index (conservative).
2. **Pattern detectors run before the model:**
   - cloud access keys, access tokens (GitHub, Slack, Google, Stripe, `sk-`, GitLab), signed tokens (JWT), and private-key blocks;
   - passwords in connection strings, "password is / password: …" and "pin: 1234";
   - card numbers (13–19 digits, **Luhn-valid**), IBANs (**mod-97-valid**), and US social security numbers;
   - a long high-entropy string next to a word that names a secret.

   Whatever they find is **redacted before the model sees the text**. Their outcome, `redact`, stands whatever the model says; the stricter of the two wins. The decision records kinds and positions only, never the matched value.
3. **The model takes the grey area:** secrets, financial details and health details in ordinary prose.

**The questions** (Nouls about `text`, one judgment each, a concrete false situation and boundary cases in the criteria):

| Id | Question |
|---|---|
| `password` | Does `text` show a password? |
| `secret_key` | Does `text` show a secret key for a computer service? |
| `financial_details` | Does `text` show a particular person's financial details? |
| `health_details` | Does `text` describe a particular person's health? |

- **No question counts digits or checks a number's format.** That is code's job (jaggedness: math and numeric representations), which is why cards, IBANs and SSNs are patterns.
- **The state** names the material and the app (`source: "text read from the screen in Notes"`). The app is a fact a person would look at too.

**The rule:** a truth table at TypeSafe's 0.7/0.3 bands, not tuned, with all 81 rows enumerated. It is built for a **privacy screen**, where a missed secret costs more than a false hold:

| Answer | Outcome | Why |
|---|---|---|
| `password` or `secret_key` "yes" | **exclude** | The model can't say where the secret is, so it can't be redacted. The text is kept out of the index and the archive, visibly. |
| `financial_details` or `health_details` "yes" | **hold** | Kept only under capture retention, not indexed into memory, marked sensitive in the timeline |
| any question unsettled | **hold** | When unsure, don't index |
| all "no" | **index** | |

- **Outcomes, least to most restrictive:** index, redact, hold, exclude.
- **Nothing is ever deleted silently** (the decision): every outcome other than index is visible in the timeline (NOTES).
- **When no model is trusted,** the default is **index after the deterministic checks**. That is today's behaviour, plus the app exclusion and pattern redaction this template adds. The alternative, holding everything until a model is trusted, would switch capture's indexing off entirely. That choice is the owner's (open question below).

**Routing** (the decision; the template's `feature: 'capture'`):
- **Local-first and local-only:** never a cloud seat. The screening opt-in doesn't apply to capture.
- **Cloud mode:** cloud Jev only with the capture source's own opt-in, which is off by default and not built yet. So today it is never.
- The service enforces this in `cloudAllowed`, and it is tested.

**Service extensions** (DS1's service, in this commit):
- the `capture` feature and a per-source `captureCloud` hook (absent means never);
- `precheck` on a template: final means no model call; otherwise its outcome and the model's combine, stricter wins, by `policy.order`;
- `findings` (kinds and positions) on the decision and its record.

## The eval (method; cases and SHA in the next commit)

- **Synthetic content only:**
  - placeholder people (Alex Placeholder, Sam Placeholder);
  - card numbers in published test ranges (4242…, 4111…, 5555…);
  - the documented example IBAN (GB82 WEST…);
  - SSNs in the reserved example range;
  - canary keys and tokens (`CANARY…`);
  - invented health notes and finances.

  **No real data and no real secrets.**
- **Case kinds:**
  - **grey-area sensitive:** a password, a secret, financial or health details in prose, with no pattern to catch them. These are the model's cases;
  - **structured:** pattern-shaped secrets and numbers. These are the deterministic layer's cases;
  - **sensitive-app:** items captured from a password manager or bank;
  - **harmless controls that look sensitive:** a docs page about API keys, a recipe with a vitamin dose, a bank's marketing page shown on a news site, a pricing page, a fitness timetable, and others.

  Labels are per question; harmless controls are false on every question.
- **Bounds,** stated now, before any case exists, and why:
  - **detection ≥ 95%** on grey-area sensitive cases, counted when the model's outcome isn't `index`. Stricter than Part 1's 90%, because a missed secret or health note goes into the archive and every later recall.
  - **false holds ≤ 20%** on harmless controls, counted when the model's outcome isn't `index`. Looser than Part 1's 10%, because a false hold costs recall, not privacy: the item stays visible in the timeline and expires with retention.
  - **ECE ≤ 0.10** over every (case, question) pair of the grey-area and harmless cases, with Part 1's method (10 bins; an unanswered case counts against the model both ways at p = 0.5).
  - **The deterministic layer** is a code property, checked in CI and reported in the run. It must redact or exclude 100% of structured and sensitive-app cases, and no secret value may ever reach a model.
- **A size passes** only if the three model bounds hold. The verdict per size goes in the service's verdict store, as before.

## Open question for the owner

**The default when no model is trusted.** Index after the deterministic checks (as built: today's behaviour plus app exclusion and redaction), or hold everything until a decision model passes this template's eval (safer for the archive, but it switches capture indexing off for now)?

## NOTES for Track 1

Filled in when the results are in, at the end of this file.
