### Security
- Handing work to a helper now checks the files you pass exactly as reading a file does: Nova's
  database, checkpoints, backups, history and secrets are refused for the same reason, even through
  a link or a differently cased name, so none of their contents can reach a helper.
