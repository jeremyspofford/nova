# Screenpipe Setup

[Screenpipe](https://screenpi.pe/) is an open-source background daemon that records and indexes
everything happening on your workstation — active window titles, on-screen text (OCR), and audio
transcriptions — and exposes it over a local HTTP API.

Nova uses screenpipe as the substrate for its Personal Context Layer (PCL, sub-project 1 of the
Personal Context Layer roadmap). The screenpipe-bridge service polls screenpipe's LAN API, enriches
raw sessions with embeddings, and surfaces them through Nova's `/capture` feed and memory system.
This gives Nova's agents ambient awareness of your recent work without you manually feeding it
context.

---

## Install screenpipe

### macOS

```bash
brew tap mediar-ai/screenpipe
brew install screenpipe
```

Works on both Apple Silicon (arm64) and Intel (x86_64). The brew formula pulls the correct binary
for your architecture.

If you prefer a GUI installer, download from [screenpi.pe](https://screenpi.pe/).

### Windows

Windows 10 and 11 are supported. Download the `.exe` installer from
[screenpi.pe](https://screenpi.pe/) and run it. The installer registers screenpipe as a user-level
startup service.

### Linux

Linux is supported but requires building from source. Follow the canonical instructions in the
[screenpipe GitHub repository](https://github.com/mediar-ai/screenpipe) — the build steps change
frequently enough that duplicating them here would go stale.

---

## Configure screenpipe

Screenpipe reads its config from `~/.screenpipe/screenpipe.config.json` on all platforms.
Create or edit that file:

```json
{
  "exclude_apps": [
    "1Password",
    "1Password 7 - Password Manager",
    "Bitwarden",
    "KeePassXC",
    "Keeper Password Manager",
    "LastPass"
  ],
  "listen_on_lan": true,
  "api_key": "REPLACE_WITH_RANDOM_STRING",
  "analytics_enabled": false
}
```

**Config file locations by OS:**

| OS | Path |
|----|------|
| macOS | `~/.screenpipe/screenpipe.config.json` |
| Windows | `%USERPROFILE%\.screenpipe\screenpipe.config.json` |
| Linux | `~/.screenpipe/screenpipe.config.json` |

### Generate an API key

```bash
openssl rand -hex 32
```

Paste the output into the `api_key` field. You'll enter the same value in Nova's dashboard.

### Privacy: disable analytics

Screenpipe ships with PostHog telemetry enabled by default. The `"analytics_enabled": false` field
in the config above disables it. This takes effect on the next screenpipe restart.

---

## Enable LAN listening

`"listen_on_lan": true` is required for Nova's bridge to reach screenpipe from a Docker container.
Without it, the screenpipe API binds only to `127.0.0.1` and the bridge cannot connect.

After editing the config, restart screenpipe. On macOS with brew services:

```bash
brew services restart screenpipe
```

On Windows: right-click the screenpipe system tray icon → Restart, or kill and relaunch the
process.

**Important:** LAN listening must be set before screenpipe starts. If you set it while screenpipe
is already running, it won't take effect until you restart it.

---

## macOS: accessibility permissions

Screenpipe reads on-screen text via the macOS Accessibility API. You must grant permission:

1. **System Settings** → **Privacy & Security** → **Accessibility**
2. Find screenpipe in the list and toggle it on

Without this, screenpipe captures window titles but no text content, and audio transcription still
works. Accessibility permission is required for OCR to function.

---

## Configure Nova

1. Open the Nova dashboard
2. Go to **Settings** → **Connections** → **Screenpipe**
3. Set the URL to `http://<workstation-ip>:3030`
   - Use the LAN IP of the machine running screenpipe, not `localhost`
   - To find your IP on macOS/Linux: `ip route get 1 | awk '{print $NF; exit}'`
   - On Windows: `ipconfig` → look for your IPv4 address
4. Paste the API key from `screenpipe.config.json`
5. Click **Test Connection** and confirm "Connected" status
6. Toggle **Enabled**

Nova's bridge polls screenpipe every 30 seconds and indexes new sessions automatically.

---

## Verify it's working

1. Navigate to `/capture` in the Nova dashboard
2. Use your workstation normally for a few minutes — switch apps, browse, type
3. Sessions should appear in the activity feed within ~30 seconds of each screenpipe recording

Each entry shows the source app, window title, duration, and a snippet of captured text.

---

## Privacy notes

- **Active window only.** Screenpipe does not take periodic screenshots. It reads structured text
  through accessibility APIs and OCR on the current window. No image files are stored in Nova.
- **Layer 1 denylist** (configured above) excludes password managers at the screenpipe level.
  Matching apps are never recorded in the first place.
- **Layer 2 denylist** is editable in Nova at **Settings** → **Capture** → **Privacy**. Add
  additional app names, URL patterns, or window title substrings to filter from ingestion.
- **Filtered = invisible.** Denied sessions leave no trace in Nova's memory or activity feed —
  they are dropped before storage.
- **Pause capture** from the `/capture` page or **Settings** → **Capture** → **Advanced**.
  Pausing stops the bridge from polling; screenpipe itself keeps recording locally.
- **Session aggregation:** Nova groups raw screenpipe events into sessions capped at 30 minutes.
  Events shorter than 30 seconds are discarded as noise.

---

## Troubleshooting

**Bridge can't connect to screenpipe**

Check that:
1. Screenpipe is running on the workstation (`screenpipe --version` or check the system tray)
2. `listen_on_lan: true` is set and screenpipe was restarted after the change
3. Port 3030 is open on the workstation's firewall
   - macOS: **System Settings** → **Network** → **Firewall** → check inbound rules
   - Windows: **Windows Defender Firewall** → add an inbound rule for port 3030
   - Linux: `sudo ufw allow 3030` (or equivalent for your distro)
4. Nova's bridge URL uses the workstation's LAN IP, not `localhost`

**No sessions appearing in /capture**

1. Run **Test Connection** in Settings → Connections → Screenpipe first — confirm it shows "Connected"
2. Check the screenpipe-bridge health: `curl http://localhost:3035/health/ready`
3. Check bridge logs:
   ```bash
   docker compose logs --tail=50 screenpipe-bridge
   ```
4. Confirm screenpipe is actually recording — the screenpipe desktop app or tray icon will show
   recording status

**`/screenpipe-api/health/ready` returns an error**

This endpoint proxies to screenpipe's own health check. If it returns an error but the bridge
shows "Connected", screenpipe is running but may be in an initializing state. Wait 30 seconds and
retry.

**macOS: no text content in sessions (only window titles)**

Accessibility permission is not granted. See [macOS: accessibility permissions](#macos-accessibility-permissions) above.
