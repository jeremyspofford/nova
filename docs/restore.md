# Restoring a backup

How to get a working Nova back from a nightly backup, or from its encrypted copy and your
recovery key. Restoring is a command for now; there is no screen for it yet.

## What you need

- **A backup folder** (`nova-backup-000042`, in the folder you chose in Settings › Backups). It
  is **not encrypted**: anyone who can read it can read your data. Keep it on a drive only you use.
- **Or an encrypted copy** (`nova-backup-000042.nbk`, in the second folder) **and its recovery
  key**: the 64 digits and letters a–f, in eight groups, that Nova showed you once when you set the
  copy up. Without the key the copy can't be opened, by you or anyone else.
- This version of Nova, or a newer one. A backup made by a newer Nova is refused.

Stop Nova first if it is running.

## The command

From Nova's folder:

```sh
node scripts/restore-backup.js <backup folder or .nbk file> [new home] [--keep-from <old home>]
```

- **The new home** is a folder that isn't there yet, or an empty one. Nova never restores over a
  home. Leave it out and it is `NOVA_HOME` (or `~/Nova`).
- **An encrypted copy** asks for its recovery key on the terminal, and doesn't show it as you type.
  You can also pipe it in: `node scripts/restore-backup.js copy.nbk ~/Nova < key.txt`. The key is
  never taken from the command line, where other programs and your shell's history could see it.
- **`--keep-from <old home>`** is for when the home you are replacing is still there (a damaged
  home, or one you moved aside). It keeps from it what a restore never rolls back; see below.

Then start Nova on the new home:

```sh
NOVA_HOME=<new home> npm start
```

Examples:

```sh
# This computer died; you have the backup drive.
node scripts/restore-backup.js /mnt/backup/nova-backup-000042 ~/Nova

# You have only the encrypted copy and your recovery key.
node scripts/restore-backup.js ~/Downloads/nova-backup-000042.nbk ~/Nova

# Your home is damaged but still there: move it aside and keep what happened since.
mv ~/Nova ~/Nova-damaged
node scripts/restore-backup.js /mnt/backup/nova-backup-000042 ~/Nova --keep-from ~/Nova-damaged
```

## What the command checks

Before anything is in place, every file and the database are checked against the backup's
manifest (their hashes), the database against SQLite's integrity check, and its migrations against
this Nova's. If any check fails, nothing is restored and nothing is left behind. The manifest's
seal can only be checked by the Nova that made it, so restore a backup you know is yours.

## What happens to things you asked Nova to forget

Forgets are applied again on restore:

- **Memories** by their record id, and **captured items** by the tombstone each forget leaves.
  Any of these still in the backup are deleted the way every forget deletes them.
- **Day notes**, which have no record, by their id or by a hash of their words. Nova never keeps
  the words themselves.

Every forget is also carried into each backup and encrypted copy when it happens, so a backup made
before a forget no longer holds what was forgotten. One case needs the old home: if the backup drive
was unplugged when you forgot something, the forget is owed to that drive and written down in the
old home. Restore with `--keep-from <old home>` and it is applied. Without the old home, that one
forget can't be applied: forget the item again after the restore.

## The vault (your saved secrets)

Checkpoints never hold the vault, and restoring a checkpoint never repairs the vault from one. What
restores the vault is its own encrypted backup path: each nightly backup carries the vault's file,
still encrypted, and **never the key that opens it**. So:

- **On the same computer**, if its system keychain still holds the vault's key, your saved secrets
  come back as they were when the backup was made. A secret you deleted after that stays deleted:
  deleting one changes the key, so the older file no longer opens with it.
- **With `--keep-from`**, the vault is the old home's as it is now. A restore never brings back a
  secret you deleted.
- **Otherwise** (a new computer, or the key was in a file in the old home), the vault can't be
  opened. Nova sets its file aside (`vault/secrets.json.unopenable-<time>`, in case the key turns
  up) and starts with an empty vault. **Connectors need signing in again** and provider keys need
  entering again. Health shows this as something that needs you until you resolve it.

If you restored from the encrypted copy, the new Nova keeps using the same recovery key for its
encrypted copies.

## After the restore

- **Backups** go where the backup said: the command prints the folders. Change them in Settings ›
  Backups if they belong to the old computer. If the vault was set aside, the backups already in
  those folders were sealed with the old vault's key: the new Nova treats them as not its own, never
  prunes them and never restores from them. Delete them yourself once you trust the new backups.
- **Paired devices and this computer's keys** aren't in a backup. With `--keep-from` they are the
  old home's. Otherwise add your phones and other devices again (Settings › Devices).
- **Checkpoints** aren't in a backup either: they stay on the computer that took them.
- Run the restore drill (Health › Run the restore drill) once the first new backup is made.
