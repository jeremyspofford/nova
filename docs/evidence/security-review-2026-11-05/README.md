# Security, performance and readiness fixes — 2026-11-05

Addresses the seven findings from the November 5 review of 03b4facd.

- Host Node pin: 26.13.0, including the October 21 security fixes. The permission-model metadata probe now returns `ERR_ACCESS_DENIED`.
- Web fetching: abort-aware decompression pipeline, bounded decompressed content, and explicit rejection of premature close/oversized bodies. Tests cover gzip, deflate and Brotli timeout/cancellation and malformed/valid bodies.
- Framing: CSP `frame-ancestors 'none'` plus `X-Frame-Options: DENY`. A real second local origin's iframe is blocked by Chromium's CSP enforcement.
- File reads: asynchronous bounded reads, regular-file validation, nonblocking FIFO refusal and UTF-8-safe truncation.
- History: rebuildable metadata index with filesystem invalidation, asynchronous cold HTTP indexing, shared in-flight rebuild, cursor pagination, and an Older conversations control. Parsed active-session events are reused across appends; externally changed/replaced logs are read again, and callers cannot mutate the cached record. The legacy array endpoint remains available.
- Health: shared readiness labels distinguish unchecked, limited, unconfigured and missing passkey setup from faults. Settings links identify the next step. Styleguide covers the new state.
- Imports: setup and grounding use the configured home directory; paths also identify the computer that owns the files.

## Validation

- Token lint, theme checks and TypeScript passed.
- Focused security/server/health/onboarding suites: 86 passed, no skips.
- Follow-up grounding/self/index suites: 15 passed, no skips. Import/ingest/setup follow-up: 33 passed, no skips.
- Browser pagination/readiness: phone, tablet and desktop passed (3 tests).
- Browser setup: phone, tablet and desktop passed (3 tests).
- Existing Health Chromium integration passed after correcting its observer to start at the current saving transition, excluding the previous save's success before click preparation. The assertion that a failed attempt never shows success remains intact.
- Eighteen desktop/phone route combinations: no page errors, document overflow or axe WCAG A/AA violations.
- Full `npm test` was attempted under `docker-init -s`, then interrupted after Docker workspace tests failed/stalled: this runtime cannot list container processes or pause containers because cgroup/freezer paths are unavailable. It is not a passing full-suite result. Import-path expectations discovered in that run were corrected and rerun separately.
- WebKit is absent from this machine; its check did not pass. CI's pinned Playwright image must validate WebKit and the full Docker-dependent suites before merge.

Synthetic benchmark on the same machine (single samples, not production throughput):

| Operation | Before | After |
| --- | --- | --- |
| 64 MiB file, event-loop delay | 112.9 ms | 0.2 ms |
| 64 MiB file, RSS increase during sample | 88 MiB | 0.25 MiB |
| 5,000 conversations, event-loop delay | 68.3 ms | 1.2 ms during asynchronous cold indexing |
| 5,000 conversations, warm list | 68.3 ms synchronous scan | 1.8 ms |

Cold asynchronous indexing took about 1.06 seconds while yielding to other work. Plain JSONL files remain authoritative; indexes are disposable. Very long conversations still have a full server-side reduction when a snapshot is requested; this change reduces repeated disk/JSON parsing and bounds list responses, not all costs of arbitrarily long individual conversations.

## Rendered evidence

Each posture has an app Health screenshot and a matched HealthCard styleguide screenshot:

| Posture | App | Styleguide |
| --- | --- | --- |
| Phone, 375 × 812 | [App](app-phone.png) | [Styleguide](styleguide-phone.png) |
| Tablet, 768 × 1024 | [App](app-tablet.png) | [Styleguide](styleguide-tablet.png) |
| Desktop, 1280 × 820 | [App](app-desktop.png) | [Styleguide](styleguide-desktop.png) |
| Half-open, 842 × 675 | [App](app-halfopen.png) | [Styleguide](styleguide-halfopen.png) |

The UI reuses existing cards, rows, pills, links and buttons. No new fonts, colors, radii, shadows, decorative gradients, emoji or icon treatment were introduced; token lint passed. Copy is tied to observed readiness. Existing unconfigured services are described as optional/unconfigured rather than as failures.
