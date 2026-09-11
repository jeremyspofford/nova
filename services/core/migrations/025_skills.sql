-- S17 skills: a procedure she wrote down, and the record of whether it helped.
--
-- Skills already half-existed: agents.skills is a text[] of names resolving to
-- <WORKSPACE_ROOT>/skills/<name>.md, pasted into that agent's instructions.
-- Nothing recorded where a procedure came from, whether it was ever read, or
-- whether reading it changed anything, and Nova herself could not read one.
--
-- THE BODY STAYS A FILE. It is markdown in the workspace volume, editable by
-- hand like a memory note and read by the same code agents already use. This
-- table is the RECORD around it: status, provenance, timestamps. The join key
-- is the name, which is also the file stem, so `name` carries the file-name
-- character class rather than a prose title's.
--
-- Nothing here asks anyone for approval (owner ruling 2026-09-03). Status is a
-- lifecycle, not a permission: a draft is not advertised because it has not
-- been read by the owner yet, and a retired one is not advertised because he
-- withdrew it.

CREATE TABLE skills (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The same class app/skills.py's NAME_RE enforces, spelled here too: the
    -- path is built from this string, and a row whose name is legal in SQL and
    -- illegal to the path helper would be a skill that can never be read.
    name        text NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9_-]{0,40}$'),
    title       text NOT NULL,
    -- The one line the roster shows. Composed from the SOURCE REQUESTS (the
    -- owner's own message rows, quoted and dated) when a draft is made, so the
    -- matching signal in the prompt is his words, not a model's paraphrase.
    summary     text NOT NULL,
    status      text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'active', 'flagged', 'retired')),
    -- 'eval' is the harness's own: a case may DECLARE the skill its turn is
    -- scored with, and the runner creates that row and deletes it again. It is
    -- a third origin rather than a lie about one of the two real ones, so a row
    -- left behind by a crashed run is identifiable as what it is.
    created_via text NOT NULL CHECK (created_via IN ('beat', 'page', 'eval')),
    -- Provenance, and DELIBERATELY NOT a foreign key. Turn retention sweeps
    -- rows; a skill whose evidence aged out must not be deleted with it, nor
    -- silently emptied. The page resolves what still exists and says plainly
    -- when a source turn is gone.
    source_turn_ids uuid[] NOT NULL DEFAULT '{}',
    -- The tool sequence, read from turn_spans at composition time. A skill
    -- therefore cannot describe a call that never ran — the same rule as the
    -- distillation notes (S14) and the delegation facts line (S12).
    step_names  text[] NOT NULL DEFAULT '{}',
    -- Written by the ledger when it flags, in words, naming the uses it read.
    flagged_reason text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX skills_status ON skills (status, name);

-- One row per load_skill span: WHICH skill was read in WHICH turn, and what
-- that turn's spans said afterwards.
--
-- outcome_known is the honest half. A turn that was stopped (S15) or that died
-- on a transport failure leaves an incomplete span record, and a use whose
-- outcome was never observed must not be counted as a clean one. A ledger that
-- reads "we did not look" as "it went fine" is the failure shape this repo
-- keeps finding, and the flag query filters on this column for that reason.
--
-- Nothing in here ever says a skill HELPED. failed_calls and guard_fires are
-- counts off the turn's own spans; the transition they drive is to `flagged`,
-- which is a raised hand, not a verdict.
CREATE TABLE skill_uses (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id      uuid NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
    -- ON DELETE SET NULL, like notices.turn_id: the use survives retention
    -- sweeping the turn, because the COUNT is the ledger's evidence and it
    -- must not shrink when Activity ages out.
    turn_id       uuid REFERENCES turns (id) ON DELETE SET NULL,
    loaded_at     timestamptz NOT NULL DEFAULT now(),
    failed_calls  int NOT NULL DEFAULT 0,
    guard_fires   int NOT NULL DEFAULT 0,
    outcome_known boolean NOT NULL DEFAULT false
);

CREATE INDEX skill_uses_skill ON skill_uses (skill_id, loaded_at DESC);
