#!/usr/bin/env bash
set -Eeuo pipefail

MOMO_PACKAGE_MANIFEST_URL="https://momoapi.us/install/latest.json"
GITHUB_RELEASE_API="https://api.github.com/repos/momo-api/momoapi-codex-switch/releases/latest"
FALLBACK_PACKAGE_URL="https://momoapi.us/install/packages/momo-api-momoapi-codex-switch-2.29.17.tgz"
FALLBACK_PACKAGE_SHA256="e6a30b454fe432b63312428c0ec3514db6cfe0de60ae776a4a3951e5e29304c3"
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

package_version_from_url() {
  local url="$1"
  printf '%s' "$url" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const match = input.match(/(?:momo-api-)?momoapi-codex-switch-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz/);
      if (match) process.stdout.write(match[1]);
    });
  '
}

read_sha256_from_text() {
  node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const match = input.match(/\b([a-f0-9]{64})\b/i);
      if (match) process.stdout.write(match[1].toLowerCase());
    });
  '
}

installed_momo_version() {
  local listing
  listing="$(npm list --global --prefix "$NPM_PREFIX" --depth=0 --json "@momo-api/momoapi-codex-switch" 2>/dev/null || true)"
  printf '%s' "$listing" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const parsed = JSON.parse(input || "{}");
        const version = parsed.dependencies?.["@momo-api/momoapi-codex-switch"]?.version;
        if (version) process.stdout.write(version);
      } catch {}
    });
  '
}

resolve_momo_package_from_manifest() {
  local manifest_json manifest_candidate
  manifest_json="$(curl --fail --location --silent --show-error --max-time 30 -H "User-Agent: momoapi-codex-switch-installer" "$MOMO_PACKAGE_MANIFEST_URL" 2>/dev/null || true)"
  [[ -n "$manifest_json" ]] || return 1
  manifest_candidate="$(printf '%s' "$manifest_json" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const manifest = JSON.parse(input || "{}");
        const url = String(manifest.url || manifest.package_url || "").trim();
        const sha = String(manifest.sha256 || "").trim().toLowerCase();
        const version = String(manifest.version || "").replace(/^v/, "");
        if (!url || !/^[a-f0-9]{64}$/.test(sha)) return;
        process.stdout.write([url, sha, version].join("\t"));
      } catch {}
    });
  ')"
  [[ -n "$manifest_candidate" ]] || return 1
  IFS=$'\t' read -r PACKAGE_URL PACKAGE_SHA256 PACKAGE_VERSION <<< "$manifest_candidate"
  [[ -n "$PACKAGE_VERSION" ]] || PACKAGE_VERSION="$(package_version_from_url "$PACKAGE_URL")"
  PACKAGE_SOURCE="MOMO Cloudflare CDN"
}

resolve_momo_package_from_github() {
  local release_json candidate package_sha_url
  release_json="$(curl --fail --location --silent --show-error --max-time 30 -H "User-Agent: momoapi-codex-switch-installer" "$GITHUB_RELEASE_API" 2>/dev/null || true)"
  [[ -n "$release_json" ]] || return 1
  candidate="$(printf '%s' "$release_json" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const release = JSON.parse(input || "{}");
        const assets = Array.isArray(release.assets) ? release.assets : [];
        const re = /^momo-api-momoapi-codex-switch-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/;
        const asset = assets.find((item) => re.test(String(item.name || "")));
        if (!asset?.browser_download_url) return;
        const digest = String(asset.digest || "").match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase() || "";
        const shaAsset = assets.find((item) => String(item.name || "") === String(asset.name || "") + ".sha256") || assets.find((item) => /\.sha256$/i.test(String(item.name || "")));
        const version = String(asset.name).match(re)?.[1] || String(release.tag_name || "").replace(/^v/, "") || "";
        process.stdout.write([asset.browser_download_url, digest, shaAsset?.browser_download_url || "", version].join("\t"));
      } catch {}
    });
  ')"
  [[ -n "$candidate" ]] || return 1
  IFS=$'\t' read -r PACKAGE_URL PACKAGE_SHA256 package_sha_url PACKAGE_VERSION <<< "$candidate"
  if [[ -z "$PACKAGE_SHA256" && -n "$package_sha_url" ]]; then
    PACKAGE_SHA256="$(curl --fail --location --silent --show-error --max-time 30 "$package_sha_url" 2>/dev/null | read_sha256_from_text || true)"
  fi
  [[ -n "$PACKAGE_URL" && -n "$PACKAGE_SHA256" ]] || return 1
  PACKAGE_SOURCE="GitHub Release"
}

resolve_momo_package() {
  PACKAGE_URL=""
  PACKAGE_SHA256=""
  PACKAGE_VERSION=""
  PACKAGE_SOURCE=""

  if [[ -n "${MOMO_PACKAGE_URL:-}" ]]; then
    PACKAGE_URL="$MOMO_PACKAGE_URL"
    PACKAGE_SHA256="${MOMO_PACKAGE_SHA256:-}"
    PACKAGE_VERSION="$(package_version_from_url "$PACKAGE_URL")"
    PACKAGE_SOURCE="MOMO_PACKAGE_URL"
    return
  fi

  if resolve_momo_package_from_manifest; then return; fi
  say "Could not resolve the latest package from MOMO Cloudflare CDN. Trying GitHub Release."
  if resolve_momo_package_from_github; then return; fi
  say "Could not resolve the latest package from GitHub. Falling back to MOMO mirror."

  PACKAGE_URL="$FALLBACK_PACKAGE_URL"
  PACKAGE_SHA256="$FALLBACK_PACKAGE_SHA256"
  PACKAGE_VERSION="$(package_version_from_url "$FALLBACK_PACKAGE_URL")"
  PACKAGE_SOURCE="MOMO mirror fallback"
}

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

resolve_momo_package
installed_version="$(installed_momo_version)"
ocx="$NPM_PREFIX/bin/ocx"
if [[ -n "$PACKAGE_VERSION" && "$installed_version" = "$PACKAGE_VERSION" && -x "$ocx" ]]; then
  say "Local Switch runtime is already $installed_version from the latest package. Skipping download."
else
say "Downloading Switch package from $PACKAGE_SOURCE (about 4 MB)..."
curl --fail --location --silent --show-error --max-time 120 "$PACKAGE_URL" -o "$tmp_package"
if command -v sha256sum >/dev/null 2>&1; then
  actual_sha="$(sha256sum "$tmp_package" | awk '{print $1}')"
else
  actual_sha="$(shasum -a 256 "$tmp_package" | awk '{print $1}')"
fi
[[ "$actual_sha" = "$PACKAGE_SHA256" ]] || fail "MOMO Switch package integrity check failed."

say "Installing the local Switch runtime..."
npm install --global --prefix "$NPM_PREFIX" --omit=dev --allow-scripts=bun --registry "$NPM_REGISTRY" "$tmp_package"
fi
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
