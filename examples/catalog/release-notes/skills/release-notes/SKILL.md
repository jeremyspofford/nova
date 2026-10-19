---
name: release-notes
description: Draft release notes for a new version from the project's recent changes, grouped by kind.
when_to_use: When the user is preparing a release and asks for release notes or a summary of what changed.
allowed_tools: [fs.read]
---
## Instructions

1. Ask which version is being released if the user did not say.
2. Read the changes the user points to (a changelog, commit messages or files, with `fs.read`).
3. Group them under Added, Changed, Fixed and Removed; leave out a group with nothing in it.
4. Write one line per change in plain words a user of the project understands.
5. End with any upgrade steps the changes need, or "No upgrade steps".
