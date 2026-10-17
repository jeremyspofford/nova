# 22 — Networking, Transports & Relay

Nova must reach the Hub from anywhere a user is, without requiring the user to open ports or
run a VPN by hand. This document defines the transport abstraction, the Add Device flow, the
trust/HTTPS story, and the Relay.

## 1. Goals

- Work on the LAN with zero setup.
- Work remotely (phone on cellular) with minimal setup.
- Never hard-depend on a third-party service.
- Be safe by default: authenticated, encrypted, least-privilege.

## 2. Transports (the "Lattice" abstraction)

A **transport** is a way two Nova roles can reach each other. The Hub publishes a set of
reachable **endpoints**; clients try them in order and use the first that works.

| Transport | Description | Requires |
| --- | --- | --- |
| **LAN** | Direct on the local network (mDNS/`.local` names or IP). | Same network |
| **Lattice** | A WireGuard-based mesh. Supported control planes: **Headscale** (self-hosted, recommended), **Tailscale** (managed), **NetBird** (self-hosted, mobile-friendly), or **plain WireGuard**. | An installed mesh client |
| **Relay** | A content-blind forwarding server that both sides connect **outbound** to. | A reachable Relay |
| **Direct public** | Hub exposed on a public address/port. | Port forwarding or public host |

Endpoint selection order (happy-eyeballs, roughly 300 ms budget per candidate):

```
LAN → Lattice → Relay → (Direct public if configured)
```

If a candidate fails a health check, the Hub stops advertising it (`docs/23` diagnostics).

### 2.1 Control plane vs data plane (important)

- The **control plane** hands out keys and introduces peers. Headscale/Tailscale/NetBird are
  control planes.
- The **data plane** is the actual encrypted tunnel: direct where possible, through a
  **DERP** relay when NAT blocks a direct path.

Self-hosting Headscale gives you a self-hosted control plane, but:

- **Desktop/Linux/Windows/macOS**: Tailscale clients can point at Headscale — works well.
- **Mobile**: the official Tailscale apps historically do **not** allow a custom control
  server. If mobile must work with a self-hosted mesh, prefer **NetBird** (self-hostable
  with mobile apps) or rely on the **Relay**.

### 2.2 Lattice recommendation

- **Default recommendation for self-hosters: Headscale**, documented and orchestrated by Nova.
- **Managed Tailscale** offered for the easiest mobile experience.
- **NetBird** supported and evaluated as the "self-hosted *and* mobile" answer.
- **Plain WireGuard** supported for minimalists.

Nova never requires a Lattice; LAN + Relay always work.

## 3. The Relay

A Relay is a small always-reachable server that the Hub and Clients each connect **out to**.
It forwards sealed messages between them when no direct path exists.

- **Purpose**: off-LAN reach, NAT traversal, and **push** wake-up on mobile.
- **Content-blind**: carries ciphertext + routing metadata only; stores nothing.
- **Protocol**: persistent outbound WebSocket/HTTPS; messages are
  XChaCha20-Poly1305 sealed to the recipient's device key.
- **Deployment**: self-hostable (a small VPS or container) and optionally offered as a hosted
  service. The user chooses in Hub settings.
- **Push**: integrates APNs (iOS) and FCM (Android) for wake-up and notifications.

### 3.1 Per-platform reachability

| Platform | Interactive path | Background wake |
| --- | --- | --- |
| Desktop (with `novad`) | LAN → Lattice → Relay | OS notification; no wake needed |
| Android | Lattice → Relay, plus optional persistent connection (foreground service) | FCM push; optional long-lived socket |
| iOS | Relay (or Lattice while foregrounded) | **APNs push only** (iOS suspends background tunnels) |
| Browser/PWA | Same as its host device | Web push where supported |

Policy: **Relay guarantees mobile**; Lattice is preferred for desktop and compute-node traffic.

## 4. Add Device

The Hub exposes **Add a Device** (Bridge → Devices). A device is added by scanning a QR code
or entering a short code.

### 4.1 Flow

```
Hub: Add a Device
  ├─ choose role: Client · Compute Node · Wake Helper
  ├─ choose scope: offline replica? local runtime? which capabilities?
  └─ shows QR + short code (single-use, TTL 5 min)

Device scans QR
  ├─ app absent → Hub bootstrap page (platform-detected):
  │     • iOS/Android: install app (store) or Add to Home Screen (PWA)
  │     • macOS/Win/Linux: download native shell, or open the PWA
  │     • headless / compute: show the one-line install command
  ├─ app present → deep link `nova://add-device?…`
  └─ both → handshake

Handshake
  1. Device generates a keypair and sends its public key + one-time code
  2. Hub shows a confirmation code; the device shows the same code
  3. User approves on the Hub (always required by default)
  4. Hub issues a device certificate + scoped token; the code is burned
```

### 4.2 Roles and scopes

- **Client** — UI access; optional offline replica; optional local runtime (if the device has
  models and the Hub grants it).
- **Compute Node** — registers capabilities and accepts Hub-authorized work.
- **Wake Helper** — allowed to send WoL packets to other devices on its LAN.

Scopes are chosen at add time and shown on the success screen; they can be edited later.

### 4.3 Bootstrap command (headless)

The Hub serves per-arch, **signed** `novad` binaries at `/api/v1/agent/dist/`. A typical
command (generalizing the prototype) is:

```bash
d=$(mktemp -d) && \
  case $(uname -m) in
    x86_64|amd64)  a=amd64; h=<sha256-amd64> ;;
    aarch64|arm64) a=arm64; h=<sha256-arm64> ;;
    *) echo "no build for $(uname -m)" >&2; a= ;;
  esac && \
  [ -n "$a" ] && \
  curl -fsSL -o "$d/novad" "https://<hub>/api/v1/agent/dist/novad-linux-$a" && \
  echo "$h  $d/novad" | sha256sum -c - && \
  chmod 0755 "$d/novad" && \
  "$d/novad" install --hub https://<hub> --code <PAIR-CODE>; s=$?; \
  rm -rf "$d"; [ "$s" -eq 0 ]
```

Enhancements over the prototype: **signature verification** (not just SHA-256), Hub TLS
pinning/fingerprint check, and a scripted `--role`/`--scope` selection.

### 4.4 Mobile behavior

On Android and iOS the app does as much as the OS allows: open the store listing if the app
is missing, otherwise deep-link into the app; if a PWA is acceptable, prompt to install it.
Full capabilities (files, screen, services) require the native app plus `novad` where
applicable.

### 4.5 Revocation and re-adding

- One-click **Revoke** on the Hub kills the device certificate and instructs the device to
  wipe its credentials.
- Re-adding requires a fresh code; revoked keys are blacklisted.
- Every add/revoke writes a **Flight recorder** entry.

## 5. Trust & HTTPS

Browser/PWA features (camera, mic, service workers, notifications) require a **secure
context**. Three supported paths, chosen in Hub settings during onboarding (H1):

| Path | How | Best for |
| --- | --- | --- |
| **Core local CA** | Hub generates a CA; Add Device installs the root cert on the device. | Fully private, LAN-only |
| **Lattice certificates** | Real TLS certs from the mesh (`*.ts.net` or your domain). | Remote + mobile |
| **Native shell pinning** | Native clients pin the Hub key. | Desktop, no CA install |

A device may use more than one path (e.g., LAN via local CA, remote via Lattice certs).

## 6. Network Setup (assistant)

Nova must be able to configure its own networking (L3). The assistant:

1. Detects existing VPNs, meshes, IP/subnet, and DNS state.
2. Offers to install and authenticate a chosen Lattice (Headscale / Tailscale / NetBird /
   WireGuard), with a **one-time consent** per change, then remembers the choice.
3. Applies tags/ACLs, MagicDNS names, subnet routes, and (optionally) an exit node.
4. Fetches/installs TLS certs, or provisions the Core CA.
5. Configures the Hub/Compute firewall and which ports listen.
6. Enrolls the Relay and verifies an off-LAN path.
7. Runs **reachability tests** (LAN, Lattice, Relay) and refuses to advertise a failing path.
8. Offers **one-click rollback**; must never lock the user out of their own Hub.

A **Network** panel shows active transports, latency, certificate status, ACL summary, Relay
status, and per-device reachability, with guided fixes for common failures.

## 7. Wake Helper (WoL)

Wake-on-LAN magic packets only cross a single LAN segment. To wake a sleeping device:

- The Hub uses a **Wake Helper** on the same LAN (a router, NAS, or another `novad` device).
- The Helper is an opt-in role granted during Add Device.
- Wake requires the target to have WoL enabled (Nova can set this via BIOS management where
  supported — `docs/23`) and to be on AC power (or battery policy allowing it).
- Wakes are logged and rate-limited.

## 8. Configuration model

```jsonc
// Hub settings → Network
{
  "transports": {
    "lan": { "enabled": true, "mdns": true },
    "lattice": { "enabled": true, "provider": "headscale", "controlUrl": "https://headscale.lan" },
    "relay":   { "enabled": true, "url": "wss://relay.arialabs.ai", "selfHosted": true },
    "directPublic": { "enabled": false }
  },
  "trust": { "mode": "local-ca", "latticeCerts": true, "pinNativeShells": true },
  "egress": { "allow": ["*.corp.example"], "deny": ["*"] },
  "wakeHelpers": ["device:<id>"]
}
```

Managed policy can restrict transports, require a specific provider, or force the Relay off.

## 9. Security requirements

1. Every transport is authenticated with device keys; no anonymous access.
2. Relay payloads are end-to-end encrypted; the Relay sees only routing metadata.
3. The Add Device code is single-use, short-lived, and rate-limited.
4. Joining always requires Hub-side confirmation (auto-approve off by default).
5. Transport changes are audited and reversible.
6. A compromised transport (e.g., revoked mesh key) can be disabled without data loss.
7. The Hub never advertises an endpoint that fails its own reachability test.

## 10. Failure & degradation

| Failure | Behavior |
| --- | --- |
| LAN down | Use Lattice; else Relay |
| Lattice down | Use LAN; else Relay |
| Relay down | LAN/Lattice continue; mobile loses background wake but resumes on reconnect |
| Cert expired | Native shells warn; Lattice path auto-renews; CA path prompts re-install |
| ACL misconfig | Reachability test fails; Nova refuses to advertise; rollback offered |
| Hub unreachable | Client local fallback (`docs/21` §9) |
