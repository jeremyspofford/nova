-- 015: Seed platform_config with trusted network settings
-- SEC2 (2026-07-06): fresh installs trust loopback only. LAN/Tailscale
-- trust is an explicit opt-in, and network position never grants admin.
INSERT INTO platform_config (key, value, description, is_secret)
VALUES
  ('trusted_networks', '"127.0.0.0/8,::1/128"',
   'Comma-separated CIDRs whose requests skip USER-surface auth (dashboard viewing/chat). Admin endpoints always require credentials. Add private ranges (e.g. 192.168.0.0/16) or Tailscale CGNAT (100.64.0.0/10) to opt in. Empty disables.', false),
  ('trusted_proxy_header', '""',
   'HTTP header containing real client IP when behind a reverse proxy (e.g. CF-Connecting-IP, X-Real-IP). Leave empty if not behind a proxy.', false)
ON CONFLICT (key) DO NOTHING;
