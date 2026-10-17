# @nova/compute

The Nova compute node. It runs on a machine with a local model server (Ollama, a llama.cpp
server or another OpenAI-compatible server), registers with a Hub using a one-time enrollment
token, and serves only jobs the Hub authorizes (FR-126). It never connects to clients: its only
outgoing connections go to the Hub URL and its local model backend, and redirects are refused.

## Use

1. In the Hub, add a compute node (Settings → Devices, or `POST /api/v1/devices/add/start` with
   `{"role":"compute"}`). The Hub shows a one-use enrollment token (`nve_…`, valid 15 minutes).
2. On the machine with the models:

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
| `--data-dir` | `$NOVA_COMPUTE_DATA_DIR`, else `$XDG_DATA_HOME/nova-compute` | State directory |

`run` exits with code 3 when the Hub has revoked the node; enroll again with a new token.

## How it works (ADR-089, contracts/hub-api.md §2)

- **Identity.** `enroll` creates an Ed25519 key pair and a random job token, builds the
  capability document (`contracts/schemas/device-capability.json`: hardware, OS, backend and the
  models present) and signs its canonical JSON (sorted keys). The Hub pins the public key; every
  later document must verify against it.
- **State.** Keys, ids and tokens live in `node.json` (mode 0600, directory 0700). Nothing secret
  is printed or logged. On revocation the node wipes its keys and tokens and keeps only its
  stable device id.
- **Heartbeat.** Every 10 s the node lists its backend's models, re-signs and syncs the document
  when they changed (`/node/v1/models/sync`), then reports load and models (`/node/v1/heartbeat`).
  Three missed beats mark it unreachable on the Hub.
- **Job API.** `POST /node/v1/jobs`, `GET /node/v1/jobs/:id/stream` (SSE of normalized stream
  events), `POST /node/v1/jobs/:id/cancel`, `GET /node/v1/health`. Every call needs the job token
  (compared in constant time); requests carrying an `Origin` header (browsers) are refused. A job
  is cancelled, and its backend request aborted, when the Hub cancels it or disconnects.

## Library

Everything the CLI does is exported for tests and embedding: `enroll`, `ComputeNode`,
`buildJobServer`, `JobManager`, `Backend`, `buildCapability`, `signDocument`, and
`startFakeBackend`, a scripted OpenAI-compatible server for offline tests and demos.
