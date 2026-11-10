### Security
- What Nova captures from your devices is no longer saved into your home folder's history with each
  turn, so forgetting it or letting it expire is no longer undone by an old copy there. Capture keeps
  working as before.

### Added
- A command to remove captured originals that older versions saved in your home folder's history:
  `node scripts/scrub-capture-history.js`. It explains what it will do and asks before changing
  anything, then lists what it removed. Nova never does this by itself.
