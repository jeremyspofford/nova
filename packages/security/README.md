# @nova/security

Security primitives: secret redaction for every output boundary (FR-101, FR-118), path containment
that rejects `..` and symlink escapes (`docs/11` §3), protected and credential path checks
(FR-190), listener tokens stored as hashes (FR-192), and the repository secret scan. 90 % branch
coverage floor.

The secret scan (`scanText`, run over the tracked files by `scripts/secret-scan.mjs` in CI) reuses
the redaction rules: each rule's `scan` class says whether a match is a finding by its shape
(`token`), only when the captured value is a plain literal (`context`), or only in configuration
files (`config`). Obviously fake fixture values (they say so, or contain a sequential run like
`abcdef`) are skipped; anything else in a fixture needs a `secret-scan: fake` comment on the line
or the line above, or `secret-scan: fake-file` in the first five lines of the file. Private key
blocks always need the marker.
