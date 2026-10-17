---
status: accepted
date: 2026-10-17
supersedes: ADR-004
---

## Context
ADR-004 chose Tailwind plus CSS variables. The design tokens (`packages/ui/src/tokens.css`)
already carry theming, and component sources must never hard-code colors (`docs/14` §2.2).

## Decision
Components use plain CSS that reads only the tokens, plus small `nv-*` component classes. No
utility-CSS framework.

## Consequences
Less tooling and a small bundle; a test scans component sources for hard-coded colors. Layout
CSS is written by hand. Revisit if UI velocity suffers.
