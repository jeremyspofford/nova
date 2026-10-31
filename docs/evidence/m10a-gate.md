# M10a gate evidence: Nova Computer

The ADR is `docs/plans/M10.md` (its M10a section and Hard limits), and the plan is
`docs/plans/M10a.md`. Everything here ran on 2026-10-30, on this machine's Docker (Docker Desktop
29.6.1, WSL2), with the pinned image `node:26-trixie@sha256:6d2c7d5d…ee617`. On CI the same tests
run on GitHub's Ubuntu runner, against Docker's own engine there.

## Suite

`npm run check` passes: the token lint, themes, typecheck, and **984 tests: 975 pass, 0 fail, 9
skipped**. The 9 skips are the existing opt-in real-service tests (real Ollama, real Claude, real
Relay); none of the new tests skipped. The new tests:

| File | Tests | What it proves |
|---|---|---|
| `tests/core/computer-policy.test.ts` | 6 | Container arguments (no network, caps, limits, one mount, no socket), argv only, never root, egress declarations, folder rules, tiers |
| `tests/core/computer-docker.test.ts` | 2 | Create, exec, limits; a checkpoint and a reset byte for byte; a missing machine is made again |
| `tests/core/computer-egress.test.ts` | 2 | The proxy's decision; from inside a real workspace: declared reached, everything else refused |
| `tests/core/computer-ledger.test.ts` | 1 | Tiers, evidence, screening, undo, a read that writes, egress and local-only, through the ledger |
| `tests/acceptance/m10a-isolation.test.ts` | 1 | Each escape attempted from inside, with a positive control |
| `tests/acceptance/m10a-computer.test.ts` | 1 | The gate end to end for a fresh user, through the real server's API |

`tests/acceptance/fresh-user.test.ts` passes unchanged.

**Test-first.** The policy test was seen failing before `policy.ts` existed. For the other gate
items, each fix was removed in turn and its test was run against that, and it failed:

| Fix removed | What failed |
|---|---|
| The folder restore in `reset` | "the folder is back byte for byte" |
| `--network none` (bridge networking instead) | The isolation test, at `console host.docker.internal:<port>: connected` |
| The computer's own local-only check | The ledger test, at the approved cloud-allowed command |
| The read check | The ledger test, at the read that wrote |

## Gate items

### 1. A project workspace is created, a command runs, and its output is evidence

From `m10a-computer.test.ts`, with the real server, a blank profile set up by conversation, and
local-only:
- **Created** the workspace `Project`, as a tier-1 task: done and verified. *"Nova read checkpoint
  c…'s copy back itself: 0 files, digest e3b0c44298fc…, as recorded."*
- **Ran** `sh -c 'printf … > hello.txt && node --version'`, as a tier-1 task.
  - Events: created, dispatched, reported, verifying, verified.
  - The output file `workers/computer/runs/<task>.json` was hashed by the test itself. Its sha256
    matches the run record and the report's artifact.
  - The ingest gate screened the output as `tool` output: verdict quarantine, since there is no
    local model in the test, which the gate never passes straight through.
- **A read** (`cat hello.txt`) was tier 0 and ran without asking.
- **Undo:** *"'Project' is back to checkpoint c…: the machine made again from its image, and the
  folder read back byte for byte."* Verified: *"Nova read the folder back itself: it matches
  checkpoint c… byte for byte."*
- **After a restart** the workspace was still there, and it ran again.
- The egress tripwire saw **no connection** from Nova off this machine.

### 2. A checkpoint and a reset return the workspace byte for byte

`computer-docker.test.ts` first sets up state A:
- a project with a binary file, an executable, a symlink and a nested folder;
- in the container, `/tmp/.cache/tool/state` and `/tmp/note.txt` at mode 600.

It takes a checkpoint, then changes both halves (edit, delete, add, chmod, a retargeted link, and in
the container an `rm -rf`, an overwrite and a chmod). The digests differ. It resets, and both halves
are back:
- **The folder:** the digest of every path, type, mode, the bytes of each file and each link target
  equals A's.
- **The container's filesystem:** read from the host with `docker export` (more than 1000 entries,
  including files the workspace's own user can't read). The digest of every path, type, mode, owner,
  size, link target and the bytes of each file equals A's.

### 3. From inside: the console, the mesh port, Nova's home, the Docker socket and the host network can't be reached

From `m10a-isolation.test.ts`, against a real Nova server. This machine's own addresses are named
here, not written out.

| Attempt | Target | Result |
|---|---|---|
| console | 127.0.0.1:43509 | refused: ECONNREFUSED |
| mesh | 127.0.0.1:43047 | refused: ECONNREFUSED |
| console / mesh | 172.17.0.1 | refused: ENETUNREACH |
| console / mesh | this machine's three addresses (LAN, tailnet, WSL) | refused: ENETUNREACH |
| console / mesh | host.docker.internal, gateway.docker.internal | refused: EAI_AGAIN (no names) |
| home | Nova's home path, and a canary file in it, searched for across the whole filesystem | refused: not there |
| docker-socket | /var/run/docker.sock, /run/docker.sock (and any socket the scan finds) | refused: ENOENT |
| docker-tcp | :2375 on loopback, the gateway, this machine's addresses, the Docker names | refused |
| host-network | interfaces | refused: loopback only |
| outside | 1.1.1.1:443; DNS for example.com | refused: ENETUNREACH; EAI_AGAIN |
| undeclared | 93.184.215.14:443, and the proxy port with no egress declared | refused: ENETUNREACH; ECONNREFUSED |
| root | privileges | refused: uid 1000, CapEff 0, NoNewPrivs 1, writing /etc/passwd EACCES, setuid(0) EPERM |

Docker's own view: network `none`; one mount (the project folder at `/workspace`); user 1000:1000;
CapDrop ALL; no-new-privileges; not privileged; 2 GiB memory, 2 CPUs, 512 pids.

**Positive controls.** The same probe, run with one piece of isolation removed, gets through. So
each refusal above is the isolation holding, not a broken probe:

| Isolation removed | Got through to |
|---|---|
| The host's network | the console and the mesh, via host.docker.internal; non-loopback interfaces |
| Docker's default bridge network | the mesh, via host.docker.internal |
| Nova's home mounted | the home and its canary |
| The Docker socket mounted | the engine (`/_ping` answered OK) |
| Root with capabilities | root |

**Found.** Under Docker Desktop, any bridged container reaches this machine's loopback, and so
Nova's console, which answers anyone on this machine as the person. `--network none` is what stops
it. With bridge networking, the test fails on exactly that.

### 4. Egress outside the declaration is refused

**The decision** (`computer-egress.test.ts`) refuses:
- an undeclared host;
- a declared host at an undeclared port;
- a bare wildcard base;
- a declared name that also resolves to 127.0.0.1 (rebinding);
- a declared name on the tailnet range;
- `localhost`, and 127.0.0.1, even when declared.

**From inside a real workspace** (hosts mode, with stand-in hosts on loopback that this test alone
counts as public):
- **Reached:** a raw CONNECT to the declared host; curl through the proxy settings every egress
  command gets.
- **Refused:**
  - an undeclared port: 403 *not declared*;
  - an undeclared name: 403;
  - plain HTTP: 405 *HTTPS (CONNECT) only*;
  - curl to an undeclared port: 403.
- **Around the proxy:** a direct connection to 127.0.0.1 gets ECONNREFUSED (the container's own
  loopback); `host.docker.internal` doesn't resolve; a public address is ENETUNREACH.
- **With the real rule** (no test allowance), the declared 127.0.0.1 is refused as *a private
  address*, and the declared `localhost` as *a name on a private network*.
- Every attempt, allowed or refused, is in the record, in order.

**Through the ledger** (`computer-ledger.test.ts`): a command in a workspace that may reach outside
is tier 3 and waits for the OK. Its record lists `127.0.0.1` allowed and `undeclared.example.test`
refused, and the report says so.

### 5. Local-only gives no egress

- **The ledger refuses it.** While the profile is local-only, creating a workspace with `registries`
  or declared hosts is refused before anything runs: 400, *"…this task is local-only"*. This was
  seen through the real server and in process.
- **So does the computer.** When the person's default is back to local-only, a command in an egress
  workspace is refused by the ledger. A task whose own brief says cloud-allowed, approved at tier 3,
  is refused by the computer: *"…your Nova is local-only: nothing leaves this machine, so the command
  didn't run."*

### 6. The fresh-user test passes

`tests/acceptance/fresh-user.test.ts` passes unchanged, with the computer wired in. A fresh Nova
doesn't touch Docker until the computer is used. `GET /computer` shows no workspaces, and `/health`
has a `computer` check that is ok. `m10a-computer.test.ts` is the computer's own fresh-user run.

### UI

The ADR and the roadmap ask for no UI in M10a, so none was built. The API under `/computer` is the
console surface.

## Tiers as built

The full table is in `docs/plans/M10a.md`. The tier numbers deviate from the ADR's wording,
recorded in the LEDGER: a reversible write is "do, notify, undo", which is this ledger's tier 1. In
this ledger, tier 2 waits for an OK.
