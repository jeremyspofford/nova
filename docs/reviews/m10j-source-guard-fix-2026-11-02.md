# Task 5 source-guard regression repair

## Scope and result

Checkout: `/home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build`.
Branch: `codex/m10j-k3s`.
Starting HEAD: `ef60b76b4de0d329bf17a79a92d1bd6c4ecc0645`; tracked tree was clean.
Repair commit: `1673210f59f567d9c5310a0d15553e2f92467a2d` (`fix(services): centralize cluster driver identity`).

The unchanged source guard mistook four legitimate backend identity values for forbidden executable vocabulary. The repair gives that value a single named owner, `K3S_DRIVER_NAME = 'k3s'`, in the already-approved concrete driver module. Its own `name`, the operations registry directory and public observation, and both manager selection comparisons use that same identity. The value, directory layout, public driver name, and explicit-only cluster selection behavior remain the same.

Changed source is limited to `src/core/services/k3s/driver.ts`, `src/core/services/k3s/operations.ts`, and `src/core/services/manager.ts`. The only test change adds two behavioral assertions to the existing trusted-topology operations test: the registered cluster directory exists at `<fixture-home>/services/k3s/simulation`, and the API topology service row exposes `driver: 'k3s'`. Neither assertion imports the new constant; these check filesystem/API contracts, rather than mirroring the implementation.

## Actual RED evidence

Inspected `.superpowers/sdd/M10j/task-5-full-unit-ef60b76b.log`, the completed controller-run full ordinary suite at the starting HEAD. Its recorded result is 1718 tests, 1703 pass, 1 fail, 14 existing opt-in skips, 0 cancelled, 822770.553328 ms, exit 1. The sole failure is `tests/supervisor/services-review.test.ts:538`, the literal-command source guard. It reports exactly the directory/observation values in operations.ts and the two manager comparisons described above. The outer no-Kubernetes tripwire never fired.

The full suite was deliberately not repeated for this repair. The binding repair brief supplies that real RED and reserves final combined-tree/full CI validation for the controller.

## Import and initialization reasoning

Operations already imports the concrete driver; adding its named identity does not add a dependency edge there. Manager now imports the named export directly from `./k3s/driver.ts`, not the core barrel. A recursive source inspection of non-type local imports from the concrete driver found nine modules: driver, definition, mesh/purposes, errors, expected, placement, values, registry, and tools. None imports manager, operations, or a core index. All tools.ts imports are type-only. No initialization cycle is introduced.

The existing driver module defines functions/classes, inert collections, and the clock/capability objects at module scope. Filesystem registry creation belongs to its constructor/register calls; polling, child processes, tool execution, and capability use do not occur on module import. A separate tripwire-armed direct import check starts with manager before importing operations and driver, and checks the initialized exported classes/value. This also exercises the new import in an entry order independent of the core barrel.

## Verification commands

All commands below ran in the exact checkout above, with explicit tool working directories. No Node force-exit or test skip/bypass was used. Test commands use the unchanged scripts/test.sh, which arms the unchanged runtime tripwire and unsets KUBECONFIG.

1. Focused unchanged source guard:

```sh
sh scripts/test.sh --test-concurrency=2 --test-name-pattern='no code in Nova or its scripts names a Kubernetes tool to run' tests/supervisor/services-review.test.ts > .superpowers/sdd/M10j/task-5-source-guard-green.log 2>&1
```

Exit 0: 1 test, 1 pass, 0 fail, 0 skipped/cancelled; 346.462175 ms. Tripwire never fired. The existing planted arbitrary-command positive assertion runs inside this unchanged test.

2. Affected real suites:

```sh
sh scripts/test.sh --test-concurrency=2 tests/core/k3s-driver.test.ts tests/core/k3s-operations.test.ts tests/core/k3s-review.test.ts tests/core/k3s-tools.test.ts tests/core/k3s-chart.test.ts tests/core/services-manager.test.ts tests/core/services-placement.test.ts tests/core/topology-api.test.ts tests/core/topology-actions.test.ts tests/supervisor/services-contract.test.ts tests/supervisor/services.test.ts tests/supervisor/services-cli.test.ts tests/supervisor/services-review.test.ts > .superpowers/sdd/M10j/task-5-source-guard-affected.log 2>&1
```

Exit 0: 159 tests, 159 pass, 0 fail, 0 skipped/cancelled, 201838.328524 ms. Tripwire never fired; a complete-log marker scan found zero warning/failure markers. This covers the shared K3s/supervisor driver contracts, unchanged public and persisted backend identity, registered cluster API and ledger operations, no-capability and hostile-ambient refusal, explicit-only cluster selection, ordinary supervisor selection with no cluster, placement, topology/API authority and read-only paths, and supervisor CLI/service regression paths. It also reruns the unchanged source guard as part of its full file.

3. Typecheck:

```sh
npm run typecheck > .superpowers/sdd/M10j/task-5-source-guard-typecheck.log 2>&1
```

Exit 0. TypeScript project check passed; output contains only the npm script notices, with no type diagnostics.

4. Direct manager-first module initialization:

```sh
sh scripts/tripwire.sh node --input-type=module -e 'const { ServiceManager } = await import("./src/core/services/manager.ts"); const { K3sOperations } = await import("./src/core/services/k3s/operations.ts"); const { K3S_DRIVER_NAME, K3sDriver } = await import("./src/core/services/k3s/driver.ts"); if (typeof ServiceManager !== "function" || typeof K3sOperations !== "function" || typeof K3sDriver !== "function" || K3S_DRIVER_NAME !== "k3s") throw new Error("Direct module initialization failed"); console.log("Direct manager-first module initialization passed");' > .superpowers/sdd/M10j/task-5-source-guard-modules.log 2>&1
```

Exit 0; direct initialization passed; tripwire never fired.

5. Patch and boundary checks:

```sh
git diff --check
git diff --exit-code -- tests/supervisor/services-review.test.ts scripts/tripwire.sh scripts/test.sh package.json package-lock.json
```

Both exit 0. Scanner, path exceptions, planted positive control, test/tripwire scripts, dependencies, and lockfile are unchanged. The full source/test diff was reviewed locally; it contains only the three identity substitutions/import sites plus the existing test's two assertions.

6. Scoped staging and commit:

```sh
git add /home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build/src/core/services/k3s/driver.ts /home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build/src/core/services/k3s/operations.ts /home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build/src/core/services/manager.ts /home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build/tests/core/k3s-operations.test.ts
git diff --cached --check
git diff --cached --stat
git diff --cached --name-only
git commit -m 'fix(services): centralize cluster driver identity'
git rev-parse HEAD
git status --short
```

All exit 0. Exactly the assigned four files were staged and committed (11 insertions, 6 deletions). Commit is `1673210f59f567d9c5310a0d15553e2f92467a2d`; tracked working tree is clean. Report/log files are ignored and were not staged.

## Warnings, limits, and release

No runtime dependencies, scanner exceptions, tool-string obfuscation, command runners, environment bypass, baseline changes, or altered assertions were introduced. Read-only discovery briefly queried two guessed nonexistent filenames (`src/core/services/k3s/chart.ts` and `tests/core/services-topology.test.ts`); rg returned exit 2 for those searches, then the actual files were found with rg --files. These were discovery errors, not test failures. Warning/error-marker searches returning exit 1 mean no matching warnings/failures were found.

No real Kubernetes tools, credentials, owner data, keychain, external cloud/cluster/device/network changes, image/model pulls, preview work, other checkout writes, #275 changes, or M10k work were performed. Cluster and network effects in the affected tests use the existing local simulation/fake fixtures. Task 4's full gate remains blocked on actual P1a/b/c and #275 findings B; this report makes no broker-runner, phase-pass, or merge claim. Independent scoped review and final combined-tree/full CI remain the controller's responsibility.

RELEASE: source ownership is released after report finalization. The affected runner ended with exit 0 and all other owned commands ended. There are no active owned test sessions, pending source writes, background jobs, or further HEAD changes planned. Only the assigned four source/test files were staged; this ignored controller report and logs stay outside the commit. The controller may now inspect/review the commit and resume its own HEAD/combined-CI work.
