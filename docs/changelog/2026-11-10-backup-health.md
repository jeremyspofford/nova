### Fixed
- With no backup folder set, or before the first backup, Home no longer says "All systems normal"
  and Health no longer calls backups fine: both say nothing is backed up, in amber. Nothing turns
  red for it, since Nova keeps running.
- A database upgrade that fails when you start Nova with `npm start` now leaves your data exactly as
  it was, says so in one plain line with where the copy from before is, and starting again doesn't
  make another copy or checkpoint each time. A database from a newer Nova is said the same way.

### Changed
- The backup folder is now labelled as not encrypted, in Settings, Health and the README; the
  encrypted copy folder says it opens only with your recovery key.
