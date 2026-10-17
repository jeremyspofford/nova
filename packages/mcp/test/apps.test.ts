// MCP Apps support in the client (FR-198): the UI extension is advertised at initialize, a tool's
// `ui://` resource becomes `descriptor.ui`, and resource contents come back raw with their MIME
// type and `_meta` (the app's declared CSP).
import { afterEach, describe, expect, it } from 'vitest';
import { MCP_APPS_EXTENSION, MCP_APP_MIME_TYPE, uiResourceOf } from '../src/index.ts';
import { FIXTURE, harness, stdioConfig, type Harness } from './helpers.ts';

let h: Harness | null = null;
afterEach(async () => {
  await h?.manager.close();
  h = null;
});

describe('MCP Apps in the client', () => {
  it('advertises the UI extension and exposes ui resources', async () => {
    h = harness();
    const cfg = stdioConfig({ id: 'apps-1', args: [FIXTURE, '--apps'] });
    await h.manager.add(cfg);
    const caps = await h.manager.callTool(cfg.id, 'client_caps', {});
    expect(caps.ok).toBe(true);
    const text = caps.ok ? (caps.content[0] as { text: string }).text : '';
    expect(JSON.parse(text)).toMatchObject({
      extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } },
    });
    const show = h.manager.tools(cfg.id).find((t) => t.original === 'show_note')!;
    expect(show.descriptor.ui).toEqual({ resourceUri: 'ui://notes/view' });
    expect(
      h.manager.tools(cfg.id).find((t) => t.original === 'echo')!.descriptor.ui,
    ).toBeUndefined();
    const r = await h.manager.readResourceContents(cfg.id, 'ui://notes/view');
    expect(r).toEqual({
      ok: true,
      contents: [
        {
          uri: 'ui://notes/view',
          mimeType: MCP_APP_MIME_TYPE,
          text: '<!doctype html><title>Note</title><p>note</p>',
          _meta: { ui: { csp: { connectDomains: ['https://api.example.com'] } } },
        },
      ],
    });
    expect(await h.manager.readResourceContents(cfg.id, 'ui://missing')).toMatchObject({
      ok: false,
    });
    expect(await h.manager.readResourceContents('gone', 'ui://notes/view')).toMatchObject({
      ok: false,
      error: { code: 'mcp.unavailable' },
    });
  });

  it('accepts only ui:// resource URIs from tool metadata', () => {
    expect(uiResourceOf({ ui: { resourceUri: 'ui://a' } })).toBe('ui://a');
    expect(uiResourceOf({ 'ui/resourceUri': 'ui://b' })).toBe('ui://b');
    expect(uiResourceOf({ ui: { resourceUri: 'https://evil.example/x' } })).toBeNull();
    expect(uiResourceOf({ ui: 'ui://c' })).toBeNull();
    expect(uiResourceOf(undefined)).toBeNull();
  });
});
