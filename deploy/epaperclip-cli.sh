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
#   epaperclip device ...           operate ePaperclip's own services on this host
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
  ${B}device status${R}        show installed versions and service health
  ${B}device restart${R} [console|engine|all]
                           restart only ePaperclip services (default: all)
  ${B}device start|stop${R} [console|engine|cloudflared|all]
                           start or stop an ePaperclip service (default: all)
  ${B}device logs${R} [console|engine|cloudflared] [--lines N] [--follow]
                           read ePaperclip service logs (default: console)
  ${B}device publish status${R} show the local Cloudflare publishing helper state

Proxmox's own interface on :8006 is never touched.
TXT
}
die() { echo "epaperclip: $*" >&2; exit 1; }
need_root() { [ "$(id -u)" -eq 0 ] || die "run as root (on Proxmox you already are; elsewhere put sudo in front): epaperclip $1"; }
[ -f "$INSTALLER" ] || die "the installer isn't at $INSTALLER; reinstall with: curl -fsSL https://github.com/$REPO/releases/latest/download/get.sh | bash"

unit_for() {
  case "$1" in
    console) echo epaperclip ;;
    engine) echo epaperclip-engine ;;
    cloudflared) echo epaperclip-cloudflared ;;
    *) return 1 ;;
  esac
}

units_for() {
  case "$1" in
    all) printf '%s\n' epaperclip-engine epaperclip ;;
    console|engine|cloudflared) unit_for "$1" ;;
    *) die "unknown ePaperclip service '$1' (use console, engine, cloudflared or all)" ;;
  esac
}

device_usage() {
  cat <<TXT
usage: epaperclip device <command>

  status
  start|stop|restart [console|engine|cloudflared|all]
  logs [console|engine|cloudflared] [--lines N] [--follow]
  publish status

Only ePaperclip's own systemd units can be controlled here. Proxmox itself is never restarted or reconfigured.
TXT
}

device_service() {
  local action="${1:-}" target="${2:-all}" unit
  case "$action" in start|stop|restart) ;; *) die "device service action must be start, stop or restart" ;; esac
  [ "$#" -le 2 ] || die "usage: epaperclip device $action [console|engine|cloudflared|all]"
  need_root "device $action"
  while IFS= read -r unit; do
    echo "epaperclip: $action $unit"
    systemctl "$action" "$unit"
  done < <(units_for "$target")
}

device_logs() {
  local target="console" lines=80 follow=0 unit
  while [ "$#" -gt 0 ]; do
    case "$1" in
      console|engine|cloudflared) target="$1" ;;
      --lines)
        lines="${2:-}"; [[ "$lines" =~ ^[1-9][0-9]{0,3}$ ]] || die "device logs --lines needs a number from 1 to 9999"; shift ;;
      --follow|-f) follow=1 ;;
      *) die "unknown device logs option '$1'" ;;
    esac
    shift
  done
  need_root "device logs"
  unit="$(unit_for "$target")"
  args=(-u "$unit" --no-pager -n "$lines")
  [ "$follow" = 1 ] && args+=(--follow)
  exec journalctl "${args[@]}"
}

device_publish_status() {
  local etc="${EPC_ETC_DIR:-/etc/epaperclip}" socket_state cloudflared_state config="not configured"
  need_root "device publish status"
  [ -f "$etc/cloudflared.yml" ] && config="configured"
  socket_state="stopped"; systemctl is-active -q epaperclip-publish.socket && socket_state="active"
  cloudflared_state="stopped"; systemctl is-active -q epaperclip-cloudflared && cloudflared_state="active"
  echo "epaperclip: publishing helper socket: $socket_state"
  echo "epaperclip: Cloudflare tunnel: $cloudflared_state ($config)"
  [ "$config" = configured ] || echo "epaperclip: configure Cloudflare in Settings → Connectors → Plugins before starting a named tunnel."
}

device() {
  local sub="${1:-status}"; [ "$#" -eq 0 ] || shift
  case "$sub" in
    status) [ "$#" -eq 0 ] || die "usage: epaperclip device status"; exec bash "$INSTALLER" --status ;;
    start|stop|restart) device_service "$sub" "$@" ;;
    logs) device_logs "$@" ;;
    publish) [ "${1:-}" = status ] && [ "$#" -eq 1 ] || { device_usage >&2; exit 2; }; device_publish_status ;;
    help|-h|--help) device_usage ;;
    *) device_usage >&2; exit 2 ;;
  esac
}

cmd="${1:-help}"; [ "$#" -eq 0 ] || shift
case "$cmd" in
  status) exec bash "$INSTALLER" --status ;;
  version) tr -d '[:space:]' <"$PREFIX/VERSION" 2>/dev/null && echo || die "not installed" ;;
  rollback) need_root rollback; exec bash "$INSTALLER" --rollback ;;
  uninstall) need_root uninstall; if [ "${1:-}" = "--purge" ]; then exec bash "$INSTALLER" --purge; else exec bash "$INSTALLER" --uninstall; fi ;;
  device) device "$@" ;;
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
