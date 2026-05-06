---
title: "Remote Access"
description: "Access your Nova instance from anywhere via Cloudflare Tunnel or Tailscale."
---

Nova includes built-in support for remote access through two methods: **Cloudflare Tunnel** for public internet access, and **Tailscale** for private mesh networking. Both are configured through a guided wizard in the Dashboard's Remote Access page.

## Cloudflare Tunnel

Cloudflare Tunnel creates a secure, outbound-only connection from your Nova instance to Cloudflare's network, making Nova accessible via a custom domain without opening any ports on your firewall.

### What it provisions

The Dashboard wizard handles the entire setup:

1. **Verifies your API token** -- validates the token has the required permissions
2. **Selects account and zone** -- choose which Cloudflare account and domain to use
3. **Creates a tunnel** -- provisions a named Cloudflare Tunnel (e.g., `nova-<subdomain>`)
4. **Configures routing** -- sets up the tunnel to route traffic to Nova's services
5. **Creates DNS record** -- adds a CNAME record pointing `<subdomain>.<domain>` to the tunnel
6. **Saves credentials** -- stores the tunnel token in Nova's `.env` file
7. **Enables authentication** -- sets `REQUIRE_AUTH=true` and `TRUSTED_PROXY_HEADER=CF-Connecting-IP` so public traffic requires login while LAN/Tailscale traffic bypasses auth automatically
8. **Starts the container** -- launches the `cloudflared` container via Docker Compose profiles

### Prerequisites

- A Cloudflare account with at least one domain (zone)
- A Cloudflare API token with these permissions:
  - `Account: Cloudflare Tunnel: Edit`
  - `Zone: DNS: Edit`

Create a token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens).

### Key benefit for Telegram

Cloudflare Tunnel enables **webhook mode** for Telegram integration. Instead of polling Telegram servers repeatedly, Telegram pushes messages directly to your tunnel URL. This is faster, uses less bandwidth, and keeps your bot responsive. Without a public URL, you're limited to polling mode (check every 30–60 seconds).

### Trade-offs

- **Pro:** Free tier is sufficient, no additional device setup needed, webhooks for instant Telegram updates
- **Con:** Traffic routes through Cloudflare's network (though still encrypted end-to-end)

### Setup

1. Navigate to **Remote Access** in the Dashboard sidebar
2. Select the **Cloudflare Tunnel** tab
3. Enter your Cloudflare API token and click **Verify & Continue**
4. Select your account and zone (domain)
5. Choose a subdomain (e.g., `nova` for `nova.yourdomain.com`)
6. Click **Create Tunnel**

The wizard provisions everything automatically. Once complete, Nova is accessible at `https://<subdomain>.<domain>`.

### Disconnecting

Click **Disconnect Tunnel** on the Remote Access page. This stops the `cloudflared` container and removes the tunnel token from `.env`.

## Tailscale

Tailscale connects Nova to your personal tailnet using WireGuard-based mesh networking. Your Nova instance becomes accessible from any device on your tailnet via MagicDNS.

### What it provisions

1. **Creates an auth key** -- uses the Tailscale API to generate a pre-authorized, reusable auth key
2. **Saves the key** -- stores `TAILSCALE_AUTHKEY` in Nova's `.env` file
3. **Starts the container** -- launches the Tailscale container via Docker Compose profiles

### Prerequisites

- A Tailscale account
- A Tailscale API key with permission to create auth keys (create at [login.tailscale.com/admin/settings/keys](https://login.tailscale.com/admin/settings/keys))

### Key limitation for Telegram

Tailscale creates a private mesh network, so Telegram's servers cannot reach your tunnel URL for webhooks. You must use **polling mode**, where Nova checks Telegram for new messages every 30–60 seconds. This is slower but still functional for personal use.

### Trade-offs

- **Pro:** Private by default, no public exposure, direct fast access from your devices, no login required
- **Con:** Need Tailscale client on every device, can't share access without inviting to tailnet, Telegram polling only (not webhooks)

### Setup

1. Navigate to **Remote Access** in the Dashboard sidebar
2. Select the **Tailscale** tab
3. Enter your Tailscale API key
4. Click **Connect to Tailnet**

Once connected, Nova is available on your tailnet as `nova` via MagicDNS.

### Disconnecting

Click **Disconnect Tailscale** on the Remote Access page. This stops the Tailscale container and removes the auth key from `.env`.

## Choosing between them

| Goal | Recommendation |
|------|-----------------|
| **Privacy first** — only access from your own devices | Tailscale only (no public exposure, no login needed) |
| **Telegram webhooks** — instant bot responsiveness | Cloudflare Tunnel (enables webhook mode) |
| **Convenience** — access from anywhere without VPN | Cloudflare Tunnel |
| **Both worlds** — fast private access + Telegram webhooks | Run both simultaneously (see below) |

## Dual access: Cloudflare Tunnel + Tailscale

You can run both simultaneously. Nova uses **trusted networks** to automatically determine which requests need authentication:

- **Tailscale / LAN / localhost** — private IP ranges are trusted, no login required
- **Cloudflare Tunnel (public internet)** — real client IP extracted via `CF-Connecting-IP` header, login required

The Cloudflare Tunnel wizard configures this automatically. When you provision a tunnel, it sets `REQUIRE_AUTH=true` and `TRUSTED_PROXY_HEADER=CF-Connecting-IP` in your `.env`. The trusted network middleware inspects each request's source IP against configurable CIDR ranges (default: RFC1918, Tailscale CGNAT, localhost) and bypasses auth for trusted IPs.

You can customize trusted CIDRs in **Settings → System → Trusted Networks**.

## Tailscale-only access (recommended for self-hosted)

If you only access Nova from your own devices, Tailscale alone provides all the security you need — no login screen, no passwords, no email codes. Tailscale authenticates every device on your tailnet via WireGuard, so if someone can reach Nova, they're already trusted.

### Setup

1. **Disable any public exposure** — if you previously set up a Cloudflare Tunnel (either through the Dashboard wizard or as a system service), disable it:
   ```bash
   # If running as a systemd service
   sudo systemctl stop cloudflared
   sudo systemctl disable cloudflared

   # If running via Docker Compose profile
   # Use the Dashboard Remote Access page to disconnect, or remove
   # CLOUDFLARE_TUNNEL_TOKEN from .env and restart
   ```

2. **Set `REQUIRE_AUTH=false`** in your `.env` — Tailscale is your auth layer, so application-level auth is unnecessary. (Or leave `REQUIRE_AUTH=true` — trusted networks will bypass auth for Tailscale IPs automatically.)

3. **Access via Tailscale IP or MagicDNS** — reach Nova at `http://<tailscale-ip>:3000` or `http://mini-pc:3000` (if MagicDNS is enabled).

### Custom domain on Tailscale

You can point a custom domain (e.g., `nova.yourdomain.com`) to your Tailscale IP for a nicer URL:

1. In your DNS provider (e.g., Cloudflare), create an A record:
   - **Name:** `nova`
   - **Content:** your Tailscale IPv4 (from `tailscale ip -4`, typically `100.x.x.x`)
   - **Proxy:** OFF (DNS only / gray cloud in Cloudflare)
2. Access Nova at `http://nova.yourdomain.com:3000`

Since Tailscale IPs (`100.x.x.x`) are not routable on the public internet, only devices on your tailnet can reach this address. Anyone else gets a connection timeout.

### HTTPS

Your browser will show a "not secure" warning over plain HTTP. The connection is actually encrypted by Tailscale's WireGuard tunnel — your browser just can't see that.

To get a green padlock:
- **Using `.ts.net` domain:** Run `tailscale cert your-host.your-tailnet.ts.net` on the Nova host to get a real TLS certificate. Then configure Nova's reverse proxy to use it. This only works for `.ts.net` domains.
- **Using a custom domain:** Requires a reverse proxy (e.g., Caddy, nginx) with a certificate. Since the domain isn't publicly reachable, you'd need DNS-01 ACME validation (supported by Caddy with Cloudflare DNS plugin) or a self-signed cert.

For most self-hosted setups, plain HTTP over Tailscale is fine — the traffic is already encrypted.

### When to use Cloudflare Tunnel instead

Use Cloudflare Tunnel when you need Nova accessible to people **not** on your tailnet — for demos, multi-tenant SaaS, or shared access. The tunnel wizard automatically enables auth for public traffic while keeping Tailscale access auth-free.

## Privacy note

Both wizards run entirely in the browser. API tokens are used client-side to call the Cloudflare or Tailscale APIs directly -- they are never sent to Nova's backend. Only the resulting credentials (tunnel token or auth key) are stored in Nova's `.env` file.

## Technical details

Both remote access methods use Docker Compose profiles managed by the [Recovery Service](/nova/docs/services/recovery/). The profiles are:

| Profile | Container | Purpose |
|---------|-----------|---------|
| `cloudflare-tunnel` | `cloudflared` | Runs the Cloudflare Tunnel daemon |
| `tailscale` | `tailscale` | Runs the Tailscale client |

These containers are only started when explicitly enabled through the wizard or by manually adding the profile to `COMPOSE_PROFILES` in your `.env` file.
