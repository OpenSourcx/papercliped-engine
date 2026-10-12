#!/usr/bin/env bash
# Builds ePaperclip from the repository on the Proxmox host itself, then installs it. For branches and for hosts
# before a release exists; once a release is published, deploy/get.sh is the simple way.
#
#   curl -fsSL https://raw.githubusercontent.com/OpenSourcx/papercliped-engine/<branch>/deploy/from-source.sh | EPC_REF=<branch> bash
#
# Nothing here uses or changes the host's own Node.js: the build runs on the same pinned, checksum-verified Node.js the
# service itself uses, inside a temporary folder that is deleted afterwards.
set -euo pipefail
REPO="${EPC_REPO:-https://github.com/OpenSourcx/papercliped-engine.git}"
REF="${EPC_REF:-main}"
die() { echo "epaperclip: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root"
command -v pveversion >/dev/null || die "this isn't a Proxmox VE host (pveversion not found)"

need=(); for c in git curl tar xz sha256sum; do command -v "$c" >/dev/null || need+=("$c"); done
if [ "${#need[@]}" -gt 0 ]; then
  echo "epaperclip: installing ${need[*]}"
  apt-get update -qq && apt-get install -y -qq git curl xz-utils ca-certificates >/dev/null || die "couldn't install ${need[*]}"
fi

work="$(mktemp -d /var/tmp/epaperclip-build.XXXXXX)"; trap 'rm -rf "$work"' EXIT
echo "epaperclip: fetching $REF"
git clone --quiet --depth 1 --branch "$REF" "$REPO" "$work/src" || die "couldn't fetch '$REF' from $REPO"

# Reuse the installer's pinned Node.js version and checksums, so there is one place to update them.
eval "$(grep -E '^NODE_(VERSION|SHA256_(x64|arm64))=' "$work/src/deploy/install.sh")"
case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) die "unsupported processor: $(uname -m)" ;; esac
want="NODE_SHA256_$arch"; want="${!want}"
file="node-v$NODE_VERSION-linux-$arch.tar.xz"
echo "epaperclip: downloading Node.js $NODE_VERSION for the build"
curl -fsSL --retry 3 -o "$work/$file" "https://nodejs.org/dist/v$NODE_VERSION/$file" || die "couldn't download Node.js"
[ "$(sha256sum "$work/$file" | cut -d' ' -f1)" = "$want" ] || die "the Node.js download doesn't match its expected checksum"
tar -xJf "$work/$file" -C "$work"
export PATH="$work/node-v$NODE_VERSION-linux-$arch/bin:$PATH"
export COREPACK_HOME="$work/corepack" COREPACK_ENABLE_DOWNLOAD_PROMPT=0

cd "$work/src"
echo "epaperclip: building (a few minutes the first time)"
mkdir -p "$work/bin"
corepack enable --install-directory "$work/bin" || die "couldn't set up pnpm"
export PATH="$work/bin:$PATH"
pnpm install --frozen-lockfile >/dev/null
pnpm build >/dev/null
git describe --tags --always > VERSION 2>/dev/null || echo "$REF" > VERSION
echo "$REF-$(git rev-parse --short HEAD)" > VERSION
bash deploy/install.sh "$@"
