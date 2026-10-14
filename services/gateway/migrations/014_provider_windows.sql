-- S38b T5: the context window each provider's LISTING declares per model
-- (its `context_length`), kept on every listing fetch — the save's verify and
-- admin._listing_for, the one path the catalogue and the admin page use — so a
-- chat completion never fetches a listing to know a cloud model's window.
-- One provider's rows are the set its LAST listing stated: a model dropped
-- from it, or no longer stating a length, is deleted. Read only for a link
-- that is not an engine and whose origin states no served window (/api/ps);
-- stated as declared, never as served. Deleted with its provider.
CREATE TABLE IF NOT EXISTS provider_windows (
    provider       text NOT NULL REFERENCES providers (name) ON UPDATE CASCADE ON DELETE CASCADE,
    model          text NOT NULL,
    context_length integer NOT NULL CHECK (context_length > 0),
    read_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, model)
);
