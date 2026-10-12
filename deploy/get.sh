#!/usr/bin/env bash
# Installs the latest ePaperclip release on a Proxmox VE host. Run it in the host's shell as root:
#
#   curl -fsSL https://github.com/OpenSourcx/papercliped-engine/releases/latest/download/get.sh | bash
#
# It downloads the release, checks it against the published SHA-256, and runs the installer inside it.
# Read it first if you like: it is short, and deploy/install.sh (what it runs) is in the same repository.
set -euo pipefail
BASE="${EPC_RELEASE_BASE:-https://github.com/OpenSourcx/papercliped-engine/releases/latest/download}"
die() { echo "epaperclip: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root"
for c in curl tar sha256sum; do command -v "$c" >/dev/null || die "the '$c' command is missing (apt-get install -y curl)"; done

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
echo "epaperclip: downloading the latest release"
curl -fsSL --retry 3 -o "$tmp/epaperclip.tar.gz" "$BASE/epaperclip.tar.gz" || die "couldn't download the release from $BASE"
curl -fsSL --retry 3 -o "$tmp/epaperclip.tar.gz.sha256" "$BASE/epaperclip.tar.gz.sha256" || die "couldn't download the release's checksum"
(cd "$tmp" && sha256sum -c epaperclip.tar.gz.sha256 >/dev/null) || die "the download doesn't match its checksum, so it was not installed"
tar -xzf "$tmp/epaperclip.tar.gz" -C "$tmp"
bash "$tmp/epaperclip/deploy/install.sh" "$@"
