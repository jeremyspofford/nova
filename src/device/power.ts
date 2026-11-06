// The boot agent's sixth verb, `power` (docs/plans/wol-inference-nodes-adr-2026-11-06.md, "The sleep
// policy"; the owner amended Decision 1 from five verbs to six on 2026-11-06). It takes exactly one
// of three fixed arguments and nothing else, and acts only on this machine:
//   - hold:    hold an OS sleep inhibitor while Nova has work here, so the OS's own power plan can't
//              suspend it in the middle of a reply;
//   - release: let that inhibitor go;
//   - sleep:   ask the OS to suspend, after the boot agent's own checks (sleepRefusal).
// It starts nothing of the hub's and takes nothing from the hub but the policy. The runtime decides
// when (runtime.ts idleStep); this module does. The OS's idle time (no input from a person) is read
// here too, since the runtime may not run tools. Tests hand in stand-ins: a test never sleeps a machine.
import { execFile, spawn } from 'node:child_process';

export const POWER_ACTIONS = ['hold', 'release', 'sleep'] as const;
export type PowerAction = (typeof POWER_ACTIONS)[number];

// The whole request, less its message type and id: `{verb: 'power', action}` and nothing more.
export function checkPowerRequest(r: unknown): { ok: true; action: PowerAction } | { ok: false; said: string } {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return { ok: false, said: 'A power request is {verb: power, action}.' };
  const o = r as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== 'verb' && k !== 'action');
  if (o.verb !== 'power' || extra.length) return { ok: false, said: `A power request carries only its action${extra.length ? `, not ${extra.join(', ')}` : ''}.` };
  if (!POWER_ACTIONS.includes(o.action as PowerAction)) return { ok: false, said: 'The power verb takes hold, release or sleep, and nothing else.' };
  return { ok: true, action: o.action as PowerAction };
}

// Why the boot agent won't suspend now, or null (the ADR's step 3): not in safe mode, no workload
// install, switch or start in progress, and `hold` still false in the hub's latest answer, which must
// carry a sleep policy at all.
export function sleepRefusal(s: { safeMode: boolean; verbsRunning: number; power: { sleep_after_min: number | null; hold: boolean } | null }): string | null {
  if (s.safeMode) return 'It is in safe mode.';
  if (s.verbsRunning > 0) return 'A workload is being installed, switched or started.';
  if (!s.power || s.power.sleep_after_min === null) return 'Its sleep policy is “Never sleep”.';
  if (s.power.hold) return 'Nova has work here.';
  return null;
}

// The hub's answer's `power`, read the same way on both sides of the IPC.
export { readPower } from './runtime.ts';

export type Run = (program: string, args: string[]) => Promise<string | null>;
export type Spawn = (program: string, args: string[]) => { kill(): void };

const runTool: Run = (program, args) => new Promise((resolve) => {
  execFile(program, args, { timeout: 10_000, maxBuffer: 256 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
});
const spawnTool: Spawn = (program, args) => {
  const c = spawn(program, args, { stdio: 'ignore', windowsHide: true });
  c.on('error', () => { /* no inhibitor tool: the OS's plan decides */ });
  return { kill: () => { c.kill(); } };
};

// The OS commands, fixed per platform; nothing in them comes from the hub.
const PS = ['-NoProfile', '-NonInteractive', '-Command'];
const WIN_IDLE = 'Add-Type -Namespace W -Name I -MemberDefinition \'[StructLayout(LayoutKind.Sequential)] public struct L { public uint s; public uint t; } [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref L p);\'; $l = New-Object W.I+L; $l.s = 8; [void][W.I]::GetLastInputInfo([ref]$l); [Environment]::TickCount - $l.t';
const WIN_HOLD = '$t = Add-Type -Namespace W -Name P -PassThru -MemberDefinition \'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);\'; [void]$t::SetThreadExecutionState(0x80000001); while ($true) { Start-Sleep 60 }';
export const POWER_COMMANDS: Record<'linux' | 'darwin' | 'win32', { suspend: [string, string[]]; inhibit: [string, string[]] }> = {
  linux: { suspend: ['systemctl', ['suspend']], inhibit: ['systemd-inhibit', ['--what=sleep:idle', '--who=Nova', '--why=Nova is using this computer', '--mode=block', 'sleep', 'infinity']] },
  darwin: { suspend: ['pmset', ['sleepnow']], inhibit: ['caffeinate', ['-i']] },
  win32: { suspend: ['rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']], inhibit: ['powershell.exe', [...PS, WIN_HOLD]] },
};

export class Power {
  #platform: string;
  #run: Run;
  #spawn: Spawn;
  #held: { kill(): void } | null = null;
  #now: () => number;

  constructor(o: { platform?: string; run?: Run; spawn?: Spawn; now?: () => number } = {}) {
    this.#platform = o.platform ?? process.platform;
    this.#run = o.run ?? runTool;
    this.#spawn = o.spawn ?? spawnTool;
    this.#now = o.now ?? Date.now;
  }

  get held(): boolean { return this.#held !== null; }
  #commands() { return POWER_COMMANDS[this.#platform as keyof typeof POWER_COMMANDS] ?? null; }

  hold(): { ok: boolean; said: string } {
    if (this.#held) return { ok: true, said: 'Already held awake.' };
    const c = this.#commands();
    if (!c) return { ok: false, said: `Nova can’t hold a ${this.#platform} computer awake.` };
    this.#held = this.#spawn(...c.inhibit);
    return { ok: true, said: 'Held awake while Nova has work here.' };
  }

  release(): { ok: boolean; said: string } {
    this.#held?.kill();
    this.#held = null;
    return { ok: true, said: 'The OS’s own power plan decides again.' };
  }

  async sleep(): Promise<{ ok: boolean; said: string }> {
    const c = this.#commands();
    if (!c) return { ok: false, said: `Nova can’t put a ${this.#platform} computer to sleep.` };
    this.release();
    const r = await this.#run(...c.suspend);
    return r === null ? { ok: false, said: 'The OS refused to suspend.' } : { ok: true, said: 'Going to sleep.' };
  }

  // How long since a person last used this machine, in ms; null when it can't be read (then Nova
  // never sleeps it). Linux: logind's IdleSinceHint for each session, the least idle one; a machine
  // with no sessions at all has no one at it. macOS: HIDIdleTime. Windows: GetLastInputInfo (as the
  // agent's own session sees it; shortcut: a service in session 0 sees no input, upgrade with a
  // per-user helper when one exists).
  async osIdleMs(): Promise<number | null> {
    if (this.#platform === 'darwin') {
      const ns = /"HIDIdleTime"\s*=\s*(\d+)/.exec((await this.#run('ioreg', ['-c', 'IOHIDSystem', '-d', '4'])) ?? '')?.[1];
      return ns ? Math.floor(Number(ns) / 1e6) : null;
    }
    if (this.#platform === 'win32') {
      const ms = Number(((await this.#run('powershell.exe', [...PS, WIN_IDLE])) ?? '').trim());
      return Number.isFinite(ms) && ms >= 0 ? ms : null;
    }
    if (this.#platform !== 'linux') return null;
    const list = await this.#run('loginctl', ['list-sessions', '--no-legend']);
    if (list === null) return null;
    const ids = list.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((x): x is string => !!x && /^[\w-]+$/.test(x));
    if (!ids.length) return Number.MAX_SAFE_INTEGER;
    let least = Number.MAX_SAFE_INTEGER;
    for (const id of ids) {
      const out = await this.#run('loginctl', ['show-session', id, '-p', 'IdleHint', '-p', 'IdleSinceHint']);
      if (out === null) return null;
      if (/IdleHint=no/.test(out)) return 0;
      const since = Number(/IdleSinceHint=(\d+)/.exec(out)?.[1] ?? NaN) / 1000;
      if (!Number.isFinite(since) || since <= 0) return null;
      least = Math.min(least, Math.max(0, this.#now() - since));
    }
    return least;
  }
}
