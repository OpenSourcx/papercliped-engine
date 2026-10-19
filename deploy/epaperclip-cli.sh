#!/usr/bin/env bash
# `epaperclip`: the command that manages an installed ePaperclip, however it was installed (get.sh, npx, apt). The installer
# keeps this beside its own copy under /opt/epaperclip/update/ and links it as /usr/local/bin/epaperclip, so it travels with
# the version a rollback restores. The Debian package ships its own /usr/sbin/epaperclip, which the installer leaves alone.
#
#   epaperclip status               versions, whether both services run and answer, where the data is
#   epaperclip version              the installed version
#   epaperclip update [--pre|--tag vX]
#                                   install the newest release; signature-checked. While you run a release candidate it
#                                   follows release candidates too; --pre does that from a stable version, --tag picks one
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
  ${B}update${R} [--pre]       install the newest release (candidates too while you run one, or with --pre); signature-checked
  ${B}update${R} --tag vX      install a particular release, such as v1.0.0-rc5
  ${B}rollback${R}             put the previous version back
  ${B}uninstall${R} [--purge]  remove it; your data and settings stay unless you add --purge

Proxmox's own interface on :8006 is never touched.
TXT
}
die() { echo "epaperclip: $*" >&2; exit 1; }
need_root() { [ "$(id -u)" -eq 0 ] || die "run as root (on Proxmox you already are; elsewhere put sudo in front): epaperclip $1"; }
[ -f "$INSTALLER" ] || die "the installer isn't at $INSTALLER; reinstall with: curl -fsSL https://github.com/$REPO/releases/latest/download/get.sh | bash"

cmd="${1:-help}"; [ "$#" -eq 0 ] || shift
case "$cmd" in
  status) exec bash "$INSTALLER" --status ;;
  version) tr -d '[:space:]' <"$PREFIX/VERSION" 2>/dev/null && echo || die "not installed" ;;
  rollback) need_root rollback; exec bash "$INSTALLER" --rollback ;;
  uninstall) need_root uninstall; if [ "${1:-}" = "--purge" ]; then exec bash "$INSTALLER" --purge; else exec bash "$INSTALLER" --uninstall; fi ;;
  update)
    need_root update
    command -v curl >/dev/null || die "curl is needed (apt-get install -y curl)"
    tag=""; pre=0
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --tag) tag="${2:-}"; [ -n "$tag" ] || die "update --tag needs a tag, such as v1.0.0-rc5"; shift 2 ;;
        --pre) pre=1; shift ;;
        *) die "unknown option $1 (use --pre or --tag vX)" ;;
      esac
    done
    installed="$(tr -d '[:space:]' <"$PREFIX/VERSION" 2>/dev/null || true)"; installed="${installed#v}"
    case "$installed" in *-*) pre=1 ;; esac   # on a release candidate: follow candidates
    downloads="${EPC_DOWNLOADS:-https://github.com/$REPO/releases/download}"
    # A tag counts only when its release was really published: a failed build leaves a bare tag that the feed still lists.
    published() { curl -fsIL --max-time 20 -o /dev/null "$downloads/$1/get.sh" 2>/dev/null; }
    if [ -z "$tag" ]; then
      # The newest release first in the project's public release feed; a release candidate has a hyphen in its tag.
      candidates="$(curl -fsSL --max-time 20 "${EPC_FEED:-https://github.com/$REPO/releases.atom}" 2>/dev/null | grep -o 'releases/tag/v[0-9][0-9A-Za-z.+-]*' | sed 's|releases/tag/||' | awk '!seen[$0]++' | while read -r t; do case "$t" in *-*) [ "$pre" = 1 ] || continue ;; esac; echo "$t"; done)"
      if [ -z "$candidates" ]; then
        [ "$pre" = 1 ] && die "couldn't find a release (is this host online?). Try: epaperclip update --tag vX"
        die "no final release has been published yet. Release candidates are installed with: epaperclip update --pre"
      fi
      for t in $candidates; do
        if published "$t"; then tag="$t"; break; fi
        echo "epaperclip: skipping $t, it has no published release (its build may have failed)" >&2
      done
      [ -n "$tag" ] || die "found release tags, but none has a published installer. Try again later, or see https://github.com/$REPO/releases"
    fi
    [[ "$tag" =~ ^v[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(-[0-9A-Za-z.]{1,40})?$ ]] || die "that isn't a release tag (like v1.0.0 or v1.0.0-rc5)"
    if [ "${tag#v}" = "$installed" ]; then echo "epaperclip: already on $tag"; exit 0; fi
    published "$tag" || die "$tag has no published release (its build may have failed, or the tag is wrong). Releases are listed at https://github.com/$REPO/releases"
    echo "epaperclip: installing $tag${installed:+ (you have v$installed)}"
    [ -z "${EPC_UPDATE_DRY:-}" ] || exit 0
    base="$downloads/$tag"
    script="$(curl -fsSL --max-time 60 "$base/get.sh")" || die "couldn't download the installer for $tag from $base; nothing was changed"
    printf '%s\n' "$script" | EPC_RELEASE_BASE="$base" bash ;;
  help|-h|--help) usage ;;
  install) die "to install or upgrade, use: epaperclip update" ;;
  *) usage >&2; exit 2 ;;
esac
