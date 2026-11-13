### Added
- Nova keeps its own Claude sign-in, in its home folder, separate from the one you use in a
  terminal. It checks the sign-in every 6 hours (`seat_probe_hours` in nova.config.json, or
  `NOVA_SEAT_PROBE_HOURS`), which also keeps it from lapsing, and Health shows how it stands.
- When the sign-in stops working, Nova says so ("My Claude sign-in expired") in chat, in a
  scheduled run's report and as one problem in Health, with a Sign in again button. Sign in again
  shows Claude's sign-in page as a link you can open on any device, phone included, and takes the
  code back. The problem closes once Nova's own check call to Claude works again.

### Changed
- The first time this version runs, Nova's own sign-in is empty, so Health asks you to sign in once
  more. Signing in again in a terminal doesn't sign Nova in, and Nova never copies a sign-in from
  anywhere.
