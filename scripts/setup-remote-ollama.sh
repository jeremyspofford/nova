#!/usr/bin/env bash
# Nova AI Platform — Remote Ollama Setup
# Run this ON your GPU machine to prepare it as a remote AI inference server.
set -euo pipefail

usage() {
  cat <<USAGE
Nova Remote Ollama Setup

Run this ON the GPU machine you want Nova to use as a remote inference
server. The script installs Ollama (if missing), configures it to listen
on all interfaces (so Nova can reach it across the LAN), pulls Nova's
default models, and prints the URL to paste into Nova's Settings →
AI & Models → External target.

Usage:
  curl -fsSL https://raw.githubusercontent.com/arialabs/nova/main/scripts/setup-remote-ollama.sh | bash
  bash ./scripts/setup-remote-ollama.sh

Options:
  --help, -h     Show this help message and exit
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --help|-h|-help) usage; exit 0 ;;
  esac
done

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
warn() { printf "  ${YELLOW}!${RESET} %s\n" "$1"; }
fail() { printf "  ${RED}✗${RESET} %s\n" "$1"; }

echo ""
printf "${BOLD}═══════════════════════════════════════════════════${RESET}\n"
printf "${BOLD}  Nova — Remote Ollama Setup${RESET}\n"
printf "${BOLD}═══════════════════════════════════════════════════${RESET}\n"
echo ""

# ── Step 1: Install Ollama ────────────────────────────────────────────────────
if command -v ollama >/dev/null 2>&1; then
  ver="$(ollama --version 2>/dev/null || echo "unknown")"
  ok "Ollama already installed (${ver})"
else
  echo "Installing Ollama..."
  curl -fsSL https://ollama.com/install.sh | sh
  ok "Ollama installed"
fi

# ── Step 2: Configure LAN listening ──────────────────────────────────────────
echo ""
echo "Configuring Ollama to listen on all interfaces..."

OVERRIDE_DIR="/etc/systemd/system/ollama.service.d"
OVERRIDE_FILE="${OVERRIDE_DIR}/lan.conf"

if [ -d /etc/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  sudo mkdir -p "${OVERRIDE_DIR}"
  sudo tee "${OVERRIDE_FILE}" > /dev/null <<EOF
[Service]
Environment="OLLAMA_HOST=0.0.0.0"
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now ollama
  ok "Ollama listening on 0.0.0.0:11434 (systemd)"
else
  warn "systemd not found — set OLLAMA_HOST=0.0.0.0 in your environment manually"
  export OLLAMA_HOST=0.0.0.0
  if ! pgrep -x ollama >/dev/null 2>&1; then
    nohup ollama serve > /tmp/ollama.log 2>&1 &
    sleep 2
  fi
  ok "Ollama started manually (OLLAMA_HOST=0.0.0.0)"
fi

# Wait for Ollama to be ready
echo ""
echo "Waiting for Ollama to be ready..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
  fail "Ollama did not start within 30s"
  echo "  Check: journalctl -u ollama -f"
  exit 1
fi
ok "Ollama is running"

# ── Step 3: Pull required models ─────────────────────────────────────────────
echo ""
echo "Pulling required models (this may take a while on first run)..."

for model in nomic-embed-text llama3.2; do
  echo ""
  echo "  Pulling ${model}..."
  ollama pull "${model}" || warn "Failed to pull ${model}"
done
echo ""
ok "Models ready"

# ── Step 4: Detect network info ──────────────────────────────────────────────
echo ""

# Find the primary network interface and its IP/MAC
IFACE=""
IP_ADDR=""
MAC_ADDR=""

if command -v ip >/dev/null 2>&1; then
  # Linux with iproute2
  IFACE="$(ip route get 1.1.1.1 2>/dev/null | head -1 | sed 's/.*dev \([^ ]*\).*/\1/')"
  if [ -n "${IFACE}" ]; then
    IP_ADDR="$(ip -4 addr show "${IFACE}" 2>/dev/null | grep -oP 'inet \K[0-9.]+' | head -1)"
    MAC_ADDR="$(ip link show "${IFACE}" 2>/dev/null | grep -oP 'link/ether \K[0-9a-f:]+' | head -1)"
  fi
fi

# Fallback
if [ -z "${IP_ADDR}" ]; then
  IP_ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
if [ -z "${MAC_ADDR}" ] && [ -n "${IFACE}" ]; then
  MAC_ADDR="$(cat "/sys/class/net/${IFACE}/address" 2>/dev/null || echo "")"
fi

# ── Step 5: Optional Wake-on-LAN ─────────────────────────────────────────────
echo ""
printf "${BOLD}Enable Wake-on-LAN?${RESET} (allows Nova to wake this machine remotely)\n"
printf "Enable? [y/N]: "
read -r wol_choice

case "$(echo "${wol_choice}" | tr 'A-Z' 'a-z')" in
  y|yes)
    if [ -z "${IFACE}" ]; then
      warn "Could not detect network interface. Enable WoL manually."
    elif command -v ethtool >/dev/null 2>&1; then
      sudo ethtool -s "${IFACE}" wol g 2>/dev/null && ok "WoL enabled on ${IFACE}" || warn "ethtool failed — enable WoL in BIOS"

      # Persist via networkd drop-in if available
      if [ -d /etc/systemd/network ]; then
        WOL_CONF="/etc/systemd/network/50-wol.link"
        if [ ! -f "${WOL_CONF}" ]; then
          sudo tee "${WOL_CONF}" > /dev/null <<EOF
[Match]
MACAddress=${MAC_ADDR}

[Link]
WakeOnLan=magic
EOF
          ok "WoL persisted via systemd-networkd"
        fi
      elif command -v nmcli >/dev/null 2>&1; then
        # Try NetworkManager
        nm_conn="$(nmcli -t -f NAME,DEVICE con show --active 2>/dev/null | grep ":${IFACE}$" | cut -d: -f1)"
        if [ -n "${nm_conn}" ]; then
          nmcli con modify "${nm_conn}" 802-3-ethernet.wake-on-lan magic 2>/dev/null && \
            ok "WoL persisted via NetworkManager" || warn "nmcli failed"
        fi
      else
        warn "WoL enabled for this session. Add 'ethtool -s ${IFACE} wol g' to a startup script to persist."
      fi
    else
      warn "ethtool not found. Install it: sudo apt install ethtool"
    fi
    ;;
esac

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo ""
printf "${BOLD}═══════════════════════════════════════════════════${RESET}\n"
printf "${BOLD}  Your GPU box is ready!${RESET}\n"
printf "${BOLD}═══════════════════════════════════════════════════${RESET}\n"
echo ""
echo "  Enter these in Nova setup on your main machine:"
echo ""
if [ -n "${IP_ADDR}" ]; then
  printf "  IP:   ${BOLD}%s${RESET}\n" "${IP_ADDR}"
fi
if [ -n "${MAC_ADDR}" ]; then
  printf "  MAC:  ${BOLD}%s${RESET}\n" "${MAC_ADDR}"
fi
echo ""
echo "  Test from Nova machine:  curl http://${IP_ADDR:-<this-ip>}:11434/api/tags"
echo ""
