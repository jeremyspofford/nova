# Example: a scheduled RSS digest

The web increment's third deliverable from the continuity plan — no new code,
just a schedule whose prompt uses `web.fetch` (which returns feeds as raw XML
and articles as readable text). Create it via the Schedules page or:

```bash
curl -X POST http://localhost:8000/api/v1/schedules \
  -H "X-Admin-Secret: $ADMIN_SECRET" -H "content-type: application/json" \
  -d '{
    "name": "morning hn digest",
    "prompt": "Fetch https://hnrss.org/frontpage with web.fetch. Pick the 5 most interesting items for someone building a self-hosted AI platform. For each: title, one-sentence why-it-matters, link. If nothing stands out, reply with exactly: NOTHING",
    "trigger": {"type": "cron", "expr": "0 7 * * *"}
  }'
```

The digest lands in the schedule's `⏰ morning hn digest` chat thread each
morning; quiet days post nothing (the NOTHING convention). Swap in any feed —
release notes, subreddit RSS, status pages.
