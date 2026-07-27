---
type: topic
title: Following YouTube Channels in Nova
priority: 0
source_type: tool
enabled: true
description: How source following works in Nova — follow_source, the poll automation, and what unfollowing does and does not remove
category: knowledge
tags: [source-following, poll-automation, ingest-queue]
timestamp: 2026-07-22T17:20:11.093442+00:00
---

Following a channel is a subscription, not an ingest. follow_source records
the channel in source_subscriptions, writes a per-channel source node, and
enqueues a backfill of recent uploads onto the durable ingest queue. The
videos land in memory as each job finishes, not when the call returns.

The poll-followed-sources automation checks every followed channel on its
interval and enqueues anything new. Nothing is pulled synchronously.

Unfollowing stops future polling and nothing else. Videos already ingested
stay in memory, with their transcripts and their per-channel source tag
intact — removing those is a separate, deliberate curation job.

Each channel gets its own `src-<slug>` tag so its videos orbit their own
source node instead of chaining together through the generic media and
transcript tags.

Four channels are followed today. How much to trust them is a separate
matter and is not this note's business.
