-- D-012: one kernel decides who may call what. This table is the DATA that
-- kernel reads — a tool's disposition lives here, never in an if-chain, so a
-- tool moves tier later with a row edit and no code change.
--
-- disposition is the whole decision:
--   auto     the kernel allows it outright (contained, reversible, visible)
--   consent  the kernel raises an approval card and allows only a burned,
--            args-bound, single-use consent (fetch_url — the one tool that
--            reaches OUT to the internet)
--   deny     the kernel refuses by name
-- A tool with NO row here is DENIED (fail-closed) by the kernel, and the
-- pinned tripwire test reddens the day a registered tool has no row — a new
-- tool is never auto by accident. (notify/step-up are later dispositions;
-- the CHECK is widened deliberately when one lands, never pre-emptively.)
--
-- risk_tier is descriptive only (audit/UI) — the kernel reads disposition.

CREATE TABLE action_classes (
    action_class text PRIMARY KEY,
    risk_tier    text NOT NULL,
    disposition  text NOT NULL CHECK (disposition IN ('auto', 'consent', 'deny')),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Seed per ruling S3-R1: consent-tier is {fetch_url} ONLY (egress + untrusted
-- content into the transcript); every other currently-registered tool is auto
-- (contained, reversible, visible in Files/Activity — do NOT regress S2's free
-- file-writing). Any tool absent from this seed is denied by absence.
INSERT INTO action_classes (action_class, risk_tier, disposition) VALUES
    ('get_time',             'read',      'auto'),
    ('workspace_read_file',  'read',      'auto'),
    ('workspace_list_files', 'read',      'auto'),
    ('memory_search',        'read',      'auto'),
    ('memory_save',          'contained', 'auto'),
    ('workspace_write_file', 'contained', 'auto'),
    ('fetch_url',            'outward',   'consent');
