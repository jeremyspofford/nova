# Persona layer — a structural home for what makes Nova *Nova*

Status: designed 2026-07-17 (Fable session with Jeremy); ROADMAP "Next up" #15.
Implement one phase per session; live-verify each per CLAUDE.md before moving on.

## The incident that motivates this

During the persona pass (ROADMAP #13), the voice brevity block was silently
ignored while patched into the FRONT of main's agent prompt — identical
instructions worked the moment they were appended LAST to the assembled
prompt (`run_agent(system_suffix=...)`). Position beats emphasis. Nothing in
the architecture currently *guarantees* position, so identity survives only
by convention. This plan makes it survive by construction.

## Prompt-craft laws (apply to every block this plan touches)

1. **No answer-shaped sentences in system blocks** — facts as bare data
   lines, guidance as imperatives ("This is the authoritative current time"
   got parroted into spoken replies; a bare timestamp did not).
2. **Must-win instructions go LAST** — small models obey the end of the
   prompt, not the middle.
3. **Paired examples beat adjectives** — "warm, concise" did nothing;
   `"goodnight" gets "Night — sleep well.", never "Goodnight! If you need
   anything else...!"` fixed the register in one shot.

## LOCKED decisions (Jeremy, 2026-07-17)

1. **Nova is the only persona.** Specialists are their own entities — they
   get a role, not an identity. No soul.md injection into specialists, no
   "Your name is Nova" backstop for them. (Today five agents are each told
   "I am Nova" — that latent confusion goes away.)
2. **Nova is the proxy between the operator and the agents.** Surfaces that
   speak AS Nova — chat, voice, push notifications — always terminate at
   main. Ops surfaces — inbox, run logs, the chat activity trace — are
   machine-register and labeled as such. Write this invariant down wherever
   an output path is added.
3. **Slot-based assembly, owned by the runner.** Agents supply only their
   role slot; the runner appends the rest in fixed order. An agent
   *cannot* bury the last slot because it never controls assembly:

   | Slot | Nova (main) | Specialist |
   |------|-------------|------------|
   | 1. ROLE | her role sheet (orchestrator, who her specialists are) | its own entity: purpose, methods, examples |
   | 2. FACTS | now + platform (fresh, de-quotable) | same |
   | 3. CONTEXT | memories, skills, capability index, summary | task-relevant memories/skills |
   | 4. LAST WORD | soul kernel + channel register (typed/voice) | house rules + "your reader is Nova" output style |

4. **House rules are not persona.** Specialists keep a thin, universal
   last-slot block earned from real incidents: act-don't-narrate, memories
   describe the past, honesty about unknowns. Their output style targets a
   model reader (Nova): dense, structured, complete, no pleasantries.
5. **Per-agent role sheets as markdown** (`data/agents/<name>.md`,
   frontmatter + body), seeded from repo templates at startup, replacing
   prose-in-DB-patched-by-migrations. **Capability fields (model,
   allowed_tools) stay operator-gated** — prose is Nova's to edit,
   privileges are not.
6. **soul.md splits into kernel + extended.** Kernel = identity + register,
   hard budget (~500 tokens), always injected into Nova's slot 4, linted at
   startup (warn when over budget). Extended = everything she grows into,
   lazy-loaded like any other doc. Growth goes to the lazy layer, never the
   always-on layer.
7. **Feature docs are lazy-loaded** (`data/memory/capabilities/*.md`): BM25
   retrieval injects them when the query matches, plus a one-line index in
   the prompt and `read_memory_item` for explicit fetch (same shape as
   skills and the MCP lazy tool index, PR #54). Also chips at ROADMAP
   item 12(c) self-inventory.
8. **Accepted cost:** the proxy is a bottleneck — Nova's model quality is
   the ceiling for everything user-facing. That's the right trade (it's
   what makes her *her*), but it raises the stakes on main's model choice.

## Open questions (decide during implementation, with Jeremy)

- Register examples: move into the soul kernel (Nova can evolve her own
  voice, but a bad self-edit can flatten it) or stay code-side as a
  guardrail? Currently code-side (`_VOICE_BREVITY`).
- Agents table → files: exactly which columns move to frontmatter vs stay
  DB (enabled? routing_keywords?).
- Automations that notify (ntfy) — do they get a Nova voice-pass hop before
  the notification is sent? (Decision 2 says yes for anything speaking as
  her; design the hop's cost/latency.)

## Phases

**Phase 1 — slots in the runner (no file moves). SHIPPED 2026-07-17.**
Restructure `_build_system_prompt` into the slot order above. Stop
injecting soul + name backstop into specialists; add the house-rules
block for them. Give TYPED chat a channel-register block in Nova's
slot 4 (voice already has one via system_suffix) — typed parity is the
biggest immediate win. Verify: dispatch turn (specialist prompt has no
soul, has house rules); typed register probe.
*Shipped as designed: `MAIN_AGENT`/`_TYPED_REGISTER`/`_HOUSE_RULES` in
runner.py; conversation_summary + system_suffix moved inside the
assembler (they used to be appended after it, putting the summary
behind the soul). Live-verified per the plan.*

**Phase 2 — role sheets.** `data/agents/<name>.md` seeded from repo
templates; loader; `manage_agents` validates structure at write time;
capability fields remain in the DB. Frontmatter gets a per-agent
`max_tool_rounds` override (research specialists need ~3× the rounds of
managers; the global default is the `agents.max_tool_rounds` setting,
live since 2026-07-17). Verify: agent-creator makes a new agent → it
conforms and speaks to Nova in machine register.

**Phase 3 — soul kernel/extended + capability docs.** Kernel budget +
startup lint; extended sections + `capabilities/*.md` into the lazy layer
with an index line. Verify: "what can you do" answered from capability
docs, not journals; kernel over-budget warning fires.

**Phase 4 — proxy invariant.** Audit every operator-facing output path;
Nova last-hop for notification paths; label ops surfaces machine-register.
Verify: an automation's ntfy notification reads in Nova's voice.
