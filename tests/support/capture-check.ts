// A capture-sensitive check for full-core tests (capture screening, job 1), with no Ollama: the Tev1
// stand-in (HTTP on loopback, local, as the real seat is) answers capture-sensitive's four questions
// from markers in the text, and a verdict store trusts capture-sensitive v1 on the stand-in's
// tev1:4b build only when the test says so. `trust()` and `distrust()` change that while the core
// runs, so a test can show held events released once a model is trusted.
//
// The markers (synthetic only): CANARY-GREY-PASSWORD, CANARY-GREY-SECRET, CANARY-GREY-FINANCE,
// CANARY-GREY-HEALTH answer yes to their question; CANARY-GREY-UNSURE leaves every question
// unsettled; anything else is no to all four.
import { memoryVerdicts, type VerdictRecord, type VerdictStore } from '../../src/core/decision-service/index.ts';
import { startTev1StandIn } from './tev1-stand-in.ts';
import { hardwareFile, hubHardware } from './models.ts';

export const STAND_IN_MODEL = 'tev1:4b@aaaa4b';
export const CS_PASS: VerdictRecord = { template_id: 'capture-sensitive', version: 1, seat: 'tev1', model: STAND_IN_MODEL, status: 'pass', why: 'test pass (stand-in)', run_at: '2026-10-31T00:00:00Z', ref: 'test#capture-sensitive' };

const MARKS: Record<string, string> = { password: 'CANARY-GREY-PASSWORD', secret_key: 'CANARY-GREY-SECRET', financial_details: 'CANARY-GREY-FINANCE', health_details: 'CANARY-GREY-HEALTH' };

export function captureScore(content: string, question: string): number {
  if (!(question in MARKS)) return 0.02;
  if (content.includes('CANARY-GREY-UNSURE')) return 0.5;
  return content.includes(MARKS[question]!) ? 0.96 : 0.02;
}

// For a real server, which reads the committed verdicts: a stand-in listing tev1:4b at the build that
// passed capture-sensitive's eval (verdicts-capture-sensitive.json), so the server trusts it. It is
// a stand-in all the same: its answers are captureScore's, not the model's.
export const PASSED_4B = { name: 'tev1:4b', digest: 'sha256:7954dce22bc6c29c3b119656207681d12cb34434fed7caa086bfbc919bef0740', size: 4_610_582_112, family: 'qwen35', parameter_size: '4B' };
// Ollama's version on the run that passed (Tev1 needs 0.40.4 or later).
export const PASSED_OLLAMA = '0.40.13';

// The Tev1 stand-in alone as the server's Ollama, with the hardware file that picks Tev1 4B.
export async function captureCheckServer(dir: string) {
  const tev1 = await startTev1StandIn({ models: [PASSED_4B], version: PASSED_OLLAMA, score: captureScore });
  return { tev1, env: { NOVA_OLLAMA_URL: tev1.url, NOVA_HARDWARE_FILE: hardwareFile(dir) }, close: () => tev1.close() };
}

export async function captureCheck(o: { trusted?: boolean; score?: (content: string, question: string) => number; contextBytes?: number } = {}) {
  const tev1 = await startTev1StandIn({ score: o.score ?? captureScore, ...(o.contextBytes ? { contextBytes: o.contextBytes } : {}) });
  const records: VerdictRecord[] = o.trusted === false ? [] : [CS_PASS];
  const now = () => memoryVerdicts(records);
  const verdicts: VerdictStore = { lookup: (...a) => now().lookup(...a), passed: (...a) => now().passed(...a), forModel: (...a) => now().forModel(...a) };
  // What the stand-in was asked about captured text: the states it saw, as JSON.
  const seen = () => tev1.requests.filter((r) => Object.keys(r.questions).includes('password')).map((r) => JSON.stringify(r.state));
  return {
    tev1, seen,
    trust: () => { if (!records.includes(CS_PASS)) records.push(CS_PASS); },
    distrust: () => { records.splice(0, records.length); },
    core: { models: { ollamaUrl: tev1.url, hardware: async () => hubHardware() as never, watchMs: 60_000 }, decisions: { verdicts } },
    close: () => tev1.close(),
  };
}
