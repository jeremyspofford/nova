// Launch arguments that hold a bundle's sensitive setting (FR-199): only references into the
// server's own part of the vault are resolved at launch, the values are redacted from its logs, and
// a reference to any other secret is passed through as plain text.
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE, harness, stdioConfig, type Harness } from './helpers.ts';

let h: Harness | null = null;
afterEach(async () => {
  await h?.manager.close();
  h = null;
});

describe('secret arguments', () => {
  it("resolves the server's own references and redacts them", async () => {
    h = harness();
    h.secrets.set('secret://mcp/s-args/arg/2', 'ARG_TARGET');
    const cfg = stdioConfig({
      id: 's-args',
      args: [FIXTURE, '--print-env', 'secret://mcp/s-args/arg/2'],
      env: { ARG_TARGET: 'visible-value' },
    });
    await h.manager.add(cfg);
    expect(h.manager.state(cfg.id)!.status).toBe('connected');
    const lines = h.manager.logs(cfg.id).map((l) => l.text);
    // The fixture printed the variable the resolved argument named; its name is a secret now.
    expect(lines).toContain('env [REDACTED]=[REDACTED]');
    expect(JSON.stringify(lines)).not.toMatch(/secret:|ARG_TARGET/);
  });

  it('never resolves a reference outside its own namespace', async () => {
    h = harness();
    h.secrets.set('secret://provider/p1/api_key', 'SHOULD_NOT_LEAK');
    const cfg = stdioConfig({
      id: 's-other',
      args: [FIXTURE, '--print-env', 'secret://provider/p1/api_key'],
    });
    await h.manager.add(cfg);
    const lines = h.manager.logs(cfg.id).map((l) => l.text);
    // Passed through unresolved: the fixture saw the reference text itself.
    expect(lines.some((l) => l.startsWith('env secret:'))).toBe(true);
    expect(JSON.stringify(lines)).not.toContain('SHOULD_NOT_LEAK');
  });

  it('fails closed when its own secret is missing', async () => {
    h = harness({ backoff: { baseMs: 5000, maxMs: 5000 } });
    const cfg = stdioConfig({ id: 's-missing', args: [FIXTURE, 'secret://mcp/s-missing/arg/1'] });
    await h.manager.add(cfg);
    expect(h.manager.state(cfg.id)).toMatchObject({
      status: 'error',
      lastError: 'the secret for argument 2 is missing',
    });
  });
});
