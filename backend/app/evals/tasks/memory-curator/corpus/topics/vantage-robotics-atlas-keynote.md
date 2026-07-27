---
type: topic
title: Vantage Robotics Atlas Keynote
priority: 0
source_type: tool
enabled: true
description: What Vantage Robotics showed at the Atlas work-cell keynote on 2026-07-18, written from Jeremy's account of attending it
category: knowledge
tags: [vantage-robotics, atlas-work-cell, bimanual-manipulation]
timestamp: 2026-07-19T09:14:02.441907+00:00
---

Written from Jeremy's account of the Vantage Robotics Atlas keynote,
2026-07-18 in Portland. No recording was published and press were asked not
to film, so this note and its two companions are the whole record.

Atlas is a fixed-base bimanual work cell, not a walking humanoid. Two 7-DOF
arms on a shared torso, 1.4 m reach, 9 kg payload per arm. Vantage's pitch is
that legs are the expensive part of humanoid robotics and buy nothing on a
bench, so they deleted them.

The live demo ran unpacking, sorting and re-boxing of mixed cartons with no
fixture and no barcode. Failure recovery was the point of the demo rather
than throughput: an arm knocked a carton off the table twice and recovered it
both times without a human stepping in.

Perception is one overhead depth camera plus wrist cameras, no lidar. The
whole controller runs on the cell, so a cell keeps working with the network
down — which is what Jeremy actually cared about.

Not shown: the tool changer, two cells coordinating on one task, and anything
at all outside a bench. Pricing and warranty are in [[Vantage Robotics Atlas Keynote — Part 2: Pricing and Warranty]].
The things this note cannot answer are in [[Vantage Robotics Atlas Keynote — Open Questions]].
