#!/usr/bin/env bash
# Builds release/epaperclip_*_all.deb into ePaperclip's signed APT repository layout. The release workflow uploads the
# resulting files to Cloudflare R2, served at https://apt.papercliped.co.
#
#   APT_SIGNING_KEY=... bash scripts/publish-apt.sh --local <dir>
#
# Without APT_SIGNING_KEY it skips, saying so. The key must be the one whose public half is committed at
# deploy/apt/epaperclip-archive-keyring.asc (users trust that one); anything else is refused. APT_SIGNING_PASSPHRASE is
# used if the key has one. Earlier versions stay in the pool, so the repository keeps them.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC_KEY="${EPC_APT_PUBLIC_KEY:-$ROOT/deploy/apt/epaperclip-archive-keyring.asc}"
die() { echo "publish-apt: $*" >&2; exit 1; }

[ "${1:-}" = "--local" ] || die "usage: publish-apt.sh --local <dir>"
out="${2:?usage: publish-apt.sh --local <dir>}"
if [ -z "${APT_SIGNING_KEY:-}" ]; then
  echo "::notice::publish-apt: APT_SIGNING_KEY isn't set, so the APT repository was not published."
  exit 0
fi
deb="$(ls -t "$ROOT"/release/epaperclip_*_all.deb 2>/dev/null | head -n1)"
[ -n "$deb" ] || die "no release/epaperclip_*_all.deb; run scripts/build-deb.sh first"
for c in gpg dpkg-scanpackages gzip; do command -v "$c" >/dev/null || die "the '$c' command is missing (apt-get install -y gnupg dpkg-dev)"; done
[ -f "$PUBLIC_KEY" ] || die "$PUBLIC_KEY is missing"

GNUPGHOME="$(mktemp -d)"; export GNUPGHOME
cleanup() { rm -rf "$GNUPGHOME"; }
trap cleanup EXIT
printf '%s\n' "$APT_SIGNING_KEY" | gpg --batch --quiet --import 2>/dev/null || die "APT_SIGNING_KEY isn't a key gpg can import"
fpr="$(gpg --batch --with-colons --list-secret-keys | awk -F: '$1=="fpr"{print $10; exit}')"
want="$(gpg --batch --with-colons --show-keys "$PUBLIC_KEY" | awk -F: '$1=="fpr"{print $10; exit}')"
[ -n "$fpr" ] && [ "$fpr" = "$want" ] || die "the signing key (${fpr:-none}) isn't the one published in ${PUBLIC_KEY#"$ROOT/"} ($want); nothing was published"
sign=(gpg --batch --yes --pinentry-mode loopback --local-user "$fpr")
[ -z "${APT_SIGNING_PASSPHRASE:-}" ] || sign+=(--passphrase-fd 3)

apt="$out"

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

echo "publish-apt: $debname -> $apt (signed by $fpr)"
