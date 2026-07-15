# Self-updating model curation — proposal flow

Implementation plan (authored 2026-07-15 with Fable). Goal: the curated
models table (migration 018, `backend/app/curated_models.py`) must not
rot, or recommendations rot with it. A scheduled automation researches
new local/cloud models and PROPOSES rows; a human (or later, policy)
enables them. **Core invariant: automation writes always land disabled —
nothing self-enables, ever.**

## Design

### Data model (small migration)

Extend `curated_models` (check current columns first) with:
- `status text` — `active | proposed | rejected | retired_proposed`
  (existing enabled/disabled boolean maps onto this; migrate it)
- `provenance jsonb` — who proposed (agent/human), when, source URLs,
  and the one-paragraph rationale the researcher wrote
- `reviewed_at / reviewed_by` — audit trail for accept/reject

### The `manage_curated` tool

New tool in `backend/app/tools/`, granted ONLY to the model-manager
agent. Capabilities, enforced in the tool (not the prompt):
- `propose(row)` → inserts with `status='proposed'`, always. The tool
  physically cannot write `active`.
- `propose_retire(id, reason)` → flags an active row as
  `retired_proposed` (e.g. pin-guard says the provider no longer serves
  it); row STAYS active until a human confirms.
- `list_curated()` — so the researcher can dedupe before proposing.
- No update of active rows, no delete, no enable. Rejected proposals stay
  (with reason) so the researcher stops re-proposing them — the tool's
  `propose` must check for a prior rejected row with the same
  provider+model id and refuse with the stored reason.

### The automation

A scheduled automation (existing scheduler + automations infra) running
weekly: model-manager agent with `web_search` (searxng is keyless —
batteries-included holds), `fetch_url`, `manage_curated`, and
`list_models`. Prompt contract:
1. survey what's new (local: ollama library, HF trending GGUF; cloud:
   openrouter catalog — validated-discovery work from the llm-gateway
   lane already fetches this; REUSE that fetcher, don't scrape twice);
2. cross-check against `list_curated()` incl. rejected;
3. propose at most N (5) rows per run with rationale + VRAM/pricing
   facts — the tier-validation rules from the gateway lane apply to
   proposals too (a proposal with an impossible tier is refused by the
   tool using the same validation code);
4. check active rows against the pin-guard/discovery data and
   `propose_retire` any the provider stopped serving.

Runs under the autonomous safety rails (ledger + wall-clock budget) like
any automation — nothing new needed there.

### UI — review queue

Models page (card patterns exist from the Phase-1 pool work): a
"Proposals" section — each row shows the rationale, source links, facts,
and Accept / Reject buttons (Accept flips to active; Reject requires a
one-line reason that feeds the dedupe). Badge count on the section
header. Retire proposals appear in the same queue styled as warnings.
Must be reachable by navigation (memory rule): it lives on the Models
page itself, no buried route.

## Phases

1. Migration + `manage_curated` tool + tests for every forbidden
   transition (propose→active, touch-active, delete). Verify by driving
   the tool through a real agent turn in chat.
2. UI review queue + accept/reject endpoints (`_require_edit_mode`
   gates apply, same as other manual edits). Verify: propose via chat,
   accept in UI, model appears in recommendations.
3. The scheduled automation + prompt. Verify: run it manually once
   (automation "run now" path), inspect proposals for sanity, confirm
   ledger + kill-switch coverage, then enable the weekly schedule.

## Traps

- The researcher will hallucinate model facts — the tool validates
  provider+id against the discovery fetcher before insert; unverifiable
  local models (no HF/ollama hit) are refused, not stored as maybes.
- Don't let proposals influence recommendations while `proposed` —
  `model_recs.py` must filter on `status='active'` explicitly.
- Weekly cadence + N=5 cap keeps token spend bounded; the automation
  budget (wall-clock kill) is the hard backstop.
