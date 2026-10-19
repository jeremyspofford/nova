// Preload of the Hub windows (FR-009; contracts/ipc-channels.md "Security rules"): the narrow
// `window.novaShell` bridge the Hub's web UI may use (NovaShellBridge in @nova/shared). It runs
// sandboxed and context-isolated, passes plain values only, and the main process validates every
// payload and checks that the caller is the Hub's own page.
// A sandboxed preload is a classic script: `require` is its only way to reach Electron.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, payload) =>
  ipcRenderer.invoke(channel, payload).then((res) => {
    if (res && res.ok === true) return res;
    throw new Error((res && res.message) || 'The desktop app refused the request.');
  });

// Local models (FR-128): each chat has an id; its text arrives as `localRuntime.delta`.
const deltaHandlers = new Map();
let chatSeq = 0;
ipcRenderer.on('localRuntime.delta', (_event, msg) => {
  const handler = msg && deltaHandlers.get(msg.id);
  if (handler) handler(String(msg.text));
});

const localRuntime = {
  models: () =>
    ipcRenderer.invoke('localRuntime.models', {}).then((res) =>
      res && res.ok === true
        ? res.result
        : {
            ok: false,
            reason: 'failed',
            message: (res && res.message) || 'The desktop app refused the request.',
            models: [],
          },
    ),
  chat: (req, onDelta) => {
    const id = `c${Date.now().toString(36)}${(chatSeq++).toString(36)}`;
    if (typeof onDelta === 'function') deltaHandlers.set(id, onDelta);
    const messages = req && Array.isArray(req.messages) ? req.messages : [];
    return ipcRenderer
      .invoke('localRuntime.chat', {
        id,
        model: String(req && req.model),
        messages: messages.map((m) => ({
          role: String(m && m.role),
          content: String(m && m.content),
        })),
      })
      .then((res) => {
        if (res && res.ok === true) return { text: String(res.text) };
        throw new Error((res && res.message) || 'Local models are not available.');
      })
      .finally(() => deltaHandlers.delete(id));
  },
};

contextBridge.exposeInMainWorld('novaShell', {
  version: 1,
  platform: process.platform,
  openWindow: (path) =>
    ipcRenderer
      .invoke('shell.openWindow', { path: String(path) })
      .then((res) => Boolean(res && res.ok === true)),
  shortcuts: () => call('shortcut.global.list', {}).then((res) => res.items),
  setShortcut: (action, accelerator) =>
    call('shortcut.global.set', {
      action: String(action),
      accelerator: accelerator === null ? null : String(accelerator),
    }).then((res) => res.items),
  localRuntime,
});
