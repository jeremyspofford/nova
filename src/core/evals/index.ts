// The eval harness (Amendment 2026-10-31-B Part 4): golden tasks graded on outcomes, the
// REGRESSION, CAPABILITY and INJECTION suites, and the model-swap scorecard. The tasks themselves,
// and the driver that runs them on a whole Nova, live in tests/evals (they need createNova, which
// the core may not import). See docs/plans/evals.md.
export * from './types.ts';
export * from './graders.ts';
export { runSuite, fingerprintOf, manifestOf, regressionVerdict, type Driven, type RunOptions } from './run.ts';
export { Scorecards, SCORECARD_DIR, SCORECARD_SCHEMA, cardFile, scorecardRoutes, targetsFrom, type Target, type Scorecard, type SuiteCard, type CardState, type CardStatus } from './scorecards.ts';
export { demonstrated, checkClaims, type Claim, type ClaimsReport } from './claims.ts';
export { INJECTION_SET, injectionPaths, loadInjectionSet, injectionTasks, type InjectionCase, type InjectionTask, type Screening } from './injection.ts';
export { REGRESSION_MANIFEST, REGRESSION_FINGERPRINT } from './manifest.ts';
