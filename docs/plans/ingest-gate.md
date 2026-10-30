# Plan: the ingest security gate (Amendment 2026-10-30-C Part 3)

**Sources:** AMENDMENT-2026-10-30-C Part 3 (binding). ROADMAP "Ingest security gate". NOVA-SPEC tiers. CONTRACTS §2 (receipts) and §3 (decisions). OPERATING-RULES: local-only never reaches the cloud; Noul is one calibrated probability.

**When it lands:** before M10. No Nova browser opens a real page for a model until it is merged. It also covers what is already built: the agent's tools, mail, files, skills, capture, and helpers' handoffs.

**Already landed:** the SSRF guard on `web_fetch` (`src/safe-fetch.js`, PR #226).

## What the survey found (2026-10-30)

These are the paths outside content takes today:
- **The main loop puts every tool result straight into the transcript of the chat model,** and that model can act. The results come from `web_fetch`, `web_search`, `gmail_*`, `read_file` and `exec`. See `src/runner.js:361` and `src/context.js:115`.
- **Escaping is incomplete:** `esc()` escapes closing tags only, and `htmlToText` lets hidden text through.
- **Taint is narrow:** the only "taint" is `run.tainted`. It is set by mail tools only, makes the web tools ask first, and is skipped when `permissions.md` says `online: yes`. Web pages and files never set it.
- **Taint doesn't follow handoffs:** a helper's or scheduled run's report comes back as a `<handoff>`, and an automatic parent turn starts without the taint.
- **Memory with no approval:** the model writes memory without asking (`<remember>`, `<note>`, `<forget>`). Records are "unreviewed" but still shown in the system prompt.
- **Standing files with no approval:** `write_file` can rewrite the four standing files, which load into every system prompt.
- **Uploaded skills go into the system prompt unescaped.**
- **Capture** already uses a local model with no tools for its proposals, but has no screen.
- **The M5 browser worker** stores page reads as evidence; no model reads them yet.
- **The decision stack fits the screen's needs:**
  - `Decisions.decide` with the local-model provider is forced local-only, gets no tools and no memory, and its output is a typed schema.
  - It has no input length cap.
  - Text in an input isn't delimited as data.
  - Without a local sorting model assigned, every decision escalates.

## Design

One core module, `src/core/ingest/`, exported through `src/core/index.ts`. Code outside the core uses only that. The person-facing words are plain, and the details go in the ledger.

### 1. `ingest.screen(content, source)`

```text
screen({ text, html?, headers?, source: { kind, origin, ref } }) →
  { verdict: 'pass' | 'quarantine' | 'block', id, scores, flags, extract, taint }
```

- **`kind`:** `web`, `search`, `email`, `file`, `skill`, `ocr`, `transcript`, `qr`, `tool`, `handoff`, or `connector`.
- **`origin`:** a host, a sender, or a path.
- **The deterministic checks (§3) and the Noul screen (§2) run in parallel.**
- **`extract`** is what an acting model may see: the content as data, never as instructions (§4).
- **Every screen is recorded**, with its id, source, scores, flags, verdict and a content hash. A block also opens a Work Ledger entry that says what was blocked and why.

### 2. The Noul screen (isolated)

- **A built-in decision template, `ingest-screen`,** with five Noul questions:
  - P(direct instruction);
  - P(hidden or indirect instruction);
  - P(secret or exfiltration request);
  - P(impersonation);
  - P(an action the person never asked for).
- **It is answered only by a local model** through the existing local-model provider. That provider is already forced local-only, gets no tools, memory or secrets, and must answer in the typed schema.
- **Private content never goes to a cloud screener,** in any privacy mode. The cloud screener the amendment allows outside local-only is not built: a screen that can be skipped by changing modes isn't a gate. Jev stays a stub.
- **The input is wrapped as delimited data.** A fixed fence with a random nonce, and text inside that tries to close the fence is escaped.
- **The input is capped and chunked:**
  - chunks of about 3,000 characters, at most 16 per screen;
  - longer content is screened on its first and last chunks plus an even sample, and is never marked `pass`;
  - each question takes the highest probability across the chunks.
- **With no local sorting model,** there is no Noul screen, and the deterministic checks decide alone. Anything not blocked becomes `quarantine`, never `pass`, and Health says screening is running without a model.

### 3. The deterministic checks

These run every time, with or without a model:
- **Hidden text in HTML**, which is kept apart and flagged:
  - `display:none`, `visibility:hidden`, zero size or zero opacity, text the same colour as its background, off-screen positioning;
  - `aria-hidden`, `<template>`, comments, and `meta` or `alt` or `title` text that looks like instructions.
- **Characters:** zero-width and bidi-control characters, and Unicode tag characters (U+E0000).
- **Encoded blobs:** long base64, hex or URL-encoded runs.
- **Links:** link text that shows one host while the `href` goes to another.
- **Instruction-shaped text:** imperatives addressed to an assistant or AI, "ignore previous…", role or system markers, and Nova's own protocol tags (`<tool_call`, `<remember`, `<handoff`, …).
- **Email:**
  - the `Authentication-Results` SPF, DKIM and DMARC verdicts (no header counts as unknown, never as a pass);
  - a Reply-To or return path different from From;
  - display-name impersonation (the name says one thing, the address another).
- **Attachments:** a type that doesn't match its extension, executables and macros, and archives. Nova doesn't open attachments today; if it does later, they go through the same sandbox.
- **Addresses:** the SSRF guard (already landed) for any fetch made on the content's behalf.

### 4. Thresholds and what each verdict means

The highest Noul probability decides:
- **Below 0.2, with no blocking flag: `pass`.** The content reaches the acting model wrapped as **data**:
  - a provenance header (source, origin, screen id);
  - every protocol tag escaped, opening and closing;
  - a fixed line saying it is material to read, not instructions.
- **0.2 to 0.8, or a quarantining flag, or no model: `quarantine`.**
  - Instruction-shaped spans and hidden text are removed; what was removed is listed by kind, never by content.
  - When a local model is available, a facts-only extract is made by a **reader**: the local model, with no tools and the same data wrapping.
  - The result is tagged with its provenance.
- **0.8 or above, or a blocking flag: `block`.**
  - Blocking flags: hidden instructions, and protocol tags in hidden text.
  - The acting model gets one line: "Nova blocked this content: it looked like it was trying to give instructions." The ledger has the full record.

The cut-offs are config with these defaults. Lowering one is tier 3. They are never loosened to make a test pass.

### 5. Taint

- **What sets it:** every screened read, whatever the verdict. The run's taint becomes a list of the sources it read, with their screen ids and highest scores, instead of a flag that only mail sets.
- **It carries across handoffs.** A helper's or scheduled run's taint goes with its report, and the parent's automatic follow-up turn starts tainted.
- **While a run is tainted, these never run on their own, whatever `permissions.md` says:**
  - sending (mail drafts, webhooks, browser form fills);
  - paying;
  - deleting or organising;
  - sharing;
  - running code (`exec`);
  - changing settings (writing the standing files, schedules, permissions);
  - pairing.

  Each asks the person, and the request names the outside source that led to it. A rule set to "yes" in `permissions.md` still applies to untainted runs.
- **Fetching while tainted** goes through the outbound guard (§7) instead of a blanket question, so ordinary research still flows.

### 6. Reader and actor

- **The actor never sees raw outside content.** The chat model gets only the screened form: the data-wrapped `pass` content, the quarantine extract, or the block line.
- **The reader** is the local model used for quarantine extracts. It has no tools beyond reading the text it is given.
- **Skills from outside** (uploaded zips) are screened when they are installed:
  - a `block` refuses the install;
  - `quarantine` installs the skill disabled, with the reasons, until the person turns it on.
  - Skills in the catalog that ship with Nova are trusted.

### 7. Outbound guard

Before anything leaves for a destination taken from outside content, the payload is checked. That covers a URL's path and query, a search query, a mail draft, a form fill, and a webhook body.
- **It checks for:**
  - secrets: vault values and canary strings;
  - memory content: any 24 characters or more matching a memory record or a standing file;
  - long encoded blobs.
- **A match:** the step stops, and the person is asked, with what matched shown by kind ("looks like a saved password"). It is never sent silently.
- **An untainted run** to a destination the person gave isn't checked for memory content, so they can still share their own notes when they ask to.

### 8. Memory guard

- **No direct writes from outside content.** In a tainted run, `<remember>` and `<note>` write candidates that are quarantined with their provenance. They are not shown in the system prompt until the person confirms them.
- **Device notes and capture promotions** keep the person-accept step they already have.
- **`<forget>` in a tainted run asks first.**

### 9. Coverage

Every external read goes through `screen` before a model sees it:
- `web_fetch`;
- `web_search` results;
- `gmail_search` and `gmail_read`;
- `read_file` on `workspace/` files whose provenance is outside, or unknown (files written by `exec`, providers, or downloads);
- `exec` output while the run is tainted;
- helpers' handoffs;
- skill installs;
- capture text, before the capture-promote decision;
- device inbox notes;
- the M5 browser worker's page reads, before any future model step reads them;
- provider (Claude Code, Codex, Relay) summaries and copied-back files, which are marked outside provenance.

Standing files and memory are the person's own and are not screened, but writes to them follow §5 and §8.

## Gate

- **A regression set of injection payloads** in `tests/ingest/corpus/`, with neutral placeholders, each with its expected verdict at least. Every one must be quarantined or blocked:
  - direct;
  - hidden by CSS;
  - zero-width;
  - in comments and metadata;
  - encoded;
  - link mismatch;
  - impersonation mail with a failing DMARC verdict;
  - "ignore previous instructions";
  - fake tool calls;
  - Reply-To swaps;
  - exfiltration-by-URL.
- **A benign set** (ordinary pages, newsletters, docs) must `pass` or, without a model, `quarantine`. A false-positive count is reported.
- **Canary secrets:** a planted canary in the vault and in memory never leaves through any outbound path, in an end-to-end run where a fake model obeys an injected page. The fake model is the attacker in this test: it does exactly what the page says.
- **Taint:** a web or mail read followed by `exec`, `write_file` to a standing file, a schedule change or a mail draft asks the person, even with `permissions.md` set to yes. Across a helper's handoff too.
- **Local-only:** the screen never calls a remote provider, checked by the egress tripwire.
- **These run in CI like any other suite.** The Noul screen is exercised with a fake local model that returns fixed probabilities; the deterministic checks are tested directly.
- **The fresh-user test still passes.**

## As built (2026-10-30)

Branch `ingest/gate`. The ledger entry of the same date has the decisions in full; the evidence is `docs/evidence/ingest-gate.md`.

- **Where it lives:** `src/core/ingest/`:
  - `checks.ts`: the deterministic checks (§3);
  - `screen.ts`: `Ingest` with `screen`, `screenNow`, holds, memory candidates and file provenance (§1, §2, §4, §6, §8);
  - `outbound.ts`: the outbound guard (§7);
  - `index.ts`: the core wiring, with the verified ledger record of a block.
  - Migration 0013 adds `ingest_screen`, `ingest_hold`, `memory_candidate` and `file_provenance`, none replicated.
  - Exported through `src/core/index.ts`; the API is `GET /api/v1/ingest/screens[/{id}]` and `POST /api/v1/ingest/screen`.
- **The agent loop** (`src/runner.js`) screens each outside read, logs the raw output for the person, and gives the model only the screened form (`context.js`).
  - Taint is a list of sources in the session log, carried into handoffs and helpers.
  - `GUARDED`, and any tool that needs an OK, always asks in a tainted run.
  - The outbound guard checks URLs, searches, drafts and commands.
  - Memory blocks in a tainted run become candidates.
- **Elsewhere:**
  - skills are screened at upload (server.js), and a held skill has "Turn it on";
  - capture is screened before triage;
  - browser page reads are screened as they are taken;
  - device notes get Nova's own checks before the inbox writes.
  - Health has "Outside content".
- **Where this reads the plan** (each is in the ledger entry):
  - handoffs are screened only from tainted runs;
  - `exec` output only while tainted;
  - `<forget>` waits as a candidate;
  - device notes had no accept step to keep, and none was added;
  - the old `online` permission is retired in favour of the outbound guard;
  - any approval-needing tool is guarded in a tainted run, not only the listed ones.
- **Gate results:**
  - 31 of 31 injection payloads are caught with no model, and with a model that sees nothing wrong.
  - 14 of 15 benign items pass with a model. One known false positive is quarantined, not blocked: an article quoting an injection phrase.
  - The canary test passes in three variants and fails with the guard switched off.
  - The tripwire saw no egress.

### After the adversarial review (2026-10-30)

The decisions are in the ledger entry "fixes from the adversarial review of #229". In short:
- **B1:** failed reads are screened and taint the run.
- **B2:** standing-file paths are normalised before the guard compares them.
- **B3:** in a tainted run, an address the model put together asks; following a link the run read is free.
- **B4:** every skill file is screened before anything is written. The skill goes in through a staging folder, and its files are trusted only while unchanged.
- **S1:** origins never go in tag attributes.
- **S2:** device notes wait as candidates unless they pass.
- **S3:** `exec` output is screened in every run, and taints when a check flags it or the model is unsure. This replaces the "only while tainted" reading above.
- **S4:** the tokenizer is linear and capped.
- **S5:** the screen template is tier 3, and its questions can't be dropped.
- **Folding and more hiding rules** are added, and the browser worker fails closed.
