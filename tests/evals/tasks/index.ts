// Every golden task, by suite. The INJECTION suite is loaded separately (src/core/evals/injection.ts:
// Part 1's set, through its hook).
import { CAPABILITY } from './capability.ts';
import { REGRESSION } from './regression.ts';

export { CAPABILITY, REGRESSION };
export const TASKS = [...REGRESSION, ...CAPABILITY];
