### Fixed
- A repair Nova makes on a problem no longer closes that problem on its own word. Once a repair
  says it worked, Health shows "Repaired, checking" and when the problem closes. The problem
  closes only after a separate check sees it is really gone: the connection is listening, the
  local model answers Nova's own probe, the standby is copying again, the computer's heartbeat
  says it is running, or a new backup reads back correctly. If that check sees the problem is
  still there, the problem stays open and the repair is shown as not having held. Problems with
  no such check stay open until you mark them dealt with.
