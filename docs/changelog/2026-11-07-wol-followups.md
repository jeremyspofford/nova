### Fixed
- A computer set to sleep when idle no longer has services moved onto it, and a service pinned to
  a sleeping computer now shows as "down, wakeable" rather than just down.
- On Windows, Nova now notices when a computer's wired network card isn't allowed to wake it, and
  says so instead of sending a wake that can't work.
