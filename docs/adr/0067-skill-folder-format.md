---
status: accepted
date: 2026-10-17
amends: ADR-055
---

## Context
`docs/08` §4 defined a skill as one Markdown file. The open agent-skills layout (a folder with
`SKILL.md` and supporting files) is now common, and injecting every skill body costs context
that local models cannot spare (APP-3 row 19).

## Decision
A skill is a folder with `SKILL.md` (front-matter `description` required; `name`,
`when_to_use`, `allowed_tools`, `model_hint` optional) plus optional scripts and templates. Only
a catalog of names and descriptions is injected, within 2 % of the context window (max 10,000
tokens); the body loads when the skill is invoked. Name collisions resolve managed > project >
user > plugin > built-in.

## Consequences
Skills from other tools can be imported unchanged (FR-200). Auto-selection relies on good
descriptions, so the skill validator warns on empty or very short ones.
