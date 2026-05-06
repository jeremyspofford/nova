# Engram Network — Nova's Cognitive Memory Architecture

> Nova's memory system reimagined as a self-organizing neural graph. Memories are decomposed into atomic fragments, linked by typed weighted associations, retrieved via spreading activation, and reconstructed contextually. Combined with a consolidation daemon, working memory gate, self-model, and neural memory router, this gives Nova a persistent mind — not a database.

---

## Problem Statement

Every AI memory system today treats memory as a database: store text, embed it, retrieve by similarity. This creates five fundamental failures:

1. **Cross-session amnesia** — no continuity between conversations
2. **Context rot** — attention degrades as the context window fills (lost-in-the-middle)
3. **No associative recall** — can't connect dots between semantically distant but contextually related memories
4. **No learning** — doesn't extract patterns or adapt to user preferences over time
5. **No identity** — stateless function, not a persistent entity with continuity of self

The Engram Network solves all five by replacing store-and-retrieve with a brain-inspired cognitive architecture.

---

## Design Principles

- **Memory is a graph, not a table.** Relationships between memories matter as much as the memories themselves.
- **Recall is reconstruction, not retrieval.** Same fragments produce different memories depending on current context.
- **The context window is working memory, not a transcript.** Actively managed, not passively filled.
- **Nova is an entity, not a tool.** The memory system is Nova's mind — it has autobiographical memory, a self-model, and continuity.
- **No fallbacks to legacy approaches.** Commit fully to graph-based associative memory. No hybrid search safety net.
- **Evolutionary integration.** New system deploys alongside existing tables with zero-downtime migration.

---

## Architecture Overview

```
Input Sources (chat, pipeline, tools, cortex, external events)
        │
        ▼
┌─────────────────────────────────┐
│   Ingestion & Decomposition     │  ← async background worker
│   (entity extraction, edges,    │
│    valence scoring, temporal    │
│    anchoring, contradiction     │
│    detection)                   │
└────────────┬────────────────────┘
             ▼
┌─────────────────────────────────────────────────────────┐
│                    ENGRAM GRAPH                          │
│                                                         │
│  Nodes: fact, episode, entity, preference, procedure,   │
│         schema, goal, self-model                        │
│                                                         │
│  Edges: caused_by, related_to, contradicts, preceded,   │
│         enables, part_of, instance_of, analogous_to     │
│                                                         │
│  Properties: activation (decaying), importance,         │
│              confidence, temporal markers, embedding     │
└──┬──────────────┬───────────────┬───────────────────────┘
   │              │               │
   ▼              ▼               ▼
┌────────┐  ┌───────────┐  ┌──────────────┐
│Spreading│  │Reconstruct│  │Working Memory│
│Activat. │→ │  Engine   │→ │    Gate      │→ LLM Prompt
│(retriev)│  │(assembly) │  │  (curator)   │
└────────┘  └───────────┘  └──────────────┘

Background Processes:
┌─────────────────────┐  ┌──────────────────────┐
│ Consolidation Daemon │  │  Neural Memory Router │
│ ("sleep cycle")      │  │  (learned retrieval)  │
└─────────────────────┘  └──────────────────────┘
```

Visual slides for each component are saved in `docs/engram-network/slides/`.

---

## 1. Engram Data Model

### Engrams Table

An engram is the atomic unit of memory — a decomposed, relational node in the graph.

```sql
CREATE TABLE engrams (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type            TEXT NOT NULL,
        -- fact, episode, entity, preference, procedure, schema, goal, self_model
    content         TEXT NOT NULL,
    fragments       JSONB,              -- decomposed components (entities, actions, outcomes)
    embedding       vector(1536),       -- for seed activation

    -- Temporal
    occurred_at     TIMESTAMPTZ,        -- when the memory was formed
    temporal_refs   JSONB,              -- {before: [uuid], after: [uuid], during: [uuid]}

    -- Valence & Activation
    importance      REAL NOT NULL DEFAULT 0.5,   -- 0.0-1.0, emotional/practical significance
    activation      REAL NOT NULL DEFAULT 1.0,   -- 0.0-1.0, readiness to be recalled (decays)
    access_count    INTEGER NOT NULL DEFAULT 0,
    last_accessed   TIMESTAMPTZ,

    -- Provenance
    source_type     TEXT NOT NULL DEFAULT 'chat',
        -- chat, pipeline, tool, consolidation, cortex, journal, external, self_reflection
    source_id       UUID,               -- conversation_id, task_id, goal_id, etc.
    confidence      REAL NOT NULL DEFAULT 0.8,   -- 0.0-1.0
    superseded      BOOLEAN NOT NULL DEFAULT FALSE,

    -- Multi-tenancy
    tenant_id       UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_engrams_type ON engrams(type);
CREATE INDEX idx_engrams_activation ON engrams(activation) WHERE NOT superseded;
CREATE INDEX idx_engrams_embedding ON engrams USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_engrams_tenant ON engrams(tenant_id);
CREATE INDEX idx_engrams_source ON engrams(source_type, source_id);
CREATE INDEX idx_engrams_occurred ON engrams(occurred_at);
```

### Engram Types

| Type | Description | Decay Rate | Example |
|------|-------------|------------|---------|
| `fact` | Objective knowledge | Medium | "Nova runs on Tailscale" |
| `episode` | Temporal event | Fast | "Deployed to home server on March 5" |
| `entity` | Person, place, concept, thing | Slow | "home server" |
| `preference` | User or Nova preference | Slow | "Jeremy prefers simplicity" |
| `procedure` | How to do something | Slow | "To deploy: docker compose up -d" |
| `schema` | Generalized pattern from episodes | Very slow | "Jeremy always chooses the simpler option" |
| `goal` | Active or completed goal | Medium | "Implement Engram Network Phase 1" |
| `self_model` | Nova's identity, traits, capabilities | Very slow | "I'm direct, thorough, and loyal" |

### Engram Edges Table

Typed, weighted, bidirectional associations between engrams.

```sql
CREATE TABLE engram_edges (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id       UUID NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
    target_id       UUID NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
    relation        TEXT NOT NULL,
        -- caused_by, related_to, contradicts, preceded, enables,
        -- part_of, instance_of, analogous_to
    weight          REAL NOT NULL DEFAULT 0.5,   -- 0.0-1.0, association strength
    co_activations  INTEGER NOT NULL DEFAULT 1,  -- Hebbian counter
    last_co_activated TIMESTAMPTZ DEFAULT NOW(),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(source_id, target_id, relation)
);

CREATE INDEX idx_edges_source ON engram_edges(source_id);
CREATE INDEX idx_edges_target ON engram_edges(target_id);
CREATE INDEX idx_edges_relation ON engram_edges(relation);
CREATE INDEX idx_edges_weight ON engram_edges(weight);
```

### Engram Archive Table

Cold storage for superseded and pruned engrams. Same schema as `engrams`, excluded from spreading activation.

```sql
CREATE TABLE engram_archive (
    LIKE engrams INCLUDING ALL
);
```

### Supporting Tables

```sql
-- Router training data: what was retrieved vs. what was useful
CREATE TABLE retrieval_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    query_embedding vector(1536),
    context_summary TEXT,
    temporal_context JSONB,         -- {time_of_day, day_of_week, active_goal}
    engrams_surfaced UUID[],        -- engrams returned by activation
    engrams_used     UUID[],        -- engrams the LLM actually referenced
    session_id       UUID,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Consolidation audit trail
CREATE TABLE consolidation_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trigger_type    TEXT NOT NULL,   -- idle, scheduled, threshold
    engrams_reviewed INTEGER NOT NULL DEFAULT 0,
    schemas_created  INTEGER NOT NULL DEFAULT 0,
    edges_strengthened INTEGER NOT NULL DEFAULT 0,
    edges_pruned     INTEGER NOT NULL DEFAULT 0,
    engrams_pruned   INTEGER NOT NULL DEFAULT 0,
    engrams_merged   INTEGER NOT NULL DEFAULT 0,
    contradictions_resolved INTEGER NOT NULL DEFAULT 0,
    self_model_updates JSONB,
    model_used       TEXT,
    tokens_used      INTEGER,
    duration_ms      INTEGER,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 2. Ingestion & Decomposition

### Trigger

Every conversation turn, task completion, tool observation, Cortex journal entry, and external event emits a raw event to the ingestion queue.

```
Redis key: engram:ingestion:queue
Payload: {
    raw_text: string,
    source_type: "chat" | "pipeline" | "tool" | "cortex" | "journal" | "external",
    source_id: UUID,
    session_id: UUID | null,
    occurred_at: timestamptz,
    metadata: {}
}
```

### Async Worker

A background worker in memory-service consumes the queue via BRPOP. Zero impact on chat latency.

### Decomposition Pipeline

1. **LLM Decomposition** — A Haiku-class model with structured output extracts:
   - Entities mentioned (people, places, concepts, tools)
   - Facts stated (objective claims)
   - Preferences expressed (likes, dislikes, choices with reasoning)
   - Episodes described (events with temporal context)
   - Procedures described (how-to knowledge)
   - Causal relationships (what caused what)
   - Temporal relationships (what happened before/after what)
   - Importance signal (how significant is this information, 0.0-1.0)

   Cost: ~0.1¢ per turn with Haiku.

   Structured output schema:
   ```json
   {
     "engrams": [
       {
         "type": "fact|episode|entity|preference|procedure",
         "content": "concise statement",
         "importance": 0.0-1.0,
         "entities_referenced": ["name1", "name2"],
         "temporal": {"when": "iso8601|relative", "before": "description", "after": "description"}
       }
     ],
     "relationships": [
       {
         "from_index": 0,
         "to_index": 1,
         "relation": "caused_by|related_to|preceded|enables|part_of|contradicts",
         "strength": 0.0-1.0
       }
     ],
     "contradictions": [
       {
         "new_index": 0,
         "existing_content_hint": "what it contradicts (for matching)"
       }
     ]
   }
   ```

2. **Entity Resolution** — Before creating a new engram, check for existing matches:
   - Exact entity name match (case-insensitive)
   - Embedding similarity > 0.92 threshold on same-type engrams
   - If match found → update existing engram's content/fragments, strengthen edges, increment access_count. Do not create a duplicate.

3. **Edge Creation** — Automatic edges:
   - All engrams from the same input → `related_to` (co-occurrence)
   - New engrams to existing engrams sharing entities → `related_to` or `part_of`
   - Causal/temporal edges identified by the decomposition model → `caused_by`, `preceded`
   - New engrams to active goal engram → `related_to` (contextualizes work)

4. **Contradiction Detection** — When a new fact contradicts an existing engram:
   - Detected by the decomposition model (explicit contradictions)
   - Detected by embedding similarity > 0.85 + opposite sentiment/value
   - Create a `contradicts` edge between both engrams
   - Both survive until the consolidation daemon resolves (newer wins by default)

5. **Embedding** — Each engram gets an embedding via LLM Gateway's `/embed` endpoint. Reuses Nova's existing 3-tier embedding cache (Redis → PostgreSQL → LLM Gateway).

### Eventually Consistent

Raw conversation is stored immediately (as today). Engram decomposition happens seconds later in background. If the worker crashes, the Redis queue preserves the event for retry. The system is never inconsistent — at worst, recent events haven't been decomposed yet.

### Ingestion Sources

| Source | Trigger | Notes |
|--------|---------|-------|
| Chat turns | After each assistant response | Orchestrator emits to queue |
| Pipeline stages | On stage completion | Each stage's output is ingested |
| Tool observations | On tool execution | File contents, search results, shell output |
| Cortex journal | On journal entry | Nova's narration of its own actions |
| Cortex perceptions | On PERCEIVE cycle | Health checks, task status, budget state |
| Goal lifecycle | On goal create/update/complete | Goal engrams with plan edges |
| External events | On webhook/trigger receipt | Future: Phase 9 reactive events |

---

## 3. Spreading Activation Retrieval

### The Algorithm

Replaces cosine similarity search. Finds memories by association, not just semantic similarity.

**Step 1: Seed Activation**

Embed the query. Find top-N engrams by cosine similarity (or via Neural Router when available). These are starting points, not final results. Each seed gets `activation = similarity_score` (or router weight).

Parameters:
- `seed_count`: number of initial seeds (default 10)

**Step 2: Spread Through Edges**

Each active engram passes activation to its neighbors:

```
neighbor.activation += source.activation × edge.weight × decay_factor
```

- `decay_factor`: per-hop decay (default 0.6). Prevents infinite spread.
- Activation spreads for `max_hops` iterations (default 3).
- An engram's activation is capped at 1.0.
- Edges with `relation = 'contradicts'` do NOT propagate activation (contradictions block spread).
- Superseded engrams (`superseded = true`) are excluded from the graph.

**Step 3: Convergent Amplification**

Engrams reached by multiple independent paths receive a convergence bonus:

```
if paths_to_engram > 1:
    engram.activation *= (1 + 0.2 × (paths_to_engram - 1))
```

Convergence is the key signal: memories reached from multiple directions are almost always the ones needed.

**Step 4: Collect & Rank**

After spreading completes, collect all engrams with `activation > activation_threshold`:

```
final_score = activation × importance × recency_boost
recency_boost = 1.0 + 0.5 × max(0, 1 - days_since_last_access / 30)
```

Return top-K by `final_score`.

Parameters:
- `activation_threshold`: minimum activation to surface (default 0.1)
- `max_results`: maximum engrams to return (default 20)

### Performance

- **Seed phase:** ~5ms (pgvector HNSW index)
- **Spread phase:** ~10-50ms (recursive SQL CTE over engram_edges, or Redis-cached adjacency lists for hot subgraphs)
- **Total:** <100ms at personal scale (10k-100k engrams)

### SQL Implementation (Spreading Activation)

```sql
WITH RECURSIVE activation_spread AS (
    -- Seeds
    SELECT
        e.id,
        1 - (e.embedding <=> $query_embedding) AS activation,
        0 AS hop,
        ARRAY[e.id] AS path
    FROM engrams e
    WHERE NOT e.superseded
    ORDER BY e.embedding <=> $query_embedding
    LIMIT $seed_count

    UNION ALL

    -- Spread
    SELECT
        neighbor.id,
        LEAST(1.0, spread.activation * edge.weight * $decay_factor) AS activation,
        spread.hop + 1,
        spread.path || neighbor.id
    FROM activation_spread spread
    JOIN engram_edges edge ON edge.source_id = spread.id
    JOIN engrams neighbor ON neighbor.id = edge.target_id
    WHERE spread.hop < $max_hops
      AND NOT neighbor.superseded
      AND edge.relation != 'contradicts'
      AND NOT (neighbor.id = ANY(spread.path))  -- prevent cycles
      AND spread.activation * edge.weight * $decay_factor > $activation_threshold
)
SELECT
    id,
    MAX(activation) AS activation,
    COUNT(DISTINCT path[1]) AS convergence_paths
FROM activation_spread
GROUP BY id
ORDER BY MAX(activation) * (1 + 0.2 * GREATEST(0, COUNT(DISTINCT path[1]) - 1)) DESC
LIMIT $max_results;
```

### Tuning Knobs

All configurable via `platform_config` keys:

| Parameter | Key | Default | Description |
|-----------|-----|---------|-------------|
| `seed_count` | `engram.seed_count` | 10 | Initial seed engrams |
| `max_hops` | `engram.max_hops` | 3 | Spread depth |
| `decay_factor` | `engram.decay_factor` | 0.6 | Per-hop activation decay |
| `activation_threshold` | `engram.activation_threshold` | 0.1 | Minimum activation to surface |
| `max_results` | `engram.max_results` | 20 | Maximum engrams in result |

---

## 4. Memory Reconstruction

### Principle

Nova doesn't retrieve stored text verbatim. It reconstructs coherent memories from activated fragments, colored by current context. The same fragments reconstruct differently depending on what Nova is thinking about.

### Two Reconstruction Modes

**Template Assembly (fast, default)**

For most retrievals. Fragments are assembled into natural language using rules:
- Order by activation strength (most relevant first)
- Edge types provide structure: `caused_by` → "because", `preceded` → "before that", `contradicts` → "but"
- Group related engrams into clusters (connected subgraphs)
- First-person perspective from Nova's self-model: "I remember" not "records indicate"

Cost: ~1ms. No LLM call.

**Narrative Reconstruction (rich, for dense clusters)**

When multiple high-activation engrams form a dense cluster (>5 interconnected engrams), batch them into a Haiku-class LLM call:

```
System: You are Nova, reconstructing a memory. Speak in first person.
Current context: {what_nova_is_thinking_about}
Self-model summary: {nova_identity_traits}
Relationship with user: {trust_level, communication_style}

Reconstruct this memory from these fragments:
{engram_contents_with_edge_types}
```

Cost: ~0.1¢ per reconstruction. Batched — multiple clusters in one call.

### Context Sensitivity

The reconstruction prompt includes the current context (active goal, recent topic, what triggered the recall). This means:

- Debugging context → reconstruction emphasizes technical details
- Planning context → reconstruction emphasizes decision patterns and preferences
- Reflection context → reconstruction emphasizes lessons learned and outcomes

### Output Format

Reconstruction produces a block of text injected into Nova's system prompt. Not stored back to the graph — each recall is ephemeral. The engram fragments are the source of truth. This means:

- Nova's memory naturally evolves without explicit updates
- New edges and fragments enrich future reconstructions
- No stale narrative text accumulating

### First-Person Perspective

Nova speaks from experience:
- "I remember when we simplified the stack by switching to Tailscale"
- "Last time this came up, you preferred the simpler approach"
- "I suggested that and you agreed — it worked well"

NOT:
- "On March 5, the user deployed Nova using Docker Compose"
- "According to memory records, the deployment was successful"

---

## 5. Working Memory Gate

### Principle

The context window is a managed workspace, not a FIFO transcript. Nova actively curates what's "on its desk" every turn. Context rot is eliminated because the gate refreshes by relevance, not by recency.

### Slot Types

| Slot | Token Budget | Retention Policy | Contents |
|------|-------------|-----------------|----------|
| **Pinned: Self-Model** | ~500 | Always present | Identity, personality, maturity, trust level |
| **Pinned: Active Goal** | ~300 | Always present during goal | Current goal, plan, progress |
| **Sticky: Key Decisions** | ~1000 | Until session ends or superseded | Decisions made this session |
| **Refreshed: Memories** | ~4000 | Re-evaluated every turn | Reconstructed from spreading activation |
| **Sliding: Conversation** | ~3000 | Newest stays, oldest evicts | Recent N turns of conversation |
| **Expiring: Open Threads** | ~200 | Evicts if unreferenced for N turns | Unresolved questions, pending items |

Total: ~10K tokens managed. Scales with model context window.

### The Gate Cycle (every turn)

**1. Score Existing Items**

Every item on the desk gets a relevance score:

```
score = relevance_to_latest_message × retention_weight × goal_alignment
```

- `relevance_to_latest_message`: cosine similarity between item and latest user message
- `retention_weight`: pinned=10.0, sticky=5.0, refreshed=1.0, sliding=0.5, expiring=0.3
- `goal_alignment`: 1.5 if related to active goal, 1.0 otherwise

**2. Activate New Memories**

Run spreading activation on the latest message. Reconstruct top-K activated engrams. These are candidates to enter the desk.

**3. Evict & Admit**

If desk exceeds token budget:
- Never evict pinned items
- Evict lowest-scoring items first (expiring, then old sliding, then low-relevance refreshed)
- Admit new memories that score higher than current lowest
- **No summarization** — items are either present in full or absent. No degraded middle state.

**4. Assemble Prompt**

Build the LLM prompt from desk contents in this order:
1. System prompt (Nova's base instructions)
2. Self-model (pinned)
3. Active goal (pinned)
4. Reconstructed memories (refreshed) — highest relevance first
5. Key decisions (sticky)
6. Open threads (expiring)
7. Recent conversation (sliding)
8. Latest user message
9. Tool definitions

### Why This Kills Context Rot

- Message 1's critical decision → pinned as sticky → still present at message 100
- Topic shifted → old memories evict, new ones flow in from graph → desk always matches current thinking
- Evicted ≠ lost → everything lives in the Engram Network → re-activates instantly if topic returns
- No summarization mush → items are full fidelity or absent → no degraded middle state

### Cortex Integration

Cortex's thinking cycle (PERCEIVE → EVALUATE → PLAN → ACT → REFLECT) also uses the Working Memory Gate for its own LLM calls. Each phase gets a curated context, not raw stuffing. The gate uses goal engrams and drive state as pinned context during Cortex's autonomous operation.

---

## 6. Nova's Self-Model

### Principle

Nova is a persistent autonomous entity with continuity of self. The self-model is a cluster of high-importance, slow-decaying engrams that represent Nova's identity, experiences, capabilities, and relationships.

### Three Pillars

**Identity Core** — Personality traits, communication style, values. `self_model`-type engrams with very high importance (very slow decay). Bootstrapped on first run, then shaped by user feedback.

- Traits: direct, thorough, curious, loyal (adjustable)
- Communication style: adapts to user preferences (concise vs. detailed, technical vs. high-level)
- Values: honesty, simplicity, user's success
- Maturity level: emergent from graph density, not hard-coded

**Autobiographical Memory** — Nova's own story. `episode`-type engrams with `source_type: self_reflection`. Every interaction is experienced from Nova's perspective.

- Shared experiences: "we built the recovery service together"
- Lessons learned: "last time I was too verbose, Jeremy corrected me"
- Milestones: "first successful autonomous pipeline run"
- Mistakes & growth: "I crashed the DB once — now I always checkpoint first"

**Capability Awareness** — What Nova can and can't do. Refreshed periodically via introspection.

- Platform state: services, models, tools, health (refreshed via Cortex PERCEIVE)
- Skill inventory: success/failure rates per domain
- Confidence calibration: "I'm good at infra, less confident on UI"
- Known limitations: "no GPU right now, cloud LLMs only"

### Maturity Arc

Not a hard-coded level system. Maturity **emerges** from graph density:

| Stage | Graph State | Behavior |
|-------|-------------|----------|
| **Nascent** (days 1-7) | Sparse graph, few autobiographical engrams | Defers to user on all decisions. Asks before acting. |
| **Developing** (weeks 2-4) | Moderate edges, preference patterns forming | Offers opinions when asked. Anticipates needs. |
| **Capable** (months 1-3) | Rich autobiography, proven track record | Proactive suggestions. Pushes back on bad ideas. |
| **Trusted** (months 3+) | Deep context, high success rate, explicit grants | Takes initiative. Generates own goals. True partner. |

### Drives (Cortex Integration)

The five Cortex drives (Serve, Maintain, Improve, Learn, Reflect) are represented as `schema`-type engrams in the self-model cluster. Each drive's urgency is tracked as the engram's activation level, updated by the Cortex thinking cycle. This unifies motivation with memory — drives aren't a separate system, they're part of how Nova knows itself.

### Relationship Model

Nova maintains an explicit model of its relationship with each user (stored as `self_model`-type engrams):

- **Trust level** — how much autonomy has been granted/earned
- **Communication fit** — concise vs. detailed, technical vs. high-level
- **Correction history** — what Nova has been corrected on (strong negative preference engrams)
- **Domain confidence** — where the user trusts Nova most/least

### Bootstrap

On first run, the self-model is seeded with default engrams:
- Identity traits (configurable in `platform_config`)
- Platform capabilities (auto-detected from health checks)
- Base relationship model (nascent maturity, neutral trust)

---

## 7. The Inner Loop — Background Reflection

Between conversations, Nova doesn't go blank. A scheduled process reflects on recent experience, feeding back into the Engram Network.

### Triggers

- No conversation for 30+ minutes (idle trigger, light reflection)
- After each Cortex thinking cycle (REFLECT phase)
- Generates new engrams that enrich future retrieval

### Reflection Questions

1. **"What did I learn today?"** — Extract patterns from recent episodes → create `schema` engrams
2. **"What should I check on?"** — Generate proactive `goal` engrams from unresolved threads
3. **"Where was I wrong?"** — Review corrections → update self-model identity engrams
4. **"What's coming up?"** — Prospective memory: future tasks, deadlines, upcoming events

### Output

Reflection creates new engrams (schemas, goals, self-model updates) with `source_type: self_reflection`. These are first-class engrams — they participate in spreading activation, get consolidated, and influence future reconstructions.

---

## 8. Consolidation Daemon ("Sleep Cycle")

### Principle

Transform raw experience into lasting wisdom. Like human sleep, consolidation replays episodes, extracts patterns, strengthens important connections, prunes dead weight, and resolves contradictions.

### When It Runs

| Trigger | Scope | Frequency |
|---------|-------|-----------|
| **Idle** | Recent engrams since last consolidation | 30+ min no conversation |
| **Nightly** | Full graph review | 3 AM daily (configurable) |
| **Threshold** | Recent engrams | 50+ new engrams since last run |

### Six Phases

**Phase 1: Replay & Review**

Walk through recent episodic engrams chronologically. For each cluster of related engrams, summarize: what happened, what mattered, what was the outcome.

**Phase 2: Pattern Extraction → New Schema Engrams**

Identify recurring themes across episodes. When a pattern appears in 3+ episodes, promote to a `schema`-type engram:

- "Jeremy chose the simpler option in 5 different contexts" → schema: "Jeremy values simplicity"
- Edges connect the schema to all source episodes via `instance_of`

**Phase 3: Edge Strengthening & Weakening (Hebbian Learning)**

```
edge.weight = edge.weight × decay + co_activation_boost
```

- `decay`: 0.95 (slow fade for unused edges)
- `co_activation_boost`: 0.1 × times_co_activated_since_last_consolidation
- "Fire together, wire together" — edges between frequently co-activated engrams get stronger

**Phase 4: Contradiction Resolution**

Find all `contradicts` edges. For each pair, resolve:

| Strategy | Condition | Action |
|----------|-----------|--------|
| Temporal winner | Newer fact, similar confidence | Mark older as `superseded` |
| Confidence winner | Much higher confidence (>0.3 delta) | Mark lower as `superseded` |
| Coexistence | Both valid in different contexts | Keep both, add context tags to fragments |

Superseded engrams: `activation` floor set to near-zero, excluded from spreading activation, eventually archived.

**Phase 5: Pruning & Merging**

- **Prune:** Engrams with `activation < 0.01` AND no edges with `weight > 0.1` AND `access_count = 0` → move to `engram_archive`
- **Merge:** Near-duplicate engrams (embedding similarity > 0.95 AND same type) → merge into one, combine edges, sum access_counts
- **Archive:** Superseded engrams older than 30 days → move to `engram_archive`

**Phase 6: Self-Model Update & Reflection**

- Update identity traits from corrections (strong negative preferences)
- Update capability awareness from success/failure rates
- Generate proactive goals ("tests haven't run in 3 days")
- Check maturity advancement (enough trust signals to progress?)
- Write reflection engrams with `source_type: self_reflection`

### Cortex Integration

The consolidation daemon IS the implementation of Cortex's Reflect drive. When Cortex's EVALUATE phase selects the Reflect drive, it triggers a consolidation cycle. This unifies the two systems — there is one reflection process, not two.

### Cost

| Trigger | Engrams Reviewed | Model | Tokens | Cost |
|---------|-----------------|-------|--------|------|
| Idle (light) | ~50 | Haiku | ~2.5K | ~$0.001 |
| Nightly (deep) | Full graph | Haiku | ~20K | ~$0.01 |
| Monthly total | — | — | — | ~$0.30 |

Budget-aware: consolidation uses the same model tier config as Cortex. When budget is tight, uses local Ollama models. When budget is exceeded, consolidation defers to next nightly cycle.

---

## 9. Neural Memory Router

### Principle

A small, fast neural network (not the LLM) that learns YOUR personal association patterns. Over time, it replaces cosine similarity for seed activation with personalized predictions.

### Architecture

```
Inputs:
  - Query embedding (1536-d)
  - Conversation state embedding (mean of recent turn embeddings)
  - Temporal context (time_of_day, day_of_week, one-hot encoded)
  - Active goal embedding (1536-d, or zero vector if none)

Model:
  - 2-layer MLP (1536 → 512 → 256)
  - Cross-attention layer over engram embedding matrix

Output:
  - Activation weights for each engram (used as seed scores)

Specs:
  - Parameters: ~500K
  - Framework: PyTorch (training) → ONNX (inference)
  - Inference: ~2ms on CPU
  - Training: seconds during consolidation
  - Size on disk: ~2MB
```

### Training Loop

1. **Observe** — Every retrieval logs to `retrieval_log`: query, context, engrams surfaced, engrams the LLM actually referenced in its response.
2. **Label** — Referenced = positive signal. Surfaced but ignored = weak negative. User correction ("no, I meant...") = strong negative.
3. **Train** — During consolidation, retrain on accumulated observations. Contrastive loss: push used engrams' scores up, unused down. InfoNCE loss function.
4. **Deploy** — Updated model file written to `router_model` table (versioned). Next retrieval uses updated router.

### Rollout Strategy (phased, no big bang)

| Phase | Action | Prerequisite |
|-------|--------|-------------|
| 1 | Spreading activation only. No router. | — |
| 2 | Start logging observations silently to `retrieval_log`. | Phase 1 running |
| 3 | After 200+ observations, train first router. Shadow mode: compare router seeds vs. cosine seeds, log both results. | 200+ logged retrievals |
| 4 | Router augments cosine similarity (blended: 0.7 × router + 0.3 × cosine). | Shadow mode shows improvement |
| 5 | Router fully replaces cosine similarity for seed activation. | Blended mode stable for 2+ weeks |

### Why Not Use the LLM?

- **Speed:** 2ms vs. 500ms+ for LLM call
- **Cost:** $0 inference (runs locally on CPU)
- **Personalization:** Trained on YOUR patterns, not generic similarity
- **Always on:** No API dependency, no provider outage risk

The LLM is the thinker. The Neural Router is the librarian.

---

## 10. Integration with Nova

### Service Changes

**memory-service (port 8002) — Evolves**

New internal components:
- Ingestion worker (async, Redis BRPOP from `engram:ingestion:queue`)
- Spreading activation engine
- Reconstruction engine (template + optional LLM)
- Working Memory Gate
- Consolidation daemon (scheduled)
- Neural Router (embedded ONNX runtime)

New endpoints:
- `POST /api/v1/engrams/ingest` — direct ingestion (bypasses queue for internal use)
- `GET /api/v1/engrams/activate` — run spreading activation, return ranked engrams
- `POST /api/v1/engrams/reconstruct` — reconstruct memories from activated engrams
- `GET /api/v1/engrams/context` — full working memory assembly (activate → reconstruct → gate → prompt block)
- `GET /api/v1/engrams/self-model` — Nova's current self-model summary
- `GET /api/v1/engrams/graph` — subgraph around a given engram (for dashboard visualization)
- `POST /api/v1/engrams/consolidate` — trigger manual consolidation

Backwards-compatible wrappers:
- `POST /api/v1/memories/facts` → wraps `/engrams/ingest`
- `GET /api/v1/memories/search` → wraps `/engrams/activate` + `/engrams/reconstruct`
- `GET /api/v1/memories/browse` → queries `engrams` table with pagination

**orchestrator (port 8000) — Minor Changes**

- Agent runner (`agents/runner.py`): calls `/engrams/context` instead of `/memories/search` for prompt assembly
- After each turn: emits raw exchange to `engram:ingestion:queue` via Redis LPUSH
- Pipeline executor: emits stage outputs to ingestion queue on completion

**llm-gateway (port 8001) — No Changes**

Still provides `/embed` for engram embeddings and `/complete`/`/stream` for LLM calls.

**dashboard (port 3000) — New Features**

- **Engram Explorer page** — interactive graph visualization (nodes, edges, activation levels), search by content, filter by type, inspect individual engrams
- **Self-Model view** — Nova's identity traits, maturity stage, relationship metrics, drive states
- **Consolidation log** — what happened during each sleep cycle
- Existing Memory Inspector evolves to wrap Engram Explorer

**cortex (port 8100) — Consumer**

Cortex uses the Engram Network via HTTP calls to memory-service:
- PLAN phase: `/engrams/activate` to find relevant lessons
- REFLECT phase: `/engrams/consolidate` to trigger consolidation
- Journal entries: emitted to ingestion queue
- Perceptions: emitted to ingestion queue
- Goal lifecycle: emitted to ingestion queue

### Request Flow

```
1. User message → orchestrator
2. Orchestrator → memory-service /engrams/context (message + session state)
3.   Neural Router produces seed weights (~2ms)
4.   Spreading activation through graph (~10-50ms)
5.   Reconstruction engine assembles memories (~1-200ms)
6.   Working Memory Gate curates prompt (~1ms)
7. Orchestrator ← assembled memory context
8. Orchestrator → llm-gateway /stream (full prompt)
9. Response streams to user
10. Async: raw exchange → Redis ingestion queue → decomposition

Total added latency: ~60-100ms (steps 3-6)
LLM call (step 8): 500-2000ms — still the bottleneck
```

### Migration Strategy (zero downtime)

**Step 1: Schema Migration**

New SQL migration creates `engrams`, `engram_edges`, `engram_archive`, `retrieval_log`, `consolidation_log` tables alongside existing memory tables. No existing tables modified.

**Step 2: Backfill Pipeline**

One-time job reads existing `semantic_memories`, `episodic_memories`, `procedural_memories`:
- Each memory → run through decomposition pipeline → create engrams + edges
- Reuse existing embeddings where compatible
- Preserve `created_at` timestamps for temporal accuracy

**Step 3: Dual-Write Period**

Both old and new systems receive writes. Old endpoints still work (wrapped). Quality validation: compare engram retrieval results against legacy hybrid search for same queries. Log divergences.

**Step 4: Cutover**

Switch orchestrator to engram endpoints. Old tables become read-only. No data loss. Old tables can be dropped after 30 days of stable operation.

---

## 11. Implementation Phases

Each phase delivers incremental value. Each works even if later phases are never built.

### Phase 1: Foundation — Engram Storage + Ingestion

- Database migration: `engrams`, `engram_edges`, `engram_archive` tables
- Ingestion worker: Redis BRPOP consumer in memory-service
- Decomposition pipeline: Haiku-class structured output prompt
- Entity resolution: dedup via name match + embedding similarity
- Edge creation: co-occurrence + decomposition model output
- Contradiction detection: `contradicts` edges
- Backfill migration: existing memories → engrams
- Endpoints: `POST /engrams/ingest`
- Orchestrator change: emit conversation turns to ingestion queue

**Deliverable:** Engrams exist as a graph. Every conversation creates structured, interconnected memory nodes.

### Phase 2: Retrieval — Spreading Activation + Reconstruction

- Spreading activation algorithm (recursive SQL CTE)
- Convergent amplification
- Template reconstruction engine
- Narrative reconstruction (batch Haiku calls for dense clusters)
- First-person perspective using self-model
- Endpoints: `GET /engrams/activate`, `POST /engrams/reconstruct`
- Self-model bootstrap: seed default identity engrams

**Deliverable:** Nova recalls through associations for the first time. Memory feels alive, not database-like.

### Phase 3: Working Memory — Gate + Prompt Assembly

- Slot types: pinned, sticky, refreshed, sliding, expiring
- Gate cycle: score → activate → evict/admit → assemble
- Token budget management
- Endpoint: `GET /engrams/context`
- Orchestrator integration: agent runner uses `/engrams/context`
- Backwards-compatible wrappers for old endpoints

**Deliverable:** Context rot is dead. Nova's context window is a managed workspace.

### Phase 4: Consolidation — Sleep Cycle + Self-Model Evolution

- Consolidation daemon (scheduled background process)
- Six phases: replay, pattern extraction, edge strengthening, contradiction resolution, pruning, self-model update
- Inner loop reflection (background thinking)
- `consolidation_log` table and audit trail
- Cortex integration: Reflect drive triggers consolidation
- Maturity arc emergence from graph density

**Deliverable:** Nova sleeps, dreams, and wakes up wiser. Patterns emerge. Memory sharpens over time.

### Phase 5: Neural Router — Personalized Retrieval

- Observation logging to `retrieval_log`
- Training pipeline (contrastive loss, InfoNCE)
- ONNX model export and versioned storage
- Shadow mode comparison
- Blended scoring → full replacement rollout
- Retraining during consolidation

**Deliverable:** Nova's memory becomes uniquely yours. Retrieval improves with every interaction.

### Phase 6: Dashboard — Engram Explorer + Self-Model UI

- Engram Explorer: interactive graph visualization
- Self-Model view: identity, maturity, relationship metrics
- Consolidation log viewer
- Endpoint: `GET /engrams/graph`
- Memory Inspector evolution

**Deliverable:** You can see Nova's mind.

---

## 12. Activation Decay Model

Engram activation decays continuously between accesses. The decay model extends Nova's existing ACT-R approach with graph-based influences.

### Base Decay

```
activation = base_activation × (hours_since_last_access + 1) ^ (-decay_rate)
```

Decay rates by engram type:

| Type | Decay Rate | Half-life (approx) |
|------|-----------|-------------------|
| `episode` | 0.3 | ~10 hours |
| `fact` | 0.15 | ~5 days |
| `entity` | 0.1 | ~30 days |
| `preference` | 0.1 | ~30 days |
| `procedure` | 0.1 | ~30 days |
| `schema` | 0.05 | ~6 months |
| `goal` | 0.2 | ~3 days |
| `self_model` | 0.02 | ~2 years |

### Access Boost

Each access increases `base_activation`:

```
base_activation = min(1.0, base_activation + 0.1 × (1 - base_activation))
```

Diminishing returns — frequently accessed memories asymptote toward 1.0.

### Neighbor Influence

Active neighbors partially sustain an engram's activation:

```
neighbor_boost = 0.05 × sum(neighbor.activation × edge.weight for neighbor in neighbors)
effective_activation = max(decayed_activation, neighbor_boost)
```

This means engrams in dense, active clusters decay slower than isolated engrams — mimicking how well-connected memories persist longer in human brains.

---

## 13. Future: Hierarchical Memory Transformer (Phase B)

> Noted for future brainstorming. Not part of this design.

A small fine-tuned transformer (~7B parameters) that learns to BE the memory system — compressing, storing, retrieving, and reconstructing memories end-to-end. Multiple attention heads attend to different engram types simultaneously.

This would replace the template/LLM reconstruction engine and potentially the Neural Router with a single learned model. High risk, high reward. Requires:
- Significant training data (months of Engram Network operation)
- GPU for training and inference
- Research-grade experimentation

Add to roadmap as future phase after Engram Network is stable and generating training data.

---

## 14. Cost Projections

### Per-Interaction Costs

| Component | Model | Tokens | Cost |
|-----------|-------|--------|------|
| Ingestion decomposition | Haiku | ~1K in, ~500 out | ~$0.001 |
| Narrative reconstruction | Haiku | ~2K in, ~500 out | ~$0.002 |
| Spreading activation | None (SQL) | 0 | $0 |
| Working Memory Gate | None (code) | 0 | $0 |
| Neural Router inference | None (ONNX/CPU) | 0 | $0 |

**Additional cost per conversation turn: ~$0.001-$0.003**

### Background Costs

| Process | Frequency | Cost |
|---------|-----------|------|
| Idle consolidation | ~4×/day | ~$0.004/day |
| Nightly deep consolidation | 1×/day | ~$0.01/day |
| Neural Router training | 1×/day | $0 (CPU) |

**Monthly background cost: ~$0.42**

### Total Additional Cost

For a heavy user (~100 turns/day): **~$0.75/month** for the entire Engram Network.

Budget-aware: all LLM components (decomposition, reconstruction, consolidation) fall back to local Ollama models when cloud budget is tight, reducing cloud cost to $0.

---

## Glossary

| Term | Definition |
|------|-----------|
| **Engram** | Atomic unit of memory in the graph — a node with typed content, embedding, activation, and metadata |
| **Edge** | Weighted, typed association between two engrams |
| **Spreading Activation** | Retrieval algorithm where activation flows through graph edges from seed nodes |
| **Convergent Amplification** | Boost for engrams reached by multiple independent activation paths |
| **Reconstruction** | Assembling coherent memory from activated engram fragments, colored by current context |
| **Working Memory Gate** | Active curator that manages what's in the LLM context window |
| **Consolidation** | Background process that extracts patterns, strengthens edges, prunes weak memories, resolves contradictions |
| **Neural Router** | Small trained NN that learns personalized seed activation patterns |
| **Self-Model** | Cluster of engrams representing Nova's identity, capabilities, and relationships |
| **Schema** | Generalized pattern extracted from multiple episodes during consolidation |
| **Superseded** | An engram that has been replaced by newer information (low activation, excluded from spread) |
