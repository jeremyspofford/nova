import { expect, it } from 'vitest';
import { COMPUTE_NODE_VERSION } from '../src/index.ts';

it('exports a version', () => {
  expect(COMPUTE_NODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
