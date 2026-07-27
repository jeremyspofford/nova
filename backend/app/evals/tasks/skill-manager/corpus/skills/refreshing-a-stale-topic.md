---
type: skill
title: Refreshing a Stale Topic
priority: 0
source_type: tool
enabled: true
description: How to bring an existing topic up to date without forking a second copy of it and without losing the facts the new source does not repeat.
category: workflow
tags: [topic-refresh, memory-write-discipline, staleness]
timestamp: 2026-07-19T14:02:11.884213+00:00
---

# Refreshing a Stale Topic

## 1. Decide it is actually stale
A topic is stale when its frontmatter timestamp is more than 30 days old.
"Feels old" is not a threshold. Inside the window, leave the note alone and
say why you left it.

## 2. Refresh in place, never alongside
Call write_memory with item_id set to the existing topics/....md id. A write
with no item_id creates a SECOND topic. That is the failure this skill exists
for: it happened twice to the Kimi K3 note, and both times the agent reported
that it had updated the topic.

## 3. Carry forward what the new source does not contradict
A refreshed page restates some facts, changes some, and quietly omits others.
Anything the old note carried that the new source does not contradict has to
survive the refresh. Replacing the body with only the delta silently deletes
the licence and serving-footprint facts a future reader needs.

## 4. Report the diff, not the act
"Updated the topic" is not a report. Name what changed — old value, new value
— and name what stayed the same.

## 5. Refuse when the source no longer matches
If the source_url 404s, redirects to a parked domain, or now covers a
different subject, do NOT refresh. Leave the note untouched and tell the
operator what that URL serves now.
