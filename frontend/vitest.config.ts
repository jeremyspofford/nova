/// <reference types="vitest" />
/** Unit tests for the frontend, which had none: 2300 lines of api.ts, every
 *  formatter, every reducer, all shipped on the e2e suite's word alone.
 *
 *  The coverage floor is a RATCHET, same contract as
 *  backend/tests/coverage_floor.json: it records the best total honestly
 *  reached, a change that drops below it fails, and it only moves up — in
 *  the same commit as the tests that earned it, where lowering it is a
 *  visible diff. It is not a target; it is the line behind us. */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import floor from './coverage_floor.json';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      thresholds: {
        lines: floor.lines,
        statements: floor.statements,
        functions: floor.functions,
        branches: floor.branches,
      },
    },
  },
});
