// The tool registry (docs/08 §1): built-ins plus every ToolSourceProvider (MCP servers now,
// plugins in M4), under canonical namespaced names (tool-descriptor.json, docs/08 §8). The
// built-in source lists web.search only while a search service is configured (FR-029).
import { Logger } from '@nova/telemetry';
import type { Redactor } from '@nova/security';
import { artifactTool, type ArtifactService } from './artifacts.ts';
import type { BuiltinTool } from './builtin.ts';
import { execTools } from './exec.ts';
import { fsTools } from './fs.ts';
import type { PathPolicy } from './roots.ts';
import { toolSearchTool } from './search.ts';
import type { ToolDefinition, ToolSourceProvider } from './types.ts';
import { webTools, type WebToolOptions } from './web.ts';

/** Canonical names (contracts/schemas/tool-descriptor.json). */
export const TOOL_NAME =
  /^(mcp:[a-z0-9-]+\.[A-Za-z0-9_.-]+|plugin:[a-z0-9.-]+\.[A-Za-z0-9_]+|page:[a-z0-9.-]+\.[A-Za-z0-9_]+|[a-z]+(\.[a-z][A-Za-z0-9_]*)+|[a-z]+(_[a-z]+)+)$/;

export interface BuiltinToolsOptions {
  artifacts: ArtifactService;
  /** The `search.searxngUrl` setting. */
  searxngUrl: () => Promise<string | null>;
  paths?: PathPolicy;
  redactor?: Redactor;
  web?: Omit<WebToolOptions, 'searxngUrl'>;
}

/** Every built-in tool of docs/08 §1.1 that M3 ships. */
export function builtinTools(opts: BuiltinToolsOptions): BuiltinTool[] {
  const fsOpts = opts.paths ? { paths: opts.paths } : {};
  return [
    ...fsTools(fsOpts),
    ...execTools({ ...fsOpts, ...(opts.redactor ? { redactor: opts.redactor } : {}) }),
    ...webTools({ ...opts.web, searxngUrl: opts.searxngUrl }),
    artifactTool(opts.artifacts),
    toolSearchTool(),
  ];
}

/** The built-ins as a source; web.search is left out while no search service is set. */
export function builtinSource(
  tools: readonly BuiltinTool[],
  searxngUrl: () => Promise<string | null>,
): ToolSourceProvider {
  return {
    source: 'builtin',
    list: async () => {
      let search = false;
      try {
        search = !!(await searxngUrl());
      } catch {
        search = false;
      }
      return tools.filter((t) => search || t.descriptor.name !== 'web.search');
    },
  };
}

export interface ToolRegistryOptions {
  sources: readonly ToolSourceProvider[];
  log?: Logger;
}

export class ToolRegistry {
  readonly #sources: readonly ToolSourceProvider[];
  readonly #log: Logger;

  constructor(opts: ToolRegistryOptions) {
    this.#sources = opts.sources;
    this.#log = opts.log ?? new Logger({ module: 'core.tools', sinks: [] });
  }

  /** Every tool available to the account now; the first source wins a name collision. */
  async list(accountId: string): Promise<ToolDefinition[]> {
    const out: ToolDefinition[] = [];
    const seen = new Set<string>();
    for (const s of this.#sources) {
      let tools: ToolDefinition[];
      try {
        tools = await s.list(accountId);
      } catch (err) {
        // A source must never throw; one that does lists nothing (docs/08 §9).
        this.#log.warn('tool source failed to list', { err, source: s.source });
        continue;
      }
      for (const t of tools) {
        const name = t.descriptor.name;
        if (seen.has(name)) continue;
        if (!TOOL_NAME.test(name)) {
          this.#log.warn('tool with a non-canonical name ignored', { name, source: s.source });
          continue;
        }
        seen.add(name);
        out.push(t);
      }
    }
    return out;
  }

  async find(accountId: string, name: string): Promise<ToolDefinition | null> {
    return (await this.list(accountId)).find((t) => t.descriptor.name === name) ?? null;
  }
}
