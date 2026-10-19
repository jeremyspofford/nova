// The Electron side of attach window (FR-214): the window's pixels through desktopCapturer, bound
// to that very window (capture.pickSource), the platform's locator, and redaction in a utility
// process so the main process never blocks. Nova's own windows are left out of every list.
import { fileURLToPath } from 'node:url';
import { BrowserWindow, desktopCapturer, utilityProcess } from 'electron';
import { gdbusCli } from '../capture/atspi.ts';
import { darwinFront, execRun, processName, win32Front, x11Front } from '../capture/identity.ts';
import {
  linuxLocator,
  pickSource,
  platformLocator,
  type FrontWindow,
  type Redact,
  type ScreenshotProvider,
  type WindowLocator,
} from '../capture/index.ts';
import { IsolatedRedactor, type WorkerChannel } from '../capture/redact-service.ts';

function ownSourceIds(): Set<string> {
  const ids = new Set<string>();
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      ids.add(w.getMediaSourceId());
    } catch {
      // a window being destroyed
    }
  }
  return ids;
}

/** The window's screenshot: exactly that window, or none. */
export const screenshot: ScreenshotProvider = async (win: FrontWindow) => {
  const own = ownSourceIds();
  const all = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 1920, height: 1920 },
    fetchWindowIcons: false,
  });
  const match = pickSource(
    all.filter((s) => !own.has(s.id)),
    win,
  );
  if (!match || match.thumbnail.isEmpty()) return null;
  const size = match.thumbnail.getSize();
  return { png: match.thumbnail.toPNG(), width: size.width, height: size.height };
};

export function locatorFor(platform: string): WindowLocator {
  const run = execRun();
  if (platform === 'linux')
    return linuxLocator({
      gdbus: gdbusCli(),
      x11: () => (process.env.DISPLAY ? x11Front(run) : Promise.resolve(null)),
      procName: (pid) => processName(pid),
    });
  if (platform === 'win32') return platformLocator(() => win32Front(run), platform);
  if (platform === 'darwin') return platformLocator(() => darwinFront(run), platform);
  return { frontmost: () => Promise.resolve(null) };
}

const WORKER = fileURLToPath(new URL('../capture/redact-worker.ts', import.meta.url));

function utilityChannel(): WorkerChannel {
  const child = utilityProcess.fork(WORKER, [], { serviceName: 'Nova redaction' });
  return {
    post: (m) => child.postMessage(m),
    onMessage: (l) => {
      child.on('message', l);
    },
    onExit: (l) => {
      child.once('exit', l);
    },
    kill: () => {
      child.kill();
    },
  };
}

/** Redaction in a utility process; a job that takes over 5 s fails and its worker is killed. */
export function isolatedRedact(): { redact: Redact; close(): void } {
  const service = new IsolatedRedactor(utilityChannel, { timeoutMs: 5000 });
  return { redact: (job) => service.redact(job), close: () => service.close() };
}
