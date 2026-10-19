// Attach window (FR-214): GVariant replies, the AT-SPI reader over a fake `gdbus`, and the capture
// draft (exclusions, Nova's own windows, password fields, redaction, what is attached).
import { describe, expect, it } from 'vitest';
import { AtspiReader, type Gdbus } from '../src/capture/atspi.ts';
import { parseGVariant } from '../src/capture/gvariant.ts';
import {
  darwinFront,
  processName,
  win32Front,
  x11Front,
  type Run,
} from '../src/capture/identity.ts';
import {
  captureFrontmost,
  draftAttachments,
  draftView,
  isExcluded,
  linuxLocator,
  noTextReason,
  pickSource,
  platformLocator,
  redactText,
  type FrontWindow,
  type WindowLocator,
} from '../src/capture/index.ts';

describe('GVariant text', () => {
  it('reads the replies gdbus prints', () => {
    expect(parseGVariant("('unix:path=/run/user/1000/at-spi/bus_0,guid=ab',)")).toEqual([
      'unix:path=/run/user/1000/at-spi/bus_0,guid=ab',
    ]);
    expect(
      parseGVariant("([(':1.5', objectpath '/org/a11y/atspi/accessible/root'), (':1.6', '/x')],)"),
    ).toEqual([
      [
        [':1.5', '/org/a11y/atspi/accessible/root'],
        [':1.6', '/x'],
      ],
    ]);
    expect(parseGVariant('([uint32 1124073474, uint32 0],)')).toEqual([[1124073474, 0]]);
    expect(parseGVariant("(<'Inbox \\'today\\''>,)")).toEqual(["Inbox 'today'"]);
    expect(parseGVariant('("it\'s",)')).toEqual(["it's"]);
    expect(parseGVariant('(@as [], true, false, nothing, just 3, int32 -7, 0x1f, 2.5e1)')).toEqual([
      [],
      true,
      false,
      null,
      3,
      -7,
      31,
      25,
    ]);
    expect(parseGVariant("({'a': <1>, 'b': <'x'>},)")).toEqual([{ a: 1, b: 'x' }]);
    expect(parseGVariant("('tab\\there\\nnew \\u00e9 \\U0001F600 \\\\',)")).toEqual([
      'tab\there\nnew é 😀 \\',
    ]);
    expect(parseGVariant("(b'ab\\101',)")).toEqual(['abA']);
    expect(parseGVariant("('\\a\\b\\f\\v\\r\\q',)")).toEqual(['\x07\b\f\v\rq']);
  });

  it.each([
    "('x'",
    "('x',) trailing",
    '(1 2)',
    '[1 2]',
    "{'a' 1}",
    "{'a': 1 'b': 2}",
    "('\\u12',)",
    '(?)',
    "('open",
  ])('refuses %j', (text) => {
    expect(() => parseGVariant(text)).toThrow(SyntaxError);
  });
});

// A small accessibility bus: two apps, the second with the active window holding a heading, a
// label, a text area (more text than shows on screen) and a password field.
const ADDRESS = 'unix:path=/tmp/a11y';
const ROOT = '/org/a11y/atspi/accessible/root';
const A11Y = ':1.9';
interface Node {
  role: number;
  name: string;
  text?: string;
  children: string[];
  states?: number[];
}
const nodes: Record<string, Node> = {
  [`${A11Y}/w`]: {
    role: 23,
    name: 'Report — Editor',
    children: ['/h', '/l', '/t', '/p'],
    states: [2, 0],
  },
  [`${A11Y}/h`]: { role: 29, name: 'Quarterly report', children: [] },
  [`${A11Y}/l`]: {
    role: 29,
    name: '',
    text: 'Token: sk-abcdefghijklmnopqrstuvwxyz123456',
    children: [],
  },
  [`${A11Y}/t`]: {
    role: 61,
    name: '',
    text: 'Line one\nLine two (scrolled off screen)',
    children: [],
  },
  [`${A11Y}/p`]: { role: 40, name: 'Password', text: 'hunter2-secret', children: [] },
};

function fakeGdbus(opts: { cache: boolean; bus?: boolean; calls?: string[][] }): Gdbus {
  return (args) => {
    opts.calls?.push(args);
    const method = args[args.indexOf('--method') + 1] ?? '';
    const dest = args[args.indexOf('--dest') + 1] ?? '';
    const path = args[args.indexOf('--object-path') + 1] ?? '';
    const tail = args.slice(args.indexOf('--method') + 2);
    const node = nodes[`${dest}${path}`];
    const out = (s: string) => Promise.resolve(`${s}\n`);
    if (method === 'org.a11y.Bus.GetAddress')
      return opts.bus === false ? Promise.reject(new Error('no bus')) : out(`('${ADDRESS}',)`);
    if (method === 'org.a11y.atspi.Accessible.GetChildren') {
      if (dest === 'org.a11y.atspi.Registry')
        return out(`([(':1.8', objectpath '${ROOT}'), ('${A11Y}', objectpath '${ROOT}')],)`);
      if (dest === ':1.8') return out(`([(':1.8', objectpath '/bg')],)`);
      if (path === ROOT) return out(`([('${A11Y}', objectpath '/w')],)`);
      return out(
        `([${(node?.children ?? []).map((c) => `('${A11Y}', objectpath '${c}')`).join(', ')}],)`,
      );
    }
    if (method === 'org.a11y.atspi.Accessible.GetState') {
      if (dest === ':1.8') return out('([uint32 0, uint32 0],)');
      return out(`([uint32 ${node?.states?.[0] ?? 0}, uint32 0],)`);
    }
    if (method === 'org.freedesktop.DBus.Properties.Get') {
      const [iface, prop] = tail;
      if (prop === 'Name') return out(`(<'${path === ROOT ? 'editor' : (node?.name ?? '')}'>,)`);
      if (iface === 'org.a11y.atspi.Text' && prop === 'CharacterCount')
        return out(`(<int32 ${node?.text?.length ?? 0}>,)`);
    }
    if (method === 'org.a11y.atspi.Text.GetText') {
      if (node?.role === 40) throw new Error('a password field was read');
      return out(`(${JSON.stringify(node?.text ?? '')},)`);
    }
    if (method === 'org.freedesktop.DBus.GetConnectionUnixProcessID')
      return tail[0] === `'${A11Y}'`
        ? out('(uint32 4242,)')
        : Promise.reject(new Error('no such name'));
    if (method === 'org.a11y.atspi.Accessible.GetRole') return out(`(uint32 ${node?.role ?? 0},)`);
    if (method === 'org.a11y.atspi.Accessible.GetInterfaces')
      return out(
        `(['org.a11y.atspi.Accessible'${node?.text !== undefined ? ", 'org.a11y.atspi.Text'" : ''}],)`,
      );
    if (method === 'org.a11y.atspi.Cache.GetItems') {
      if (!opts.cache) return Promise.reject(new Error('no cache'));
      const items = Object.entries(nodes).map(([key, n]) => {
        const p = key.slice(A11Y.length);
        const parent = p === '/w' ? ROOT : '/w';
        const ifaces = `['org.a11y.atspi.Accessible'${n.text !== undefined ? ", 'org.a11y.atspi.Text'" : ''}]`;
        const index = nodes[`${A11Y}/w`]!.children.indexOf(p);
        return `(('${A11Y}', objectpath '${p}'), ('${A11Y}', objectpath '${ROOT}'), ('${A11Y}', objectpath '${parent}'), ${index}, ${n.children.length}, ${ifaces}, '${n.name}', uint32 ${n.role}, '', [uint32 ${n.states?.[0] ?? 0}, uint32 0])`;
      });
      return out(`([${items.join(', ')}],)`);
    }
    return Promise.reject(new Error(`unexpected ${method}`));
  };
}

describe('AT-SPI reader', () => {
  for (const cache of [true, false]) {
    it(`finds the active window and reads its text without password fields (${cache ? 'cache' : 'walk'})`, async () => {
      const reader = new AtspiReader(fakeGdbus({ cache }));
      const win = await reader.activeWindow();
      // The process comes from the bus daemon, not from the app.
      expect(win).toMatchObject({
        address: ADDRESS,
        app: 'editor',
        title: 'Report — Editor',
        pid: 4242,
      });
      const text = await reader.windowText(win!);
      expect(text.text).toBe(
        'Quarterly report\nToken: sk-abcdefghijklmnopqrstuvwxyz123456\nLine one\nLine two (scrolled off screen)',
      );
      expect(text.text).not.toContain('hunter2');
      expect(text).toMatchObject({ complete: true, passwordFieldsSkipped: 1 });
    });
  }

  it('says when there is no accessibility bus', async () => {
    const reader = new AtspiReader(fakeGdbus({ cache: true, bus: false }));
    expect(await reader.busAddress()).toBeNull();
    expect(await reader.activeWindow()).toBeNull();
  });

  it('stops at its limits and says the text is incomplete', async () => {
    const short = new AtspiReader(fakeGdbus({ cache: true }), { maxNodes: 1 });
    const win = await short.activeWindow();
    expect(await short.windowText(win!)).toMatchObject({
      text: 'Quarterly report',
      complete: false,
    });
    const fewChars = new AtspiReader(fakeGdbus({ cache: false }), { maxChars: 20 });
    expect((await fewChars.windowText(win!)).complete).toBe(false);
    let t = 0;
    const slow = new AtspiReader(fakeGdbus({ cache: false }), {
      budgetMs: 5,
      now: () => (t += 10),
    });
    expect((await slow.windowText(win!)).complete).toBe(false);
  });
});

const win = (over: Partial<FrontWindow> = {}): FrontWindow => ({
  appName: 'editor',
  appId: 'gedit',
  title: 'Report — Editor',
  sourceId: null,
  pid: 100,
  ...over,
});
type Text = Awaited<
  ReturnType<NonNullable<Awaited<ReturnType<WindowLocator['frontmost']>>>['readText']>
>;
const front = (w: FrontWindow, text: Text): WindowLocator => ({
  frontmost: () => Promise.resolve({ window: w, readText: () => Promise.resolve(text) }),
});
const png = { png: Buffer.from('png-bytes'), width: 10, height: 20 };
const shot = () => Promise.resolve(png);
const opts = {
  excludedApps: ['vault', 'KeePassXC'],
  ownNames: ['Nova'],
  ownPids: [999],
  now: () => new Date('2026-10-19T10:00:00.000Z'),
};
const someText: Text = { text: 'x', complete: true, passwordFieldsSkipped: 0 };

describe('capture draft', () => {
  it('captures image and redacted text, and nothing leaves until the user sends', async () => {
    const res = await captureFrontmost(
      front(win(), {
        text: 'api_key = "sk-abcdefghijklmnopqrstuvwxyz123456"\nhello',
        complete: true,
        passwordFieldsSkipped: 2,
      }),
      shot,
      opts,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.text).not.toContain('sk-abcdefghijklmnop');
    expect(res.draft.text).toContain('[REDACTED]');
    expect(res.draft.redactions.length).toBeGreaterThan(0);
    expect(res.draft).toMatchObject({
      appName: 'editor',
      image: png,
      textNote: null,
      passwordFieldsSkipped: 2,
    });
    const view = draftView(res.draft, 'thread-1');
    expect(view).toMatchObject({
      draftId: res.draft.id,
      currentThreadId: 'thread-1',
      capturedAt: '2026-10-19T10:00:00.000Z',
    });
    expect(view.image?.dataUrl).toBe(
      `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`,
    );
    const both = draftAttachments(res.draft, { image: true, text: true });
    expect(both.map((a) => [a.name, a.mime])).toEqual([
      ['Report-Editor.png', 'image/png'],
      ['Report-Editor.txt', 'text/plain'],
    ]);
    expect(Buffer.from(both[1]!.data, 'base64').toString()).toMatch(
      /^Window: Report — Editor\nApp: editor\n/,
    );
    expect(draftAttachments(res.draft, { image: false, text: true })).toHaveLength(1);
    expect(
      draftAttachments(
        { ...res.draft, windowTitle: '', appName: '' },
        { image: true, text: false },
      )[0]?.name,
    ).toBe('window.png');
  });

  it('refuses a window whose app it cannot name (fail closed)', async () => {
    // The review's probe: a list of window titles with no app identity was captured.
    const unnamed = win({ appName: '', appId: null, title: 'Passwords.kdbx - KeePassXC' });
    expect(
      await captureFrontmost(front(unnamed, someText), shot, { ...opts, excludedApps: [] }),
    ).toMatchObject({
      ok: false,
      reason: 'unknown_app',
    });
  });

  it('never captures an excluded app, by name, process or title', async () => {
    for (const w of [
      win({ appName: 'Vault Manager' }),
      win({ appName: 'Some app', appId: 'keepassxc' }),
      win({ appName: 'Some app', appId: 'other', title: 'Passwords.kdbx - KeePassXC' }),
    ])
      expect(await captureFrontmost(front(w, someText), shot, opts)).toMatchObject({
        ok: false,
        reason: 'excluded',
      });
    expect(isExcluded(win(), [' ', ''])).toBe(false);
  });

  it("never captures Nova's own window, by name or by process", async () => {
    expect(
      await captureFrontmost(front(win({ appName: 'nova' }), someText), shot, opts),
    ).toMatchObject({ reason: 'own_window' });
    expect(
      await captureFrontmost(front(win({ appName: 'whatever', pid: 999 }), someText), shot, opts),
    ).toMatchObject({
      reason: 'own_window',
    });
    expect(
      await captureFrontmost({ frontmost: () => Promise.resolve(null) }, shot, opts),
    ).toMatchObject({
      ok: false,
      reason: 'no_window',
    });
  });

  it('says when there is no text, or only part of it, and survives a failing image', async () => {
    const none = await captureFrontmost(
      front(win(), { unavailable: noTextReason('darwin') }),
      shot,
      opts,
    );
    expect(none).toMatchObject({ ok: true, draft: { text: null, image: png } });
    if (none.ok) expect(none.draft.textNote).toMatch(/macOS/);
    const empty = await captureFrontmost(
      front(win(), { text: '', complete: true, passwordFieldsSkipped: 0 }),
      shot,
      opts,
    );
    if (empty.ok) expect(empty.draft.textNote).toBe('The window offers no text.');
    const partial = await captureFrontmost(
      front(win(), { text: 'some', complete: false, passwordFieldsSkipped: 0 }),
      shot,
      opts,
    );
    if (partial.ok) expect(partial.draft.textNote).toMatch(/left out/);
    const noImage = () => Promise.reject(new Error('x'));
    const failing: WindowLocator = {
      frontmost: () =>
        Promise.resolve({ window: win(), readText: () => Promise.reject(new Error('gone')) }),
    };
    const failed = await captureFrontmost(failing, shot, opts);
    if (failed.ok) expect(failed.draft.textNote).toMatch(/could not be read \(gone\)/);
    // Neither an image nor text: nothing to attach.
    expect(await captureFrontmost(failing, noImage, opts)).toMatchObject({
      ok: false,
      reason: 'nothing_to_attach',
    });
    expect(noTextReason('win32')).toMatch(/Windows/);
    expect(noTextReason('linux')).toMatch(/accessibility service is off/);
  });

  it('leaves the text out when redaction does not finish in time', async () => {
    const slow = () => Promise.reject(new Error('redaction did not finish in time'));
    const res = await captureFrontmost(
      front(win({ title: 'token sk-abcdefghijklmnopqrstuvwxyz123456' }), someText),
      shot,
      { ...opts, redact: slow },
    );
    expect(res).toMatchObject({
      ok: true,
      draft: { text: null, windowTitle: 'editor', image: png },
    });
    if (res.ok) expect(res.draft.textNote).toMatch(/could not be checked for secrets in time/);
  });

  it('counts what each redaction rule masked', () => {
    const r = redactText(
      'password=hunter22 and ghp_abcdefghijklmnopqrstuvwxyz0123 and ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    expect(r.text).not.toContain('hunter22');
    expect(r.redactions.find((x) => x.rule === 'github-token')?.count).toBe(2);
    expect(redactText('nothing to see').redactions).toEqual([]);
  });

  it('redacts dotted text quickly (the review probe: 8 s before the rules were bounded)', () => {
    const t0 = performance.now();
    redactText('a.'.repeat(100_000));
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe('the screenshot is that very window', () => {
  const sources = [
    { id: 'window:1:0', name: 'Report — Editor' },
    { id: 'window:2:0', name: 'Report' },
    { id: 'window:3:0', name: 'Twin' },
    { id: 'window:4:0', name: 'Twin' },
  ];

  it('takes the source with its id, or the only one with exactly its title', () => {
    expect(pickSource(sources, win({ sourceId: 'window:2:0', title: 'Report — Editor' }))?.id).toBe(
      'window:2:0',
    );
    expect(pickSource(sources, win({ sourceId: 'window:9:0' }))).toBeNull();
    expect(pickSource(sources, win())?.id).toBe('window:1:0');
  });

  it('attaches no image for a partial, missing or ambiguous title', () => {
    expect(pickSource(sources, win({ title: 'Report — Edit' }))).toBeNull();
    expect(pickSource(sources, win({ title: 'Twin' }))).toBeNull();
    expect(pickSource(sources, win({ title: '  ' }))).toBeNull();
  });
});

describe('which window is in front', () => {
  it('binds AT-SPI to the X11 window of the same process, with the process name from /proc', async () => {
    const x11 = () =>
      Promise.resolve(
        win({
          appName: 'Gedit',
          appId: 'gedit',
          title: 'Report',
          sourceId: 'window:77:0',
          pid: 4242,
        }),
      );
    const loc = linuxLocator({
      gdbus: fakeGdbus({ cache: true }),
      x11,
      procName: (pid) => (pid === 4242 ? 'gedit' : null),
    });
    const found = await loc.frontmost();
    expect(found?.window).toEqual({
      appName: 'editor',
      appId: 'gedit',
      title: 'Report — Editor',
      sourceId: 'window:77:0',
      pid: 4242,
    });
    expect(await found?.readText()).toMatchObject({ passwordFieldsSkipped: 1 });
    // Another process in front on X11: no binding to its window.
    const other = linuxLocator({
      gdbus: fakeGdbus({ cache: true }),
      x11: () => Promise.resolve(win({ pid: 1 })),
      procName: () => null,
    });
    expect((await other.frontmost())?.window).toMatchObject({ sourceId: null, appId: null });
  });

  it('uses the X11 window alone without AT-SPI, and finds nothing without either', async () => {
    const x = win({ sourceId: 'window:5:0' });
    const loc = linuxLocator({
      gdbus: fakeGdbus({ cache: true, bus: false }),
      x11: () => Promise.resolve(x),
      procName: () => null,
    });
    const found = await loc.frontmost();
    expect(found?.window).toEqual(x);
    expect(await found?.readText()).toEqual({ unavailable: noTextReason('linux') });
    const none = linuxLocator({
      gdbus: null,
      x11: () => Promise.reject(new Error('no xprop')),
      procName: () => null,
    });
    expect(await none.frontmost()).toBeNull();
  });

  it('asks the platform on macOS and Windows', async () => {
    const loc = platformLocator(() => Promise.resolve(win({ sourceId: 'window:9:0' })), 'win32');
    expect(await (await loc.frontmost())?.readText()).toEqual({
      unavailable: noTextReason('win32'),
    });
    expect(
      await platformLocator(() => Promise.reject(new Error('denied')), 'darwin').frontmost(),
    ).toBeNull();
  });

  it('reads xprop', async () => {
    const run: Run = (cmd, args) => {
      expect(cmd).toBe('xprop');
      if (args[0] === '-root')
        return Promise.resolve('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007, 0x0\n');
      expect(args.slice(0, 2)).toEqual(['-id', '0x3a00007']);
      return Promise.resolve(
        [
          '_NET_WM_PID(CARDINAL) = 4321',
          'WM_CLASS(STRING) = "keepassxc", "KeePassXC"',
          '_NET_WM_NAME(UTF8_STRING) = "Passwords.kdbx - \\"Vault\\""',
          'WM_NAME(STRING) = "ignored"',
        ].join('\n'),
      );
    };
    expect(await x11Front(run, () => 'keepassxc-bin')).toEqual({
      appName: 'KeePassXC',
      appId: 'keepassxc-bin',
      title: 'Passwords.kdbx - "Vault"',
      sourceId: `window:${0x3a00007}:0`,
      pid: 4321,
    });
    expect(
      await x11Front(() => Promise.resolve('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0')),
    ).toBeNull();
    const noPid: Run = (_c, a) =>
      Promise.resolve(
        a[0] === '-root' ? 'window id # 0x10' : 'WM_CLASS(STRING) = "inst"\nWM_NAME(STRING) = "T"',
      );
    expect(await x11Front(noPid, () => null)).toMatchObject({
      appName: 'inst',
      appId: 'inst',
      title: 'T',
      pid: null,
    });
  });

  it('reads the Windows foreground window and the macOS front app', async () => {
    const ps: Run = (cmd, args) => {
      expect(cmd).toBe('powershell.exe');
      expect(args).toContain('-NonInteractive');
      return Promise.resolve(
        '{"hwnd":131234,"pid":77,"process":"KeePassXC","path":"C:\\\\Program Files\\\\KeePassXC\\\\KeePassXC.exe","title":"Vault"}',
      );
    };
    expect(await win32Front(ps)).toEqual({
      appName: 'KeePassXC',
      appId: 'KeePassXC.exe',
      title: 'Vault',
      sourceId: 'window:131234:0',
      pid: 77,
    });
    expect(await win32Front(() => Promise.resolve('{"hwnd":0}'))).toBeNull();
    expect(await win32Front(() => Promise.resolve('{"hwnd":5,"process":"app"}'))).toMatchObject({
      appId: 'app',
      title: '',
    });
    const osa: Run = (cmd) => {
      expect(cmd).toBe('osascript');
      return Promise.resolve('com.example.Vault\nVault\n321\nMy vault\n');
    };
    expect(await darwinFront(osa)).toEqual({
      appName: 'Vault',
      appId: 'com.example.Vault',
      title: 'My vault',
      sourceId: null,
      pid: 321,
    });
    expect(await darwinFront(() => Promise.resolve('\n\n\n'))).toBeNull();
  });

  it('names a Linux process by its executable, else its command name', () => {
    expect(
      processName(12, { readlink: () => '/usr/bin/keepassxc (deleted)', read: () => '' }),
    ).toBe('keepassxc');
    expect(
      processName(12, {
        readlink: () => {
          throw new Error('EACCES');
        },
        read: () => 'firefox\n',
      }),
    ).toBe('firefox');
    expect(
      processName(12, {
        readlink: () => {
          throw new Error('x');
        },
        read: () => {
          throw new Error('x');
        },
      }),
    ).toBeNull();
    expect(processName(-1)).toBeNull();
    expect(processName(process.pid)).toBeTruthy();
  });
});
