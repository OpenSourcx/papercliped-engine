#!/usr/bin/env bash
# Installs ePaperclip on a Proxmox VE host as a native systemd service.
#
#   pnpm install && pnpm build      # on any machine, from this repository
#   sudo ./deploy/install.sh           # on the Proxmox host, from the same checkout
#
# It serves the console on https://<host>/ (port 443) with the node's own certificate and signs people in with their
# Proxmox accounts. The stock Proxmox UI stays on :8006 as the emergency console. Uninstall with --uninstall.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX=/opt/epaperclip
SERVICE=/etc/systemd/system/epaperclip.service

die() { echo "epaperclip: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root"

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now epaperclip 2>/dev/null || true
  rm -f "$SERVICE"
  systemctl daemon-reload
  rm -rf "$PREFIX"
  echo "epaperclip: removed. /etc/default/epaperclip and the epaperclip user were left in place."
  exit 0
fi

command -v pveversion >/dev/null || die "this isn't a Proxmox VE host (pveversion not found)"
[ -f "$ROOT/services/epaperclip/dist/epaperclip.mjs" ] || die "build first: pnpm install && pnpm build"
[ -f "$ROOT/apps/console/dist/index.html" ] || die "build the console first: pnpm --filter @papercliped-engine/console build"

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "epaperclip: installing Node.js from the Debian repositories"
  apt-get update -qq && apt-get install -y -qq nodejs
fi
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Node.js 20 or newer is needed"

if ss -Hltn 'sport = :443' | grep -q . && ! systemctl is-active -q epaperclip; then
  die "something else is listening on port 443; stop it or set EPC_LISTEN in /etc/default/epaperclip"
fi

id epaperclip >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin epaperclip

install -d -m 0755 "$PREFIX" "$PREFIX/console"
install -m 0644 "$ROOT/services/epaperclip/dist/epaperclip.mjs" "$PREFIX/epaperclip.mjs"
rm -rf "${PREFIX:?}/console/"*
cp -r "$ROOT/apps/console/dist/." "$PREFIX/console/"
chown -R root:root "$PREFIX"
chmod -R a+rX "$PREFIX"

[ -f /etc/default/epaperclip ] || install -m 0644 "$ROOT/deploy/epaperclip.default" /etc/default/epaperclip
install -m 0644 "$ROOT/deploy/epaperclip.service" "$SERVICE"
systemctl daemon-reload
systemctl enable epaperclip >/dev/null
systemctl restart epaperclip

sleep 1
if systemctl is-active -q epaperclip; then
  echo "epaperclip: running. Open https://$(hostname -f 2>/dev/null || hostname)/ and sign in with your Proxmox account."
  echo "epaperclip: the stock Proxmox UI stays at https://$(hostname -f 2>/dev/null || hostname):8006/"
else
  journalctl -u epaperclip -n 30 --no-pager
  die "the service didn't start; see the log above"
fi
