#!/usr/bin/env bash
# Installs the ePaperclip worker on macOS as a per-user LaunchAgent: it starts when you log in and restarts if it stops.
# The worker connects out to your own ePaperclip host; it opens no port and holds no Proxmox or model-account credentials.
#
#   ./install-macos.sh [--bundle FILE]      install or upgrade (epaperclip-worker.mjs next to this script, or FILE)
#   ./install-macos.sh --uninstall [--purge]   remove it (--purge also deletes its key, settings and logs)
#
# Needs Node.js 22 or newer (brew install node). Run it as yourself, not with sudo. For Linux use install.sh.
set -euo pipefail
die() { echo "install-macos: $*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || die "this is for macOS; on Linux use install.sh"
[ "$(id -u)" -ne 0 ] || die "run as your own user, not root"

LABEL=co.papercliped.epaperclip-worker
DATA="${EPW_DIR:-$HOME/Library/Application Support/epaperclip-worker}"
WORKSPACES="${EPW_WORKSPACES:-$HOME/epaperclip-workspaces}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BIN="$HOME/.local/bin/epaperclip-worker"
HERE="$(cd "$(dirname "$0")" && pwd)"
UID_NUM="$(id -u)"

if [ "${1:-}" = --uninstall ]; then
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$BIN" "$DATA/bin/epaperclip-worker.mjs"
  if [ "${2:-}" = --purge ]; then rm -rf "$DATA"; echo "removed, including its key, settings and logs"; else echo "removed; kept $DATA (key and settings) and $WORKSPACES"; fi
  exit 0
fi

BUNDLE="$HERE/epaperclip-worker.mjs"
if [ "${1:-}" = --bundle ]; then BUNDLE="${2:?--bundle needs a file}"; fi
[ -f "$BUNDLE" ] || die "no worker bundle at $BUNDLE (build it with: pnpm --filter @papercliped-engine/worker-daemon build)"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "Node.js 22 or newer is needed: brew install node"
[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 22 ] || die "Node.js 22 or newer is needed (found $("$NODE" -v))"

mkdir -p "$DATA/bin" "$DATA/logs" "$WORKSPACES" "$HOME/Library/LaunchAgents" "$(dirname "$BIN")"
cp "$BUNDLE" "$DATA/bin/epaperclip-worker.mjs"
cat >"$BIN" <<WRAP
#!/bin/sh
exec "$NODE" "$DATA/bin/epaperclip-worker.mjs" "\$@"
WRAP
chmod 755 "$BIN"

cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DATA/bin/epaperclip-worker.mjs</string><string>run</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>EPW_DIR</key><string>$DATA</string>
    <key>EPW_WORKSPACES</key><string>$WORKSPACES</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DATA/logs/worker.log</string>
  <key>StandardErrorPath</key><string>$DATA/logs/worker.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl kickstart -k "gui/$UID_NUM/$LABEL"
echo "installed. The worker runs at login. Logs: $DATA/logs/worker.log"
echo "next: open Workers in ePaperclip, add a worker, then run:  $BIN adopt <pairing code>"
case ":$PATH:" in *":$(dirname "$BIN"):"*) ;; *) echo "note: add $(dirname "$BIN") to your PATH to run epaperclip-worker directly" ;; esac
