# 23 — Device Agent (`novad`)

`novad` is the Nova device agent. It runs on the Hub, on Compute Nodes, and on desktop
clients. It is responsible for registration, capability reporting, local execution, device
management, power/boot, and (optionally) firmware/BIOS management. Mobile devices do not run
`novad`; their app performs the subset the OS allows.

## 1. Architecture: supervisor + modules (hybrid)

```
                 ┌───────────────────────────────┐
                 │            novad               │  small, auditable supervisor
                 │  install · update · register   │  (root/admin, minimal surface)
                 │  capabilities · policy broker  │
                 └───────┬───────────────────────┘
        ┌───────────┬────┴──────┬───────────┬─────────────┐
        ▼           ▼           ▼           ▼             ▼
   management   compute     browser     screen       storage      (signed modules,
   (power/boot/  (inference) (automation) (input)     (files)       sandboxed, optional)
    services/BIOS)
```

- The **supervisor** is the only component that needs elevated privileges continuously.
- **Modules** are separately signed binaries/workers, spawned on demand, each sandboxed and
  independently updatable. A device installs only the modules it needs.
- The supervisor enforces policy per module (filesystem scopes, network, resource limits).

Rationale: least privilege + isolation + independent updates, without the packaging sprawl of
entirely separate products.

## 2. Install & bootstrap

- The Hub serves signed, per-arch builds at `/api/v1/agent/dist/novad-<os>-<arch>`.
- Installation uses the Add Device code (`docs/22` §4.3), verifies the **signature** and
  **checksum**, pins/validates the Hub certificate, then registers.
- `novad install --hub <url> --code <PAIR-CODE> [--role client|compute|wake] [--modules …]`.
- The installer sets up a service (systemd / launchd / Windows service), a data directory, and
  an unprivileged runtime user for modules.
- Uninstall (`novad uninstall --purge`) revokes the device certificate and removes data.

## 3. Capability declaration

On first connect and on change, `novad` reports a capability document. Default: declare
everything detectable. Advanced: the Hub or user can override. Includes the additions agreed
for DA7 (timezone/locale, energy/quiet hours, routing weight, egress limits).

```jsonc
{
  "schemaVersion": 1,
  "deviceId": "…",
  "roles": ["client", "compute"],            // modules this device accepts
  "hardware": {
    "arch": "x86_64", "cores": 8, "ramBytes": 17179869184,
    "disks": [{ "mount": "/", "freeBytes": 500000000000 }],
    "gpus": [{ "vendor": "nvidia", "name": "RTX 4070", "vramBytes": 12884901888 }],
    "nic": { "wol": true, "macs": ["aa:bb:cc:dd:ee:ff"] },
    "firmware": { "type": "uefi", "vendor": "dell", "oob": { "amt": false, "ipmi": false, "redfish": false } }
  },
  "os": { "family": "linux", "version": "…", "init": "systemd", "packageManager": "apt",
          "sandbox": { "bubblewrap": true, "container": "podman" } },
  "services": {
    "computeBackends": ["llama.cpp", "vllm"],
    "listeningPorts": [8000],
    "modelsPresent": [{ "id": "qwen2.5-coder:14b", "format": "gguf", "sizeBytes": 9000000000 }]
  },
  "models": {
    "storagePaths": ["/var/lib/nova/models", "/mnt/models"],
    "cacheQuotaBytes": 200000000000
  },
  "computePolicy": {
    "gpuSharing": "shared", "vramReserveBytes": 1073741824,
    "maxConcurrentJobs": 2, "maxJobDurationSec": 3600
  },
  "peripherals": { "screens": 2, "camera": true, "mic": true, "speakers": true, "browser": true },
  "access": { "fsScopes": ["/home/user/projects"], "admin": true, "network": "lan+lattice" },
  "power": { "ac": true, "alwaysOn": true, "wakeable": true, "policy": "stay-awake",
             "thermalLimitC": 85 },
  "data": { "retentionDays": 30, "telemetryAllowed": false, "updateChannel": "stable" },
  "locale": { "timezone": "America/Los_Angeles", "locale": "en-US" },
  "scheduling": { "quietHours": ["22:00-07:00"], "energyPriceTier": "offpeak-cheap",
                  "routingWeight": 10 },
  "limits": { "maxEgressMbps": 500 }
}
```

The Hub validates this against `contracts/schemas/device-capability.json` and stores it in the
capability registry used for routing.

## 4. Modules

| Module | Purpose | Privilege | Default |
| --- | --- | --- | --- |
| **management** | Power state, boot configuration, services, updates, (opt) BIOS/OOB | High | On for Hub/desktop |
| **compute** | Run inference/embeddings/media backends; manage models | Medium | On for Compute Nodes |
| **browser** | Headless browser automation for agents | Low | Optional |
| **screen** | Observe and control the desktop (computer use) | Medium | Optional |
| **storage** | Expose/mount folders; model storage; snapshots | Medium | Optional |

Modules are sandboxed; the supervisor applies per-module policy (filesystem, network, CPU/RAM,
wall clock).

## 5. Boot & power

### 5.1 High-level boot

- **Linux**: systemd unit (`novad.service`) with `Restart=always`.
- **macOS**: launchd agent/daemon.
- **Windows**: Windows service.

The supervisor starts modules per configuration and re-registers with the Hub.

### 5.2 Low-level boot (opt-in)

For headless/compute machines and lab setups, `novad` may manage lower-level boot paths:

- **PXE / iPXE** network boot: serve boot images and menus so a device can netboot into a Nova
  image.
- **Bootloader** configuration: managed entries (e.g., systemd-boot/GRUB) with a safe default
  and automatic fallback.
- **Boot profiles**: choose an OS/image on next boot, with a watchdog that reverts if the
  machine fails to come up (Nova marks the boot successful only after `novad` reconnects).

Low-level boot is disabled by default and requires an admin toggle.

### 5.3 Wake-on-LAN

- Enable WoL where the platform allows (NIC setting, and BIOS where supported).
- A **Wake Helper** on the same LAN sends the magic packet (`docs/22` §7).
- `novad` reports wakeability; the Hub only offers "wake" for wakeable devices.
- Wakes are rate-limited and logged.

## 6. BIOS / firmware management

Capability varies by platform. Support ladder (BM1): **Dell → Lenovo → HP → ASUS →
Supermicro/server → generic UEFI**.

### 6.1 Methods

| Method | Use |
| --- | --- |
| Vendor OS agents (Dell Command \| Configure, Lenovo WMI, HP BCU, ASUS/Dell WMI) | Change settings from the OS |
| `fwupd` | Firmware **updates** (not arbitrary settings) |
| `dmidecode` | Read-only inventory |
| Out-of-band: IPMI / Redfish / Intel AMT/vPro | Settings + power **without a running OS** |

### 6.2 Settings in scope (BM2)

Wake-on-LAN enable · power-on-after-power-loss · boot order · virtualization (VT-x/AMD-V) ·
Secure Boot / TPM state · fan/thermal profile.

### 6.3 Safety model (mandatory)

1. **Global toggle** "Allow BIOS/firmware changes" — **off by default** (BM3).
2. Even when enabled, **every change requires explicit approval** on the Hub; BIOS changes are
   **never** proactive or autonomous.
3. **Dry-run + diff preview** (current → proposed) before applying.
4. **Snapshot** the current configuration first; support **rollback**.
5. **Allowlist only**; **security-degrading changes** (disabling Secure Boot/TPM, turning off
   firmware write-protect) are blocked by default and require a separate, explicit override.
6. **Supported-hardware matrix**; unsupported devices get a clear refusal, never a guess.
7. Reboot/power-cycle coordination, with a watchdog and automatic rollback on failed boot.
8. Every change is written to the **Flight recorder** with before/after values.

## 7. Out-of-band management (BM4, opt-in)

- **IPMI** (BMC), **Redfish**, **Intel AMT/vPro**: power on/off/cycle, firmware settings,
  console access, health sensors — even with the OS down.
- Module is **off by default**; admin-only; credentials stored in the keychain; endpoints
  must be allowlisted.
- All operations are policy-gated, approved, and audited.
- Supports server hardware (Supermicro/Dell/HPE) and vPro client machines.

## 8. Updates

- The Hub serves signed module bundles; `novad` verifies signature + version pinning.
- Update flow: download → verify → stage → health check → commit; on failure, roll back to the
  previous module version.
- Channels: stable / beta / nightly, set per device (default stable).
- The supervisor updates itself last, with a fallback binary and a watchdog.

## 9. Security model

- **Elevated supervisor, unprivileged modules.** Modules run as a restricted user in a sandbox.
- **Signed everything**: binaries, modules, update bundles, and capability profiles.
- **mTLS** between `novad` and the Hub, using the device certificate.
- **Least privilege per module**, enforced by the supervisor and OS sandbox.
- **No secrets to the model**: credentials stay in the keychain/vault; modules receive
  short-lived tokens only for the operation in flight.
- **Audit**: every privileged action (install, module start/stop, power, boot, BIOS, OOB) is
  recorded on the Hub's Flight recorder.
- **Revocation** instantly disables the device certificate and stops module execution.

## 10. Failure & recovery

| Failure | Behavior |
| --- | --- |
| Hub unreachable | Keep running local fallback (if enabled); buffer management events |
| Module crash | Supervisor restarts with backoff; repeated crashes disable the module |
| Bad firmware/BIOS change | Watchdog reverts boot profile / restores snapshot; alert the user |
| Update fails health check | Automatic module rollback |
| Service can't start at boot | Boot profile marked failed; fallback to known-good; `novad` reports |
| Certificate revoked | `novad` stops modules, wipes credentials, awaits re-add |

## 11. Uninstall & decommission

- `novad uninstall` stops modules, removes services, and (with `--purge`) deletes data.
- The Hub removes the device from the registry and revokes its certificate.
- For rented/sold hardware, a **decommission** action wipes Nova data and, where supported,
  clears the BIOS management credentials it installed.
