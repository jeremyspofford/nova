# Test Manifest

Every requirement in `docs/03-functional-requirements.md` must appear here with at least one
unit test and, where the requirement touches IPC/storage/providers/UI, one integration or E2E
test. A CI check (to be implemented in M0) fails if any `FR-*` is missing.

Legend: `U` unit · `I` integration · `E` E2E journey (see `docs/18` §3) · `—` not applicable.

| FR | U | I | E | Notes |
| --- | --- | --- | --- | --- |
| FR-001 | todo | todo | J1 | shell layout + a11y |
| FR-002 | todo | todo | J1 | mode switching preserves state |
| FR-003 | todo | todo | J1 | command palette |
| FR-004 | todo | todo | J1 | shortcut registry |
| FR-005 | todo | todo | J4 | pane layout |
| FR-006 | todo | todo | J4 | bottom panel + terminal |
| FR-007 | todo | todo | — | deep links |
| FR-008 | todo | todo | — | tray |
| FR-009 | todo | todo | — | multi-window |
| FR-010 | todo | todo | J1 | theming tokens |
| FR-011 | todo | todo | J4 | theme import/export |
| FR-012 | todo | todo | — | pets |
| FR-013 | todo | todo | J3 | notifications |
| FR-014 | todo | todo | J1 | onboarding |
| FR-015 | todo | todo | J1/all | accessibility |
| FR-016 | todo | todo | — | i18n/RTL |
| FR-017 | todo | todo | J1 | chat CRUD |
| FR-018 | todo | todo | J1 | streaming/stop |
| FR-019 | todo | todo | J2 | steer/queue |
| FR-020 | todo | todo | J2 | edit/regenerate/branch |
| FR-021 | todo | todo | J2 | attachments |
| FR-022 | todo | todo | J3 | @mentions |
| FR-023 | todo | todo | J2 | model picker |
| FR-024 | todo | todo | J2 | reasoning levels |
| FR-025 | todo | todo | J2 | find/search |
| FR-026 | todo | todo | J3 | side chat |
| FR-027 | todo | todo | J2 | temporary chats |
| FR-028 | todo | todo | J4 | suggested prompts |
| FR-029 | todo | todo | J3 | web search citations |
| FR-030 | todo | todo | J5 | image gen |
| FR-031 | todo | todo | — | voice |
| FR-032 | todo | todo | J2 | memory |
| FR-033 | todo | todo | — | branch tree |
| FR-034 | todo | todo | J2 | projects |
| FR-035 | todo | todo | J4 | local projects |
| FR-036 | todo | todo | — | space/pages |
| FR-037 | todo | todo | — | sites |
| FR-038 | todo | todo | J5 | artifacts |
| FR-039 | todo | todo | J4 | file editor |
| FR-040 | todo | todo | J3 | sources |
| FR-041 | todo | todo | J4 | library |
| FR-042 | todo | todo | J3 | MCP client |
| FR-043 | todo | todo | J3 | MCP health |
| FR-044 | todo | todo | J4 | MCP server |
| FR-045 | todo | todo | J4 | plugins |
| FR-046 | todo | todo | J4 | skills |
| FR-047 | todo | todo | J4 | connectors |
| FR-048 | todo | todo | J3 | per-tool defaults |
| FR-049 | todo | todo | J10 | marketplace |
| FR-050 | todo | todo | — | build plugin/skill |
| FR-051 | todo | todo | J5 | work run |
| FR-052 | todo | todo | J5 | continue when closed |
| FR-053 | todo | todo | J5 | sub-agents |
| FR-054 | todo | todo | J5 | child threads |
| FR-055 | todo | todo | J5 | schedules |
| FR-056 | todo | todo | J7 | event triggers |
| FR-057 | todo | todo | J5 | activity |
| FR-058 | todo | todo | J5 | approvals |
| FR-059 | todo | todo | J5 | work→code |
| FR-060 | todo | todo | J7 | notification routing |
| FR-061 | todo | todo | J6 | code session |
| FR-062 | todo | todo | — | environments |
| FR-063 | todo | todo | J6 | permission modes |
| FR-064 | todo | todo | J6 | file edits |
| FR-065 | todo | todo | J6 | diff review |
| FR-066 | todo | todo | J6 | terminal |
| FR-067 | todo | todo | J6 | browser pane |
| FR-068 | todo | todo | J6 | auto-verify |
| FR-069 | todo | todo | J6 | code review |
| FR-070 | todo | todo | J6 | PR flow |
| FR-071 | todo | todo | J9 | cloud envs |
| FR-072 | todo | todo | — | cross-session |
| FR-073 | todo | todo | — | parallel worktrees |
| FR-074 | todo | todo | J6 | repo index |
| FR-075 | todo | todo | — | appshots |
| FR-076 | todo | todo | — | visualizations |
| FR-077 | todo | todo | J9 | mobile dispatch |
| FR-078 | todo | todo | — | SSH persistence |
| FR-079 | todo | todo | J7 | agent creation |
| FR-080 | todo | todo | J7 | cloud computer |
| FR-081 | todo | todo | J7 | connect computer |
| FR-082 | todo | todo | J7 | proactive research |
| FR-083 | todo | todo | J7 | background threads |
| FR-084 | todo | todo | J7 | custom rules |
| FR-085 | todo | todo | J7 | auto-review |
| FR-086 | todo | todo | J8 | sign-in flow |
| FR-087 | todo | todo | J7 | takeover |
| FR-088 | todo | todo | J7 | channels |
| FR-089 | todo | todo | J7 | agent memory |
| FR-090 | todo | todo | J7 | agent activity/stop |
| FR-091 | todo | todo | — | specialist agents |
| FR-092 | todo | todo | J8 | browser tool |
| FR-093 | todo | todo | J8 | computer use |
| FR-094 | todo | todo | J8 | allow/block lists |
| FR-095 | todo | todo | J8 | write-action classifier |
| FR-096 | todo | todo | — | browser profiles/extension |
| FR-097 | todo | todo | J6 | dev servers |
| FR-098 | todo | todo | J8 | action screenshots |
| FR-099 | todo | todo | J3 | policy engine |
| FR-100 | todo | todo | J3 | approvals |
| FR-101 | todo | todo | J3 | secrets |
| FR-102 | todo | todo | J8 | egress control |
| FR-103 | todo | todo | J8 | injection defense |
| FR-104 | todo | todo | J5 | audit log |
| FR-105 | todo | todo | J10 | data controls |
| FR-106 | todo | todo | J10 | managed policy |
| FR-107 | todo | todo | J7 | sandboxing |
| FR-108 | todo | todo | J9 | cloud runner |
| FR-109 | todo | todo | J9 | sync |
| FR-110 | todo | todo | J9 | channel bridge |
| FR-111 | todo | todo | J9 | mobile dispatch |
| FR-112 | todo | todo | J9 | offline queue |
| FR-113 | todo | todo | J4 | profile |
| FR-114 | todo | todo | J4 | usage insights |
| FR-115 | todo | todo | J4 | multiple accounts |
| FR-116 | todo | todo | J10 | spend caps |
| FR-117 | todo | todo | J10 | extension SDK |
| FR-118 | todo | todo | J3 | logging |
| FR-119 | todo | todo | J5 | diagnostics |
| FR-120 | todo | todo | J11 | auto-update |
| FR-121 | todo | todo | — | crash reporting |
| FR-122 | todo | todo | — | performance budgets |
| FR-123 | todo | todo | — | security suite |
