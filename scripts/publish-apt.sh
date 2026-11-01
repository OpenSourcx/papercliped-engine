#!/usr/bin/env bash
# Publishes release/epaperclip_*_all.deb to ePaperclip's signed APT repository on Cloudflare R2 (folder apt/), served at
# https://updates.papercliped.co/apt (scripts/r2.sh).
#
#   APT_SIGNING_KEY=<ASCII-armored private key> R2_ENDPOINT=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
#     bash scripts/publish-apt.sh                                              CI, on a version tag: upload
#   APT_SIGNING_KEY=... bash scripts/publish-apt.sh --local <dir>              build the repository into <dir> only
#
# Without APT_SIGNING_KEY it skips, saying so. The key must be the one whose public half is committed at
# deploy/apt/epaperclip-archive-keyring.asc (users trust that one); anything else is refused. APT_SIGNING_PASSPHRASE is
# used if the key has one. Earlier versions stay in the pool, so the repository keeps them.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/r2.sh
. "$ROOT/scripts/r2.sh"
PUBLIC_KEY="${EPC_APT_PUBLIC_KEY:-$ROOT/deploy/apt/epaperclip-archive-keyring.asc}"
die() { echo "publish-apt: $*" >&2; exit 1; }

mode=push; out=""
if [ "${1:-}" = "--local" ]; then mode=local; out="${2:?usage: publish-apt.sh --local <dir>}"; fi
if [ -z "${APT_SIGNING_KEY:-}" ]; then
  echo "::notice::publish-apt: APT_SIGNING_KEY isn't set, so the APT repository was not published."
  exit 0
fi
deb="$(ls -t "$ROOT"/release/epaperclip_*_all.deb 2>/dev/null | head -n1)"
[ -n "$deb" ] || die "no release/epaperclip_*_all.deb; run scripts/build-deb.sh first"
for c in gpg dpkg-scanpackages gzip; do command -v "$c" >/dev/null || die "the '$c' command is missing (apt-get install -y gnupg dpkg-dev)"; done
[ -f "$PUBLIC_KEY" ] || die "$PUBLIC_KEY is missing"

GNUPGHOME="$(mktemp -d)"; export GNUPGHOME
site=""
cleanup() { rm -rf "$GNUPGHOME"; [ -z "$site" ] || rm -rf "$site"; }
trap cleanup EXIT
printf '%s\n' "$APT_SIGNING_KEY" | gpg --batch --quiet --import 2>/dev/null || die "APT_SIGNING_KEY isn't a key gpg can import"
fpr="$(gpg --batch --with-colons --list-secret-keys | awk -F: '$1=="fpr"{print $10; exit}')"
want="$(gpg --batch --with-colons --show-keys "$PUBLIC_KEY" | awk -F: '$1=="fpr"{print $10; exit}')"
[ -n "$fpr" ] && [ "$fpr" = "$want" ] || die "the signing key (${fpr:-none}) isn't the one published in ${PUBLIC_KEY#"$ROOT/"} ($want); nothing was published"
sign=(gpg --batch --yes --pinentry-mode loopback --local-user "$fpr")
[ -z "${APT_SIGNING_PASSPHRASE:-}" ] || sign+=(--passphrase-fd 3)

if [ "$mode" = push ]; then
  if ! r2_ready; then
    echo "::notice::publish-apt: R2_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY aren't set, so the APT repository was not published."
    exit 0
  fi
  site="$(mktemp -d)"; apt="$site/apt"
  # The packages already published, so the new index keeps every earlier version.
  r2 sync "s3://$R2_BUCKET/apt/pool/" "$apt/pool/"
else
  apt="$out"
fi

debname="$(basename "$deb")"
pool="$apt/pool/main/e/epaperclip"
install -d "$pool"
cp -f "$deb" "$pool/$debname"
cp -f "$PUBLIC_KEY" "$apt/epaperclip-archive-keyring.asc"
gpg --batch --yes --dearmor -o "$apt/epaperclip-archive-keyring.gpg" "$PUBLIC_KEY"

dists="$apt/dists/stable"
rm -rf "$dists"
for arch in amd64 arm64 all; do
  d="$dists/main/binary-$arch"; install -d "$d"
  (cd "$apt" && dpkg-scanpackages --multiversion pool /dev/null 2>/dev/null) >"$d/Packages"
  gzip -9nkf "$d/Packages"
  printf 'Archive: stable\nSuite: stable\nComponent: main\nOrigin: ePaperclip\nLabel: ePaperclip\nArchitecture: %s\n' "$arch" >"$d/Release"
done
grep -q "^Filename: pool/main/e/epaperclip/$debname$" "$dists/main/binary-all/Packages" || die "the package didn't make it into the index"

{
  echo "Origin: ePaperclip"
  echo "Label: ePaperclip"
  echo "Suite: stable"
  echo "Codename: stable"
  echo "Date: $(LC_ALL=C date -Ru)"
  echo "Architectures: amd64 arm64 all"
  echo "Components: main"
  echo "Description: ePaperclip for Proxmox VE"
  for h in MD5Sum:md5sum SHA256:sha256sum SHA512:sha512sum; do
    echo "${h%%:*}:"
    (cd "$dists" && find main -type f | LC_ALL=C sort | while read -r f; do
      printf ' %s %8d %s\n' "$("${h#*:}" "$f" | cut -d' ' -f1)" "$(stat -c %s "$f")" "$f"
    done)
  done
} >"$dists/Release"
if [ -n "${APT_SIGNING_PASSPHRASE:-}" ]; then
  "${sign[@]}" --clearsign -o "$dists/InRelease" "$dists/Release" 3<<<"$APT_SIGNING_PASSPHRASE"
  "${sign[@]}" --armor --detach-sign -o "$dists/Release.gpg" "$dists/Release" 3<<<"$APT_SIGNING_PASSPHRASE"
else
  "${sign[@]}" --clearsign -o "$dists/InRelease" "$dists/Release"
  "${sign[@]}" --armor --detach-sign -o "$dists/Release.gpg" "$dists/Release"
fi
gpg --batch --verify "$dists/Release.gpg" "$dists/Release" 2>/dev/null || die "the Release signature doesn't verify"

if [ "$mode" = local ]; then echo "publish-apt: $debname -> $apt (signed by $fpr)"; exit 0; fi
# Packages first, then the keyring, then the signed indexes, so an index never names a file that isn't there yet. A package
# never changes once published; the indexes are cached briefly so a new release shows up within minutes.
r2 sync "$apt/pool/" "s3://$R2_BUCKET/apt/pool/" --cache-control "public, max-age=31536000, immutable"
for f in epaperclip-archive-keyring.asc epaperclip-archive-keyring.gpg; do
  r2 cp "$apt/$f" "s3://$R2_BUCKET/apt/$f" --cache-control "public, max-age=3600"
done
r2 sync "$apt/dists/" "s3://$R2_BUCKET/apt/dists/" --delete --cache-control "public, max-age=300"
echo "publish-apt: published $debname to $EPC_UPDATES_BASE/apt (signed by $fpr)"
