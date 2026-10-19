// @ts-check
// A sample Nova extension (docs/14 §4): a command, a panel and a tool, plus a status item, a
// keybinding, a menu item, a hook and an event listener. It runs in an isolated engine with only
// what .nova-plugin/extension.json declares; anything else is refused and turns it off.

/** @param {import('@nova/sdk').Nova} nova */
export function activate(nova) {
  let greeted = 0;
  let calls = 0;
  const status = nova.status.addItem({
    id: 'hello.count',
    text: 'Hello: 0',
    onClick: 'hello.greet',
  });

  nova.commands.register({
    id: 'hello.greet',
    title: 'Hello: say hello',
    run: async (args) => {
      greeted++;
      status.update(`Hello: ${greeted}`);
      const name = args && typeof args === 'object' && 'name' in args ? String(args.name) : 'world';
      const greeting = (await nova.secrets.get('greeting')) ?? 'Hello';
      return { text: `${greeting}, ${name}!`, greeted };
    },
  });

  nova.panels.register({
    id: 'hello.panel',
    title: 'Hello',
    resource: 'ui://hello/panel',
    entryPoint: 'global',
  });

  nova.tools.register({
    name: 'greet',
    title: 'Greet someone',
    description: 'Return a friendly greeting for a name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Who to greet' } },
      required: ['name'],
    },
    annotations: { readOnly: true },
    handler: (args) => `Hello, ${/** @type {{name: string}} */ (args).name}!`,
  });

  nova.tools.register({
    name: 'save_note',
    title: 'Save a note',
    description: "Save a short note in the extension's own data folder.",
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 2000 } },
      required: ['text'],
    },
    handler: async (args) => {
      await nova.fs.write('${extensionData}/note.txt', /** @type {{text: string}} */ (args).text);
      return 'Saved.';
    },
  });

  nova.hooks.register({
    id: 'note-greetings',
    event: 'tool.post',
    handler: () => ({ context: 'The hello extension greeted someone.' }),
  });

  nova.events.on('tool.call', () => {
    calls++;
  });

  nova.keybindings.register({ command: 'hello.greet', key: 'mod+shift+h' });
  nova.menus.register({ where: 'thread', items: [{ title: 'Say hello', command: 'hello.greet' }] });
  nova.log(`hello is ready (${calls} tool calls seen so far)`);
}
