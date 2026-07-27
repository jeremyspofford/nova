---
type: topic
title: ISO 10218 Industrial Robot Safety
priority: 0
source_type: tool
enabled: true
description: How ISO 10218 and ISO/TS 15066 govern collaborative robot cells, and what a buyer has to check for themselves
category: knowledge
tags: [iso-10218, robot-safety-standards, collaborative-robotics]
timestamp: 2026-06-30T15:47:12.884990+00:00
---

ISO 10218 is the industrial-robot safety standard, in two parts: 10218-1
covers the robot itself, 10218-2 covers the integrated cell. The 2025
revision folded most of ISO/TS 15066 — the collaborative-operation technical
specification — into 10218-2 proper.

The four collaborative modes are safety-rated monitored stop, hand guiding,
speed and separation monitoring, and power and force limiting. Only the last
one lets a person and a robot share a workspace with no fence at all, and it
is defined by pain-onset thresholds per body region, not by a single number.

The thing buyers get wrong: a robot ARM can be certified to 10218-1 while the
CELL it is dropped into is not compliant to 10218-2. Compliance of the cell is
the integrator's obligation and, in practice, often the buyer's. Vantage
Robotics' Atlas cell is a live example — the arms carry a 10218-1 certificate,
and the cell-level assessment is explicitly listed as the customer's.

Nothing in the standard requires a supplier to publish force-test data. Ask
for it in writing before a pilot, because after the pilot you have no leverage.
