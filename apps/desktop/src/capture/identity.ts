// Which window is in front, and which app it belongs to (FR-214): attach window refuses a window
// whose app it cannot name (excluded apps are matched by name, process and title), and binds the
// screenshot to that very window where the platform gives its id. Per platform:
// - Linux X11: `xprop` gives the active window's id, its process and its class;
// - Windows: PowerShell asks user32 for the foreground window, its process and title;
// - macOS: System Events gives the front app's bundle id, name and front window title;
// - the process behind a Linux pid comes from /proc (its executable), not from the app itself.
import { execFile } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { basename } from 'node:path';

/** Runs a command and returns its stdout. */
export type Run = (cmd: string, args: string[]) => Promise<string>;

/** What a platform knows about the window in front. */
export interface FrontWindow {
  /** The app's display name (self-reported on some platforms). */
  appName: string;
  /** The app's process or bundle id (`keepassxc`, `KeePassXC.exe`, `com.example.App`), or null. */
  appId: string | null;
  title: string;
  /** Electron's capture source id of this very window (`window:<id>:0`), or null when unknown. */
  sourceId: string | null;
  pid: number | null;
}

export function execRun(timeoutMs = 4000): Run {
  return (cmd, args) =>
    new Promise((resolve, reject) => {
      execFile(
        cmd,
        args,
        { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' },
        (err, out) =>
          err ? reject(err instanceof Error ? err : new Error(`${cmd} failed`)) : resolve(out),
      );
    });
}

/** The executable behind a Linux process (its real file, then its command name), or null. */
export function processName(
  pid: number,
  fs: { readlink(p: string): string; read(p: string): string } = {
    readlink: (p) => readlinkSync(p),
    read: (p) => readFileSync(p, 'utf8'),
  },
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const exe = basename(fs.readlink(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ''));
    if (exe) return exe;
  } catch {
    // another user's process: the command name is still readable
  }
  try {
    const comm = fs.read(`/proc/${pid}/comm`).trim();
    return comm || null;
  } catch {
    return null;
  }
}

/** The quoted strings of an xprop value (`"a", "b \"c\""`). */
function xpropStrings(value: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  for (let m = re.exec(value); m; m = re.exec(value))
    out.push((m[1] ?? '').replace(/\\(.)/g, '$1'));
  return out;
}

/** The active X11 window through `xprop` (null on Wayland or without xprop). */
export async function x11Front(
  run: Run,
  procName: (pid: number) => string | null = processName,
): Promise<FrontWindow | null> {
  const root = await run('xprop', ['-root', '_NET_ACTIVE_WINDOW']);
  const hex = /window id # (0x[0-9a-fA-F]+)/.exec(root)?.[1];
  const xid = hex ? parseInt(hex, 16) : 0;
  if (!xid) return null;
  const props = await run('xprop', [
    '-id',
    hex ?? '',
    '_NET_WM_PID',
    'WM_CLASS',
    '_NET_WM_NAME',
    'WM_NAME',
  ]);
  const line = (name: string) =>
    new RegExp(`^${name}\\([^)]*\\) = (.*)$`, 'm').exec(props)?.[1] ?? '';
  const pid = Number(/^\d+$/.exec(line('_NET_WM_PID').trim())?.[0] ?? 0) || null;
  const [instance = '', klass = ''] = xpropStrings(line('WM_CLASS'));
  const title = xpropStrings(line('_NET_WM_NAME'))[0] ?? xpropStrings(line('WM_NAME'))[0] ?? '';
  return {
    appName: klass || instance,
    appId: (pid ? procName(pid) : null) ?? (instance || null),
    title,
    sourceId: `window:${xid}:0`,
    pid,
  };
}

const WIN32_SCRIPT = [
  "Add-Type -Namespace NovaShell -Name User32 -MemberDefinition '",
  '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(System.IntPtr h, out int p);',
  '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);',
  "';",
  '$h = [NovaShell.User32]::GetForegroundWindow(); $p = 0;',
  '[void][NovaShell.User32]::GetWindowThreadProcessId($h, [ref]$p);',
  '$sb = New-Object System.Text.StringBuilder 1024; [void][NovaShell.User32]::GetWindowText($h, $sb, 1024);',
  '$pr = Get-Process -Id $p -ErrorAction SilentlyContinue;',
  '[pscustomobject]@{ hwnd = [int64]$h; pid = $p; process = $pr.ProcessName; path = $pr.Path; title = $sb.ToString() } | ConvertTo-Json -Compress',
].join(' ');

/** The foreground window on Windows, through PowerShell and user32. */
export async function win32Front(run: Run): Promise<FrontWindow | null> {
  const out = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    WIN32_SCRIPT,
  ]);
  const v = JSON.parse(out.trim()) as {
    hwnd?: unknown;
    pid?: unknown;
    process?: unknown;
    path?: unknown;
    title?: unknown;
  };
  const hwnd = typeof v.hwnd === 'number' && v.hwnd > 0 ? v.hwnd : null;
  if (!hwnd) return null;
  const proc = typeof v.process === 'string' ? v.process : '';
  const path = typeof v.path === 'string' ? v.path : '';
  return {
    appName: proc,
    appId: path ? basename(path.replace(/\\/g, '/')) : proc || null,
    title: typeof v.title === 'string' ? v.title : '',
    sourceId: `window:${hwnd}:0`,
    pid: typeof v.pid === 'number' ? v.pid : null,
  };
}

const DARWIN_SCRIPT = `tell application "System Events"
  set p to first application process whose frontmost is true
  set t to ""
  try
    set t to name of front window of p
  end try
  return (bundle identifier of p) & linefeed & (name of p) & linefeed & (unix id of p) & linefeed & t
end tell`;

/** The front app and window on macOS, through System Events (needs the Accessibility grant). */
export async function darwinFront(run: Run): Promise<FrontWindow | null> {
  const out = await run('osascript', ['-e', DARWIN_SCRIPT]);
  const [bundle = '', name = '', pid = '', ...title] = out.replace(/\n$/, '').split('\n');
  if (!bundle && !name) return null;
  return {
    appName: name,
    appId: bundle || null,
    title: title.join('\n'),
    sourceId: null,
    pid: /^\d+$/.test(pid) ? Number(pid) : null,
  };
}
