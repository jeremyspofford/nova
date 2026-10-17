# @nova/security

Security primitives: secret redaction for every output boundary (FR-101, FR-118), path containment
that rejects `..` and symlink escapes (`docs/11` §3), protected and credential path checks
(FR-190), and listener tokens stored as hashes (FR-192). 90 % branch coverage floor.
