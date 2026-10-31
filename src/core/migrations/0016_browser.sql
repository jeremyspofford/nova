-- Nova Browser (M10b): the sites Nova's own browser profile keeps something for (cookies, storage),
-- so Settings can list them and the person can forget one. Never a value: the sign-ins themselves
-- are in the vault, under the host they were saved for. Not replicated: the profile lives on this
-- machine.
CREATE TABLE browser_site (
  host TEXT PRIMARY KEY,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL
);
