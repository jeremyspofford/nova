# @nova/compute

The Nova compute node. It runs on a machine with a local model server (Ollama, a llama.cpp
server or another OpenAI-compatible server), joins a Hub with an Add Device code or a one-time
enrollment token, and serves only jobs the Hub authorizes (FR-126, FR-132). It never connects to clients: its only
outgoing connections go to the Hub URL and its local model backend, and redirects are refused.

## Use

With a code (Add Device, docs/22 §4):

1. In the Hub, add a device with the role Compute Node (Settings → Devices, or
   `POST /api/v1/devices/add/start` with `{"role":"compute"}`). The Hub shows a code like
   `ABCD-EFGH` (single use, 5 minutes).
2. On the machine with the models:

   ```bash
   nova-compute enroll --hub http://hub.local:7419 --code ABCD-EFGH \
     --backend http://127.0.0.1:11434 --backend-kind ollama
   ```

   It sends the code, a new Ed25519 key and a commitment to a secret nonce, gets the Hub's nonce,
   then reveals its own (Add Device v2: nobody on the network path can grind a key that shows the
   same digits). It prints `Confirm this code on the Hub: 123 456` and stops if the Hub's number
   differs from the one it computes itself. Approve the request on the Hub when it shows the same
   six digits; the node then registers with the token the Hub grants (bound to the node's key)
   and exits. `--pairing <id>` passes the pairing id from the QR payload or the install command
   (a code typed without it has a small guess budget). `--pin <fingerprint>` checks that the
   Hub's public key from `GET /api/v1/hello` hashes to the pin and that the Hub signed the
   confirmation with it; anything else stops with "this is not your Hub".
3. `nova-compute run`.

With a token (scripted setups): `POST /api/v1/devices/compute/enroll` returns a one-use
enrollment token (`nve_…`, 15 minutes); creating it with a session is the owner's approval.

```bash
nova-compute enroll --hub http://hub.local:7419 --token nve_… \
  --backend http://127.0.0.1:11434 --backend-kind ollama
nova-compute run
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--backend-kind` | `ollama` | `ollama`, `llamacpp` or `openai_compatible` (`/v1` is added when missing) |
| `--name` | host name | Shown in the Hub's device list and model picker |
| `--listen` | `0.0.0.0:7420` | Where the job API listens (`host:port`); port 0 needs `--advertise` |
| `--advertise` | LAN address + port | The URL the Hub calls |
| `--max-jobs` | `1` | Jobs run at once; up to 4 more wait, beyond that the node answers busy |
| `--pin` | none | The Hub fingerprint from Add Device; needed to trust an `https://` Hub's own CA (below) |
| `--quiet-hours` | none | `HH:MM-HH:MM` ranges, comma separated, in this machine's zone: no new jobs then (M7.5) |
| `--backend-unit` | none | The systemd unit running the model server; the Hub may then start, stop and restart it |
| `--pairing` | none | The pairing id from the QR payload or the install command (with `--code`) |
| `--data-dir` | `$NOVA_COMPUTE_DATA_DIR`, else `$XDG_DATA_HOME/nova-compute` | State directory |

`run` exits with code 3 when the Hub has revoked the node; enroll again with a new code or token
(a revoked key is never accepted again; enrolling creates a new one).

## HTTPS and mutual TLS (FR-126, FR-134; `src/hub-tls.ts`)

With `--pin` (with a code or a token) an `https://` Hub is trusted the way `docs/22` §5 tells
native shells to: a certificate the Hub local CA issued for the host (the CA a verified statement
vouched for; every name the certificate carries must be inside the CA's name constraints, as
novad's TLS stack requires), or one a verified statement listed, is trusted at once; otherwise the node asks the
Hub for its signed identity statement on that same connection, with a fresh nonce, before
anything else crosses it, and stops with "this is not your Hub" unless the key hashes to the pin,
the signature verifies and the statement vouches for the chain shown. What it vouched for is kept
in the state file (`hubTrust`). Over `http://` with a pin the node learns the Hub local CA from
the signed statement (the CA from `GET /api/v1/trust/ca.pem` must hash to the SHA-256 it lists),
and when a heartbeat can no longer reach the Hub it tries `https://` on the same address (at most
once a minute), moving there for good once the pinned identity vouches for it (never back).
Without a pin an `https://` Hub is checked against the system's roots.

When Add Device grants a device certificate (the Hub's trust mode is the local CA), the node keeps
it (`enrollment.certificatePem`) and presents it, signed with its own key, on every connection to
a verified Hub, from registration on; a provisional connection never carries it. A Hub that
refuses the certificate (`certificate_revoked`, …) is logged; the node keeps its credentials.

## How it works (ADR-089, contracts/hub-api.md §2)

- **Identity.** `enroll` creates an Ed25519 key pair and a random job token, builds the
  capability document (`contracts/schemas/device-capability.json`: hardware, OS, backend and the
  models present) and signs its canonical JSON (sorted keys). The Hub pins the public key; every
  later document must verify against it.
- **State.** Keys, ids, tokens, the device certificate and the Hub trust live in `node.json`
  (mode 0600, directory 0700). Nothing secret
  is printed or logged. On revocation the node wipes its keys and tokens and keeps only its
  stable device id.
- **Heartbeat.** Every 10 s the node lists its backend's models, re-signs and syncs the document
  when they changed (`/node/v1/models/sync`), then reports load and models (`/node/v1/heartbeat`).
  Three missed beats mark it unreachable on the Hub.
- **Job API.** `POST /node/v1/jobs`, `GET /node/v1/jobs/:id/stream` (SSE of normalized stream
  events), `POST /node/v1/jobs/:id/cancel`, `GET /node/v1/health`. Every call needs the job token
  (compared in constant time); requests carrying an `Origin` header (browsers) are refused. A job
  is cancelled, and its backend request aborted, when the Hub cancels it or disconnects.

## GPU memory, quiet hours and services (M7.5, FR-126)

- **VRAM.** `nvidia-smi` or `rocm-smi`, when installed, is read without a shell (`src/vram.ts`):
  each GPU's total memory goes into the signed document (`hardware.gpus[].vramBytes`) and every
  heartbeat carries `vram: [{index, vendor, name, totalBytes, usedBytes}]`. Nothing is guessed
  when neither tool answers.
- **Quiet hours.** New jobs are refused with 503 `node_unavailable` `{reason: quiet_hours}` in the
  operator's own hours (`--quiet-hours`, declared as `scheduling.quietHours`, read in the zone the
  document declares as `locale.timezone`) and in the owner's: every heartbeat answer carries the
  Hub's policy for the node `{quietHours, timeZone, routingEligible, revision}`, kept in the state
  file. Running jobs finish; each heartbeat reports `quiet`.
- **Services.** `GET /node/v1/services` and `POST /node/v1/services/:name/{start,stop,restart,status}`
  (job token, like the job API): `jobs` (stopped, new jobs get `{reason: jobs_stopped}`; restart
  cancels what runs) and `backend`, only with `--backend-unit` (`systemctl` with the unit name
  after `--`; otherwise 409 `{reason: not_managed}`). Any other name is 404.

## Library

Everything the CLI does is exported for tests and embedding: `enroll`, `joinWithCode` (with
`addDeviceCommitment`, `addDeviceConfirmation`, `signAddDeviceReveal`, `signAddDeviceStatus`,
`verifyHubReveal`, `hubKeyFingerprint` and `normalizeAddDeviceCode`), `ComputeNode`,
`buildJobServer`, `JobManager`, `Backend`, `buildCapability`, `signDocument`, `HubTls` (with
`checkStatement` and `learnCaOverHttp`), `NodeServices` (with `systemctlController` and
`fakeUnitController`), the VRAM probes (`detectVramProbe`, `nvidiaSmiProbe`, `rocmSmiProbe`,
`fakeVramProbe`), and `startFakeBackend`, a scripted OpenAI-compatible server for offline tests
and demos.
