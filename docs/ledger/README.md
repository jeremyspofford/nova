# Ledger: what each merge changed

One file per merge to main, written in the pull request itself, newest first by file name. The history before 2026-11-06 is in [../LEDGER.md](../LEDGER.md).

**File name:** `YYYY-MM-DD-<branch-name>.md`: the date the pull request was opened and its branch without the `claude/` or `codex/` prefix, so two pull requests never write the same file.

**Contents:** one entry in the same plain-language form as before.

```
**YYYY-MM-DD · Area · What changed, in one line**
- What changed: …
- What you can now do: …
- Still unfinished: …
- Checked: …
```

A merge without an entry is incomplete, the same as one without gate evidence. `tests/ledger-files.test.js` checks every file here keeps this shape.
