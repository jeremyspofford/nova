# Changelog fragments

[CHANGELOG.md](../../CHANGELOG.md) at the repository root is generated from the files here by
`npm run changelog`; never edit it by hand. Each pull request writes its own file, so two pull
requests never edit the same one (the same reason the [ledger](../ledger/README.md) is one file per
pull request).

**When:** a pull request that changes what Nova ships (anything under `src/`, `ui/`, `skills/`,
`templates/` or `system/`) adds one fragment here and one ledger entry in `docs/ledger/`. CI refuses
it otherwise (`scripts/check-changelog.sh`), unless the pull request has the `no-changelog` label
(a change you can't see in what Nova does: a test fix, a refactor). After adding the label, re-run
the checks.

**File name:** `YYYY-MM-DD-<branch-name>.md`, as for the ledger: the date the pull request was opened
and its branch without the `claude/` or `codex/` prefix.

**Contents:** Keep a Changelog sections, each with `- ` items, in plain language, in the owner's
voice: what you notice or can now do, not how it was built. No pull request numbers: say what the
change does. An item may continue on lines indented by two spaces.

```
### Added
- …
### Changed
- …
### Removed
- …
### Fixed
- …
### Security
- …
```

Use only the sections you need.

**Versions:** a fragment waits at the top of this folder until the version is bumped. The bump
(package.json's `version`) moves every waiting fragment into `docs/changelog/<version>/` and
regenerates CHANGELOG.md: `npm run changelog -- --release`. A version's date in CHANGELOG.md is its
newest fragment's. How the bump, the tag and the deploy record fit together is in
[docs/plans/versioning-deploy.md](../plans/versioning-deploy.md).

`tests/changelog.test.js` checks every fragment's shape and that CHANGELOG.md is what the fragments
make.
