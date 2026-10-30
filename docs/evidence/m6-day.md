# M6 gate — a day in the life, local-only (real run)

Run 2026-10-30T08:16:52.261Z on this machine, with the real Ollama 0.40.0 at http://127.0.0.1:11434 (read and asked only: a relay in front of it refuses pull, delete and anything but reading and inference). The hardware was read for real; the roles are the model manager’s own recommendation from installed models, accepted as recommended. Screenpipe is the stand-in (it isn’t installed here) and there is no standby (the CI run, m6-day.test.ts, has one). Times in headings are capture’s test clock; durations are wall time. Not part of CI: `NOVA_REAL_OLLAMA=1 node --test tests/acceptance/m6-day-real.test.ts`.

## 07:30 — A fresh profile, set up as local-only by conversation

**Nova:** Hi, I’m Nova. A few quick questions to set things up; you can change any answer later just by telling me, and "skip" keeps my default.

What should I call you?

**Person:** Hi! I'm Sam.

**Nova:** Nice to meet you, Sam.

Your computer says you’re on UTC time. Is that right? (Yes, or tell me the right one.)

**Person:** yes

**Nova:** UTC it is.

I go by Nova. Want to call me something else? (A name, or "keep".)

**Person:** keep

**Nova:** Nova it stays.

How direct should I be? I’ll always tell you when I think something’s wrong; that part isn’t adjustable. But I can say it gently, plainly, or bluntly.

**Person:** plainly, please

**Nova:** Plainly, then.

Last setting: privacy. Local-only means nothing leaves this machine. One thing to know: chat is set up to use claude, which runs in the cloud. With local-only, chat stays off until you add a local model; everything else works. I’d keep it local unless you want cloud help when local isn’t enough. Keep it local-only, or allow cloud when needed?

**Person:** keep everything on this machine

**Nova:** Got it: everything stays on your devices.

Here’s what I have: I’ll call you Sam; UTC; I’m Nova; plain about hard truths; local-only.

Want a first task to prove the plumbing works? I’ll write a short welcome note into your workspace and check it myself. (Yes or no.)

**Person:** yes

**Nova:** Started. I’ll check the note myself before I call it done. That’s setup done. I see nothing on your devices unless you turn capture on in Settings › Capture. A computer can share a lot, under its own permissions; Android needs accessibility and notification access; an iPhone or iPad allows no passive capture of other apps at all. Ask me anything, or tell me to change any of this.

- Profile privacy: **local-only**. Setup’s first task “Write a welcome note”: **done** — Wrote welcome.md (237 bytes).
- Hardware read: NVIDIA GeForce RTX 3090 (24 GB) · 31 GB memory · 20 threads · 6.3 GB free disk
- Recommended for triage-text: `Qwen3:8b` (installed) — Qwen3:8b (8.2B parameters, 4.9 GB) is the smallest capable model installed here, so sorting stays quick. Fast and light; not meant for long answers.
- Recommended for reasoner: `deepseek-r1:32b` (installed) — deepseek-r1:32b (32.8B parameters, 18 GB) is the deepest model that fits NVIDIA GeForce RTX 3090 with 24 GB. Slower to answer than a small model, and it and the sorting model can’t both stay loaded, so switching between them takes a few seconds.
- Recommended for embedder: `nomic-embed-text:latest` (installed) — nomic-embed-text:latest (262 MB) is the smallest embedding model installed here. Small and fast; good enough for finding things by meaning.
- Recommended for transcriber: nothing — There is no transcription runtime on your devices (Nova looks for whisper.cpp or faster-whisper), so transcription stays off. Nothing is sent elsewhere to transcribe instead.
- Accepted: triage-text → `Qwen3:8b`, reasoner → `deepseek-r1:32b`, embedder → `nomic-embed-text:latest`. Transcription stays unassigned: “There is no transcription runtime on your devices (Nova looks for whisper.cpp or faster-whisper), so transcription stays off. Nothing is sent elsewhere to transcribe instead.”
- Chat uses the `openai-compatible` provider set to the **reasoner** role (egress local). A cloud model (a loopback stand-in) and a cloud budget of $0.50 a task, $5 a day are set, for the record; local-only must never use them.
- Rules: an event rule on capture’s `unclassified` topic (a message), and a heartbeat at 12:00 (a task). Step took 0.7 s.

## 08:00–10:05 — Morning: capture on, events through the day, classified by the person’s signals

- Screenpipe (stand-in) at http://127.0.0.1:43253 added off, then turned on at 08:00; the person asked for what it kept since yesterday noon. Indicator: **on** (Screenpipe).
- Signals: Editor → work, Recipes/Notes/Chat → home, weekdays 09:00–17:00 → work. Retention: 1 day.
- Pulled at 10:05 (30.6 s, including the local triage of each new event): kept 5; dropped {"private":1}. Source counts: {"kept":5,"private":1}.
  - yesterday 16:00 screen Editor → **work** (signal:app+calendar)
  - 08:05 screen Recipes → **home** (signal:app)
  - 08:20 screen Notes → **home** (signal:app)
  - 09:15 screen Editor → **work** (signal:app+calendar)
  - 10:00 audio (audio) → **work** (signal:calendar)
- The incognito window (08:40) was never stored: its words are nowhere under Nova’s home.

## 10:05 — Triage: the local decision provider looks at what was captured (Noul)

- 5 decision calls (capture-promote@1, one Noul question), each with a receipt: ollama · Qwen3:8b · egress local · decision: capture-promote@1.
- Proposals: “Yesterday’s notes YESTERDAY-2208” p=0.9 by `local-model`; “Oat porridge: one cup of oats, two of milk.” p=0.9 by `local-model`; “The boiler service is booked for 12 March, reference BOILER-7731.” p=0.9 by `local-model`; “Quarterly plan draft: three goals.” p=0.9 by `local-model`.
- The local model proposed 4 of the 5 events it was asked about. A proposal is never a memory: the person accepts only the boiler appointment below.

## 10:10 — Chat through the local reasoner

- **Person:** Good morning. What should I start with today? One sentence.
- **Nova** (155.7 s): I don't have any specific tasks or priorities noted for today. Could you share what you're focusing on or any upcoming deadlines?
- Receipt: ollama · deepseek-r1:32b · egress local · chat.

## 10:30 — Delegated work: the M5 calc brief through the local model, local-only

- Brief: “Make the failing test in calc/ pass” (`node --test calc/sum.test.mjs`, evidence test_result + file_diff), local-only.
- Nova asked before running the model’s code: calc/sum.mjs — “This runs code the provider wrote, as you, with access to your files.”
- Outcome (24.7 s): **done** — You OK’d running `node --test calc/sum.test.mjs` on what Local model (Ollama or compatible) wrote. Nova ran `node --test calc/sum.test.mjs` itself: it passed.
  - test_result: passed — Nova ran `node --test calc/sum.test.mjs` itself in the task’s folder: it passed (exit 0, 0.1 s).
  - file_diff: passed — Nova compared calc/sum.mjs in the task’s folder with the copy it started from: 1 line added, 2 removed, as reported.
- Receipts: ollama · deepseek-r1:32b · egress local · task: Make the failing test in calc/ pass. The bug is in calc/sum.mjs..

## 10:45 — Memory: the person promotes one captured fact, with provenance

- Accepted the local model’s proposal: memory “The boiler service is booked for 12 March, reference BOILER-7731.” (scope home).
- Provenance: source `capture:<event>`, observed 2030-01-15T08:20:00.000Z, recorded by console; GET /capture/memory/{id} → event captured 2030-01-15T08:20:00.000Z on the hub, from the proposal.
- Backups taken on the hub (as an upgrade leaves them); they hold the fact.

## 12:00–12:40 — Midday: a heartbeat and an event trigger, triaged by the local decision provider (Choice)

- Heartbeat “Midday note” at 12:00: triage **act** by `local-model` (triage@1) — Decided “act” by the local-model decision provider.
  - Its task “Write the midday note”: **done** — Added to notes/midday.md (17 bytes).
- 12:30 “Lunch at one?” in Chat during working hours: home by the app, work by the hours, so **unclassified**, not guessed.
- Event trigger “Unfiled capture”: triage **act** by `local-model` — Decided “act” by the local-model decision provider.
  - Message: “Something from today isn’t filed under a space yet; the Capture view has it.”
- Triage receipts: 2, each ollama · Qwen3:8b · egress local · decision: triage@1 (model `Qwen3:8b`).

## 13:00–13:45 — Midday outage: the local reasoner goes down

- How: simulated, not a real crash: Nova reaches Ollama through a loopback relay (http://127.0.0.1:43623 → http://127.0.0.1:11434), and the relay stops listening, so the address the reasoner (and the sorting model, on the same runtime) is served from is a dead port. The real Ollama keeps running; at 13:30 the relay listens again on the same port.
- The inference API answers 409: “Waiting on local capacity: Nova couldn’t reach Ollama at 127.0.0.1:43623: connect ECONNREFUSED 127.0.0.1:43623. This is local-only, so it stays on your devices and runs when the model is back.”
- Chat: “Waiting on local capacity: Nova couldn’t reach Ollama at 127.0.0.1:43623: connect ECONNREFUSED 127.0.0.1:43623. This is local-only, so it stays on your devices and runs when the model is back.”
- A local-only task waits: **waiting** — Blocked: Waiting on local capacity: Nova couldn’t reach Ollama at 127.0.0.1:43623: connect ECONNREFUSED 127.0.0.1:43623. This is local-only, so it stays on your devices and runs when the model is back.
- The person is told, as a proactive message: ““Make the failing test in calc/ pass (during the outage)” is waiting. Waiting on local capacity: Nova couldn’t reach Ollama at 127.0.0.1:43623: connect ECONNREFUSED 127.0.0.1:43623. This is local-only, so it stays on your devices and runs when the model is back.”
- Meanwhile capture keeps working (13:10 captured). The cloud stand-in received **0** requests; remote receipts: **0**.
- 13:30 the runtime is back.
- The waiting task reran by itself and ended (142.9 s after the runtime returned): **done** — You OK’d running `node --test calc/sum.test.mjs` on what Local model (Ollama or compatible) wrote. Nova ran `node --test calc/sum.test.mjs` itself: it passed.
  - Events: created → dispatched → waiting_on_model → reported → blocked → retried → dispatched → test_run_asked → reported → partial → test_run_approved → retried → dispatched → reported → verifying → verified → copied_back.
- The event captured during the outage was put to the local model once it was back: proposed (p=0.9, `local-model`).

## 17:30 — The person forgets the promoted fact: gone from memory, capture, the database and WAL, backups

- DELETE /memory/{id}: not in memory, not in capture (GET the event → 404), and its words are in no file under the hub’s home: database, write-ahead log, backups, MEMORY.md.

## 20:00 — Evening: retention sweeps old capture

- The 20:00 pass swept 1 event(s) older than 1 day (yesterday 16:00), here; 7 events from today remain.
- The cloud budget: $0.5 a task, $5 a day; spent $0. Settings › Models says: “Example cloud is set, but your privacy setting is local-only, so it is never used.” The cloud stand-in received **0** requests all day.

## Night — All day

- Receipts: **19**, every one egress local (local-only).
  - 10 × ollama · Qwen3:8b · decision: capture-promote@1
  - 2 × ollama · deepseek-r1:32b · chat
  - 3 × ollama · deepseek-r1:32b · task (the calc brief)
  - 3 × ollama · Qwen3:8b · decision: triage@1
  - 1 × ollama · deepseek-r1:32b · asked through the API
- The egress tripwire (every TCP connect off loopback) logged **nothing**.
- Wall time for the day: 422 s.

| Step (test clock) | Wall time |
| --- | --- |
| 07:30 | 0.7 s |
| 08:00–10:05 | 30.9 s |
| 10:05 | 0.0 s |
| 10:10 | 155.7 s |
| 10:30 | 24.7 s |
| 10:45 | 0.0 s |
| 12:00–12:40 | 34.1 s |
| 13:00–13:45 | 174.9 s |
| 17:30 | 0.0 s |
| 20:00 | 1.3 s |
| Night | 0.0 s |

Model-dependent steps not as hoped: none.

The relay refused nothing (nothing but reading and inference was asked of Ollama).
