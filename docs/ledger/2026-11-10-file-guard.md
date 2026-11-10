**2026-11-10 · Helpers · One file guard for read_file and Delegate (F-039)**
- What changed: Delegate checked the files it passed to a helper with a weaker test than read_file (no case folding, links not followed, Nova's database, checkpoints, backups and history not refused) and put their contents into the helper's prompt. It now uses read_file's own guard, so the refusal and its reason are the same; conversations stay refused for helpers on top of that.
- What you can now do: rely on "Nova won't read that" meaning the same thing for a helper.
- Still unfinished: nothing for this finding.
- Checked: a test plants a vault key, a checkpoint and a link to the key, and runs nine protected paths through both tools: each refused by both, with read_file's reason; no helper started and nothing planted reached a brief. The same test on the old code fails at the first path (Delegate accepted nova.db). Full suite passes.
