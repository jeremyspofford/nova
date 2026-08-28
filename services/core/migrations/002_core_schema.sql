-- The S1 spine: who lives here, what was said, and what each turn did.
-- gen_random_uuid() is built into postgres 13+, so no extension is needed.

CREATE TABLE people (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text NOT NULL,
    role          text NOT NULL CHECK (role IN ('owner', 'adult', 'kid', 'guest')),
    password_hash text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- One owner per instance, decided by the database — not by the register
-- handler remembering to look first.
CREATE UNIQUE INDEX people_one_owner ON people (role) WHERE role = 'owner';

CREATE TABLE sessions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id  uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

CREATE TABLE conversations (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id  uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    title      text,
    created_at timestamptz NOT NULL DEFAULT now(),
    active     boolean NOT NULL DEFAULT true
);

CREATE INDEX conversations_person_active
    ON conversations (person_id, created_at DESC) WHERE active;

CREATE TABLE messages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    role            text NOT NULL CHECK (role IN ('user', 'assistant')),
    content         text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX messages_conversation_created ON messages (conversation_id, created_at);

-- The trace ledger. status stays NULL until the turn closes, so an
-- unfinished row is visibly unfinished rather than silently "ok".
CREATE TABLE turns (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind            text NOT NULL DEFAULT 'chat',
    conversation_id uuid REFERENCES conversations (id) ON DELETE SET NULL,
    model           text,
    status          text CHECK (status IN ('ok', 'error', 'interrupted')),
    started_at      timestamptz NOT NULL DEFAULT now(),
    ended_at        timestamptz
);

CREATE TABLE turn_spans (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    turn_id     uuid NOT NULL REFERENCES turns (id) ON DELETE CASCADE,
    kind        text NOT NULL,
    name        text,
    started_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms int,
    meta        jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX turn_spans_turn ON turn_spans (turn_id, started_at);

CREATE TABLE settings (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
