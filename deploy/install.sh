#!/usr/bin/env bash
# Installs, upgrades, rolls back and removes ePaperclip on a Proxmox VE host.
#
#   sudo ./deploy/install.sh              install or upgrade
#   sudo ./deploy/install.sh --rollback   go back to the previous version
#   sudo ./deploy/install.sh --status     what's installed and whether it's healthy
#   sudo ./deploy/install.sh --uninstall  remove it (keeps /etc/default/epaperclip; --purge removes that too)
#
# Works from a release download (epaperclip.mjs and console/ next to this script's deploy/ folder) or from a built
# checkout of the repository.
#
# What it promises:
#   - It never touches Proxmox's own web interface. That stays on :8006, always, as the way back in.
#   - It checks everything it needs first and says what's missing before changing anything.
#   - It brings its own Node.js (a pinned, checksum-verified copy inside /opt/epaperclip), so the host's Node isn't used or changed.
#   - The new version is built and test-started on the side, then swapped in. If the swapped-in service doesn't come up
#     healthy, the previous version (or nothing, on a first install) is put back automatically.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${EPC_PREFIX:-/opt/epaperclip}"
UNIT_DIR="${EPC_UNIT_DIR:-/etc/systemd/system}"
DEFAULTS="${EPC_DEFAULTS:-/etc/default/epaperclip}"
SERVICE="$UNIT_DIR/epaperclip.service"
STAGE="$PREFIX.new"
PREV="$PREFIX.prev"
UNIT_PREV="$SERVICE.prev"

# The Node.js that runs the service, pinned by version and checksum (from https://nodejs.org/dist/v24.21.0/SHASUMS256.txt).
NODE_VERSION="24.21.0"
NODE_SHA256_x64="fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"
NODE_SHA256_arm64="6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2"

say()  { echo "epaperclip: $*"; }
warn() { echo "epaperclip: warning: $*" >&2; }
die()  { echo "epaperclip: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (for example: sudo ./deploy/install.sh)"

# ---- where things are: a release download, or a built checkout --------------------------------------------------
if [ -f "$ROOT/epaperclip.mjs" ]; then
  SRC_BUNDLE="$ROOT/epaperclip.mjs"; SRC_CONSOLE="$ROOT/console"
else
  SRC_BUNDLE="$ROOT/services/epaperclip/dist/epaperclip.mjs"; SRC_CONSOLE="$ROOT/apps/console/dist"
fi

listen_port() {
  local l=""
  [ -f "$DEFAULTS" ] && l="$(sed -n 's/^EPC_LISTEN=//p' "$DEFAULTS" | tail -n1 | tr -d "\"' ")"
  echo "${l##*:}" | grep -E '^[0-9]+$' || echo 443
}
PORT="$(listen_port)"
health_url() { echo "${EPC_HEALTH_URL:-https://127.0.0.1:$PORT}"; }

service_active() { systemctl is-active -q epaperclip 2>/dev/null; }
wait_healthy() { # up to ~20 s
  local i
  for i in $(seq 1 40); do
    curl -fsk --max-time 2 "$(health_url)/api/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}
installed_version() { [ -f "$PREFIX/VERSION" ] && cat "$PREFIX/VERSION" || echo "none"; }
host_name() { hostname -f 2>/dev/null || hostname; }
host_ip() { hostname -I 2>/dev/null | awk '{print $1}'; }

# ---- --status ---------------------------------------------------------------------------------------------------
if [ "${1:-}" = "--status" ]; then
  say "version: $(installed_version)$([ -d "$PREV" ] && echo " (previous: $(cat "$PREV/VERSION" 2>/dev/null || echo unknown))")"
  if service_active; then say "service: running"; else say "service: not running"; fi
  if wait_healthy; then say "health: ok at https://$(host_ip):$PORT/"; else say "health: no answer on port $PORT"; fi
  command -v pveversion >/dev/null && say "proxmox: $(pveversion)"
  exit 0
fi

# ---- --uninstall ------------------------------------------------------------------------------------------------
if [ "${1:-}" = "--uninstall" ] || [ "${1:-}" = "--purge" ]; then
  systemctl disable --now epaperclip 2>/dev/null || true
  rm -f "$SERVICE" "$UNIT_PREV"
  systemctl daemon-reload 2>/dev/null || true
  rm -rf "${PREFIX:?}" "${PREV:?}" "${STAGE:?}"
  if [ "${1:-}" = "--purge" ]; then rm -f "$DEFAULTS"; id epaperclip >/dev/null 2>&1 && userdel epaperclip 2>/dev/null || true; say "removed, including its settings and user."
  else say "removed. $DEFAULTS and the epaperclip user were left in place (use --purge to remove them too)."; fi
  say "Proxmox's own interface was never changed and is still at https://$(host_ip):8006/"
  exit 0
fi

# ---- --rollback -------------------------------------------------------------------------------------------------
swap_back() { # the previous version replaces the current one
  systemctl stop epaperclip 2>/dev/null || true
  rm -rf "${PREFIX:?}.failed"
  mv "$PREFIX" "$PREFIX.failed"
  mv "$PREV" "$PREFIX"
  [ -f "$UNIT_PREV" ] && mv -f "$UNIT_PREV" "$SERVICE" && systemctl daemon-reload
  systemctl start epaperclip
}
if [ "${1:-}" = "--rollback" ]; then
  [ -d "$PREV" ] || die "there is no previous version to go back to"
  swap_back
  if wait_healthy; then rm -rf "${PREFIX:?}.failed"; say "rolled back to $(installed_version)."; exit 0; fi
  die "rolled back, but the service didn't answer. See: journalctl -u epaperclip -n 50"
fi

[ -z "${1:-}" ] || die "unknown option $1 (use --status, --rollback or --uninstall)"

# ---- preflight: find every problem before changing anything -----------------------------------------------------
problems=()
need() { problems+=("$1"); }

command -v pveversion >/dev/null || need "this isn't a Proxmox VE host (pveversion wasn't found)"
if command -v pveversion >/dev/null; then
  pvemajor="$(pveversion 2>/dev/null | sed -n 's|^pve-manager/\([0-9]*\)\..*|\1|p' || true)"
  { [ -n "$pvemajor" ] && [ "$pvemajor" -ge 8 ]; } || need "Proxmox VE 8 or newer is needed (found: $(pveversion 2>&1 | head -n1))"
fi
case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64) ARCH=arm64 ;; *) ARCH=""; need "unsupported processor: $(uname -m) (x86_64 and aarch64 are supported)" ;; esac
for c in curl tar xz sha256sum useradd setpriv ss systemctl; do command -v "$c" >/dev/null || need "the '$c' command is missing (apt-get install -y curl xz-utils util-linux iproute2)"; done
[ -f "$SRC_BUNDLE" ] || need "the service isn't built (expected $SRC_BUNDLE). From a checkout: pnpm install && pnpm build"
[ -f "$SRC_CONSOLE/index.html" ] || need "the console isn't built (expected $SRC_CONSOLE/index.html)"
[ -f "$ROOT/deploy/epaperclip.service" ] || need "deploy/epaperclip.service is missing from this download"
systemctl is-active -q pveproxy 2>/dev/null || need "Proxmox's own web service (pveproxy) isn't running, and ePaperclip signs people in through it"
if ss -Hltn "sport = :$PORT" 2>/dev/null | grep -q . && ! service_active; then need "something else is listening on port $PORT; stop it, or set EPC_LISTEN=0.0.0.0:<another port> in $DEFAULTS and run this again"; fi
if [ "${EPC_SKIP_CERT_CHECK:-}" != "1" ]; then
  for f in /etc/pve/local/pve-ssl.pem /etc/pve/local/pve-ssl.key /etc/pve/pve-root-ca.pem; do
    [ -r "$f" ] || { need "$f can't be read (is the cluster filesystem up? try: systemctl status pve-cluster)"; continue; }
  done
fi
free_kb="$(df -Pk "$(dirname "$PREFIX")" | awk 'NR==2{print $4}')"
{ [ -n "$free_kb" ] && [ "$free_kb" -ge 400000 ]; } || need "less than 400 MB free where ${PREFIX} goes"
if [ "${#problems[@]}" -gt 0 ]; then
  echo "epaperclip: can't install yet:" >&2
  for p in "${problems[@]}"; do echo "  - $p" >&2; done
  echo "epaperclip: nothing was changed." >&2
  exit 1
fi

# The service user, and proof it can read the node's certificate the way Proxmox's own web service does.
id epaperclip >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin epaperclip
if [ "${EPC_SKIP_CERT_CHECK:-}" != "1" ]; then
  setpriv --reuid=epaperclip --regid=epaperclip --groups=www-data test -r /etc/pve/local/pve-ssl.key \
    || die "the epaperclip service user (in group www-data) can't read /etc/pve/local/pve-ssl.key. Check its permissions: ls -l /etc/pve/local/pve-ssl.key"
fi

# Proxmox's firewall, if it's on, must let the console's port through or nobody will reach it.
if command -v pve-firewall >/dev/null && pve-firewall status 2>/dev/null | grep -qi 'enabled'; then
  if ! { command -v pvesh >/dev/null && pvesh get /cluster/firewall/rules --output-format json 2>/dev/null | grep -Eq "\"dport\"[^,}]*\"?$PORT\"?"; }; then
    warn "the Proxmox firewall is on and no rule allows port $PORT. If the console doesn't load, add one: Datacenter → Firewall → Add (Direction in, Action ACCEPT, Protocol tcp, Dest. port $PORT)."
  fi
fi

# ---- stage the new version beside the old one --------------------------------------------------------------------
cleanup_stage() { rm -rf "${STAGE:?}" "${TMPDIR_EPC:-/nonexistent}"; }
TMPDIR_EPC="$(mktemp -d)"
trap cleanup_stage EXIT
rm -rf "${STAGE:?}"
install -d -m 0755 "$STAGE" "$STAGE/console"

if [ -x "$PREFIX/node/bin/node" ] && [ "$("$PREFIX/node/bin/node" -p process.versions.node 2>/dev/null)" = "$NODE_VERSION" ]; then
  cp -a "$PREFIX/node" "$STAGE/node"
elif [ "${EPC_SKIP_NODE:-}" = "1" ]; then
  # Testing only: use the Node.js already on this machine.
  install -d "$STAGE/node/bin"; ln -s "$(command -v node)" "$STAGE/node/bin/node"
else
  say "downloading Node.js $NODE_VERSION (checked against a pinned checksum)"
  want="NODE_SHA256_$ARCH"; want="${!want}"
  file="node-v$NODE_VERSION-linux-$ARCH.tar.xz"
  curl -fsSL --retry 3 -o "$TMPDIR_EPC/$file" "https://nodejs.org/dist/v$NODE_VERSION/$file" || die "couldn't download Node.js from nodejs.org. Check the host's internet access and try again."
  [ "$(sha256sum "$TMPDIR_EPC/$file" | cut -d' ' -f1)" = "$want" ] || die "the Node.js download doesn't match its expected checksum, so it was not used"
  tar -xJf "$TMPDIR_EPC/$file" -C "$TMPDIR_EPC"
  mv "$TMPDIR_EPC/node-v$NODE_VERSION-linux-$ARCH" "$STAGE/node"
  rm -rf "$STAGE/node/share" "$STAGE/node/include" "$STAGE/node/lib/node_modules"
fi

install -m 0644 "$SRC_BUNDLE" "$STAGE/epaperclip.mjs"
cp -r "$SRC_CONSOLE/." "$STAGE/console/"
VERSION_OUT="$(cd "$ROOT" && { cat VERSION 2>/dev/null || git describe --tags --always 2>/dev/null || echo dev; })"
echo "$VERSION_OUT" > "$STAGE/VERSION"
chown -R root:root "$STAGE"
chmod -R a+rX "$STAGE"

# Start the staged copy on a spare local port, plain http, away from Proxmox, and make sure it answers.
test_port=$((40000 + RANDOM % 20000))
EPC_DEV_HTTP=1 EPC_LISTEN="127.0.0.1:$test_port" EPC_PVE_CA=/dev/null EPC_STATIC="$STAGE/console" "$STAGE/node/bin/node" "$STAGE/epaperclip.mjs" >"$TMPDIR_EPC/stage.log" 2>&1 &
stage_pid=$!
ok=0
for _ in $(seq 1 30); do curl -fs --max-time 1 "http://127.0.0.1:$test_port/api/health" >/dev/null 2>&1 && { ok=1; break; }; sleep 0.3; done
kill "$stage_pid" 2>/dev/null || true; wait "$stage_pid" 2>/dev/null || true
if [ "$ok" -ne 1 ]; then cat "$TMPDIR_EPC/stage.log" >&2; die "the new version doesn't start on this machine. Nothing was changed."; fi

# ---- swap it in, with the way back ready --------------------------------------------------------------------------
first_install=1; [ -d "$PREFIX" ] && first_install=0
systemctl stop epaperclip 2>/dev/null || true
if [ "$first_install" -eq 0 ]; then rm -rf "${PREV:?}"; mv "$PREFIX" "$PREV"; fi
mv "$STAGE" "$PREFIX"
[ -f "$SERVICE" ] && cp -f "$SERVICE" "$UNIT_PREV"
install -d "$UNIT_DIR"
install -m 0644 "$ROOT/deploy/epaperclip.service" "$SERVICE"
[ -f "$DEFAULTS" ] || { install -d "$(dirname "$DEFAULTS")"; install -m 0644 "$ROOT/deploy/epaperclip.default" "$DEFAULTS"; }
systemctl daemon-reload
systemctl enable epaperclip >/dev/null 2>&1 || true
systemctl start epaperclip || true

if wait_healthy; then
  # The service answers. Check it can also reach Proxmox's sign-in, which is what makes it useful.
  if curl -fsk --max-time 5 "$(health_url)/api/realms" >/dev/null 2>&1; then proxmox="reaches Proxmox's sign-in"; else proxmox="could NOT reach Proxmox's sign-in (journalctl -u epaperclip -n 30)"; fi
  say "installed $(installed_version): running, $proxmox."
  say "open https://$(host_ip)$([ "$PORT" = 443 ] || echo ":$PORT")/ (or https://$(host_name)/) and sign in with your Proxmox account."
  say "Proxmox's own interface is untouched at https://$(host_ip):8006/ — keep it as your way back in."
  [ "$first_install" -eq 1 ] || say "to go back to the previous version: sudo ./deploy/install.sh --rollback"
  exit 0
fi

# ---- it didn't come up: put things back ---------------------------------------------------------------------------
warn "the new version didn't become healthy; putting things back."
journalctl -u epaperclip -n 30 --no-pager 2>/dev/null || true
systemctl stop epaperclip 2>/dev/null || true
if [ "$first_install" -eq 0 ]; then
  rm -rf "${PREFIX:?}"; mv "$PREV" "$PREFIX"
  [ -f "$UNIT_PREV" ] && mv -f "$UNIT_PREV" "$SERVICE"
  systemctl daemon-reload; systemctl start epaperclip || true
  die "installation failed; the previous version ($(installed_version)) was restored."
fi
systemctl disable epaperclip >/dev/null 2>&1 || true
rm -f "$SERVICE" "$UNIT_PREV"; systemctl daemon-reload
rm -rf "${PREFIX:?}"
die "installation failed and was removed. Proxmox's interface is unchanged at https://$(host_ip):8006/"
