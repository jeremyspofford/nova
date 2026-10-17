---
status: accepted
date: 2026-10-17
supersedes: docs/24 §3–4 of the draft (fixed-rate frames, OCR-only text, mandatory vector index)
---

## Context
The draft ambient design sampled frames at a fixed rate and ran OCR on them. A source-level
study of a mature ambient-capture app (evidence records ER-SP-* under `docs/external/`) and two owner
design sessions show an event-driven, accessibility-first, text-first design, and a redaction
gate that hides data until it is certified.

## Decision
Capture fires on UI events with an idle heartbeat. Text comes from the accessibility tree first;
OCR runs only when the tree is thin. Pixels are optional. On each device, a capture helper with
no network access feeds `novad`, which sends text to the Hub, where recall runs. Nothing is
readable until model-based redaction certifies it (FR-227). Full-text search ordered by time is
the default; a vector index is enabled only when an eval shows a recall gain.

## Consequences
Capture cost falls sharply and recall works while devices sleep. Redaction needs a local model
on each capturing device. The track ships in phases: recall first, then meetings.
