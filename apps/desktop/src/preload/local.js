// Preload of the shell's own pages (connect, quick chat, attach preview): `window.novaLocal`
// forwards an allowlisted set of channels to the main process, which validates every payload and
// checks which page is asking (contracts/ipc-channels.md "Security rules").
// A sandboxed preload is a classic script: `require` is its only way to reach Electron.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set([
  'shell.connect.state',
  'shell.connect',
  'quick.state',
  'quick.send',
  'quick.open',
  'quick.newTask',
  'quick.home',
  'quick.attach',
  'window.capture.draft',
  'window.capture.attach',
  'window.capture.discard',
]);
const EVENTS = new Set(['quick.status']);

contextBridge.exposeInMainWorld('novaLocal', {
  invoke: (channel, payload) =>
    CHANNELS.has(channel)
      ? ipcRenderer.invoke(channel, payload ?? {})
      : Promise.resolve({ ok: false, message: 'Unknown request.' }),
  on: (event, handler) => {
    if (!EVENTS.has(event) || typeof handler !== 'function') return () => undefined;
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
