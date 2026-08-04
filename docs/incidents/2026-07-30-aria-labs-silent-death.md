<!-- Recovered 2026-08-04 from `.worktrees/SYNTHESIS.md`, an unregistered
     worktree directory that was about to be deleted as stale. It was the only
     copy and it is referenced by nothing, which is how a measured root cause
     becomes folklore.

     Most of section 5's A-list has since shipped: A1 (never send think=false
     on a call carrying tools) is `llm/router.py`'s think/tools rail, A2's read
     verbs are in `narration.py`, and A3's `correction()` exists in
     `capability_claims.py`. The document is kept as the RECORD — the
     measurements, the arms, and the "Unproven" section are the parts that
     cannot be re-derived from the diff. -->

# ARIA Labs, 2026-07-30 19:13–19:21 — root cause

## 1. What actually happened

Two different failures stacked. The split is visible in the ledger: 16 spans on `ollama:qwen3:8b` with `reasoning_chars` empty, 3 on `ollama:qwen3:14b` with `reasoning_chars` 925/1172/2817. All 19 have `tool_calls_requested = 0`, one round, `status='ok'`.

**Voice turns (19:13:45–19:18:11), deterministic.** `request.source == "voice"` triggers three substitutions on a copy of the main agent row:

1. `router_chat.py:111` — `voice_suffix = _VOICE_BREVITY` (the 505-char spoken-reply block at `router_chat.py:44-52`, appended last in the system prompt)
2. `router_chat.py:112-114` — `voice.model_override` = `"ollama:qwen3:8b"` replaces the agent's `ollama:qwen3:14b`
3. `router_chat.py:119-121` — `voice.thinking` → `"off"`. **The key has no row in `settings`** (verified live); `settings_store.py:344` declares `"default": "off"`, so the shipped default is what fired.

Then: `runner.py:1552-1554` `stream_chat(messages, round_model, tools or None, thinking="off")` → `llm/router.py:166` `resolve_thinking` → `llm/router.py:147-156` returns `False` for a local thinking-capable model → `llm/router.py:177-179` → `ollama_native.py:109-110` `payload["think"] = False`.

Measured, single-variable, n=8 per arm, real 20-tool schema, Jeremy's exact words:

```
8b  minimal prompt     think=None   8/8 called a tool
8b  minimal prompt     think=False  8/8
8b  voice prompt       think=None   8/8
8b  voice prompt       think=False  0/8   <-- shipped config
     -> "I can check that for you. Let me look it up."
8b  brevity suffix ONLY (505 chars) think=False  0/8
14b any arm            think=False  8/8
```

It is a three-way interaction: brevity suffix × `think=false` × 8b. Remove any one and it is 8/8. It is not prompt bulk — the 505-char suffix alone is worse than the full 14,965-char typed prompt. It is not model incapacity: `qwen3:14b` picks `github-profile-fetch` with `{"username": "ARIALABS"}` on the first try through the real `ollama_native.py:107` path (`/api/tags` advertises `["completion","tools","thinking"]` for 8b, 14b and ornith:9b alike).

**Typed turns (19:18:35 on), probabilistic.** Neither branch fires; `thinking='auto'` → `llm/router.py:147-148` returns None, no `think` key sent. Same question, same real 61-message replayed window (`router_chat.py:124-136`, `history_budget = max(1500, 6000-3500) = 2500`), n=8: **4/8** with history, **8/8** without. Three consecutive zeros at p≈0.5 is 0.125. Ordinary, not a mechanism.

**Turn ends.** `runner.py:1608` records `tool_calls_requested = 0`; `runner.py:1646` `if not tool_calls: break`. `runner.py:1900` capability check → None. `runner.py:1912` narration check → None. Reply streams, is spoken, and is replayed verbatim as an assistant message on the next turn (`router_chat.py:134-135`).

## 2. Why she can't do it

Two requests, two different answers.

**"Clone one of my repos under ARIA Labs" (19:16:31) — genuinely impossible.** No git, no shell, no filesystem write on any agent. The union: `maintainer` holds seven read-only `mcp:nova-src/*` tools rooted at /workspace; `deployer` holds `deploy_workload`. Nothing clones. No fix below changes this.

**"Does ARIA Labs exist on GitHub" (19:17:48) — she held the tool.** `github-profile-fetch` is an enabled row in `tools` (`http_call`, `GET https://api.github.com/users/{username}`, created 2026-07-14), and it reaches main through the `db:*` wildcard at `tools/registry.py:230` (`all_db = "db:*" in allowed`) and `:238`. **19 grants resolve to 20 tools** — any audit reading `allowed_tools` instead of calling `get_agent_tools()` gets this wrong, and `AgentsTab.tsx:168-171` renders the raw comma-separated grant string, so the operator sees the token `db:*` and never what it expands to. `api.github.com` is already in `tool_host_allowlist`.

She was also *told*: `runner.py:814` prints "Tools you can call yourself this turn:" from the same resolved list, followed by "Together those two lists are COMPLETE."

Two caveats worth knowing before treating this as solved:
- It is an exact-login lookup with no search. `/users/arialabs` does return the org (`type: "Organization"`), but a wrong guess returns **a different real account, 200 OK** — `aria-labs` is id 125805565, a stranger; `arialabs` is id 259376335. Post-incident on ornith:9b she did exactly that and reported the stranger's zero repos as the answer.
- It cannot list repos, so the natural follow-up has no tool either.

Dispatch route was live: main holds `dispatch_to_agent`; news-summarizer/ingestion/model-manager hold `web_search`+`fetch_url` and are bound to `openrouter:z-ai/glm-5.2`, which resolves through — `llm/providers.py:136-150` has an `OPENROUTER_API_KEY` env fallback, `is_configured` is True, resolved key len 73, `effective_model` passes the id unchanged. (The `llm_providers.api_key` column reads empty while the provider works, so any UI reading that column reports "no key" — same class of lie as reading `allowed_tools`.)

## 3. Why she promises anyway

**Nothing refuses.** `calls_made` has exactly one reader in the entire runner: `narration.detect` at `runner.py:1912`. The round loop exits at `runner.py:1646` on zero tool calls with no check on what the text said. There is no `tool_choice` anywhere in `agents/runner.py`.

**narration.py missed 6 of 6.** Two independent reasons, both verified by running the real module against the stored message rows:

1. `_PATTERNS` (`narration.py:26-40`) enumerates mutation verbs only — `create|build|add|update|delete|write|schedule|pull|set up`, plus dispatch. Every verb in the transcript was a read: check, search, look up, confirm, fetch. The bare pro-forms ("Let me do that for you", "One moment") match nothing at all.
2. `_CONDITIONAL_MARKERS` (`narration.py:79-80`) contains a bare `\bif\b`/`\bwhether\b` and is applied per-sentence at `narration.py:113` **before any pattern is tried**. "I'll check **if** I have access to GitHub" is discarded as a hypothetical. Adding read verbs alone fires on **4 of 6** — it misses the two turns that opened the stretch. Adding read verbs *plus* narrowing the guard to markers that precede the match fires 6/6 with `test_narration.py`'s MUST_NOT_FLAG still green.

**capability_claims.py fired once (19:15:41, "filesystem") and missed the rest.** `_NOT_A_CLAIM` (`capability_claims.py:92-98`) also carries a bare `\bif\b`, so 19:16:35 was exempted whole. The git arm (`capability_claims.py:61-65`) requires the literal token `git` adjacent — "clone one of your repos" never matches, and the comment at `:37` records that this was deliberately narrowed because "github" was satisfying it. And `_CAPABILITIES` has **no web/network/search family at all** (filesystem, shell, git, code editing, machine access), so "I'll check if I have access to GitHub" had no honest home even unguarded.

**Where the output goes — this is the part that matters.** narration, when it fires, does three things: activity event (`runner.py:1913`), a journal memory write (`runner.py:1919-1923`), and `final_text += note` at `runner.py:1937` with a text yield at `:1939`. capability_claims does **only the banner** (`runner.py:1900-1908`): activity event and `log.warning`. No `final_text +=`, no journal write, and `capability_claims.py` has no `correction()` helper at all (`model_claims.py:159` has one).

The activity event persists as a `role='tool'` row (`router_chat.py:220-226`). `conversations.to_llm_history` keeps only user/assistant (`conversations.py:101-105`), and `router_chat.py:134-135` loads with `roles=("user","assistant")`. So the 19:15:41 verdict was invisible to the model on every later turn and inaudible on the voice channel, while the claim it contradicted replayed forever. The comment at `runner.py:1924-1933` is exactly this argument — written for narration on 2026-07-28, never applied to its sibling four lines above it.

**The approval was fabricated twice over.** `propose_goal` was narrated, never called (`goals` is empty; `consents` has no `goal.activate` row, ever). Nothing checks a claimed pending approval against `consents.list_pending` (`consents.py:71-81`). And had she called it, no card could have rendered: `ctx` is built at `runner.py:1499-1516` with **no `conversation_id` key** (`git log -S'conversation_id' -- backend/app/agents/runner.py` returns nothing — it has never been there), while `builtin.py:1412` passes `conversation_id=ctx.get("conversation_id")` → NULL and `consents.list_pending` filters `AND conversation_id = $1` (`consents.py:77-81`), which the chat UI always supplies. Same for guardian's card at `builtin.py:1147-1150`. The documented fallback — "the operator can approve it in Settings" (`builtin.py:1418`) — names a surface that does not exist; `grep -rn goal frontend/src` returns nothing, and there is no goals HTTP route.

Also relevant before anyone designs a goal-shaped fix: `scopes.GOAL_SCOPED_TOOLS` (`tools/scopes.py:29`) contains no read verb, so a "search GitHub" goal is refused at `builtin.py:1386` anyway. Her own prompt says so — `runner.py:444`: "research, search, memory and dispatch never need one" — and she said the opposite. Prompt correct, model answering from the transcript.

## 4. Why he can't tell she's idle

Timings first, because they reframe the complaint: every failing turn completed in 3–16s, `status='ok'`, and `emitPresence(false)` fired in the `finally` at `ChatPanel.tsx:1639`. The UI correctly said *done*. The 98 seconds Jeremy sat through (19:18:52 → 19:20:30) had nothing running at all. This is not a missing spinner — it is that **"finished, having done nothing" renders identically to "finished, having answered"**, while the reply text says work is in flight.

- **Chat.** The trace chip is the one artefact carrying the decisive fact and spends it on a duration: `ChatPanel.tsx:62` `if (t.tools)` is falsy at 0, so a 14-second turn that ran nothing renders `14s`. (`ChatPanel.tsx:64` can never fire on a live turn either — `ChatPanel.tsx:1642` hardcodes `status: 'ok'` on the client-built trace.)
- **The loud surface exists and was silent.** `ChatPanel.tsx:164` renders a full-width amber narration banner, `:172` the capability one, and `:334` exempts both from history collapse. Purpose-built for this; blind for the reasons in §3.
- **Voice.** `VoiceOverlay.tsx` is `fixed inset-0 bg-black` — it occludes the transcript, the typing dots, the streaming caret and the chip. Its only busy string is a `title`/`aria-label` tooltip (`VoiceOverlay.tsx:60-66`, consumed at `:100-101`), which touch cannot surface. No status sentence, and **no stop control** — a stalled stream in phone voice mode cannot be cancelled.
- **Canvas.** Live `brain.view` is `universe`, and `universe.ts:1985-1988` discards the activity `kind` entirely; `act.active` drives bloom (`:1718`) and a 50% rotation bump (`:1719`, `:1722`). The thinking/tool/dispatch vocabulary `ChatPanel.tsx:1546/1610/1615` emits renders only in `nova.ts`. Moot here (nothing but 'thinking' ever fired), but the contract is published to four renderers and honoured by one and a half.
- **Reasoning stream.** On voice there was none (think=false). On the typed turns there was, but `router_chat.py:210-212` drops the `kind: "thinking"` the runner sets at `runner.py:1579`/`:1603`, so a model's scratchpad and a dispatched specialist's output render as the same collapsed grey accordion — and for a dispatched specialist, its reply text and its reasoning merge into one blob, since ChatPanel keys on agent+turn only.
- **Adjacent cliff, not this incident.** No SSE heartbeat (`router_chat.py:183-297` yields only on runner events), and `ollama_native.py:118` hands a bare float to `httpx.AsyncClient(timeout=...)` — a per-read gap, not a total budget. A trickling generation is unbounded.

## 5. The fix, ranked

### A. Minimal — stops the silent death

**A1. Never send `think=false` on a call carrying tools.** `backend/app/llm/router.py`, in `stream_chat` (`:162-180`), which already holds both facts. Refusing line: `if think is False and tools: think = None`, immediately after `:166`. Derived from the request, no verb list, no setting to keep in sync. **Effort: one line + test. Converts 16 of 19 turns from 0% to 100%.** Consequence to accept: `voice.thinking` becomes inert for any tool-carrying agent, and the 1.0s-vs-2.2s measurement justifying it (`settings_store.py:344-348`) was taken on a question that needed no tool — it never covered this path.

**A2. Make the promise-with-no-call loud on the read family.** `backend/app/narration.py`.
- `:33-34` — add retrieval verbs and the progressive form: `check|checking|search|look up|look into|find|fetch|confirm|verify|see if|browse|query|propose`, plus the pro-form sign-offs (`let me do (that|it|this)`, `one moment`).
- `:113` — apply `_CONDITIONAL_MARKERS` only when the marker *precedes* the match (`cm.start() < m.start()`), so "If I dispatched the agent, it would take minutes" stays exempt and "I'll check if X" does not.
- Refusing line is already there: `narration.py:102` `if tool_calls_made or not final_text: return None`. A promise to look something up in a turn that ran no tool is false by construction — same argument that made past-tense matching safe.
- Measured: verbs alone 4/6; verbs + guard 6/6, existing MUST_NOT_FLAG green. Known precision cost to decide deliberately: "I'll check that if you'd like." starts firing — exempt trailing offers or pin it in MUST_NOT_FLAG. Add the six real replies to MUST_FLAG. **Effort: half a day.**

**A3. Give the capability check the three lines narration has.** `backend/app/agents/runner.py:1900-1908` — add `final_text += capability_claims.correction(claimed)` and the `yield {"type":"text"}` at `dispatch_depth == 0`, mirroring `:1937-1939`, plus the journal write from `:1919-1923`. Add `correction(label)` to `capability_claims.py` so the wording lives next to the patterns (phrase per label — the naive template yields "code editing access" and "machine access access"). Refusing line: the `final_text +=`. That is what puts the contradiction into the replayed history and the spoken channel instead of a `role='tool'` row nothing reads. **Effort: 30 minutes.**

**A4. Close the two `\bif\b` holes in `capability_claims.py`.** `:92-98` same treatment as A2's guard; `:61-65` add a bare-VCS-verb alternation (`clone|fork|checkout|push to|pull from` within 25 chars of `repo|repository`) so "clone one of your repos" matches; and add a web/network capability entry whose token set (`web, search, fetch, url, http, browse`) self-silences the day main gets `web_search`. **Effort: one hour, with `test_capability_claims.py`.**

**A5. Show the zero.** `frontend/src/chat/ChatPanel.tsx:62` — `parts.push(t.tools ? … : '0 tools')`. Caveat: ~71% of chat turns run zero tools, so unconditional it becomes wallpaper — gate on the narration/capability flag for that trace once A2/A3 land. Also fix `:1642`'s hardcoded `status: 'ok'`. **Effort: 20 minutes.**

**A6. Voice liveness.** `frontend/src/chat/VoiceOverlay.tsx` — render a status line over the orb by hoisting `conversationLabel` (`ChatPanel.tsx:1766`, already branches on busy and speaking) and passing `voiceState.speaking` in; do **not** reuse `micStatus` (`ChatPanel.tsx:1797`) — it has no busy branch and would say "Tap to listen" mid-reply. Add a stop control. **Effort: half a day.**

### B. Larger — capability and plumbing

**B1. Thread `conversation_id` into the tool ctx.** `runner.py` — `run_agent` signature (`:1397-1402`), the ctx dict (`:1499-1516`), **and the dispatch recursion (~`:1972`)** so guardian's cards work too; `router_chat.py:194` passes the value it already holds at `:188`. This is what makes `consents.list_pending`'s `AND conversation_id = $1` able to match. Without it every agent-raised approval card is orphaned. Miss the dispatch path and you ship a partial fix that looks verified. **Effort: one hour.**

**B2. Fix or delete `builtin.py:1418`.** There is no Settings goals surface and no goals route. Either build one (`list_goals` is a model tool, not an endpoint — `goals.active()` also filters `status='active'`, so a *proposed* goal is invisible to it) or say the card was lost.

**B3. GitHub scope is a product decision, not a bug fix.** If "find X on GitHub" should work, that is a second declarative DB tool against `https://api.github.com/search/users?q={query}&per_page=5` — no key, host already allowlisted, but `per_page` is mandatory because the http executor truncates at 8000 bytes with no JSON awareness. Also correct `github-profile-fetch`'s description: the endpoint resolves organizations, and the model has cited "only fetches user profiles" as its reason for declining it. Clone is a genuinely new capability with real blast radius.

**B4. Regression gate.** The eval harness has no thinking dimension and no arm asserting a local model emits a tool call under the **real assembled prompt** — precisely the gap that let A1 ship. `evals/runner.py:295` builds the contestant from the agent row, so `thinking` is inherited and cannot be varied per task. Add `think × voice-suffix × model` as runner dimensions, scored as a **rate over repeated samples** (the history effect is ~50%; a single-sample gate would flap). Note the existing main suite already fails 0/6 on all four local models (`eval_runs`, 2026-07-28) and nothing surfaces it.

### Explicitly not worth doing

- **Bounding the replayed history window.** Real effect at the true production window: 8/8 → 4/8 on 14b. Real, modest, cannot carry 16 consecutive zeros. Re-measure after A1.
- **Reordering `_build_system_prompt`.** `runner.py:378` does say "re-read the tool list above" 76 lines before `runner.py:814` prints it — fix the word "above". Moving `## What you can actually do` out of the LAST WORD slot fights the deliberate placement documented at `runner.py:806-819` and measured 0/12 improvement.
- **Anything about context pressure.** `context_trim.py:131` `ceiling_for` reads `local_context.cached()`, which is None before a model's first resolve (and after its 300s TTL), falling back to the flat `inference.ollama_num_ctx` default 16384 → ceiling 12384 → the reported `context_pressure` 0.82. The call actually ran at num_ctx 20480, ~51% occupancy, `truncated = 0`. **Worth fixing on its own merits** — `ceiling_for` also drives the tool-result cap (`runner.py:1253`), the summariser chunk (`summariser.py:322`) and the paged-read cap (`builtin.py:51`), so a cold-cache turn silently shows the model ~25% less of every document — but it caused nothing here and it cost this investigation a day.
- **The `tools_hash` gate.** Ruled out: MCP-only (`mcp_servers.py:175/185`), and main's resolved 20 contain no `mcp:` tool. Recorded so nobody reopens it.

## 6. Open questions

1. **`voice.thinking`.** A1 makes it inert for tool-carrying agents. Keep it (meaningful only for toolless agents), delete it, or replace with a two-pass voice turn — think for the tool decision, brief spoken answer after?
2. **`voice.model_override` = qwen3:8b**, set 2026-07-17, still live — while `agents.main.model` is now `ollama:ornith:9b` (changed 2026-07-31 03:08, actor=operator). Voice currently runs 8b over a 9b main. Deliberate? If not: drop it, or surface it at the point of edit — `AgentsTab.tsx` never mentions voice, and RolesPanel shows both values as peers with nothing saying which wins.
3. **False-positive appetite for A3.** Appending the capability correction to `final_text` puts `capability_claims`' regex precision into the spoken channel; its own docstring says one false accusation costs more than several missed catches. That is presumably why it stopped at a banner. Ship it, or keep the banner and accept the model never sees its own correction?
4. **Claimed-pending-approval check.** "Reply asserts waiting-on-approval while `consents.list_pending(conversation)` is empty" is derivable from live state and would have caught 19:20:39 exactly. Its own control, or folded into A2?
5. **Read-capability requests have no route.** `GOAL_SCOPED_TOOLS` is all capability-*creating* verbs, so "may I search GitHub" is not expressible as a goal — and your prompt correctly says it needs none. Do you want an operator-facing route for "I could do this if you dispatched/granted X", or is dispatch-in-the-same-turn the whole answer?
6. **GitHub scope.** Existence lookup only (B3), repo listing, or actual clone?

## Unproven — stated rather than papered over

- **The voice/typed split is inferred, not recorded.** `turn_traces.source` is CHECK-constrained to chat/automation/compaction/eval and voice turns record `'chat'` (`router_chat.py:188`); `messages.metadata` is `{}` for every user row in the window. The only surviving discriminator is that the model equals `voice.model_override` — and `inference.local_fallback_model` is *also* `qwen3:8b`, so the discriminator is round-count + status, not the model column alone. Clear the override and this incident becomes unreconstructible.
- The 4/8-vs-8/8 history effect is n=8 per arm. Direction solid, effect size soft.
- The three typed 14b turns are accounted for *probabilistically*. Three zeros at p≈0.5 is unremarkable; unremarkable is not explained.
- OpenRouter: verified the key resolves and routing passes through unchanged. Not verified that upstream accepts it.
- `agents.main` was repointed to ornith:9b ~1h45m after the conversation. Any reproduction must pin `ollama:qwen3:8b`/`qwen3:14b` explicitly rather than reading the agent row.