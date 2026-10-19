// Runs one script in a worker thread of its own (FR-202). The worker has its own heap limits,
// an empty environment and no access to the Hub: it can only post nested calls, which this side
// hands to `call` one at a time and answers. Beyond the engine's own CPU budget, a watchdog
// counts the time the worker runs with no nested call outstanding and terminates it once that
// passes the budget plus a grace period, so even an engine that never yields is stopped. The
// abort signal (the tool's timeout, a cancelled turn) terminates it too.
import { Worker } from 'node:worker_threads';
import {
  DEFAULT_SCRIPT_LIMITS,
  MAX_CALL_ARGS_CHARS,
  type BridgeAnswer,
  type ScriptLimits,
  type ScriptOutcome,
} from './vm.ts';

/** Largest `input` accepted, as JSON characters. */
export const MAX_INPUT_CHARS = 200_000;
/** Time the worker gets beyond the CPU budget (start-up, loading the engine). */
export const WATCHDOG_GRACE_MS = 3_000;

const WORKER_URL = new URL('./worker.ts', import.meta.url);

export interface IsolatedScript {
  code: string;
  input?: unknown;
  /** Tool names offered as functions (`tools['fs.read'](args)`). */
  names: string[];
  limits?: Partial<ScriptLimits>;
  signal: AbortSignal;
  /** One nested call; never called concurrently. */
  call: (name: string, args: unknown) => Promise<BridgeAnswer>;
  /** Override the watchdog grace (tests). */
  graceMs?: number;
}

type FromWorker =
  | { type: 'call'; id: number; name: string; argsJson: string }
  | { type: 'done'; outcome: ScriptOutcome };

function failed(code: NonNullable<ScriptOutcome['error']>['code'], message: string): ScriptOutcome {
  return {
    ok: false,
    resultJson: null,
    resultTruncated: false,
    error: { code, message },
    log: '',
    logTruncated: false,
    cpuMs: 0,
    calls: 0,
  };
}

export function resolveLimits(over: Partial<ScriptLimits> = {}): ScriptLimits {
  return { ...DEFAULT_SCRIPT_LIMITS, ...over };
}

/** Run a script in its own worker; never throws. */
export function runIsolatedScript(s: IsolatedScript): Promise<ScriptOutcome> {
  const limits = resolveLimits(s.limits);
  let inputJson: string;
  try {
    inputJson = JSON.stringify(s.input ?? null) ?? 'null';
  } catch {
    return Promise.resolve(failed('script_error', 'the input is not JSON'));
  }
  if (inputJson.length > MAX_INPUT_CHARS)
    return Promise.resolve(failed('script_error', 'the input is too large'));
  if (s.signal.aborted) return Promise.resolve(failed('cancelled', 'the script was stopped'));

  return new Promise<ScriptOutcome>((resolve) => {
    const heapMb = Math.ceil(limits.memoryBytes / 1048576);
    let worker: Worker;
    try {
      worker = new Worker(WORKER_URL, {
        workerData: { code: s.code, inputJson, names: s.names, limits },
        // The engine's memory lives in the worker's heap; nothing of the Hub's environment does.
        resourceLimits: {
          maxOldGenerationSizeMb: 64 + heapMb * 2,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
        env: {},
        stdout: true,
        stderr: true,
      });
    } catch {
      resolve(failed('crashed', 'the script engine could not start'));
      return;
    }
    // The engine's own diagnostics are not the Hub's to print.
    worker.stdout.resume();
    worker.stderr.resume();

    let done = false;
    let pending = 0;
    let computed = 0;
    let since = Date.now();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const budget = limits.cpuMs + (s.graceMs ?? WATCHDOG_GRACE_MS);

    const finish = (o: ScriptOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      s.signal.removeEventListener('abort', onAbort);
      void worker.terminate().catch(() => undefined);
      resolve(o);
    };
    const arm = () => {
      clearTimeout(watchdog);
      since = Date.now();
      watchdog = setTimeout(
        () =>
          finish(failed('cpu_limit', `the script used more than ${limits.cpuMs} ms of CPU time`)),
        Math.max(0, budget - computed),
      );
    };
    const pause = () => {
      clearTimeout(watchdog);
      computed += Date.now() - since;
    };
    const onAbort = () => finish(failed('cancelled', 'the script was stopped'));
    s.signal.addEventListener('abort', onAbort, { once: true });
    arm();

    worker.on('message', (m: FromWorker) => {
      if (done) return;
      if (m.type === 'done') {
        finish(m.outcome);
        return;
      }
      if (m.type !== 'call') return;
      pending++;
      if (pending === 1) pause();
      const answer = async (): Promise<BridgeAnswer> => {
        if (typeof m.name !== 'string' || typeof m.argsJson !== 'string')
          return { ok: false, code: 'invalid_arguments', message: 'a tool name is needed' };
        if (m.argsJson.length > MAX_CALL_ARGS_CHARS)
          return { ok: false, code: 'invalid_arguments', message: 'the arguments are too large' };
        let args: unknown;
        try {
          args = JSON.parse(m.argsJson) as unknown;
        } catch {
          return { ok: false, code: 'invalid_arguments', message: 'the arguments are not JSON' };
        }
        try {
          return await s.call(m.name, args);
        } catch (err) {
          return {
            ok: false,
            code: 'tool_error',
            message: err instanceof Error ? err.message : String(err),
          };
        }
      };
      void answer().then((a) => {
        if (done) return;
        pending--;
        if (pending === 0) arm();
        worker.postMessage({ type: 'answer', id: m.id, answer: a });
      });
    });
    worker.on('error', (err: Error) => {
      const oom = /memory/i.test(err.message);
      finish(
        oom
          ? failed('memory_limit', 'the script used more memory than it may')
          : failed('crashed', 'the script engine failed'),
      );
    });
    worker.on('exit', () => finish(failed('crashed', 'the script engine stopped')));
  });
}
