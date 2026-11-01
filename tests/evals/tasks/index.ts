// Every golden task, by suite. The INJECTION suite is loaded separately (src/core/evals/injection.ts:
// Part 1's set, through its hook).
import { CAPABILITY as BASE_CAPABILITY } from './capability.ts';
import { CLAIM_CASES } from './claim-backlog.ts';
import { REGRESSION as BASE_REGRESSION } from './regression.ts';

// Claim cases are capability cases until they graduate (tests/evals/tasks/claims.ts).
// A claim case that graduated (tests/evals/tasks/claim-backlog.ts) is a regression task.
export const CAPABILITY = [...BASE_CAPABILITY, ...CLAIM_CASES.filter((t) => t.suite === 'capability')];
export const REGRESSION = [...BASE_REGRESSION, ...CLAIM_CASES.filter((t) => t.suite === 'regression')];
export const TASKS = [...REGRESSION, ...CAPABILITY];
