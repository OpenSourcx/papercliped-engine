#!/usr/bin/env bash
# `epaperclip`: the command that manages an installed ePaperclip, however it was installed (get.sh, npx, apt). The installer
# keeps this beside its own copy under /opt/epaperclip/update/ and links it as /usr/local/bin/epaperclip, so it travels with
# the version a rollback restores. The Debian package ships its own /usr/sbin/epaperclip, which the installer leaves alone.
#
#   epaperclip status               versions, whether both services run and answer, where the data is
#   epaperclip version              the installed version
#   epaperclip update [--tag vX]    install the latest release (or a tag, such as a release candidate); signature-checked
#   epaperclip rollback             put the previous version back
#   epaperclip uninstall [--purge]  remove it (keeps its data and settings; --purge removes those too)
set -euo pipefail

PREFIX="${EPC_PREFIX:-/opt/epaperclip}"
SELF="$(readlink -f "$0")"
INSTALLER="${EPC_INSTALLER:-$(dirname "$SELF")/install.sh}"
REPO="OpenSourcx/papercliped-engine"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then B=$'\e[1m'; D=$'\e[2m'; R=$'\e[0m'; else B=""; D=""; R=""; fi
usage() {
  cat <<TXT
${B}epaperclip${R} ${D}— manage ePaperclip on this Proxmox host${R}

  ${B}status${R}               versions, whether both services run and answer, where the data is
  ${B}version${R}              the installed version
  ${B}update${R} [--tag vX]    install the latest release, or a tag such as v1.0.0-rc4 (signature-checked)
  ${B}rollback${R}             put the previous version back
  ${B}uninstall${R} [--purge]  remove it; your data and settings stay unless you add --purge

Proxmox's own interface on :8006 is never touched.
TXT
}
die() { echo "epaperclip: $*" >&2; exit 1; }
need_root() { [ "$(id -u)" -eq 0 ] || die "run as root: sudo epaperclip $1"; }
[ -f "$INSTALLER" ] || die "the installer isn't at $INSTALLER; reinstall with: curl -fsSL https://github.com/$REPO/releases/latest/download/get.sh | bash"

cmd="${1:-help}"; [ "$#" -eq 0 ] || shift
case "$cmd" in
  status) exec bash "$INSTALLER" --status ;;
  version) tr -d '[:space:]' <"$PREFIX/VERSION" 2>/dev/null && echo || die "not installed" ;;
  rollback) need_root rollback; exec bash "$INSTALLER" --rollback ;;
  uninstall) need_root uninstall; if [ "${1:-}" = "--purge" ]; then exec bash "$INSTALLER" --purge; else exec bash "$INSTALLER" --uninstall; fi ;;
  update)
    need_root update
    tag=""; if [ "${1:-}" = "--tag" ]; then tag="${2:-}"; [ -n "$tag" ] || die "update --tag needs a tag, such as v1.0.0-rc4"; fi
    command -v curl >/dev/null || die "curl is needed (apt-get install -y curl)"
    if [ -n "$tag" ]; then base="https://github.com/$REPO/releases/download/$tag"; else base="https://github.com/$REPO/releases/latest/download"; fi
    curl -fsSL "$base/get.sh" | EPC_RELEASE_BASE="$base" bash ;;
  help|-h|--help) usage ;;
  install) die "to install or upgrade, use: epaperclip update   (or apt, or: curl -fsSL https://github.com/$REPO/releases/latest/download/get.sh | bash)" ;;
  *) usage >&2; exit 2 ;;
esac
