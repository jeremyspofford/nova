---
type: topic
title: github-profile-fetch tool
priority: 1
source_type: tool
enabled: true
description: The execution_spec of our first http_call tool, including the two headers every GitHub tool reuses
category: knowledge
tags: [github-profile-fetch, github-rest-api, http-call-tools]
timestamp: 2026-05-02T09:31:44.201755+00:00
---

Our first http_call tool, created 2026-05-02.

method: GET
url_template: https://api.github.com/users/{username}
headers:
  Accept: application/vnd.github.v3+json
  User-Agent: Nova-AI

Every GitHub tool we add sends those same two headers and nothing else — no
Authorization header and no token. Public data only; GitHub's unauthenticated
limit of 60 requests an hour per IP is plenty for how we use it.
