**2026-11-10 · Capture · Captured originals kept out of the home's git history (F-013)**
- What changed: capture/ (the originals devices send, under capture/raw/) was not on the list of things the home's history leaves out, so every turn's commit saved them. It is on the list now, and a home that already tracked it stops at the next start, keeping the files where they are.
- What you can now do: forget or expire a capture without a copy surviving in the home's history from here on.
- Still unfinished: commits made before this change still hold the originals they saved. Removing them means rewriting the home's history, which Nova doesn't do without the owner's ruling. That decision is flagged in the pull request.
- Checked: a test plants capture originals in a fresh home and in an old home that tracked them. Neither commits them after this change, the old home stops tracking them, and the files stay on disk. The same test fails on the old code. Full suite passes.
