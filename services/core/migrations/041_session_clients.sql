-- What each signed-in client is (the About page, 2026-10-07).
--
-- A session row said who signed in and nothing about WHERE: the phone's
-- installed web app, a laptop's browser and a desktop tab were the same
-- anonymous row, so neither the About page nor Nova could say the PWA
-- existed. Asked about her own architecture she named the hub and the Dell
-- and never the phone he was holding.
--
-- All three are written by identity.touch_session on an authenticated
-- request, never by the login itself, so a session that has not been used
-- since this migration simply reads as "not seen yet" rather than a guess.
--   user_agent:   the browser's own User-Agent, cut to 300 characters.
--   display:      'standalone' (an installed web app, the PWA) or 'browser',
--                 as the page itself reported it (X-Nova-Display); NULL when a
--                 client never said.
--   last_seen_at: the last authenticated request, at most a minute stale.
ALTER TABLE sessions ADD COLUMN user_agent   text;
ALTER TABLE sessions ADD COLUMN display      text CHECK (display IN ('standalone', 'browser'));
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz;
