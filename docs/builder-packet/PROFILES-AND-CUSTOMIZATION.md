# PROFILES AND CUSTOMIZATION

## The rule
Core ships empty of any person. Everything specific — identity settings, services, schedules, proactive preferences, privacy defaults, design-system choice, spaces/books — lives in a **profile**: a portable, exportable pack of configuration and data references that Nova loads at runtime.

## Profile contents
- Identity: Nova's name/presence/voice choices; user name and how to address them; timezone.
- Charter tuning: directness, warmth, proactivity appetite (charter itself is fixed — NOVA-SPEC §2).
- Privacy: default privacy mode, per-capability overrides, retention choices.
- Policy: approval-tier assignments per capability.
- Triggers: heartbeat jobs, event subscriptions, proactive preferences and quiet hours.
- Installed extensions and their config (secrets by reference only).
- Design system selection (per user; overridable per device).
- Spaces/books: the user's organizational scopes (e.g. Personal / work / per-project) used for memory scoping and capture classification.
- Local model preferences and provider accounts (references only).

## Setup is conversational
First run is a conversation, not a form or a YAML file: Nova interviews, proposes defaults, connects accounts one at a time with the payoff explained, and can be re-configured the same way later ("Nova, stop watching that sender", "switch to the light theme on my phone"). Every conversational change writes the same profile records a settings UI would.

## Reference profile (private, not in the repo)
The product owner's own setup exists as a private reference profile used to test that the extension model can express a real, demanding configuration — many agents, smart-home bridges, work-capture workflows — without core changes. It is never shipped, never a fixture, never an example in docs.

## Fresh-user acceptance
At every roadmap gate: install with a blank profile, complete setup conversationally, install and remove an extension, switch a design system, run one task end-to-end. Any step that assumes the reference user's services, names, or data fails the gate.

## Portability
Profiles export/import as a single archive (minus secrets, which re-link by name on import). Moving Nova to a new hub = install, import profile, re-pair devices.
