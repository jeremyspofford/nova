// Entry point of the Nova desktop shell (ADR-001): a client of the Hub, never the Hub (ADR-031).
// One instance per data folder: a second launch (a `nova://` link on Windows and Linux) hands its
// arguments to the first; macOS delivers links through `open-url`.
import { app } from 'electron';
import { Shell } from './electron/shell.ts';

app.setName('Nova');
// Local-first and nothing outside the Hub: no background downloads of browser components.
app.commandLine.appendSwitch('disable-component-update');
// A separate data folder (tests, a second profile); else the platform's per-user folder.
const dataDir = process.env.NOVA_SHELL_DATA_DIR;
if (dataDir) app.setPath('userData', dataDir);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const shell = new Shell(app.getPath('userData'));
  const early: string[] = [];
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (shell.started) shell.handleLink(url);
    else early.push(url);
  });
  app.on('second-instance', (_event, argv) => shell.handleArgv(argv));
  // Closing the last window keeps the shell in the tray (FR-008); Quit ends it.
  app.on('window-all-closed', () => undefined);
  app.on('activate', () => {
    if (shell.started) shell.openHome();
  });
  app.on('will-quit', () => shell.stop());
  // An installed build registers `nova://` with the OS (docs/04 §5.1); a development run does
  // not, so running the tests never changes the computer's link handlers.
  if (app.isPackaged) app.setAsDefaultProtocolClient('nova');
  void app
    .whenReady()
    .then(() => shell.start([...process.argv, ...early]))
    .catch((err: unknown) => {
      console.error('[nova-shell] failed to start', err);
      app.exit(1);
    });
}
