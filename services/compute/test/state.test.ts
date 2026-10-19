// The node's state file and address helpers (docs/12 §15: secrets in a 0600 file).
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  advertiseUrl,
  defaultDataDir,
  loadState,
  parseListen,
  saveState,
  statePath,
  type NodeState,
} from '../src/index.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-compute-state-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const STATE: NodeState = {
  version: 1,
  deviceId: 'dev',
  name: 'desk',
  hubUrl: 'http://hub:7419',
  backend: { url: 'http://127.0.0.1:11434', kind: 'ollama' },
  listen: { host: '0.0.0.0', port: 7420 },
  endpoint: 'http://10.0.0.2:7420',
  maxConcurrentJobs: 1,
  maxQueue: 4,
  enrollment: null,
  revokedAt: null,
  hubTrust: null,
};

describe('state file', () => {
  it('round-trips and is private to the service user', () => {
    const data = join(dir, 'data');
    expect(loadState(data)).toBeNull();
    saveState(data, STATE);
    expect(loadState(data)).toEqual(STATE);
    if (process.platform !== 'win32') {
      expect(statSync(statePath(data)).mode & 0o777).toBe(0o600);
      expect(statSync(data).mode & 0o777).toBe(0o700);
    }
  });

  it('refuses a malformed state file', () => {
    writeFileSync(statePath(dir), JSON.stringify({ version: 2 }));
    expect(() => loadState(dir)).toThrow();
  });

  it('picks a data directory from the environment', () => {
    expect(defaultDataDir({ NOVA_COMPUTE_DATA_DIR: '/x' })).toBe('/x');
    expect(defaultDataDir({ XDG_DATA_HOME: '/d' })).toBe(join('/d', 'nova-compute'));
    expect(defaultDataDir({})).toMatch(/nova-compute$/);
  });
});

describe('addresses', () => {
  it('parses listen addresses', () => {
    expect(parseListen('127.0.0.1:8000')).toEqual({ host: '127.0.0.1', port: 8000 });
    expect(parseListen(':9000')).toEqual({ host: '0.0.0.0', port: 9000 });
    expect(parseListen('7420')).toEqual({ host: '0.0.0.0', port: 7420 });
    expect(parseListen('[::1]:7420')).toEqual({ host: '::1', port: 7420 });
    expect(() => parseListen('host:99999')).toThrow(TypeError);
    expect(() => parseListen('nope')).toThrow(TypeError);
  });

  it('advertises a concrete address for a wildcard listener', () => {
    expect(advertiseUrl({ host: '10.1.2.3', port: 1 })).toBe('http://10.1.2.3:1');
    expect(advertiseUrl({ host: '::1', port: 2 })).toBe('http://[::1]:2');
    expect(advertiseUrl({ host: '0.0.0.0', port: 3 })).toMatch(/^http:\/\/[\d.]+:3$/);
  });
});
