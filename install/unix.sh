#!/usr/bin/env bash
set -Eeuo pipefail

PACKAGE_URL="https://momoapi.us/install/packages/momoapi-codex-switch-2.29.13.tgz"
PACKAGE_SHA256="17cb476588a4092c31b4f709151d1aff95ffbb67ea4a2e75f508406c89b3cb6f"
NPM_REGISTRY="${MOMO_NPM_REGISTRY:-https://registry.npmmirror.com}"
API_BASE_URL="https://momoapi.us/v1"
NPM_PREFIX="${MOMO_NPM_PREFIX:-$HOME/.local}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
INSTALL_CODEX_CLI=0

say() { printf '[momoapi-codex-switch] %s\n' "$*"; }
fail() { printf '[momoapi-codex-switch] Error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: curl -fsSL https://momoapi.us/install/momoapi-codex-switch.sh | bash

Options:
  --install-codex-cli  Install the official Codex CLI when it is not installed.
  --help               Show this help text.

The MOMOAPI Proxy itself is installed as a persistent user service. The Codex
CLI is optional: an existing Codex App can use this setup without it.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-codex-cli) INSTALL_CODEX_CLI=1 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1. Run with --help for usage." ;;
  esac
  shift
done

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

install_node() {
  if command -v node >/dev/null 2>&1; then return; fi

  case "$(uname -s)" in
    Darwin)
      command -v brew >/dev/null 2>&1 || fail "Node.js 18+ is required. Install Homebrew or Node.js from https://nodejs.org/, then run this command again."
      say "Installing Node.js with Homebrew..."
      brew install node
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        say "Installing Node.js with apt..."
        sudo apt-get update
        sudo apt-get install -y nodejs npm
      elif command -v dnf >/dev/null 2>&1; then
        say "Installing Node.js with dnf..."
        sudo dnf install -y nodejs npm
      elif command -v pacman >/dev/null 2>&1; then
        say "Installing Node.js with pacman..."
        sudo pacman -Sy --noconfirm nodejs npm
      else
        fail "Node.js 18+ is required. Install it from https://nodejs.org/, then run this command again."
      fi
      ;;
    *) fail "Unsupported operating system: $(uname -s)" ;;
  esac
}

install_node
require_command node
require_command npm
require_command curl

node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
[[ "$node_major" =~ ^[0-9]+$ ]] && (( node_major >= 18 )) || fail "Node.js 18+ is required; found $(node --version)."

mkdir -p "$NPM_PREFIX/bin" "$NPM_PREFIX/lib" "$CODEX_HOME"
export PATH="$NPM_PREFIX/bin:$PATH"

persist_path() {
  local profile="$1"
  local line='export PATH="$HOME/.local/bin:$PATH"'
  [[ "$NPM_PREFIX" = "$HOME/.local" ]] || return
  [[ -f "$profile" ]] || touch "$profile"
  grep -Fqx "$line" "$profile" || printf '\n%s\n' "$line" >> "$profile"
}

case "$(uname -s)" in
  Darwin) persist_path "$HOME/.zshrc" ;;
  Linux) persist_path "$HOME/.bashrc" ;;
esac

if [[ -n "${MOMO_API_KEY:-}" ]]; then
  api_key="$MOMO_API_KEY"
elif [[ -t 0 ]]; then
  read -r -s -p "Enter your MOMO API key: " api_key
  printf '\n'
else
  fail "Set MOMO_API_KEY or run this installer in an interactive terminal."
fi
[[ -n "$api_key" ]] || fail "A MOMO API key is required."

say "Checking MOMO API key..."
models="$(curl --fail --silent --show-error --max-time 30 -H "Authorization: Bearer $api_key" "$API_BASE_URL/models")" || fail "MOMO API key validation failed. Check the key and network connection."
[[ "$models" == *'"data"'* ]] || fail "MOMO API key validation returned an unexpected model catalog."

tmp_package="$(mktemp "${TMPDIR:-/tmp}/momoapi-codex-switch.XXXXXX.tgz")"
cleanup() { rm -f "$tmp_package"; unset MOMO_API_KEY api_key; }
trap cleanup EXIT

say "Downloading MOMO-hosted Switch package (about 4 MB)..."
curl --fail --location --silent --show-error --max-time 120 "$PACKAGE_URL" -o "$tmp_package"
if command -v sha256sum >/dev/null 2>&1; then
  actual_sha="$(sha256sum "$tmp_package" | awk '{print $1}')"
else
  actual_sha="$(shasum -a 256 "$tmp_package" | awk '{print $1}')"
fi
[[ "$actual_sha" = "$PACKAGE_SHA256" ]] || fail "MOMO Switch package integrity check failed."

say "Installing the local Switch runtime..."
npm install --global --prefix "$NPM_PREFIX" --omit=dev --allow-scripts=bun --registry "$NPM_REGISTRY" "$tmp_package"
ocx="$NPM_PREFIX/bin/ocx"
[[ -x "$ocx" ]] || fail "MOMO Switch installed, but its ocx launcher was not found."

if ! command -v codex >/dev/null 2>&1 && [[ ! -x "$NPM_PREFIX/bin/codex" ]]; then
  if (( INSTALL_CODEX_CLI )); then
    say "Installing the official Codex CLI..."
    npm install --global --prefix "$NPM_PREFIX" --registry "$NPM_REGISTRY" @openai/codex
  else
    say "Codex CLI was not found. Skipping its download; the existing Codex App can use this setup."
    say "To install the CLI separately, re-run this installer with --install-codex-cli."
  fi
fi

[[ -f "$CODEX_HOME/config.toml" ]] || : > "$CODEX_HOME/config.toml"
export MOMO_API_KEY="$api_key"
export CODEX_HOME

say "Configuring MOMO model routes..."
"$ocx" momo setup --set-default

say "Starting the local Switch service..."
if ! "$ocx" service install; then
  case "$(uname -s)" in
    Linux)
      fail "Could not register the persistent MOMOAPI Proxy service. Linux/WSL needs systemd user services. In WSL, enable systemd in /etc/wsl.conf ([boot] systemd=true), run 'wsl --shutdown' from Windows, reopen the distro, then run this installer again."
      ;;
    Darwin)
      fail "Could not register the persistent MOMOAPI Proxy service with launchd. Run the installer from a logged-in macOS user session and try again."
      ;;
    *) fail "Could not register the persistent MOMOAPI Proxy service." ;;
  esac
fi

for _ in $(seq 1 40); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:10100/healthz >/dev/null \
    && curl --fail --silent --max-time 2 http://127.0.0.1:10101/v1/models >/dev/null; then
    break
  fi
  sleep 0.5
done
curl --fail --silent --max-time 2 http://127.0.0.1:10100/healthz >/dev/null || fail "The local Switch did not start. Check ~/.opencodex/service.log."

say "Syncing the MOMO model catalog to Codex..."
"$ocx" sync
say "Installing the Codex on-demand startup shim..."
"$ocx" codex-shim install
say "Running diagnostics..."
"$ocx" doctor

printf '\nMOMOAPI Proxy is ready. Restart Codex, then select a routed MOMO model in /model.\n'
