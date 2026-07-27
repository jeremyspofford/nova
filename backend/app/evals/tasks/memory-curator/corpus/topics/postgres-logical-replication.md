---
type: topic
title: Postgres Logical Replication
priority: 0
source_type: tool
enabled: true
description: How Postgres logical replication actually behaves in production — slot retention, what it does not copy, and the failure that bites first
category: knowledge
tags: [postgres-logical-replication, replication-slots, wal-retention]
timestamp: 2026-07-23T10:41:52.918330+00:00
---

Distilled note. Logical replication ships row changes decoded from the WAL to
a subscriber, per publication, rather than shipping blocks.

What it does not copy: DDL, sequence values, and anything on a table with no
replica identity. A table with no primary key needs REPLICA IDENTITY FULL or
updates and deletes simply do not replicate.

The failure that bites first is slot retention. An inactive replication slot
holds WAL on the publisher forever, and the publisher fills its disk. Postgres
13 added max_slot_wal_keep_size, which trades the slot for the server — the
slot is invalidated and the subscriber must be rebuilt. Choosing that trade
deliberately is the whole job.

Initial sync copies tables in parallel workers and takes a snapshot per table,
so a large table's copy holds a snapshot long enough to matter for vacuum.

Two-phase commit support landed in 15 and is opt-in per subscription.
