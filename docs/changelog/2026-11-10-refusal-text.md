### Fixed
- Nova's own log file no longer grows without end: past 10 MB it starts a new one, and only the five
  before it are kept.
- When many different addresses hit the pairing rate limit, you see one problem with a count of how
  many were turned away and from how many addresses, instead of one problem per address.

### Security
- When Nova refuses something a paired device asked for, the reason it keeps and shows is cleaned
  like everything else a device says, even where the reason quotes the device's own words.
