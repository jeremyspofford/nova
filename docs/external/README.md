# External Findings

Drop reverse-engineering findings from other sessions here. The build agent reconciles each
capability against the current spec and records the result in `RECONCILIATION.md`.

Expected: one or more `*-findings.md` files describing an application's capabilities, plus the
evidence behind them. After Phase 0, `RECONCILIATION.md` lives here too.

## Files

| File | Target | Evidence records |
| --- | --- | --- |
| `app1-findings.md` | APP-1: chat assistant product (web, desktop, mobile) | ER-APP1-* |
| `app2-findings.md` | APP-2: desktop assistant with a VM-sandboxed agent mode | ER-APP2-* |
| `app3-findings.md` | APP-3: open-source coding-agent engine | ER-APP3-* |
| `app4-findings.md` | APP-4: always-on agent product | ER-APP4-* |
| `screenpipe-findings.md` | screenpipe, ambient screen and audio memory (named openly) | ER-SP-* |
| `RECONCILIATION.md` | Phase 0 output: keep / modify / add / replace / reject for every capability above, with the resulting FRs (`FR-181`…`FR-233`) and ADRs (`ADR-056`…`ADR-082`) | — |

Reference applications are tracked by opaque IDs (`docs/19` §1.3). Evidence refs in the
`app*-findings.md` files are opaque too (`APPn/doc/…`, `APPn/src/…`, `APPn/bin/…`,
`APPn/obs/…`).

`private/` is the evidence ledger and is gitignored. It holds:
- `IDENTITIES.md`: which application each ID refers to
- `appN-refs.md`: each opaque ref mapped to its real URL or path
- `research/`: the full source teardowns behind these files (2026-10-16/17)
