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
| M6.5 | [Add a computer and a phone with a code; turn the LAN off and the Relay takes over](M6.5.md) |
| M7 | [A phone starts a task through the Relay and the desktop approves it; two devices sync and restore a conflict; offline changes; a cloud run](M7.md) |
| M7.5 | [Wake-on-LAN and power-on after a power cut turned on with approval and rolled back; a boot trial reverted by its watchdog; a BMC power cycled out of band](M7.5.md) |

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
