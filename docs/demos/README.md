# Milestone Demos

For each accepted milestone, add `M<n>.md` (demo script + expected results) and an
`M<n>-evidence/` folder with small screenshots/traces referenced by the ledger. Keep files
small; large recordings go in the release assets, not the repo.

| Milestone | Demo |
| --- | --- |
| M0 | [Hub, web UI and setup](M0.md) |
| M1 | [First chat](M1.md) |
| M2 | [Providers, local models and memory](M2.md) |
| M3 | [Tools and approvals](M3.md) |
| M4 | [Plugins, skills, hooks, MCP Apps, bundles, workspace and profile](M4.md) |
| M5 | [Work runs, budgets, schedules, chat escalation and a Code session](M5.md) |
| M6 | [An agent books a meeting and asks before sending; research, Slack, events, browser, takeover](M6.md) |

## Template

```markdown
# M<n> — Demo

## Preconditions
- Clean profile, mock providers enabled, fixtures seeded.

## Script
1. …
2. …

## Expected results
- …

## Evidence
- `M<n>-evidence/01-onboarding.png`
- `M<n>-evidence/test-output.txt`
```
