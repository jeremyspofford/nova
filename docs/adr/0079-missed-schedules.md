---
status: accepted
date: 2026-10-17
supersedes: docs/09 §12 (run once if within a 15-minute grace window)
---

## Context
A 15-minute grace window silently drops a schedule missed while the Hub was down for longer. A
reference application runs one catch-up covering the last 7 days instead (APP-2 row 19).

## Decision
Missed fires of a schedule collapse into one catch-up run, which is told the window it covers.
The default lookback is 7 days; each schedule can choose `once` (default) or `skip`. RRULE is
accepted alongside cron and intervals.

## Consequences
A daily digest missed for three days produces one run covering three days, not three runs or
none. Runs must handle a variable time window.
