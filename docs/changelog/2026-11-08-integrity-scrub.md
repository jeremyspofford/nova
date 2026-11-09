### Added
- Nova can check its own health more deeply on request. It checks its database for damage, its
  newest checkpoint against what it recorded, and whether the disk has room. It reports only
  plain findings, keeps nothing, and changes nothing. Health doesn't show it yet.
