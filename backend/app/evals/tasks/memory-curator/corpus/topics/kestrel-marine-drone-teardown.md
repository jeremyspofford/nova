---
type: topic
title: Kestrel Marine Drone Teardown
priority: 0
source_type: tool
enabled: true
description: What is inside the Halden Marine Kestrel-9 survey USV, from Jeremy's teardown of a decommissioned hull
category: knowledge
tags: [kestrel-9, halden-marine, survey-usv]
timestamp: 2026-07-08T16:26:41.229077+00:00
---

The Kestrel-9 is a 3.2 m survey USV built by Halden Marine of Bergen. Jeremy
took apart a decommissioned hull that came out of a harbour survey fleet.

Propulsion is two brushless pod drives, no rudder, differential steering.
The hull is a foam-cored sandwich with a bolted deck plate rather than a
bonded one, which is why this one was still serviceable after eight years.

Electronics: a single-board computer running a stripped Linux, a separate
safety microcontroller that owns the kill relay, and a GNSS/IMU board that is
the only expensive part in the boat. Everything talks CAN.

The interesting choice is that the safety controller can cut propulsion
without the main computer's cooperation and cannot be reflashed in the field.
That is the whole reason this thing is allowed near a working harbour.

Halden Marine's name for the product line comes from the bird. There is no
company called Kestrel anywhere in this note.
