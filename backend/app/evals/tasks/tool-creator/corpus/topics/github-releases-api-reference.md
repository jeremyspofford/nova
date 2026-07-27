---
type: topic
title: GitHub releases API reference
priority: 0
source_type: tool
enabled: true
description: Ingested excerpt of GitHub's REST reference for the latest-release endpoint
category: knowledge
tags: [github-rest-api, github-releases]
source_url: https://docs.github.com/en/rest/releases/releases
timestamp: 2026-06-11T11:23:58.401229+00:00
---

Get the latest release

GET /repos/{owner}/{repo}/releases/latest
Full URL: https://api.github.com/repos/{owner}/{repo}/releases/latest

View the latest published full release for the repository. The latest release
is the most recent non-prerelease, non-draft release.

Path parameters: owner (string, required), repo (string, required). Works
unauthenticated for public repositories at the standard 60 requests/hour IP
limit; send Accept: application/vnd.github.v3+json.
