// The cost of screening every chunk (docs/plans/gate-decision-service.md, "Cost"), measured, not
// guessed: one long document through the real gate and the real Tev1 and Jev seats, against the
// loopback stand-ins, counting chunks, requests and estimated input tokens per seat. Run by hand:
//   node tests/support/screen-cost.ts [characters]
// Nothing calls TypeSafe or a real Ollama.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../../src/core/index.ts';
import { memoryVerdicts } from '../../src/core/decision-service/index.ts';
import { chunks } from '../../src/core/ingest/screen.ts';
import { check } from '../../src/core/ingest/checks.ts';
import { startTev1StandIn } from './tev1-stand-in.ts';
import { startJevStandIn } from './jev-stand-in.ts';
import { hubHardware } from './models.ts';
import { pass } from './decision-gate.ts';

export async function measure(chars: number) {
  const text = 'Plain words about bread, butter and the weekend market. '.repeat(Math.ceil(chars / 56)).slice(0, chars);
  const n = chunks(check({ text }).visible).parts.length;
  const out: Record<string, { chunks: number; requests: number; input_tokens: number; ms: number }> = {};
  for (const seat of ['tev1', 'jev'] as const) {
    const tev1 = await startTev1StandIn({ score: () => 0.02 });
    const jev = await startJevStandIn({ noul: () => 0.02 });
    const core = createCore({
      home: mkdtempSync(join(tmpdir(), 'nova-screen-cost-')), version: '0.1.0', trustedOrigin: () => true,
      models: { ollamaUrl: tev1.url, hardware: async () => hubHardware() as never, watchMs: 60_000 },
      decisions: { verdicts: memoryVerdicts([seat === 'tev1' ? pass('tev1', 'tev1:4b@aaaa4b') : pass('jev', 'jev-1.14.0')]) },
    });
    core.profile.set('privacy', 'default', seat === 'jev' ? 'cloud-allowed' : 'local-only', 'settings');
    if (seat === 'jev') { core.profile.set('models', 'decision', { jev: { base_url: jev.url, model: 'jev-1.14.0' }, tev1: null, opt_in: { screening: false, box: false } }, 'settings'); core.vault.put('decisions.jev', jev.key); }
    await core.decisionService.refresh();
    const t0 = performance.now();
    const r = await core.ingest.screen({ text, source: { kind: 'file', origin: 'workspace/long.txt' } });
    const ms = Math.round(performance.now() - t0);
    const rows = core.db.all<{ requests: number; usage: string }>("SELECT requests, usage FROM decision_record WHERE template_id = 'ingest-screen'");
    out[seat] = { chunks: n, requests: rows.reduce((a, x) => a + x.requests, 0), input_tokens: rows.reduce((a, x) => a + (JSON.parse(x.usage) as { input_tokens: number }).input_tokens, 0), ms };
    if (r.model === null) throw new Error(`${seat}: the screen didn't use the trusted seat`);
    await core.close(); await tev1.close(); await jev.close();
  }
  return out;
}

if (import.meta.main) {
  const chars = Number(process.argv[2] ?? 2_000_000);
  console.log(JSON.stringify({ characters: chars, ...(await measure(chars)) }, null, 2));
}
