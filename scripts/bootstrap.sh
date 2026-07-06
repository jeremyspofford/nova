#!/usr/bin/env bash
# Nova AI Platform — Bootstrap Script
# Clones the Nova repo and (if running on a TTY) launches the install wizard.
# Designed to be run via curl-pipe-bash for "one command" demo installs:
#
#   curl -fsSL https://raw.githubusercontent.com/arialabs/nova/main/scripts/bootstrap.sh | bash
#
set -euo pipefail

REPO_URL="${NOVA_REPO_URL:-https://github.com/arialabs/nova.git}"
NOVA_DIR="${NOVA_DIR:-nova}"

usage() {
  cat <<USAGE
Nova AI Platform — Bootstrap

Clones the Nova repo from GitHub and (when run on an interactive
terminal) launches the install wizard so a single command takes you
from "no Nova" to "wizard prompting for inference mode."

Typical use:
  curl -fsSL https://raw.githubusercontent.com/arialabs/nova/main/scripts/bootstrap.sh | bash
  bash scripts/bootstrap.sh

Environment:
  NOVA_DIR        Directory to clone into (default: ./nova). If it
                  already exists, the script aborts.
  NOVA_REPO_URL   Repo URL to clone from (default: official GitHub repo).

Options:
  --no-install    Clone only; print the next-step command instead of
                  launching the wizard.
  --help, -h      Show this help and exit.
USAGE
}

NO_INSTALL=false
for arg in "$@"; do
  case "$arg" in
    --no-install)    NO_INSTALL=true ;;
    --help|-h|-help) usage; exit 0 ;;
    *)               echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# ── Color helpers (only when stdout is a TTY) ────────────────────────────────
if [ -t 1 ]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BOLD=""; DIM=""; RESET=""
fi

step() { echo "${BOLD}$*${RESET}"; }
ok()   { echo "  ${GREEN}✓${RESET} $*"; }
warn() { echo "  ${YELLOW}⚠${RESET} $*"; }
fail() { echo "  ${RED}✗${RESET} $*" >&2; }

# ── Prereq checks ────────────────────────────────────────────────────────────
step "Checking prerequisites..."

if ! command -v git >/dev/null 2>&1; then
  fail "git is required but not installed."
  echo "    Install git from your package manager, then re-run."
  exit 1
fi
ok "git"

if ! command -v docker >/dev/null 2>&1; then
  fail "Docker is required but not installed."
  echo "    Install Docker Desktop: https://docker.com/products/docker-desktop"
  exit 1
fi
ok "docker"

if ! docker info >/dev/null 2>&1; then
  warn "Docker is installed but the daemon isn't responding."
  warn "  The install wizard will surface a clearer error — continuing."
fi

# ── Clone target ─────────────────────────────────────────────────────────────
if [ -d "$NOVA_DIR" ]; then
  fail "${NOVA_DIR} already exists."
  echo "    Either delete it (${BOLD}rm -rf ${NOVA_DIR}${RESET})"
  echo "    or set NOVA_DIR=<path> to clone elsewhere:"
  echo "      ${DIM}NOVA_DIR=nova-fresh bash scripts/bootstrap.sh${RESET}"
  exit 1
fi

step "Cloning Nova into ${NOVA_DIR}/..."
git clone --depth 1 "$REPO_URL" "$NOVA_DIR"
ok "Clone complete"

# ── Hand off to ./install ────────────────────────────────────────────────────
echo

if [ "$NO_INSTALL" = "true" ]; then
  step "Bootstrap done."
  echo "  Run the install wizard: ${BOLD}cd ${NOVA_DIR} && ./install${RESET}"
  exit 0
fi

# When piped via curl | bash, stdin is the script body, so the wizard's
# `read` calls would see EOF. Re-attach to /dev/tty if it exists; otherwise
# print the next-step command and exit so the user can run it themselves.
if [ -c /dev/tty ]; then
  step "Launching install wizard..."
  echo
  cd "$NOVA_DIR" && exec ./install < /dev/tty
else
  step "No TTY detected — clone done."
  echo "  Finish manually: ${BOLD}cd ${NOVA_DIR} && ./install${RESET}"
fi
