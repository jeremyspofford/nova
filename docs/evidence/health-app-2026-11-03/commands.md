# Task 4 complete command record

Each metadata link preserves the recorded actual argv, Docker mounts/env/cwd, UTC start/end, exit, listed source/runner hashes and egress count. Outputs are raw and include every failed attempt. No failed output is relabelled green.

**Provenance precision:** hash sets are those actually recorded for each attempt. Early small reload-probe variants were not included in the start hash list; only the final pinned probe source/hash was archived. The first SW supplement is explicitly post-run, before further source edits. The final source manifest is authoritative for the delivered tree, not retroactive proof of every early probe variant. These limits are also disclosed in the full report.

Intermediate PNG binaries remain private under exact-image-only ignore entries; all hashes are in [the intermediate manifest](intermediate-png-manifest.json). Final40 publication copies and all raw command/stdout records are tracked.

| Attempt | Exit | Recorded exact command/env/source set | Raw output |
| --- | ---: | --- | --- |
| red-app | 1 | [argv](red-app/command.json) | [stdout](red-app/stdout.txt) |
| red-app-corrected | 1 | [argv](red-app-corrected/command.json) | [stdout](red-app-corrected/stdout.txt) |
| green-app-1 | 1 | [argv](green-app-1/command.json) | [stdout](green-app-1/stdout.txt) |
| green-app-2 | 1 | [argv](green-app-2/command.json) | [stdout](green-app-2/stdout.txt) |
| static-1 | 0 | [argv](static-1/command.json) | [stdout](static-1/stdout.txt) |
| typecheck-1 | 0 | [argv](typecheck-1/command.json) | [stdout](typecheck-1/stdout.txt) |
| green-app-3 | 1 | [argv](green-app-3/command.json) | [stdout](green-app-3/stdout.txt) |
| affected-core | 1 | [argv](affected-core/command.json) | [stdout](affected-core/stdout.txt) |
| green-app-4 | 1 | [argv](green-app-4/command.json) | [stdout](green-app-4/stdout.txt) |
| affected-core-identity | 0 | [argv](affected-core-identity/command.json) | [stdout](affected-core-identity/stdout.txt) |
| green-app-5 | 0 | [argv](green-app-5/command.json) | [stdout](green-app-5/stdout.txt) |
| crawl-1 | 0 | [argv](crawl-1/command.json) | [stdout](crawl-1/stdout.txt) |
| red-island-blur | 1 | [argv](red-island-blur/command.json) | [stdout](red-island-blur/stdout.txt) |
| green-island-both | 1 | [argv](green-island-both/command.json) | [stdout](green-island-both/stdout.txt) |
| debug-webkit-crash | 1 | [argv](debug-webkit-crash/command.json) | [stdout](debug-webkit-crash/stdout.txt) |
| debug-webkit-number-restore | 1 | [argv](debug-webkit-number-restore/command.json) | [stdout](debug-webkit-number-restore/stdout.txt) |
| debug-webkit-minimal | 1 | [argv](debug-webkit-minimal/command.json) | [stdout](debug-webkit-minimal/stdout.txt) |
| debug-webkit-context-route | 1 | [argv](debug-webkit-context-route/command.json) | [stdout](debug-webkit-context-route/stdout.txt) |
| debug-webkit-static-route | 1 | [argv](debug-webkit-static-route/command.json) | [stdout](debug-webkit-static-route/stdout.txt) |
| debug-webkit-two-plain-reloads | 1 | [argv](debug-webkit-two-plain-reloads/command.json) | [stdout](debug-webkit-two-plain-reloads/stdout.txt) |
| debug-webkit-pinned-baseline | 1 | [argv](debug-webkit-pinned-baseline/command.json) | [stdout](debug-webkit-pinned-baseline/stdout.txt) |
| green-full-isolated | 1 | [argv](green-full-isolated/command.json) | [stdout](green-full-isolated/stdout.txt) |
| styleguide-final | 0 | [argv](styleguide-final/command.json) | [stdout](styleguide-final/stdout.txt) |
| static-final | 0 | [argv](static-final/command.json) | [stdout](static-final/stdout.txt) |
| debug-save-refusal | 0 | [argv](debug-save-refusal/command.json) | [stdout](debug-save-refusal/stdout.txt) |
| red-refusal-refresh | 1 | [argv](red-refusal-refresh/command.json) | [stdout](red-refusal-refresh/stdout.txt) |
| green-complete-1 | 1 | [argv](green-complete-1/command.json) | [stdout](green-complete-1/stdout.txt) |
| red-refresh-layout | 1 | [argv](red-refresh-layout/command.json) | [stdout](red-refresh-layout/stdout.txt) |
| red-refresh-layout-settled | 1 | [argv](red-refresh-layout-settled/command.json) | [stdout](red-refresh-layout-settled/stdout.txt) |
| green-real-caret-layout | 0 | [argv](green-real-caret-layout/command.json) | [stdout](green-real-caret-layout/stdout.txt) |
| final-browser | 0 | [argv](final-browser/command.json) | [stdout](final-browser/stdout.txt) |
| final-crawl | 0 | [argv](final-crawl/command.json) | [stdout](final-crawl/stdout.txt) |
| final-static | 0 | [argv](final-static/command.json) | [stdout](final-static/stdout.txt) |
| fixed-clock | 0 | [argv](fixed-clock/command.json) | [stdout](fixed-clock/stdout.txt) |
| final-browser-offline | 1 | [argv](final-browser-offline/command.json) | [stdout](final-browser-offline/stdout.txt) |
| red-lost-put | 1 | [argv](red-lost-put/command.json) | [stdout](red-lost-put/stdout.txt) |
| qualified-browser | 1 | [argv](qualified-browser/command.json) | [stdout](qualified-browser/stdout.txt) |
| qualified-crawl | 0 | [argv](qualified-crawl/command.json) | [stdout](qualified-crawl/stdout.txt) |
| qualified-static | 0 | [argv](qualified-static/command.json) | [stdout](qualified-static/stdout.txt) |
| qualified-browser-2 | 1 | [argv](qualified-browser-2/command.json) | [stdout](qualified-browser-2/stdout.txt) |
| qualified-browser-3 | 1 | [argv](qualified-browser-3/command.json) | [stdout](qualified-browser-3/stdout.txt) |
| qualified-static-2 | 0 | [argv](qualified-static-2/command.json) | [stdout](qualified-static-2/stdout.txt) |
| qualified-browser-4 | 0 | [argv](qualified-browser-4/command.json) | [stdout](qualified-browser-4/stdout.txt) |
| release-crawl | 0 | [argv](release-crawl/command.json) | [stdout](release-crawl/stdout.txt) |
| release-typecheck | 0 | [argv](release-typecheck/command.json) | [stdout](release-typecheck/stdout.txt) |
| red-local-core-connectivity | 1 | [argv](red-local-core-connectivity/command.json) | [stdout](red-local-core-connectivity/stdout.txt) |
| core-connectivity-browser | 1 | [argv](core-connectivity-browser/command.json) | [stdout](core-connectivity-browser/stdout.txt) |
| core-connectivity-offline | 0 | [argv](core-connectivity-offline/command.json) | [stdout](core-connectivity-offline/stdout.txt) |
| red-unchanged-validation | 1 | [argv](red-unchanged-validation/command.json) | [stdout](red-unchanged-validation/stdout.txt) |
| final-approved-browser | 0 | [argv](final-approved-browser/command.json) | [stdout](final-approved-browser/stdout.txt) |
| final-approved-static | 0 | [argv](final-approved-static/command.json) | [stdout](final-approved-static/stdout.txt) |
| final-approved-crawl | 0 | [argv](final-approved-crawl/command.json) | [stdout](final-approved-crawl/stdout.txt) |
| red-diagnostics-worker-upgrade | 1 | [argv](red-diagnostics-worker-upgrade/command.json) | [stdout](red-diagnostics-worker-upgrade/stdout.txt) |
| red-worker-unrelated-cache | 1 | [argv](red-worker-unrelated-cache/command.json) | [stdout](red-worker-unrelated-cache/stdout.txt) |
| debug-worker-migration | 1 | [argv](debug-worker-migration/command.json) | [stdout](debug-worker-migration/stdout.txt) |
| red-worker-owned-cleanup | 1 | [argv](red-worker-owned-cleanup/command.json) | [stdout](red-worker-owned-cleanup/stdout.txt) |
| sw-final-browser | 1 | [argv](sw-final-browser/command.json) | [stdout](sw-final-browser/stdout.txt) |
| sw-final-offline | 1 | [argv](sw-final-offline/command.json) | [stdout](sw-final-offline/stdout.txt) |
| sw-final-static | 0 | [argv](sw-final-static/command.json) | [stdout](sw-final-static/stdout.txt) |
| sw-owned-outage-browser | 1 | [argv](sw-owned-outage-browser/command.json) | [stdout](sw-owned-outage-browser/stdout.txt) |
| topology-offline-pinned-baseline | 1 | [argv](topology-offline-pinned-baseline/command.json) | [stdout](topology-offline-pinned-baseline/stdout.txt) |
| debug-validation-events | 0 | [argv](debug-validation-events/command.json) | [stdout](debug-validation-events/stdout.txt) |
| red-save-press-revalidation | 1 | [argv](red-save-press-revalidation/command.json) | [stdout](red-save-press-revalidation/stdout.txt) |
| topology-offline-semantic | 0 | [argv](topology-offline-semantic/command.json) | [stdout](topology-offline-semantic/stdout.txt) |
| red-save-press-revalidation-cleanup | 1 | [argv](red-save-press-revalidation-cleanup/command.json) | [stdout](red-save-press-revalidation-cleanup/stdout.txt) |
| final-revalidation-browser | 1 | [argv](final-revalidation-browser/command.json) | [stdout](final-revalidation-browser/stdout.txt) |
| final-revalidation-static | 1 | [argv](final-revalidation-static/command.json) | [stdout](final-revalidation-static/stdout.txt) |
| final-revalidation-crawl | 0 | [argv](final-revalidation-crawl/command.json) | [stdout](final-revalidation-crawl/stdout.txt) |
| release-final-browser | 1 | [argv](release-final-browser/command.json) | [stdout](release-final-browser/stdout.txt) |
| release-final-static | 0 | [argv](release-final-static/command.json) | [stdout](release-final-static/stdout.txt) |
| release-qualified-browser | 0 | [argv](release-qualified-browser/command.json) | [stdout](release-qualified-browser/stdout.txt) |
| delivery-crawl | 0 | [argv](delivery-crawl/command.json) | [stdout](delivery-crawl/stdout.txt) |
| delivery-typecheck | 0 | [argv](delivery-typecheck/command.json) | [stdout](delivery-typecheck/stdout.txt) |
| delivery-offline-compatibility | 0 | [argv](delivery-offline-compatibility/command.json) | [stdout](delivery-offline-compatibility/stdout.txt) |

## Fix1 — Health-entry spend refresh (base c071)

All five new attempts record exact mounted-source hashes at command start, full stdout and owned-container cleanup. [Hash index](fix-1-command-hashes.json). Original74 attempts and early probe provenance limits above remain historical, unchanged. No retries after the qualified pass.

| Run | Exit | Exact command | Raw output |
| --- | --- | --- | --- |
| fix-1-browser-green | 1 | [argv](fix-1-browser-green/command.json) | [stdout](fix-1-browser-green/stdout.txt) |
| fix-1-browser-qualified | 0 | [argv](fix-1-browser-qualified/command.json) | [stdout](fix-1-browser-qualified/stdout.txt) |
| fix-1-entry-red | 1 | [argv](fix-1-entry-red/command.json) | [stdout](fix-1-entry-red/stdout.txt) |
| fix-1-home-crawl | 0 | [argv](fix-1-home-crawl/command.json) | [stdout](fix-1-home-crawl/stdout.txt) |
| fix-1-static-qualified | 0 | [argv](fix-1-static-qualified/command.json) | [stdout](fix-1-static-qualified/stdout.txt) |

## Fix2 — per-Caps failure boundary (base308c)

All four commands retain exact current app/browser-test hashes, full stdout and container cleanup. [Hash index](fix-2-command-hashes.json). Existing runner metadata does not list offline.test.ts: its [explicit post-start supplement](fix-2-offline-test-provenance.json) verifies byte identity to308c, not a pre-execution capture. Original early-probe provenance limits remain.

| Run | Exit | Exact command | Raw output |
| --- | --- | --- | --- |
| fix-2-browser-qualified | 0 | [argv](fix-2-browser-qualified/command.json) | [stdout](fix-2-browser-qualified/stdout.txt) |
| fix-2-core-outage-qualified | 0 | [argv](fix-2-core-outage-qualified/command.json) | [stdout](fix-2-core-outage-qualified/stdout.txt) |
| fix-2-partial-red | 1 | [argv](fix-2-partial-red/command.json) | [stdout](fix-2-partial-red/stdout.txt) |
| fix-2-static-qualified | 0 | [argv](fix-2-static-qualified/command.json) | [stdout](fix-2-static-qualified/stdout.txt) |
