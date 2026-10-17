// Local server detection (docs/07 §12) with a fake fetch: Ollama and llama.cpp on their default
// ports, extra base URLs from NOVA_DETECT_URLS, short timeouts and no credentials.
import { describe, expect, it } from 'vitest';
import { detectLocalServers, detectUrlsFromEnv } from '../src/index.ts';

type Reply = { status?: number; body: unknown } | 'hang' | 'refuse';

function fakeFetch(replies: Record<string, Reply>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const f = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, init });
    const r = replies[url];
    if (!r || r === 'refuse') return Promise.reject(new TypeError('fetch failed'));
    if (r === 'hang')
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    return Promise.resolve(
      new Response(JSON.stringify(r.body), {
        status: r.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch: f, calls };
}

describe('detectLocalServers', () => {
  it('finds Ollama and llama.cpp on the default ports', async () => {
    const { fetch, calls } = fakeFetch({
      'http://127.0.0.1:11434/api/tags': {
        body: { models: [{ name: 'qwen3:8b', model: 'qwen3:8b' }, { name: 'llama3' }, { x: 1 }] },
      },
      'http://127.0.0.1:8080/v1/models': {
        body: { object: 'list', data: [{ id: 'gemma-3-4b.gguf', owned_by: 'llamacpp' }] },
      },
    });
    expect(await detectLocalServers({ fetch, env: {} })).toEqual([
      { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['llama3', 'qwen3:8b'] },
      { kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8080/v1', models: ['gemma-3-4b.gguf'] },
    ]);
    for (const c of calls) {
      expect(c.init?.credentials).toBe('omit');
      expect(c.init?.headers).toEqual({ accept: 'application/json' });
    }
  });

  it('probes NOVA_DETECT_URLS, classifying each server, and skips what does not answer', async () => {
    const { fetch, calls } = fakeFetch({
      'http://gpu.lan:11434/api/tags': { body: { models: [{ name: 'phi4' }] } },
      'http://box:1234/v1/models': { body: { data: [{ id: 'local-model', owned_by: 'me' }] } },
      'http://box:1234/api/tags': { status: 404, body: {} },
      'http://llama:9000/v1/models': { body: { models: [], data: [{ id: 'm.gguf' }] } },
      'http://127.0.0.1:11434/api/tags': 'hang',
      'http://127.0.0.1:8080/v1/models': { status: 500, body: {} },
    });
    const env = {
      NOVA_DETECT_URLS:
        'http://gpu.lan:11434/, http://box:1234/v1 ,http://llama:9000,ftp://x,not a url,http://u:p@secret:1,http://127.0.0.1:11434',
    };
    const found = await detectLocalServers({ fetch, env, timeoutMs: 20 });
    expect(found).toEqual([
      { kind: 'ollama', baseUrl: 'http://gpu.lan:11434/v1', models: ['phi4'] },
      { kind: 'openai_compatible', baseUrl: 'http://box:1234/v1', models: ['local-model'] },
      { kind: 'llamacpp', baseUrl: 'http://llama:9000/v1', models: ['m.gguf'] },
    ]);
    expect(calls.some((c) => c.url.includes('secret'))).toBe(false);
    expect(calls.filter((c) => c.url.startsWith('http://127.0.0.1:11434'))).toHaveLength(1);
  });

  it('parses the env list, dropping credentials, other schemes and duplicates', () => {
    expect(
      detectUrlsFromEnv({
        NOVA_DETECT_URLS: 'http://a:1/v1/, http://a:1, https://b/x/,file:///etc',
      }),
    ).toEqual(['http://a:1', 'https://b/x']);
    expect(detectUrlsFromEnv({})).toEqual([]);
  });

  it('returns nothing when no server answers', async () => {
    const { fetch } = fakeFetch({});
    expect(await detectLocalServers({ fetch, env: {} })).toEqual([]);
  });
});
