---
type: topic
title: Postgres Logical Replication in Practice — Full Transcript
priority: 0
source_type: media_transcript
enabled: true
description: Full transcript of the conference talk "Postgres Logical Replication in Practice", ingested from YouTube
category: knowledge
tags: [postgres-logical-replication, src-pgconf-talks, replication-slots]
source_url: https://www.youtube.com/watch?v=7bK2mQxTzR4
timestamp: 2026-07-23T10:38:04.552901+00:00
---

[00:00] Right. Logical replication. Everyone in this room has turned it on,
and about a third of you have filled a disk with it, so let's talk about the
part the docs are quiet about.

[00:19] Physical replication ships blocks. Logical replication decodes the
write-ahead log into row changes and ships those, per publication. That is
the whole difference and every consequence falls out of it.

[01:02] It does not replicate DDL. Add a column on the publisher and the
subscriber does not have it, and your apply worker stops. It does not
replicate sequence values, so your failover target has a sequence sitting at
one. And on a table with no replica identity, updates and deletes are simply
dropped on the floor.

[02:11] Now the part that fills the disk. A replication slot is a promise
that the publisher will keep WAL until the subscriber has consumed it. An
inactive slot is a promise with nobody on the other end. The publisher keeps
that promise until it runs out of filesystem.

[03:04] Thirteen gave us max_slot_wal_keep_size, which lets the server break
the promise instead of dying. The slot gets invalidated and the subscriber
has to be rebuilt from scratch. That is not a fix, it is a choice about which
failure you would rather have at three in the morning, and you should make it
on purpose rather than discovering it.

[04:20] Initial sync copies each table with its own worker and its own
snapshot. On a large table that snapshot lives long enough to hold vacuum
back across the whole database, so schedule the initial sync like you would
schedule a backup.

[05:31] Two-phase commit arrived in fifteen and it is opt-in per
subscription. If you did not turn it on, you do not have it.

[06:02] Questions.
