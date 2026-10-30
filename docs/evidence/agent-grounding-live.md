# Agent grounding — live local model

Run 2026-10-30T19:50:10.728Z, 166 s. Chat model: the `openai-compatible` provider → Ollama at http://127.0.0.1:11434/v1, model `qwen3.8:27b`; privacy local-only. Not part of CI (`NOVA_REAL_OLLAMA=1 node --test tests/acceptance/grounding-real-ollama.test.ts`).

Registry: no OpenRouter provider; Screenpipe (stand-in) refusing Nova until its API key is set (“Screenpipe answered but refused Nova; it needs the API key from Screenpipe’s Settings > Privacy.”); one schedule, Morning summary, every day at 7:00; Obsidian chosen out of the six installed design systems.

### provider: “Can you use OpenRouter instead? Connect OpenRouter.”

- **Tool:** none used

**Reply:**

> Yes — OpenRouter goes in as a provider, but that's a change only you can make in Settings (and you'd enter the API key there, so I won't ask for it in chat).
> 
> **To use OpenRouter as your chat model:**
> 1. Settings › Providers → the "Local model (Ollama or compatible)" provider (it currently points at your local Ollama at 127.0.0.1:11434 — repointing it **replaces** that).
> 2. Set the address to `https://openrouter.ai/api/v1`, pick a model, and enter your OpenRouter key in the field there.
> 3. Pick it as the chat model.
> 
> **If you'd rather keep Ollama as your primary and use OpenRouter as a fallback**, instead add it as the cloud model in Settings › Models — local-preferred work falls back to it, and your local setup stays untouched.
> 
> One question to pick a route for you: do you want OpenRouter as your main model, or as a backup for when your local models are busy?

**Checks:** ✓ named the way to add it (Settings › Providers); ✓ did not answer “I can’t, I run on X”; ✗ checked Nova’s registry with a status tool; ✗ said OpenRouter isn’t in the current setup.

### background: “Can you do work in the background, on a schedule, while I’m away?”

- **Tool:** none used

**Reply:**

> Yes, both ways, and I can already see one is set up:
> 
> - **On a schedule, unattended.** I have a *Morning summary* running every day at 7:00 AM. When it runs I do the work, and the report lands back here as a message when you're back. I can start new ones or tweak that one — just say what and when.
> - **Background work right now.** I can hand off a self-contained chunk (research, comparing options, going through files) and keep talking with you while it runs in the background; its report arrives here later.
> 
> One constraint to be upfront about: schedules run *unattended*, so whatever I do in them is bounded by what I'm allowed without asking. Right now I'm set to ask-first on most things, so a schedule can *read and reason and write its report*, but anything that changes something outside me (mail, drafts, commands on this box) waits on your approval. I can shape what a schedule does so it stays within the lane you want.
> 
> Want me to set up a schedule, or start something in the background? Tell me what it should do and when.

**Checks:** ✓ named the real schedule, Morning summary; ✓ did not deny background work; ✗ checked schedules with a status tool.

### appearance: “Can you switch yourself to a dark theme?”

- **Tool:** none used

**Reply:**

> I can't change the appearance from chat — that's yours to set. It's done in **Settings › Appearance**, where you can flip the mode off "auto" to dark (you've got Obsidian installed, which is a nice one to see in dark).
> 
> Want me to double-check what themes are installed, or are you happy to just toggle it yourself?

**Checks:** ✓ named the active design system, Obsidian; ✓ pointed to Settings › Appearance; ✓ did not claim to have switched it; ✗ checked appearance with a status tool.

### capture: “Why isn’t capture working?”

- **Tool:** `nova_capture` {}

```text
Capture: capturing from 1; 0 paused; 0 events in the last day.
Sources:
- Screenpipe [screenpipe:a101f868-e614-4910-934e-d13b78acfc72] (screenpipe at http://127.0.0.1:42451, on Hub; captures screen, audio): needs a key (status needs_key). Detail: “Screenpipe answered but refused Nova; it needs the API key from Screenpipe’s Settings > Privacy”; checked 3 min ago; API key not saved
Recent capture errors: 
- 2026-10-30T19:47:24.447Z (open): “Screenpipe answered but refused Nova; it needs the API key from Screenpipe’s Settings > Privacy. Nothing new is captured from it until it lets Nova in; nothing Screenpipe keeps meanwhile is lost”
```


**Reply:**

> Capture is stuck on one thing: **Screenpipe is refusing to let Nova in.**
> 
> Here's what I checked (from capture's own status, 3 minutes ago):
> 
> - Screenpipe is running on this hub at `127.0.0.1:42451`, and it does capture screen + audio.
> - But it answered Nova's request and turned it down. Its own message: *"Screenpipe answered but refused Nova; it needs the API key from Screenpipe's Settings > Privacy."*
> - No API key is saved here yet, and nothing new has been captured in the last day.
> 
> So it isn't a bug on your machine or in Nova — Screenpipe just needs its API key shared with Nova. One fix:
> 
> 1. Open **Screenpipe → Settings → Privacy**.
> 2. Grab the **API key**.
> 3. Put it in Nova at **Settings → Capture** (for the Screenpipe source), which stores it in the vault.
> 
> I can't do that step for you or ask you to paste the key here — that stays in the Settings field so it never touches chat or a file.
> 
> Once it's set, Screenpipe will let Nova in and capture resumes. And don't worry about the gap: nothing Screenpipe kept while this was down is lost — it just wasn't being read by Nova.
> 
> Want me to check again after you've saved the key?

**Checks:** ✓ checked capture with nova_capture; ✓ quoted the real error (Screenpipe wants its API key); ✓ no generic troubleshooting guesses about the machine.
