---
type: topic
title: get-weather tool
priority: 1
source_type: tool
enabled: true
description: The Open-Meteo forecast tool — coordinates only, keyless, and why air quality is not on the same host
category: knowledge
tags: [get-weather, open-meteo, http-call-tools]
timestamp: 2026-05-14T16:47:02.664190+00:00
---

method: GET
url_template: https://api.open-meteo.com/v1/forecast?latitude={latitude}&longitude={longitude}&current=temperature_2m,weather_code
No headers, no key — Open-Meteo is keyless for non-commercial use.

It takes coordinates, never a place name or a postal code, and one http_call
is a single request with nowhere to chain a geocoding lookup.

Air quality is a separate Open-Meteo product on its own host,
air-quality-api.open-meteo.com, which is not on our allowlist.
