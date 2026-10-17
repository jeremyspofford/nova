// Local model server detection (docs/07 §12): probe Ollama (`/api/tags`) and a llama.cpp server
// (`/v1/models`) on their default loopback ports, plus any base URLs in `NOVA_DETECT_URLS`.
// Each probe has a short timeout and never sends a credential, cookie or custom header.
import type { DetectedServer } from '@nova/shared';

export const DEFAULT_DETECT_TARGETS = [
  { kind: 'ollama', origin: 'http://127.0.0.1:11434' },
  { kind: 'llamacpp', origin: 'http://127.0.0.1:8080' },
] as const;

export interface DetectOptions {
  fetch?: typeof fetch;
  /** Per probe (default 1.5 s). */
  timeoutMs?: number;
  /** Environment to read `NOVA_DETECT_URLS` from (default `process.env`). */
  env?: Record<string, string | undefined>;
}

/** Comma-separated http(s) base URLs from `NOVA_DETECT_URLS`, as origins plus path, deduped. */
export function detectUrlsFromEnv(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const raw of (env.NOVA_DETECT_URLS ?? '').split(',')) {
    const v = raw.trim();
    if (!v) continue;
    try {
      const u = new URL(v);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      if (u.username || u.password) continue; // never carry credentials into a probe
      const base = `${u.origin}${u.pathname}`.replace(/\/+$/, '').replace(/\/v1$/, '');
      if (!out.includes(base)) out.push(base);
    } catch {
      // ignore malformed entries
    }
  }
  return out;
}

export async function detectLocalServers(opts: DetectOptions = {}): Promise<DetectedServer[]> {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? 1_500;
  const get = (url: string) => probeJson(doFetch, url, timeoutMs);
  const defaults = DEFAULT_DETECT_TARGETS.map((t) => t.origin as string);
  const extra = detectUrlsFromEnv(opts.env ?? process.env).filter((u) => !defaults.includes(u));

  const results = await Promise.all([
    probeOllama(get, DEFAULT_DETECT_TARGETS[0].origin),
    probeOpenAI(get, DEFAULT_DETECT_TARGETS[1].origin, 'llamacpp'),
    ...extra.map(async (base) => {
      const [ollama, other] = await Promise.all([
        probeOllama(get, base),
        probeOpenAI(get, base, null),
      ]);
      return ollama ?? other;
    }),
  ]);
  return results.filter((r): r is DetectedServer => r !== null);
}

type Get = (url: string) => Promise<unknown>;

async function probeOllama(get: Get, base: string): Promise<DetectedServer | null> {
  const body = await get(`${base}/api/tags`);
  if (!isRecord(body) || !Array.isArray(body.models)) return null;
  const models = body.models.flatMap((m) => {
    const id = isRecord(m) ? (m.model ?? m.name) : undefined;
    return typeof id === 'string' ? [id] : [];
  });
  return { kind: 'ollama', baseUrl: `${base}/v1`, models: [...new Set(models)].sort() };
}

/** An OpenAI-style `/v1/models`; llama.cpp marks its entries `owned_by: "llamacpp"`. */
async function probeOpenAI(
  get: Get,
  base: string,
  kind: DetectedServer['kind'] | null,
): Promise<DetectedServer | null> {
  const body = await get(`${base}/v1/models`);
  if (!isRecord(body) || !Array.isArray(body.data)) return null;
  const data = body.data.filter(isRecord);
  const models = data.flatMap((m) => (typeof m.id === 'string' ? [m.id] : []));
  const llama = Array.isArray(body.models) || data.some((m) => m.owned_by === 'llamacpp');
  return {
    kind: kind ?? (llama ? 'llamacpp' : 'openai_compatible'),
    baseUrl: `${base}/v1`,
    models: [...new Set(models)].sort(),
  };
}

async function probeJson(doFetch: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      signal: ac.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
