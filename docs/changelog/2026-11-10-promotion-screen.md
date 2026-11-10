### Security
- Making a memory from something Nova captured now checks it for hidden instructions first, the same
  way Nova's own suggestions are checked. Captured text that tries to give instructions is refused
  outright and nothing is kept, even if you type words over it.

### Changed
- A memory made from captured words now waits for your review, like any memory Nova writes. If you
  type the words yourself when you make it, it is confirmed at once, as before.
