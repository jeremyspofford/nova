**2026-11-10 · Backups · A late background read no longer erases "Backup settings saved." (#484)**
- What changed: a Backups read that answered after a save cleared the save's notice (the UI-gate timeouts in #484); it now keeps it. /tmp pressure was measured and ruled out as the cause.
- What you can now do: see "Backup settings saved." stay after saving, however slow the machine.
- Still unfinished: leaked test folders still fill the WSL /tmp tmpfs when tests run outside npm test; that is a separate issue.
- Checked: a browser test holds the read until after the save and fails on the old code; the Backups UI files pass (27/27) and the full UI gate passes (276/276). services-cli now names whatever answers its port early (#488).
