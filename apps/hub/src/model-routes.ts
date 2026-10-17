// Model presets and local server detection (contracts/hub-api.md; FR-221, docs/07 §8.1, §12).
// GET/PUT /presets read and replace the `models.presets` list (empty = the generated
// built-ins); GET /providers/detect probes local model servers. Every route requires a session
// and validates its input with the shared zod schemas.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  NovaError,
  parseAnyModelRef,
  presetSchema,
  type DetectedServer,
  type Preset,
} from '@nova/shared';

export interface ModelRouteDeps {
  /** The router, for the built-in presets generated from the models available now. */
  router: { builtInPresets(accountId: string): Promise<Preset[]> };
  /** The stored `models.presets` setting after precedence. */
  readPresets: (accountId: string) => Promise<Preset[]>;
  /** Replace the `models.presets` setting; `[]` resets to the built-ins. */
  writePresets: (accountId: string, items: Preset[]) => Promise<void>;
  detect: () => Promise<DetectedServer[]>;
  /** The authenticated account id; throws `token_required` without a principal. */
  accountOf: (req: FastifyRequest) => Promise<string>;
}

export interface PresetList {
  items: Preset[];
  /** True when nothing is saved and the list is generated (Faster / Balanced / Smarter). */
  builtIn: boolean;
}

export const putPresetsSchema = z.object({ items: z.array(presetSchema).max(20) }).strict();

/**
 * Reject malformed target refs and duplicate ids. A well-formed ref to a model that does not
 * exist is allowed: it makes the preset disabled rather than failing the save. Presets never
 * point at other presets (no nesting).
 */
export function checkPresets(items: Preset[]): void {
  const ids = new Set<string>();
  for (const p of items) {
    if (ids.has(p.id))
      throw new NovaError('validation', `two presets share the id ${p.id}`, {
        details: { reason: 'duplicate_preset', preset: p.id },
      });
    ids.add(p.id);
    for (const t of p.targets) {
      const parsed = parseAnyModelRef(t);
      if (!parsed || parsed.kind === 'preset')
        throw new NovaError('validation', `preset ${p.id} has a malformed model: ${t}`, {
          details: { reason: 'invalid_target', preset: p.id, target: t },
        });
    }
  }
}

export function registerModelRoutes(app: FastifyInstance, deps: ModelRouteDeps): void {
  const { router, readPresets, writePresets, detect, accountOf } = deps;

  const list = async (accountId: string): Promise<PresetList> => {
    const saved = await readPresets(accountId);
    if (saved.length) return { items: saved, builtIn: false };
    return { items: await router.builtInPresets(accountId), builtIn: true };
  };

  app.get('/api/v1/presets', async (req) => list(await accountOf(req)));

  app.put('/api/v1/presets', async (req) => {
    const accountId = await accountOf(req);
    const { items } = putPresetsSchema.parse(req.body);
    checkPresets(items);
    await writePresets(accountId, items);
    return list(accountId);
  });

  app.get('/api/v1/providers/detect', async (req) => {
    await accountOf(req);
    return { items: await detect() };
  });
}
