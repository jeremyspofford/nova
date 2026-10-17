---
name: summarize-notes
description: Summarize notes into key points, decisions and open questions, using the summary template.
when_to_use: When the user shares notes, meeting minutes or a long message and asks for a summary.
allowed_tools: [fs.read]
---
## Instructions

1. Read the notes the user gave: pasted text, an attachment, or files they name (with `fs.read`).
2. Fill in `template.md` from this skill: Key points, Decisions, Open questions.
3. Keep each bullet under 20 words. Quote names, numbers and dates exactly as written.
4. Write "None" for an empty section instead of inventing content.
