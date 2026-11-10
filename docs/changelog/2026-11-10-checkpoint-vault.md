### Security
- Restoring a checkpoint no longer brings back a secret you deleted: checkpoints don't hold your
  saved secrets or their key any more, and a restore keeps them exactly as they are now, including
  for checkpoints taken before this change.
