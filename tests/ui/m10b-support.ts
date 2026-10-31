// Nova Browser (M10b) gate support: a real Nova server with its browser worker in Chromium, the
// stand-in sites (scripts/stand-ins/shop-site.js), an optional stand-in local model for the
// co-pilot, fake credentials made per test, and a search of everything Nova wrote.
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { startShop } from '../../scripts/stand-ins/shop-site.js';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { INSTALLED, hardwareFile } from '../support/models.ts';
import { sleep, stop } from '../acceptance/support.ts';
import { blank, browser, finishSetup } from './support.ts';
import { browserEnv, events, settled, waitTask } from './m5c-support.ts';

export { startShop, events, settled, waitTask, sleep };
export type Shop = Awaited<ReturnType<typeof startShop>>;

// Obvious fakes, new for every test.
export const fakeLogin = () => ({ username: `example-user-${randomBytes(4).toString('hex')}`, password: `example-pw-${randomBytes(9).toString('hex')}` });

// Whether this machine can run the browser at all; a reason to skip when it can't (outside CI).
export async function canBrowse(): Promise<string | null> {
  const b = await browser();
  if (typeof b === 'string') return b;
  await b.close();
  return null;
}

// A Nova set up for a fresh user, with browser work on, and (with `model`) a stand-in local
// sorting model whose every request is kept.
export async function startNova(prefix: string, o: { model?: ((body: any) => string) | true } = {}) {
  const m = blank(prefix);
  const ollama = o.model ? await startFakeOllama({ models: INSTALLED, ...(typeof o.model === 'function' ? { reply: o.model } : {}) }) : null;
  const nova = await m.start({ ...browserEnv(), ...(ollama ? { NOVA_OLLAMA_URL: ollama.url, NOVA_HARDWARE_FILE: hardwareFile(m.dir) } : {}) });
  await finishSetup(m);
  if (ollama) {
    const r = await m.send('PUT', '/api/v1/models/roles/triage-text', { model: 'example-small:3b' });
    if (r.status !== 200) throw new Error(`assign: ${JSON.stringify(r.body)}`);
  }
  const api = (p: string) => `/api/v1${p}`;
  return {
    m, nova, ollama, api,
    // Delegates a browser task and gives the OK it asks for: tier 2 once, tier 3 with confirm.
    async task(inputs: unknown, title = 'A browser task on the example shop', evidence = [{ kind: 'screenshot' }, { kind: 'url' }]) {
      const r = await m.send('POST', api('/tasks'), { title, owner: 'browser', goal: 'Do the steps on the example shop.', evidence_required: evidence, inputs });
      if (r.status !== 201) return { created: r, id: null as string | null };
      if (r.body.state === 'waiting' && r.body.approval_tier >= 2 && !r.body.approved_at) {
        const ok = await m.send('POST', api(`/tasks/${r.body.id}/approve`), r.body.approval_tier === 3 ? { confirm: true } : {});
        if (ok.status !== 200) throw new Error(`approve: ${JSON.stringify(ok.body)}`);
      }
      return { created: r, id: r.body.id as string };
    },
    done: (id: string, ms = 90_000) => waitTask(m, id, settled, ms),
    events: (id: string) => events(m, id),
    async close() {
      await stop(nova);
      await ollama?.close();
    },
  };
}
export type Nova = Awaited<ReturnType<typeof startNova>>;

// Every file under a folder, byte by byte, that holds any of the values: the proof that a secret
// went nowhere Nova writes.
export function filesHolding(root: string, values: string[]): string[] {
  const hits: string[] = [];
  const needles = values.map((v) => Buffer.from(v, 'utf8'));
  const walk = (dir: string, depth = 0) => {
    if (depth > 30) return;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { walk(p, depth + 1); continue; }
      if (!st.isFile() || st.size > 64 * 1024 * 1024) continue;
      let data: Buffer;
      try { data = readFileSync(p); } catch { continue; }
      // Plain bytes, and the UTF-16 text some databases keep.
      if (needles.some((b) => data.includes(b) || data.includes(Buffer.from(b.toString('utf8'), 'utf16le')))) hits.push(p);
    }
  };
  walk(root);
  return hits;
}

export const shopPlan = (shop: Shop, o: { quoted?: string; learn?: string; items?: string[] } = {}) => ({
  allowed_hosts: [shop.host],
  ...(o.learn ? { learn: o.learn } : {}),
  steps: [
    { do: 'navigate', url: `${shop.url}/cart/empty` },
    ...(o.items ?? ['mug', 'tea']).flatMap((id) => [{ do: 'navigate', url: `${shop.url}/shop` }, { do: 'click', selector: `#add-${id}`, intent: 'add it to the cart' }]),
    { do: 'click', selector: '#to-checkout', intent: 'proceed to checkout' },
    { do: 'checkout', lines: '#lines .line', total: '#total', pay: '#pay', ...(o.quoted ? { quoted: o.quoted } : {}) },
  ],
  verify: { url: `${shop.url}/cart`, expect: ['Example mug'] },
});

export async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!ok(v) && Date.now() < end) { await sleep(100); v = await read(); }
  return v;
}
