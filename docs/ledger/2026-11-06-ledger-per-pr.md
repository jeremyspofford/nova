**2026-11-06 · Ledger · Each merge's entry is now its own file**
- What changed: nothing in Nova. Every pull request used to add its entry to the top of one file, `docs/LEDGER.md`, so whenever one merged, every other open pull request collided there and had to be merged again and re-checked, one after another. Each entry now goes in its own small file in `docs/ledger/`, named by date and branch, so pull requests no longer touch the same lines and can merge as soon as their own checks pass. The entries up to today stay in `docs/LEDGER.md` as history, unchanged.
- What you can now do: read the newest changes as files in `docs/ledger/`, newest first by name; the older ones are still in `docs/LEDGER.md`.
- Still unfinished: nothing known. Pull requests already open when this merged still add to `docs/LEDGER.md`; they move their entry here as they are next updated.
- Checked: a new test, `tests/ledger-files.test.js`, checks every entry file's name and its four parts.
