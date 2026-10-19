// The seccomp program the runner's bubblewrap sandbox installs (`--seccomp 3`). It follows the same
// rules as the Hub's OS sandbox (docs/12 §7.3), written here because the runner is a separate,
// Apache-2.0 package (ADR-023): another architecture's syscalls (and the x32 ABI) kill the
// process; io_uring, kernel modules, kexec, bpf, perf events and userfaultfd fail with EPERM; and
// without network, a socket of any family but AF_UNIX fails with EAFNOSUPPORT.

export type FilterArch = 'x86_64' | 'aarch64';

interface ArchTable {
  audit: number;
  socket: number;
  deny: number[];
}

const ARCHES: Record<FilterArch, ArchTable> = {
  // io_uring_setup/enter/register, kexec_load, kexec_file_load, init_module, finit_module,
  // delete_module, bpf, perf_event_open, userfaultfd.
  x86_64: {
    audit: 0xc000003e,
    socket: 41,
    deny: [425, 426, 427, 246, 320, 175, 313, 176, 321, 298, 323],
  },
  aarch64: {
    audit: 0xc00000b7,
    socket: 198,
    deny: [425, 426, 427, 104, 294, 105, 273, 106, 280, 241, 282],
  },
};

// Classic BPF opcodes: BPF_LD|BPF_W|BPF_ABS, BPF_JMP|BPF_JEQ|BPF_K, BPF_JMP|BPF_JGE|BPF_K,
// BPF_RET|BPF_K.
const LOAD = 0x20;
const JEQ = 0x15;
const JGE = 0x35;
const RET = 0x06;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO = 0x00050000;
const EPERM = 1;
const EAFNOSUPPORT = 97;
const AF_UNIX = 1;
// Offsets in struct seccomp_data: nr, arch, args[0] (low word on little-endian hosts).
const OFF_NR = 0;
const OFF_ARCH = 4;
const OFF_ARG0 = 16;

type Target = 'next' | 'allow' | 'eperm' | 'kill' | 'socket';

interface Step {
  code: number;
  k: number;
  /** Where a true / false comparison goes (jumps only). */
  yes?: Target;
  no?: Target;
}

/** The filter's architecture for a Node `process.arch`, or null when there is none. */
export function filterArch(arch: string = process.arch): FilterArch | null {
  if (arch === 'x64') return 'x86_64';
  if (arch === 'arm64') return 'aarch64';
  return null;
}

/** `struct sock_filter[]` bytes (little-endian, as both supported hosts are). */
export function seccompProgram(arch: FilterArch, network: boolean): Buffer {
  const t = ARCHES[arch];
  const head: Step[] = [
    { code: LOAD, k: OFF_ARCH },
    { code: JEQ, k: t.audit, yes: 'next', no: 'kill' },
    { code: LOAD, k: OFF_NR },
  ];
  if (arch === 'x86_64') head.push({ code: JGE, k: 0x40000000, yes: 'kill', no: 'next' });
  for (const nr of t.deny) head.push({ code: JEQ, k: nr, yes: 'eperm', no: 'next' });
  if (!network) head.push({ code: JEQ, k: t.socket, yes: 'socket', no: 'next' });
  const blocks: Record<Exclude<Target, 'next'>, Step[]> = {
    allow: [{ code: RET, k: SECCOMP_RET_ALLOW }],
    eperm: [{ code: RET, k: SECCOMP_RET_ERRNO | EPERM }],
    kill: [{ code: RET, k: SECCOMP_RET_KILL_PROCESS }],
    socket: network
      ? []
      : [
          { code: LOAD, k: OFF_ARG0 },
          { code: JEQ, k: AF_UNIX, yes: 'allow', no: 'next' },
          { code: RET, k: SECCOMP_RET_ERRNO | EAFNOSUPPORT },
        ],
  };
  // The blocks follow the comparisons in this order; `allow` comes first so a comparison that
  // falls through reaches it.
  const order: Exclude<Target, 'next'>[] = ['allow', 'eperm', 'kill', 'socket'];
  const start = new Map<Target, number>();
  let at = head.length;
  for (const name of order) {
    start.set(name, at);
    at += blocks[name].length;
  }
  const steps = [...head, ...order.flatMap((n) => blocks[n])];
  // The socket block's own jump goes back to `allow`, which lies before it: give it its own
  // allow return right after (classic BPF jumps only forward).
  const out = Buffer.alloc((steps.length + 1) * 8);
  const offset = (from: number, to: Target | undefined): number => {
    if (to === undefined || to === 'next') return 0;
    let target = start.get(to)!;
    if (target <= from) target = steps.length; // the trailing allow
    const d = target - from - 1;
    if (d < 0 || d > 255) throw new Error('seccomp jump out of range');
    return d;
  };
  steps.forEach((s, i) => {
    out.writeUInt16LE(s.code, i * 8);
    out.writeUInt8(offset(i, s.yes), i * 8 + 2);
    out.writeUInt8(offset(i, s.no), i * 8 + 3);
    out.writeUInt32LE(s.k >>> 0, i * 8 + 4);
  });
  const last = steps.length * 8;
  out.writeUInt16LE(RET, last);
  out.writeUInt32LE(SECCOMP_RET_ALLOW, last + 4);
  return out;
}
