---
status: accepted
date: 2026-10-17
supersedes: the single-thread rule in FR-088 and docs/13 §4
---

## Context
FR-088 put every channel's messages into one thread so an agent kept full context. One
reference application keeps a history per channel and shares only the agent and its notes
(APP-4 row 9). A single thread can surface a private DM's content in a shared channel.

## Decision
Each channel binding keeps its own thread. The agent's identity and memory are shared across
channels. The owner's private channels (in-app, the owner's own DMs) can opt into one shared
thread. Content from a private thread reaches a shared channel only through a policy check.

## Consequences
Continuity across channels comes from agent memory rather than raw history, so memory quality
matters more. The channel adapters must map each binding to its thread.
