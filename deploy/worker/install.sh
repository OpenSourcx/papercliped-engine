#!/usr/bin/env bash
# Installs, upgrades and removes the ePaperclip Worker on a Linux machine you want to adopt into ePaperclip.
#
#   sudo ./install.sh                         install or upgrade from this folder (epaperclip-worker.mjs next to this script)
#   sudo ./install.sh --tarball FILE --sha256 HEX
#                                             verify a downloaded release against the checksum you got from the console
#                                             or the release page, then install it; nothing is unpacked if it differs
#   sudo ./install.sh --rollback              go back to the previous version
#   sudo ./install.sh --uninstall [--purge]   remove the service (keeps its key, settings and workspaces; --purge also
#                                             removes the key and settings, --purge-workspaces the workspaces too)
#   ./install.sh --user [--fetch-node]       install for the current user only, with no root: files under ~/.local, a user
#                                             systemd service, workspaces in ~/epaperclip-workspaces. --fetch-node downloads the
#                                             pinned, checksum-verified Node.js into the install (when the machine has none).
#                                             To start at boot (not only at login) a root user must run once:
#                                               sudo loginctl enable-linger <user>      (this script tells you if it is needed)
#   ./install.sh --check                      only check the prerequisites; changes nothing
#   ./install.sh --status                     what is installed and whether it runs
#   Options with install: --name NAME  --ollama-url URL  --max-context N  --slots N  --workspaces DIR
#
# There is deliberately no "curl | sh" form. Download the tarball, compare its SHA-256 with the value published with the
# release, read this script, then run it.
#
# What it promises: it checks everything first and says what is missing before changing anything; it creates one
# unprivileged system user and keeps all of its state in one folder; the previous version is kept for --rollback;
# settings and the machine key are never overwritten; it never opens a port (the worker only connects out).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PREFIX="${EPW_PREFIX:-/opt/epaperclip-worker}"
UNIT_DIR="${EPW_UNIT_DIR:-/etc/systemd/system}"
DATA="${EPW_DATA:-/var/lib/epaperclip-worker}"
WORKSPACES="${EPW_WORKSPACES:-/workspaces}"
BIN_DIR="${EPW_BIN_DIR:-/usr/local/bin}"
SVC_USER="${EPW_USER:-epaperclip-worker}"
UNIT="$UNIT_DIR/epaperclip-worker.service"
MIN_NODE=22
# The Node.js --fetch-node installs, pinned by version and checksum (https://nodejs.org/dist/v24.21.0/SHASUMS256.txt, same pin as the host installer).
NODE_VERSION="24.21.0"
NODE_SHA256_x64="fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"
NODE_SHA256_arm64="6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then B=$'\e[1m'; R=$'\e[0m'; else B=""; R=""; fi
say()  { echo "epaperclip-worker: $*"; }
die()  { echo "epaperclip-worker: $*" >&2; exit 1; }

TMPD=""
USER_MODE=0 FETCH_NODE=0
MODE=install TARBALL="" SHA="" PURGE=0 PURGE_WS=0 NAME="" OLLAMA="" MAXCTX="" SLOTS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tarball) TARBALL="${2:?--tarball needs a file}"; shift ;;
    --sha256) SHA="${2:?--sha256 needs a value}"; shift ;;
    --user) USER_MODE=1 ;; --fetch-node) FETCH_NODE=1 ;;
    --rollback) MODE=rollback ;; --uninstall) MODE=uninstall ;; --status) MODE=status ;; --check) MODE=check ;;
    --purge) PURGE=1 ;; --purge-workspaces) PURGE=1; PURGE_WS=1 ;;
    --name) NAME="${2:?}"; shift ;; --ollama-url) OLLAMA="${2:?}"; shift ;; --max-context) MAXCTX="${2:?}"; shift ;; --slots) SLOTS="${2:?}"; shift ;;
    --workspaces) WORKSPACES="${2:?}"; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

if [ "$USER_MODE" = 1 ]; then
  : "${HOME:?HOME is not set}"
  PREFIX="${EPW_PREFIX:-$HOME/.local/epaperclip-worker}"; UNIT_DIR="${EPW_UNIT_DIR:-$HOME/.config/systemd/user}"
  DATA="${EPW_DATA:-$HOME/.local/share/epaperclip-worker}"; BIN_DIR="${EPW_BIN_DIR:-$HOME/.local/bin}"
  [ -n "${EPW_WORKSPACES:-}" ] || [ "$WORKSPACES" != /workspaces ] || WORKSPACES="$HOME/epaperclip-workspaces"
  SVC_USER="$(id -un)"; UNIT="$UNIT_DIR/epaperclip-worker.service"
  SC="systemctl --user"
else
  SC="systemctl"
fi
is_root() { [ "$USER_MODE" = 1 ] || [ "$(id -u)" = 0 ] || [ -n "${EPW_TEST:-}" ]; }
find_node() {
  local n="${EPW_NODE:-}"
  [ -n "$n" ] || [ ! -x "$PREFIX/node/bin/node" ] || n="$PREFIX/node/bin/node"
  [ -n "$n" ] || n="$(command -v node || true)"
  [ -n "$n" ] && [ -x "$n" ] || return 1
  echo "$n"
}

# ---- checks (nothing is changed before all of them pass) ----
problems=()
check() {
  [ "$(uname -s)" = Linux ] || problems+=("this installer is for Linux ($(uname -s) found)")
  case "$(uname -m)" in x86_64|aarch64|arm64|amd64) ;; *) problems+=("unsupported CPU architecture $(uname -m)") ;; esac
  if [ -z "${EPW_TEST:-}" ]; then
    command -v systemctl >/dev/null || problems+=("systemd is required (systemctl not found)")
    if [ "$USER_MODE" = 1 ]; then $SC show-environment >/dev/null 2>&1 || problems+=("the user systemd instance is not running for $(id -un) (log in with a normal session or ask root to run: loginctl enable-linger $(id -un))"); fi
    is_root || problems+=("run as root (sudo)")
  fi
  local n v
  if [ "$FETCH_NODE" = 1 ] && ! find_node >/dev/null; then
    for c in curl tar xz; do command -v $c >/dev/null || problems+=("$c is needed to unpack the Node.js download"); done
    case "$(uname -m)" in x86_64|amd64|aarch64|arm64) ;; esac
  elif n="$(find_node)"; then
    v="$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    [ "$v" -ge "$MIN_NODE" ] 2>/dev/null || problems+=("Node.js $MIN_NODE or newer is required (found $("$n" -v 2>/dev/null || echo unknown) at $n). Install it from https://nodejs.org/dist/ (verify the SHASUMS256.txt) or your package source, or set EPW_NODE=/path/to/node")
  else
    problems+=("Node.js $MIN_NODE or newer is required and was not found. Install it from https://nodejs.org/dist/, set EPW_NODE=/path/to/node, or add --fetch-node to download the pinned, checksum-verified copy into the install")
  fi
  command -v git >/dev/null || say "note: git is not installed; agents that need repositories will not work until it is (apt install git)"
  command -v tailscale >/dev/null || say "note: tailscale is not installed; that is fine for a local network, but it is the recommended way to reach your host from anywhere"
  if [ ${#problems[@]} -gt 0 ]; then
    for p in "${problems[@]}"; do echo "epaperclip-worker: cannot install: $p" >&2; done
    return 1
  fi
}

sha_of() { sha256sum "$1" | cut -d' ' -f1; }

status() {
  if [ -f "$PREFIX/epaperclip-worker.mjs" ]; then
    local n; n="$(find_node || echo node)"
    say "installed at $PREFIX ($("$n" "$PREFIX/epaperclip-worker.mjs" version 2>/dev/null || echo '?'))"
    if [ -z "${EPW_TEST:-}" ] && command -v systemctl >/dev/null; then
      $SC is-active epaperclip-worker >/dev/null 2>&1 && say "service: running" || say "service: not running (journalctl -u epaperclip-worker)"
    fi
    EPW_DIR="$DATA" "$n" "$PREFIX/epaperclip-worker.mjs" status 2>/dev/null || true
  else
    say "not installed"
  fi
}

fetch_node() {
  local arch file want d
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) die "no pinned Node.js for $(uname -m)" ;; esac
  want="NODE_SHA256_$arch"; want="${!want}"; file="node-v$NODE_VERSION-linux-$arch.tar.xz"
  d="$(mktemp -d)"
  say "downloading Node.js $NODE_VERSION ($arch) from nodejs.org"
  curl -fsSL --retry 3 -o "$d/$file" "https://nodejs.org/dist/v$NODE_VERSION/$file" || { rm -rf "$d"; die "couldn't download Node.js from nodejs.org. Nothing was installed."; }
  [ "$(sha_of "$d/$file")" = "$want" ] || { rm -rf "$d"; die "the Node.js download does not match its pinned checksum. Nothing was installed."; }
  rm -rf "$PREFIX/node.new"; mkdir -p "$PREFIX/node.new"
  tar -xJf "$d/$file" -C "$PREFIX/node.new" --strip-components=1 --no-same-owner
  rm -rf "$d" "$PREFIX/node"; mv "$PREFIX/node.new" "$PREFIX/node"
  say "Node.js $("$PREFIX/node/bin/node" -v) is in $PREFIX/node"
}

do_install() {
  check || exit 1
  local src="$HERE"
  if [ -n "$TARBALL" ]; then
    [ -f "$TARBALL" ] || die "$TARBALL not found"
    [ -n "$SHA" ] || die "--tarball needs --sha256 with the checksum from the release page or the console"
    [ "$(sha_of "$TARBALL")" = "$(echo "$SHA" | tr 'A-F' 'a-f')" ] || die "checksum mismatch for $TARBALL: expected $SHA, got $(sha_of "$TARBALL"). Nothing was installed."
    TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT
    tar -xzf "$TARBALL" -C "$TMPD" --no-same-owner
    src="$(dirname "$(find "$TMPD" -name epaperclip-worker.mjs | head -1)")"
  fi
  [ -f "$src/epaperclip-worker.mjs" ] || die "epaperclip-worker.mjs not found next to the installer (build it with: pnpm --filter @papercliped-engine/worker-daemon build, or use a release tarball)"
  install -d -m 0755 "$PREFIX"
  if [ "$FETCH_NODE" = 1 ] && ! find_node >/dev/null; then fetch_node; fi
  local node; node="$(find_node)"
  "$node" -e 'process.exit(0)' || die "$node does not run"

  if [ "$USER_MODE" = 0 ] && ! getent passwd "$SVC_USER" >/dev/null 2>&1 && ! id "$SVC_USER" >/dev/null 2>&1; then
    say "creating the system user $SVC_USER"
    useradd --system --user-group --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
  fi
  install -d -m 0755 "$PREFIX" "$BIN_DIR" "$UNIT_DIR"
  install -d -m 0750 "$DATA"
  install -d -m 0755 "$WORKSPACES"
  [ "$USER_MODE" = 1 ] || chown "$SVC_USER:$SVC_USER" "$DATA" "$WORKSPACES" 2>/dev/null || [ -n "${EPW_TEST:-}" ]

  local new="$PREFIX/epaperclip-worker.mjs" prev="$PREFIX/epaperclip-worker.mjs.prev"
  if [ -f "$new" ] && ! cmp -s "$new" "$src/epaperclip-worker.mjs"; then cp -p "$new" "$prev"; say "kept the previous version for --rollback"; fi
  install -m 0644 "$src/epaperclip-worker.mjs" "$new.tmp" && mv -f "$new.tmp" "$new"

  local tpl="$HERE/epaperclip-worker.service"; [ "$USER_MODE" = 0 ] || tpl="$HERE/epaperclip-worker.user.service"
  sed -e "s|@USER@|$SVC_USER|g" -e "s|@DATA@|$DATA|g" -e "s|@WORKSPACES@|$WORKSPACES|g" -e "s|@NODE@|$node|g" -e "s|@PREFIX@|$PREFIX|g" "$tpl" > "$UNIT.tmp"
  mv -f "$UNIT.tmp" "$UNIT"

  # The command people type. As root it runs as the service user, so it reads and writes the worker's own files.
  cat > "$BIN_DIR/epaperclip-worker.tmp" <<WRAP
#!/bin/sh
# Generated by the ePaperclip Worker installer.
export EPW_DIR="$DATA" EPW_WORKSPACES="$WORKSPACES"
if [ "$USER_MODE" = 0 ] && [ "\$(id -u)" = 0 ] && command -v runuser >/dev/null 2>&1; then exec runuser -u "$SVC_USER" -- "$node" "$PREFIX/epaperclip-worker.mjs" "\$@"; fi
exec "$node" "$PREFIX/epaperclip-worker.mjs" "\$@"
WRAP
  chmod 0755 "$BIN_DIR/epaperclip-worker.tmp"; mv -f "$BIN_DIR/epaperclip-worker.tmp" "$BIN_DIR/epaperclip-worker"

  local cfg=()
  [ -z "$NAME" ] || cfg+=("name=$NAME"); [ -z "$OLLAMA" ] || cfg+=("ollamaUrl=$OLLAMA"); [ -z "$MAXCTX" ] || cfg+=("maxContext=$MAXCTX"); [ -z "$SLOTS" ] || cfg+=("slots=$SLOTS")
  if [ ${#cfg[@]} -gt 0 ]; then
    if [ "$USER_MODE" = 0 ] && [ "$(id -u)" = 0 ] && [ -z "${EPW_TEST:-}" ]; then "$BIN_DIR/epaperclip-worker" config "${cfg[@]}" >/dev/null; else EPW_DIR="$DATA" EPW_WORKSPACES="$WORKSPACES" "$node" "$new" config "${cfg[@]}" >/dev/null; fi
  fi

  if [ -z "${EPW_TEST:-}" ]; then
    $SC daemon-reload
    $SC enable epaperclip-worker >/dev/null 2>&1 || true
    $SC restart epaperclip-worker
    local i; for i in 1 2 3 4 5 6 7 8 9 10; do $SC is-active --quiet epaperclip-worker && break; sleep 1; done
    $SC is-active --quiet epaperclip-worker || { journalctl $([ "$USER_MODE" = 1 ] && echo --user) -u epaperclip-worker -n 20 --no-pager >&2 || true; die "the service did not start. The previous version is still in $prev (sudo ./install.sh --rollback)."; }
  else
    say "(test mode: systemd not touched)"
  fi
  say "${B}ePaperclip Worker ready.${R} Installed $("$node" "$new" version) in $PREFIX; state in $DATA; workspaces in $WORKSPACES."
  echo
  echo "  Detected on this machine:"
  EPW_DIR="$DATA" EPW_WORKSPACES="$WORKSPACES" "$node" "$new" caps 2>/dev/null | "$node" -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const c=JSON.parse(s);console.log("    "+c.os.name+" "+c.os.version+", "+c.arch+", "+c.cpu.cores+" cores, "+c.memMb+" MiB RAM, GPU: "+(c.gpu.present?c.gpu.name:"none"));console.log("    tools: "+(Object.entries(c.tools).map(([k,v])=>k+" "+v).join(", ")||"none"));console.log("    models: "+(c.inference?c.inference.models.map(m=>m.name).join(", ")+" ("+c.inference.url+")":"no Ollama found"));}catch{}})' || true
  echo
  if [ "$USER_MODE" = 1 ] && [ -z "${EPW_TEST:-}" ]; then
    local lg; lg="$(loginctl show-user "$(id -un)" -p Linger 2>/dev/null | cut -d= -f2 || true)"
    if [ "$lg" != yes ]; then
      echo "  NOTE: this service starts when $(id -un) logs in, not at boot, because lingering is off for this account."
      echo "        To start it at boot, a user with root must run once:   sudo loginctl enable-linger $(id -un)"
      echo
    fi
  fi
  echo "  Next: adopt this machine into ePaperclip."
  echo "    1. In the ePaperclip console open Workers and choose Add worker, then pick how it reaches this machine (Tailscale is recommended)."
  echo "    2. Run the command it shows:   $([ "$USER_MODE" = 1 ] || echo sudo) epaperclip-worker adopt <pairing code>"
  echo "    3. Check it:                   epaperclip-worker status      (and: epaperclip-worker diagnose)"
}

do_rollback() {
  is_root || die "run as root (sudo)"
  [ -f "$PREFIX/epaperclip-worker.mjs.prev" ] || die "there is no previous version to go back to"
  mv -f "$PREFIX/epaperclip-worker.mjs" "$PREFIX/epaperclip-worker.mjs.bad"
  mv -f "$PREFIX/epaperclip-worker.mjs.prev" "$PREFIX/epaperclip-worker.mjs"
  [ -n "${EPW_TEST:-}" ] || $SC restart epaperclip-worker
  say "went back to the previous version"
}

do_uninstall() {
  is_root || die "run as root (sudo)"
  if [ -z "${EPW_TEST:-}" ]; then $SC disable --now epaperclip-worker >/dev/null 2>&1 || true; fi
  rm -f "$UNIT" "$BIN_DIR/epaperclip-worker"
  [ -z "${EPW_TEST:-}" ] && { $SC daemon-reload || true; }
  rm -rf "$PREFIX"
  if [ "$PURGE" = 1 ]; then
    rm -rf "$DATA"
    [ "$PURGE_WS" = 1 ] && rm -rf "$WORKSPACES"
    [ "$USER_MODE" = 1 ] || userdel "$SVC_USER" >/dev/null 2>&1 || true
    say "removed the service, its key and settings$([ "$PURGE_WS" = 1 ] && echo ', and the workspaces')"
  else
    say "removed the service. Kept $DATA (key and settings) and $WORKSPACES. Use --purge to remove them too."
  fi
  say "To stop ePaperclip trusting this machine, also remove the worker in the console (Workers, Revoke)."
}

case "$MODE" in
  install) do_install ;;
  check) check && say "all prerequisites are met" ;;
  status) status ;;
  rollback) do_rollback ;;
  uninstall) do_uninstall ;;
esac
