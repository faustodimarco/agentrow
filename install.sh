#!/bin/sh
# agentrow installer for macOS and Linux (and WSL).
#   curl -fsSL https://raw.githubusercontent.com/faustodimarco/agentrow/main/install.sh | sh
# Optional: $GITHUB_TOKEN / $GH_TOKEN / `gh auth token` is used when present (higher API rate limit).
# Options (env): AGENTROW_VERSION=v0.1.0  AGENTROW_INSTALL_DIR=~/.local/bin  AGENTROW_REPO=owner/repo
set -eu

REPO="${AGENTROW_REPO:-faustodimarco/agentrow}"
VERSION="${AGENTROW_VERSION:-latest}"
INSTALL_DIR="${AGENTROW_INSTALL_DIR:-$HOME/.local/bin}"

err() {
  echo "agentrow install: $*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || err "curl is required"
command -v tar >/dev/null 2>&1 || err "tar is required"

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) err "unsupported OS $os (on Windows use install.ps1)" ;;
esac
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) err "unsupported architecture $arch" ;;
esac
# An x64 shell under Rosetta on Apple silicon should still get the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  arch=arm64
fi
asset="agentrow-$os-$arch.tar.gz"

token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [ -z "$token" ] && command -v gh >/dev/null 2>&1; then
  token=$(gh auth token 2>/dev/null || true)
fi

fetch() {
  if [ -n "$token" ]; then
    curl -fsSL -H "Authorization: Bearer $token" "$@"
  else
    curl -fsSL "$@"
  fi
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ "$VERSION" = latest ]; then
  release_url="https://api.github.com/repos/$REPO/releases/latest"
else
  release_url="https://api.github.com/repos/$REPO/releases/tags/$VERSION"
fi
fetch -H "Accept: application/vnd.github+json" "$release_url" -o "$tmp/release.json" ||
  err "cannot read release $VERSION of $REPO (private repo? log in with \`gh auth login\` or set GITHUB_TOKEN)"

# API url of a named asset; works for private repos (browser_download_url does not accept tokens).
asset_api_url() {
  tr -d '\n' <"$tmp/release.json" |
    grep -o '"url": *"[^"]*/releases/assets/[0-9]*"[^}]*"name": *"[^"]*"' |
    grep "\"name\": *\"$1\"" |
    grep -o 'https://[^"]*/releases/assets/[0-9]*' |
    head -n 1
}

tag=$(grep -o '"tag_name": *"[^"]*"' "$tmp/release.json" | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')
url=$(asset_api_url "$asset")
[ -n "$url" ] || err "release $tag has no $asset"
sums_url=$(asset_api_url SHA256SUMS)

echo "Downloading agentrow $tag ($os-$arch)…"
fetch -H "Accept: application/octet-stream" "$url" -o "$tmp/$asset"
if [ -n "$sums_url" ]; then
  fetch -H "Accept: application/octet-stream" "$sums_url" -o "$tmp/SHA256SUMS"
  expected=$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$tmp/$asset" | cut -d' ' -f1)
  else
    actual=$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)
  fi
  [ "$expected" = "$actual" ] || err "checksum mismatch for $asset"
fi

tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$INSTALL_DIR"
was_running=false
if [ -x "$INSTALL_DIR/agentrow" ] && "$INSTALL_DIR/agentrow" status 2>/dev/null | grep -q "daemon: running"; then
  was_running=true
  "$INSTALL_DIR/agentrow" stop >/dev/null 2>&1 || true
fi
mv "$tmp/agentrow" "$INSTALL_DIR/agentrow"
chmod +x "$INSTALL_DIR/agentrow"
if [ "$was_running" = true ]; then
  "$INSTALL_DIR/agentrow" start >/dev/null && echo "Restarted the running daemon on the new version."
fi

echo "✓ agentrow $("$INSTALL_DIR/agentrow" --version) installed to $INSTALL_DIR/agentrow"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    shell_rc="$HOME/.profile"
    case "${SHELL:-}" in
      */zsh) shell_rc="$HOME/.zshrc" ;;
      */bash) shell_rc="$HOME/.bashrc" ;;
    esac
    echo
    echo "$INSTALL_DIR is not on your PATH. Add it with:"
    echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> $shell_rc && . $shell_rc"
    ;;
esac
echo
echo "Next:"
echo "  agentrow install                    # keep the daemon running (starts at login)"
echo "  agentrow telegram setup <bot-token> # control agents from Telegram"
echo "  agentrow ws new myproj ~/code/myproj && agentrow new myproj/claude"
