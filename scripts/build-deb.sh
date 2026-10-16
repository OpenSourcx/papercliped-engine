#!/usr/bin/env bash
# Builds release/epaperclip_<version>_all.deb from release/epaperclip.tar.gz (run scripts/package-release.mjs first).
#   bash scripts/build-deb.sh
#
# The package carries the same files as the release download, in /usr/share/epaperclip, and its postinst runs the same
# deploy/install.sh, so `apt install epaperclip` does exactly what get.sh does: preflight, the pinned and verified
# Node.js, the engine from its lockfile, a staged start and automatic rollback. Its own files are architecture
# independent; Node.js and the engine's packages are fetched at install for the host's processor.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REL="$ROOT/release"
die() { echo "build-deb: $*" >&2; exit 1; }
[ -f "$REL/epaperclip.tar.gz" ] || die "release/epaperclip.tar.gz is missing; run: pnpm build && node scripts/package-release.mjs <version>"
command -v dpkg-deb >/dev/null || die "dpkg-deb is needed (apt-get install -y dpkg)"

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
tar -xzf "$REL/epaperclip.tar.gz" -C "$work"
src="$work/epaperclip"
version="$(cat "$src/VERSION")"
# A Debian version starts with a digit and has no '-' (that would mean a Debian revision): v1.2.3-4-gabc -> 1.2.3+4.gabc
# A release candidate (1.0.0-rc1) must sort BEFORE 1.0.0, which '~' does and '+' doesn't: 1.0.0-rc1 -> 1.0.0~rc1
debver="${version#v}"
case "$debver" in [0-9]*.[0-9]*.[0-9]*-rc*|[0-9]*.[0-9]*.[0-9]*-beta*|[0-9]*.[0-9]*.[0-9]*-alpha*) debver="${debver/-/\~}" ;; esac
debver="${debver//-/+}"; debver="${debver//_/.}"
case "$debver" in [0-9]*) ;; *) debver="0.0.0+$debver" ;; esac
echo "$debver" | grep -Eq '^[0-9][A-Za-z0-9.+~]*$' || die "can't make a Debian version from '$version'"

pkg="$work/pkg"
install -d "$pkg/DEBIAN" "$pkg/usr/share/epaperclip" "$pkg/usr/share/doc/epaperclip" "$pkg/usr/sbin"
cp -a "$src/." "$pkg/usr/share/epaperclip/"
chmod 0755 "$pkg/usr/share/epaperclip/deploy/install.sh"
cp "$src/LICENSE" "$pkg/usr/share/doc/epaperclip/copyright"

# `epaperclip status|rollback|uninstall|install`: the installer that came with this package, as one command.
cat >"$pkg/usr/sbin/epaperclip" <<'EOF'
#!/bin/sh
# ePaperclip's installer, from the Debian package. See /usr/share/epaperclip/deploy/install.sh.
set -e
case "${1:-}" in
  install) shift; set -- "$@" ;;
  status) shift; set -- --status "$@" ;;
  rollback) shift; set -- --rollback "$@" ;;
  uninstall) shift; if [ "${1:-}" = "--purge" ]; then shift; set -- --purge "$@"; else set -- --uninstall "$@"; fi ;;
  *) echo "usage: epaperclip install | status | rollback | uninstall [--purge]" >&2; exit 2 ;;
esac
exec bash /usr/share/epaperclip/deploy/install.sh "$@"
EOF
chmod 0755 "$pkg/usr/sbin/epaperclip"

cat >"$pkg/DEBIAN/control" <<EOF
Package: epaperclip
Version: $debver
Architecture: all
Maintainer: OpenSourcx <releases@papercliped.co>
Depends: pve-manager (>= 8.0), curl, xz-utils, ca-certificates, tar, util-linux, iproute2
Section: admin
Priority: optional
Installed-Size: $(du -sk "$pkg/usr" | cut -f1)
Homepage: https://github.com/OpenSourcx/papercliped-engine
Description: Proxmox-native console with an engine for organizations of agents
 ePaperclip serves a console on port 443 of a Proxmox VE host. People sign in
 with their Proxmox accounts, and every action runs as that person. It also runs
 its engine, Paperclip, as a locked-down service on loopback.
 .
 Installing runs the same installer as the release download: it checks the host
 first, downloads a pinned, checksum-verified Node.js and installs the engine
 from its lockfile (internet access is needed), test-starts everything, and
 rolls back by itself if the new version doesn't come up. Proxmox's own web
 interface on port 8006 is never changed.
EOF

cat >"$pkg/DEBIAN/postinst" <<'EOF'
#!/bin/sh
# Installs or upgrades with deploy/install.sh, exactly as the release download does. If the new version doesn't come up,
# the installer puts the previous one back and this step fails, so apt reports it.
set -e
case "$1" in
  configure)
    bash /usr/share/epaperclip/deploy/install.sh
    ;;
esac
exit 0
EOF

cat >"$pkg/DEBIAN/prerm" <<'EOF'
#!/bin/sh
# On removal: stop and remove the services and programs, keep the data and settings (purge removes those).
# On upgrade nothing is stopped here: the new version's postinst swaps itself in, with rollback.
set -e
case "$1" in
  remove|deconfigure)
    bash /usr/share/epaperclip/deploy/install.sh --uninstall || true
    ;;
esac
exit 0
EOF

cat >"$pkg/DEBIAN/postrm" <<'EOF'
#!/bin/sh
# Purge removes ePaperclip's data and settings too: the engine's data and backups, the host service's vault, its
# settings and its users. Plain removal keeps them.
set -e
case "$1" in
  purge)
    if command -v systemctl >/dev/null; then systemctl disable --now epaperclip epaperclip-engine >/dev/null 2>&1 || true; fi
    rm -f /etc/systemd/system/epaperclip.service /etc/systemd/system/epaperclip-engine.service /etc/systemd/system/epaperclip.service.prev
    rm -rf /opt/epaperclip /opt/epaperclip.prev /opt/epaperclip.new /opt/epaperclip.failed
    rm -rf /var/lib/epaperclip-engine /var/lib/epaperclip /etc/epaperclip
    rm -f /etc/default/epaperclip
    for u in epaperclip epaperclip-engine; do
      if id "$u" >/dev/null 2>&1; then userdel "$u" >/dev/null 2>&1 || true; fi
    done
    if command -v systemctl >/dev/null; then systemctl daemon-reload >/dev/null 2>&1 || true; fi
    ;;
esac
exit 0
EOF
chmod 0755 "$pkg/DEBIAN/postinst" "$pkg/DEBIAN/prerm" "$pkg/DEBIAN/postrm"
(cd "$pkg" && find usr -type f -print0 | sort -z | xargs -0 md5sum) >"$pkg/DEBIAN/md5sums"

find "$pkg" -type d -exec chmod 0755 {} +
out="$REL/epaperclip_${debver}_all.deb"
dpkg-deb --root-owner-group -Zxz --build "$pkg" "$out" >/dev/null
echo "build-deb: $version -> ${out#"$ROOT/"}"
