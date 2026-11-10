### Added
- You can restore a nightly backup: `node scripts/restore-backup.js <backup folder or .nbk file>
  [new home]` makes a new home from a backup folder, or from an encrypted copy and its recovery
  key, on any computer. It checks every file against the backup first, applies your forgets again,
  and never writes over a home. Health links to how it works (docs/restore.md), including what
  happens to your saved secrets: a backup never holds the vault's key, so on a new computer
  connectors need signing in again.
