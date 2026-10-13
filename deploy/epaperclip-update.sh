#!/usr/bin/env bash
# The update helper. Runs as root, started by epaperclip-update.path when the host service (which is unprivileged and
# sandboxed, and stays that way) leaves a request in /var/lib/epaperclip/update/request. It does only two things:
#
#   action=update    download that exact release, check its published SHA-256, and run the installer from it. The
#                    installer is the same one a person runs by hand: it test-starts the new version on the side, swaps it
#                    in, and puts the previous version back by itself if the new one doesn't come up healthy.
#   action=rollback  run the installer's own --rollback.
#
# The request is plain KEY=VALUE lines. Every value is checked against a fixed shape here, whatever the host service
# checked, and nothing in it is ever run or put into a path or URL unchecked. Progress is written to .../update/status
# for the console. The release location comes from this file's environment (the unit), never from the request.
set -uo pipefail

PREFIX="${EPC_PREFIX:-/opt/epaperclip}"
DIR="${EPC_HOST_STATE_DIR:-/var/lib/epaperclip}/update"
BASE="${EPC_RELEASE_DOWNLOAD:-https://github.com/OpenSourcx/papercliped-engine/releases/download}"
REQ="$DIR/request"
STATUS="$DIR/status"

status() { # phase message [version]
  local tmp; tmp="$(mktemp "$DIR/.status.XXXXXX")" || return 0
  printf 'phase=%s\nmessage=%s\nversion=%s\nat=%s\n' "$1" "$2" "${3:-}" "$(date +%s)" >"$tmp"
  chmod 0644 "$tmp"; mv -f "$tmp" "$STATUS"
}

[ -d "$DIR" ] || exit 0
[ -e "$REQ" ] || [ -L "$REQ" ] || exit 0
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
# Take the request out of the folder the host service can write to before reading it, and never follow a link.
if [ -L "$REQ" ] || [ ! -f "$REQ" ]; then rm -f "$REQ"; status failed "The update request wasn't a plain file, so it was ignored."; exit 0; fi
head -c 2048 "$REQ" >"$WORK/request"; rm -f "$REQ"

field() { sed -n "s/^$1=//p" "$WORK/request" | head -n1; }
action="$(field action)"; version="$(field version)"; who="$(field requestedBy)"
[[ "$who" =~ ^[A-Za-z0-9._@-]{1,100}$ ]] || who="unknown"
case "$action" in
  update) [[ "$version" =~ ^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$ ]] || { status failed "The update request had no valid version, so it was ignored."; exit 0; } ;;
  rollback) version="" ;;
  *) status failed "The update request was not understood, so it was ignored."; exit 0 ;;
esac
logger -t epaperclip-update "$action ${version:-previous} requested by $who" 2>/dev/null || true
: >"$DIR/log"; chmod 0644 "$DIR/log"

if [ "$action" = rollback ]; then
  status installing "Going back to the previous version." "$version"
  if [ -x "$PREFIX/update/install.sh" ] || [ -f "$PREFIX/update/install.sh" ]; then
    bash "$PREFIX/update/install.sh" --rollback >>"$DIR/log" 2>&1; rc=$?
  else rc=1; echo "no installer found in $PREFIX/update" >>"$DIR/log"; fi
  if [ "$rc" -eq 0 ]; then status done "Rolled back to the previous version."; else status failed "The rollback didn't finish: $(tail -n 1 "$DIR/log" | cut -c1-200)"; fi
  exit 0
fi

status downloading "Downloading $version from the project's releases." "$version"
url="$BASE/v$version"
if ! curl -fsSL --retry 3 --max-time 900 -o "$WORK/epaperclip.tar.gz" "$url/epaperclip.tar.gz" || ! curl -fsSL --retry 3 --max-time 60 -o "$WORK/epaperclip.tar.gz.sha256" "$url/epaperclip.tar.gz.sha256"; then
  status failed "Couldn't download release $version. Nothing was changed." "$version"; exit 0
fi
status verifying "Checking the download against its published checksum." "$version"
if ! (cd "$WORK" && sha256sum -c epaperclip.tar.gz.sha256 >/dev/null 2>&1); then
  status failed "The download doesn't match its published checksum, so it was not installed. Nothing was changed." "$version"; exit 0
fi
if ! tar -xzf "$WORK/epaperclip.tar.gz" -C "$WORK" 2>>"$DIR/log" || [ ! -f "$WORK/epaperclip/deploy/install.sh" ]; then
  status failed "The download isn't an ePaperclip release. Nothing was changed." "$version"; exit 0
fi
got="$(tr -d '[:space:]' <"$WORK/epaperclip/VERSION" 2>/dev/null)"; got="${got#v}"
if [ "$got" != "$version" ]; then
  status failed "The download is version ${got:-unknown}, not $version. Nothing was changed." "$version"; exit 0
fi
status installing "Installing $version: the installer test-starts it, swaps it in, and puts the old version back if it doesn't come up." "$version"
bash "$WORK/epaperclip/deploy/install.sh" >>"$DIR/log" 2>&1; rc=$?
if [ "$rc" -eq 0 ]; then status done "Updated to $version." "$version"
elif grep -q "was restored" "$DIR/log"; then status rolled_back "The update didn't come up healthy, so the previous version was put back and is running." "$version"
else status failed "The update didn't finish: $(tail -n 1 "$DIR/log" | cut -c1-200)" "$version"; fi
exit 0
