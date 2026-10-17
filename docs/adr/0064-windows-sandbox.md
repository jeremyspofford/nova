---
status: accepted
date: 2026-10-17
supersedes: the Windows part of ADR-007 and docs/11 §2.3 (AppContainer / Job Objects)
---

## Context
The spec named AppContainer for Windows. A mature open-source engine (APP-3 rows 11–12) avoids
AppContainer on purpose because it breaks common developer tools, and uses restricted tokens
instead.

## Decision
Windows sandboxing uses restricted, write-restricted tokens whose restricting SIDs include
random per-root capability SIDs; folder ACLs grant write only to those SIDs. Elevated mode adds
hidden offline and online sandbox users, a private desktop per launch, and firewall rules that
are installed broad-then-narrowed so a mode change never fails open. An optional OS container
mode is used when available. Children run in kill-on-close job objects.

## Consequences
Windows support needs a one-time elevated setup step and a provisioning service. Windows stays
behind a flag until the security suite passes on it (`docs/00` §8).
