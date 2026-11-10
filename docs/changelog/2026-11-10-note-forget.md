### Fixed
- Forgetting a day note now forgets it everywhere a forgotten memory goes: every nightly backup, the encrypted copies, a backup drive that's unplugged (once it's back), checkpoints and upgrade backups. Restoring an older backup or checkpoint no longer brings a forgotten note back.
- Forgetting a memory now also takes the day notes that said the same thing in other words out of your backups, not just out of your notes. A forgotten line is found in a backup even if its spacing or line wrapping changed.
- The restore drill now checks the files in every backup for forgotten notes, not only the database, and says which backup still holds one.
- Forgetting something captured no longer says "Deleted everywhere" while a backup drive that wasn't plugged in still holds a copy: it names the folder and says Nova will delete it there when the drive is back.
