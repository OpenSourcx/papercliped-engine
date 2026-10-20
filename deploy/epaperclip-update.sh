#!/usr/bin/env bash
# The update helper. Runs as root, started by epaperclip-update.path when the host service (which is unprivileged and
# sandboxed, and stays that way) leaves a request in /var/lib/epaperclip/update/request. It does only two things:
#
#   action=update    download that exact release, check its Ed25519 signature (against the public key installed with the
#                    running version, so a new key can only arrive inside a release the old key signed), then its manifest's
#                    SHA-256 and version, and run the installer from it. Anything that fails a check is not extracted. The
#                    installer is the same one a person runs by hand: it test-starts the new version on the side, swaps it
#                    in, and puts the previous version back by itself if the new one doesn't come up healthy.
#   action=rollback  run the installer's own --rollback.
#
# The request is plain KEY=VALUE lines. Every value is checked against a fixed shape here, whatever the host service
# checked, and nothing in it is ever run or put into a path or URL unchecked. Progress is written to .../update/status
# for the console. The release location comes from this file's environment (the unit), never from the request.
#
# The folder the request arrives in belongs to the host service, so this script treats everything in it as hostile:
#   - it works inside the folder's real directory (cd -P), so swapping the folder for a link afterwards redirects nothing;
#   - it reads the request with O_NOFOLLOW and without blocking, so a link or a pipe in its place is refused;
#   - it never opens an existing name there for writing: its log and status are built in a private folder and put in place
#     by renaming a fresh file over the name (a rename replaces a link, it never follows one), so a link named "log" or
#     "status" can't make root truncate or chmod some other file;
#   - it refuses to install an older release than the one running (that is what "rollback" is for), by the signed
#     manifest's version, not by anything in the request.
set -uo pipefail

PREFIX="${EPC_PREFIX:-/opt/epaperclip}"
DIR="${EPC_HOST_STATE_DIR:-/var/lib/epaperclip}/update"
BASE="${EPC_RELEASE_DOWNLOAD:-https://github.com/OpenSourcx/papercliped-engine/releases/download}"

[ -d "$DIR" ] || exit 0
# Step into the real directory and make sure it is where it should be (not a link to somewhere else).
want="$(cd -P -- "$(dirname -- "$DIR")" 2>/dev/null && pwd -P)/$(basename -- "$DIR")"
cd -P -- "$DIR" 2>/dev/null || exit 0
if [ "$(pwd -P)" != "$want" ]; then
  logger -t epaperclip-update "the update folder is not the real $DIR (it is a link), so nothing was done" 2>/dev/null || true
  exit 0
fi
# From here on every name below is relative to that directory itself.
[ -e request ] || [ -L request ] || exit 0

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
LOG="$WORK/log"; : >"$LOG"

# Replaces <name> here with a copy of <file>: a fresh file renamed into place, never written through an existing name.
publish() {
  local tmp; tmp="$(mktemp ".$1.XXXXXX")" || return 0
  if cat -- "$2" >"$tmp" && chmod 0644 "$tmp" && mv -f -T -- "$tmp" "$1" 2>/dev/null; then :; else rm -f -- "$tmp"; fi
}
status() { # phase message [version]
  printf 'phase=%s\nmessage=%s\nversion=%s\nat=%s\n' "$1" "$2" "${3:-}" "$(date +%s)" >"$WORK/status"
  publish status "$WORK/status"
  publish log "$LOG"
}

# Take the request out of the folder the host service can write to before reading it. dd opens it with O_NOFOLLOW
# (a link fails) and O_NONBLOCK (a pipe can't hold this up), and keeps at most 2 KB.
if ! dd if=request of="$WORK/request" bs=2048 count=1 iflag=nofollow,nonblock status=none 2>/dev/null || [ -L request ] || [ ! -f request ]; then
  rm -rf -- request
  status failed "The update request wasn't a plain file, so it was ignored."; exit 0
fi
rm -f -- request

field() { sed -n "s/^$1=//p" "$WORK/request" | head -n1; }
action="$(field action)"; version="$(field version)"; who="$(field requestedBy)"
[[ "$who" =~ ^[A-Za-z0-9._@-]{1,100}$ ]] || who="unknown"
case "$action" in
  update) [[ "$version" =~ ^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(-[0-9A-Za-z.]{1,40})?$ ]] || { status failed "The update request had no valid version, so it was ignored."; exit 0; } ;;
  rollback) version="" ;;
  *) status failed "The update request was not understood, so it was ignored."; exit 0 ;;
esac
logger -t epaperclip-update "$action ${version:-previous} requested by $who" 2>/dev/null || true

if [ "$action" = rollback ]; then
  status installing "Going back to the previous version." "$version"
  if [ -x "$PREFIX/update/install.sh" ] || [ -f "$PREFIX/update/install.sh" ]; then
    bash "$PREFIX/update/install.sh" --rollback >>"$LOG" 2>&1; rc=$?
  else rc=1; echo "no installer found in $PREFIX/update" >>"$LOG"; fi
  if [ "$rc" -eq 0 ]; then status done "Rolled back to the previous version."; else status failed "The rollback didn't finish: $(tail -n 1 "$LOG" | cut -c1-200)"; fi
  exit 0
fi

# Never install an older release than the one running: a request (or a replayed one) for an old, vulnerable version
# must not downgrade the host. Going back is what "rollback" is for, and it only goes to the version this one replaced.
cur="$({ tr -d '[:space:]' <"$PREFIX/VERSION"; } 2>/dev/null)"; cur="${cur#v}"
# The verifier and the pinned public key are the ones installed with the running version (root's, in $PREFIX/update), never
# anything from the download or the request folder. A version installed before signing existed has neither and can't update itself.
if [ ! -f "$PREFIX/update/verify-release.sh" ]; then
  status failed "This installation predates signed releases, so it can't check an update. Install once from a shell: curl -fsSL https://github.com/OpenSourcx/papercliped-engine/releases/latest/download/get.sh | bash" "$version"; exit 0
fi
# shellcheck disable=SC1091
. "$PREFIX/update/verify-release.sh"
[[ "$cur" =~ ^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(-[0-9A-Za-z.]{1,40})?$ ]] || cur=""   # a development build has no comparable version
if [ -n "$cur" ] && epc_ver_lt "$version" "$cur"; then
  status failed "Version $version is older than the $cur that is running, so it was not installed. Nothing was changed." "$version"; exit 0
fi

status downloading "Downloading $version from the project's releases." "$version"
url="$BASE/v$version"
if ! curl -fsSL --proto-redir '=https' --retry 3 --max-time 900 -o "$WORK/epaperclip.tar.gz" "$url/epaperclip.tar.gz" \
  || ! curl -fsSL --proto-redir '=https' --retry 3 --max-time 60 -o "$WORK/epaperclip.manifest.json" "$url/epaperclip.manifest.json" \
  || ! curl -fsSL --proto-redir '=https' --retry 3 --max-time 60 -o "$WORK/epaperclip.manifest.sig" "$url/epaperclip.manifest.sig"; then
  status failed "Couldn't download release $version with its signed manifest and signature, so nothing was installed or changed." "$version"; exit 0
fi
status verifying "Checking the download's signature, checksum and version." "$version"
# Fail closed: the signature over the manifest, the manifest's SHA-256 against the file, the manifest's version against the
# request, and no older than what is running (checked again here against the signed version, not just the requested one).
if ! epc_verify_release "$WORK/epaperclip.tar.gz" "$WORK/epaperclip.manifest.json" "$WORK/epaperclip.manifest.sig" "$PREFIX/update/release-signing.pub" "$version" "$cur"; then
  logger -t epaperclip-update "refused release $version: $EPC_VERIFY_ERROR" 2>/dev/null || true
  echo "refused: $EPC_VERIFY_ERROR" >>"$LOG"
  status failed "The download was refused, so it was not installed and nothing was changed: ${EPC_VERIFY_ERROR:0:200}" "$version"; exit 0
fi
if ! tar -xzf "$WORK/epaperclip.tar.gz" --no-same-owner -C "$WORK" 2>>"$LOG" || [ ! -f "$WORK/epaperclip/deploy/install.sh" ]; then
  status failed "The download isn't an ePaperclip release. Nothing was changed." "$version"; exit 0
fi
got="$(tr -d '[:space:]' <"$WORK/epaperclip/VERSION" 2>/dev/null)"; got="${got#v}"
if [ "$got" != "$version" ]; then
  status failed "The download is version ${got:-unknown}, not $version. Nothing was changed." "$version"; exit 0
fi
status installing "Installing $version: the installer test-starts it, swaps it in, and puts the old version back if it doesn't come up." "$version"
bash "$WORK/epaperclip/deploy/install.sh" >>"$LOG" 2>&1; rc=$?
if [ "$rc" -eq 0 ]; then status done "Updated to $version." "$version"
elif grep -q "was restored" "$LOG"; then status rolled_back "The update didn't come up healthy, so the previous version was put back and is running." "$version"
else status failed "The update didn't finish: $(tail -n 1 "$LOG" | cut -c1-200)" "$version"; fi
exit 0
