// secret-scan: fake-file (the BMC credentials below are made-up fixtures)
// The fake ipmitool wired the way the Hub runs the real one: ProcessMeshRunner with the program
// given by absolute path (node and the script), its state in a JSON file in a temporary folder.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcessMeshRunner } from '../../../src/network/mesh/runner.ts';

export const FAKE_IPMITOOL = fileURLToPath(new URL('./fake-ipmitool.mjs', import.meta.url));

export interface FakeIpmiState {
  password: string;
  power: 'on' | 'off';
  bootdev: string;
  bootOptions?: string[];
  lastPower?: string;
  hang?: boolean;
  calls: { argv: string[]; passwordFromEnv: boolean }[];
}

export function fakeIpmi(dir: string, over: Partial<FakeIpmiState> = {}) {
  const statePath = join(dir, 'ipmi-state.json');
  const initial: FakeIpmiState = {
    password: 'ipmi-secret-7',
    power: 'on',
    bootdev: 'No override',
    calls: [],
    ...over,
  };
  writeFileSync(statePath, JSON.stringify(initial));
  return {
    statePath,
    runner: new ProcessMeshRunner({
      bins: { ipmitool: [process.execPath, FAKE_IPMITOOL] },
      baseEnv: { FAKE_IPMI_STATE: statePath },
    }),
    state: () => JSON.parse(readFileSync(statePath, 'utf8')) as FakeIpmiState,
    set(next: Partial<FakeIpmiState>) {
      const cur = JSON.parse(readFileSync(statePath, 'utf8')) as FakeIpmiState;
      writeFileSync(statePath, JSON.stringify({ ...cur, ...next }));
    },
  };
}
