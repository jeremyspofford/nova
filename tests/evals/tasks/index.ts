// Every golden task, by suite. The INJECTION suite is loaded separately (src/core/evals/injection.ts:
// Part 1's set, through its hook).
import { CAPABILITY as BASE_CAPABILITY } from './capability.ts';
import { CLAIM_CASES } from './claim-backlog.ts';
import { REGRESSION } from './regression.ts';

// Claim cases are capability cases until they graduate (tests/evals/tasks/claims.ts).
export const CAPABILITY = [...BASE_CAPABILITY, ...CLAIM_CASES];
export { REGRESSION };
export const TASKS = [...REGRESSION, ...CAPABILITY];
