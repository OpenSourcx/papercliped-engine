#!/usr/bin/env bash
# Installs the latest ePaperclip release on a Proxmox VE host. Run it in the host's shell as root:
#
#   curl -fsSL https://github.com/OpenSourcx/papercliped-engine/releases/latest/download/get.sh | bash
#
# It downloads the release and checks its Ed25519 signature (a detached signature over a manifest that carries the
# tarball's version and SHA-256) against the project's public key, which is written into this file when the release is
# built. Nothing is extracted or run unless that check passes; if it fails, nothing is installed. Then it runs the
# installer inside the release. Read it first if you like: it is short, and deploy/install.sh is in the same repository.
#
# A release candidate (a pre-release) is not "latest"; install one by pointing get.sh at its tag:
#   B=https://github.com/OpenSourcx/papercliped-engine/releases/download/v1.0.0-rc1
#   curl -fsSL $B/get.sh | EPC_RELEASE_BASE=$B bash
#
# This is the template. scripts/package-release.mjs writes the verification code and the public key into the copy
# that is published with each release; this template has neither and refuses to install anything.
set -euo pipefail
BASE="${EPC_RELEASE_BASE:-https://github.com/OpenSourcx/papercliped-engine/releases/latest/download}"
# Plain "epaperclip: ..." lines when piped or logged; a little color and marks on a terminal (same wording either way).
if [ -t 1 ] && [ -t 2 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then UI=1; R=$'\e[0m'; C=$'\e[36m'; E=$'\e[31m'; else UI=0; R=""; C=""; E=""; fi
say() { if [ "$UI" = 1 ]; then echo "  ${C}›${R} $*"; else echo "epaperclip: $*"; fi; }
die() { if [ "$UI" = 1 ]; then echo "  ${E}✕ $*${R}" >&2; else echo "epaperclip: $*" >&2; fi; exit 1; }

# @@EPC_VERIFY_LIB@@
# @@EPC_PINNED_KEY@@
EPC_PINNED_KEY="${EPC_PINNED_KEY:-}"

declare -F epc_verify_release >/dev/null || die "this copy of get.sh is the unsigned template and cannot verify a release. Use the get.sh attached to a release: https://github.com/OpenSourcx/papercliped-engine/releases"
[ "$(id -u)" -eq 0 ] || die "run as root"
for c in curl tar sha256sum openssl base64; do command -v "$c" >/dev/null || die "the '$c' command is missing (apt-get install -y curl openssl)"; done

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
[ -n "$EPC_PINNED_KEY" ] || die "this release carries no signing key, so nothing can be verified and nothing was installed. The maintainer must run scripts/release-keygen.mjs and publish a release with deploy/release-signing.pub"
printf '%s\n' "$EPC_PINNED_KEY" >"$tmp/release-signing.pub"

say "downloading the release"
curl -fsSL --retry 3 -o "$tmp/epaperclip.tar.gz" "$BASE/epaperclip.tar.gz" || die "couldn't download the release from $BASE"
curl -fsSL --retry 3 -o "$tmp/epaperclip.manifest.json" "$BASE/epaperclip.manifest.json" || die "couldn't download the release's signed manifest, so it was not installed"
curl -fsSL --retry 3 -o "$tmp/epaperclip.manifest.sig" "$BASE/epaperclip.manifest.sig" || die "couldn't download the release's signature, so it was not installed"

# Never go backwards by accident: refuse a release older than the one installed (set EPC_ALLOW_DOWNGRADE=1 to mean it).
have=""
if [ "${EPC_ALLOW_DOWNGRADE:-}" != 1 ]; then have="$({ tr -d '[:space:]' <"${EPC_PREFIX:-/opt/epaperclip}/VERSION"; } 2>/dev/null || true)"; have="${have#v}"; fi
epc_verify_release "$tmp/epaperclip.tar.gz" "$tmp/epaperclip.manifest.json" "$tmp/epaperclip.manifest.sig" "$tmp/release-signing.pub" "" "$have" \
  || die "the release was not installed: $EPC_VERIFY_ERROR"
say "signature and checksum verified (version $EPC_VERIFIED_VERSION)"
tar -xzf "$tmp/epaperclip.tar.gz" --no-same-owner -C "$tmp"
bash "$tmp/epaperclip/deploy/install.sh" "$@"
