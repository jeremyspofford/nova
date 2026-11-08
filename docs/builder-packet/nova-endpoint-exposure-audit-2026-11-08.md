# Endpoint / surface exposure audit (Muse, 2026-11-08, against origin/main 73cfbd56)

Jeremy's question: are there endpoints Claude built but never exposed in the UI? Answer: yes — mostly missing *pages*, plus capabilities buried with no index. Verified from `src/server.js` dispatch, `ui/js/nav.js`, and the repo tree.

## Pages that exist and are reachable
Nav: Home `/`, Chat `/chat`, Tasks `/tasks`, Memory `/memory`, Automations `/automations` (`/schedules` redirects here), Skills `/skills`, Activity `/activity`, Health `/health`, Settings `/settings`. Under Settings: Capture `/capture`, Machines and services `/topology`. Static: `/styleguide`, `/pair`.

## Ordered, specced, and NOT built as pages
- **About page** — ordered 2026-11-03, delta 2026-11-06. Does not exist. The changelog's own alpha.1 text calls the About area "coming."
- **/changelog page** — `CHANGELOG.md` exists in the repo (versioning landed 2026-11-06 evening, commits 4d13a9ef/5b4517a6; version API `/api/v1/version` live; Health build stamp #375), but there is no in-app changelog surface and no footer version stamp. Jeremy has nothing to click.
- **Pipeline dashboard** — delta 2026-11-06 (generated from `docs/ledger/` + roadmap). Not built.

## Capabilities with APIs/modules but no first-class surface
APIs the UI calls include: browser, changes, checkpoints (module), connections, design-systems, diagnostics, evals, hooks, mesh, messages, models, problems, reset, resilience, services, setup, version. Models, Devices, Services, Connections, Changes live as Settings sub-views at best; Evals, Problems, Resilience, Hooks have no owner-discoverable home. Individually defensible; collectively there is no single place that shows what Nova can do — the About page was supposed to be part of that index.

## Deploy enforcement (Muse, outside the builder)
On 2026-11-08 the preview sat 24 commits / ~17h behind main after six merges with no redeploy. Muse redeployed manually, then installed a deploy watcher (`~/Nova-preview/deploy-watch.sh`, tmux `nova-deploy-watch`, log `~/Nova-preview/deploy-watch.log`): every 120s it fetches origin; on a main change it checks out the preview worktree, updates `deploy/latest.json`, restarts the preview, and logs it. Deploys no longer depend on the builder remembering. It does not survive a WSL/Dell reboot (same limit as the preview itself; the real fix is the Service Manager boot agent, already in launch criteria).
