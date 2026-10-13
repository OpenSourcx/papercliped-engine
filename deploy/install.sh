#!/usr/bin/env bash
# Installs, upgrades, rolls back and removes ePaperclip on a Proxmox VE host.
#
#   sudo ./deploy/install.sh              install or upgrade
#   sudo ./deploy/install.sh --rollback   go back to the previous version
#   sudo ./deploy/install.sh --status     what's installed and whether it's healthy
#   sudo ./deploy/install.sh --uninstall  remove it (keeps its data and settings; --purge removes those too)
#
# Works from a release download (epaperclip.mjs, console/ and engine/ next to this script's deploy/ folder), from the
# Debian package (/usr/share/epaperclip) or from a built checkout of the repository.
#
# Two services: epaperclip (the console and host service, port 443) and epaperclip-engine (Paperclip, the published npm
# package at the exact version in engine/package-lock.json, on 127.0.0.1:3100 only). Both run as their own users.
#
# What it promises:
#   - It never touches Proxmox's own web interface. That stays on :8006, always, as the way back in.
#   - It checks everything it needs first and says what's missing before changing anything.
#   - It brings its own Node.js (a pinned, checksum-verified copy in /opt/epaperclip/node), so the host's Node isn't
#     used or changed. The engine is installed with npm ci from the lockfile: every package checked against its hash,
#     and no package's install scripts are run.
#   - The new version is built and test-started on the side, then swapped in. If the swapped-in services don't come up
#     healthy, the previous version (or nothing, on a first install) is put back automatically, including the engine's
#     database when the engine version changed.
#   - The engine's settings (/etc/epaperclip/engine.env, with its secrets) are written once and never overwritten.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The EPC_* paths below can be moved for testing (deploy/test/run.sh); on a real host leave them alone.
PREFIX="${EPC_PREFIX:-/opt/epaperclip}"
UNIT_DIR="${EPC_UNIT_DIR:-/etc/systemd/system}"
DEFAULTS="${EPC_DEFAULTS:-/etc/default/epaperclip}"
ETC_DIR="${EPC_ETC_DIR:-/etc/epaperclip}"
ENGINE_HOME="${EPC_ENGINE_HOME:-/var/lib/epaperclip-engine}"
HOST_STATE="${EPC_HOST_STATE_DIR:-/var/lib/epaperclip}"
ENGINE_ENV="$ETC_DIR/engine.env"
SERVICE="$UNIT_DIR/epaperclip.service"
ENGINE_SERVICE="$UNIT_DIR/epaperclip-engine.service"
UPDATE_SERVICE="$UNIT_DIR/epaperclip-update.service"
UPDATE_PATH="$UNIT_DIR/epaperclip-update.path"
UNITS=(epaperclip epaperclip-engine)
STAGE="$PREFIX.new"
PREV="$PREFIX.prev"
ENGINE_USER="epaperclip-engine"
ENGINE_PORT=3100
ENGINE_ENTRY="engine/node_modules/@paperclipai/server/dist/index.js"
DB_DIR="$ENGINE_HOME/instances/default/db"
SNAPSHOT="$ENGINE_HOME/pre-upgrade"
BACKUPS="$ENGINE_HOME/instances/default/data/backups"

# The Node.js that runs both services, pinned by version and checksum (from https://nodejs.org/dist/v24.21.0/SHASUMS256.txt).
NODE_VERSION="24.21.0"
NODE_SHA256_x64="fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"
NODE_SHA256_arm64="6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2"

say()  { echo "epaperclip: $*"; }
warn() { echo "epaperclip: warning: $*" >&2; }
die()  { echo "epaperclip: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (for example: sudo ./deploy/install.sh)"

# ---- where things are: a release download (or the Debian package), or a built checkout ----------------------------
if [ -f "$ROOT/epaperclip.mjs" ]; then
  SRC_BUNDLE="$ROOT/epaperclip.mjs"; SRC_CONSOLE="$ROOT/console"
else
  SRC_BUNDLE="$ROOT/services/epaperclip/dist/epaperclip.mjs"; SRC_CONSOLE="$ROOT/apps/console/dist"
fi
SRC_ENGINE="$ROOT/engine"
# The Proxmox sandbox provider (agent containers): built code and lockfile; its production packages are installed below.
SRC_PLUGIN="$ROOT/plugins/proxmox-sandbox"
PLUGIN_REL="plugins/proxmox-sandbox"

listen_port() {
  local l=""
  [ -f "$DEFAULTS" ] && l="$(sed -n 's/^EPC_LISTEN=//p' "$DEFAULTS" | tail -n1 | tr -d "\"' ")"
  echo "${l##*:}" | grep -E '^[0-9]+$' || echo 443
}
PORT="$(listen_port)"
health_url() { echo "${EPC_HEALTH_URL:-https://127.0.0.1:$PORT}"; }
engine_url() { echo "${EPC_ENGINE_HEALTH_URL:-http://127.0.0.1:$ENGINE_PORT}"; }

active() { systemctl is-active -q "$1" 2>/dev/null; }
wait_healthy() { # the host service, up to ~20 s
  local i
  for i in $(seq 1 "$((2 * ${EPC_HOST_WAIT:-20}))"); do
    curl -fsk --max-time 2 "$(health_url)/api/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}
wait_engine() { # up to ~3 minutes: its first start sets up its database (a few hundred migrations)
  local limit="${EPC_ENGINE_WAIT:-180}" start=$SECONDS next=15
  say "waiting for the engine to answer (its first start sets up its database; this can take up to $((limit / 60 > 0 ? limit / 60 : 1)) minutes)"
  while [ $((SECONDS - start)) -lt "$limit" ]; do
    curl -fs --max-time 2 "${1:-$(engine_url)}/api/health" >/dev/null 2>&1 && return 0
    if [ $((SECONDS - start)) -ge "$next" ]; then say "  still starting ($((SECONDS - start)) s)"; next=$((next + 15)); fi
    [ -z "${2:-}" ] || kill -0 "$2" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}
installed_version() { [ -f "${1:-$PREFIX}/VERSION" ] && cat "${1:-$PREFIX}/VERSION" || echo "none"; }
# The engine version a tree holds, read from its lockfile (no Node.js needed).
engine_version() {
  local lock="$1/package-lock.json" v=""
  [ -f "$lock" ] && v="$(sed -n '/"node_modules\/paperclipai": {/,/}/{s/^ *"version": "\([^"]*\)".*/\1/p}' "$lock" | head -n1)"
  echo "${v:-none}"
}
engine_fingerprint() { cat "$1/package.json" "$1/package-lock.json" 2>/dev/null | sha256sum | cut -d' ' -f1; }
plugin_version() { sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "${1:-$PREFIX}/$PLUGIN_REL/package.json" 2>/dev/null | head -n1; }
host_name() { hostname -f 2>/dev/null || hostname; }
host_ip() { hostname -I 2>/dev/null | awk '{print $1}'; }
latest_backup() { ls -1t "$BACKUPS" 2>/dev/null | head -n1; }

# Units: a version's units are kept inside its tree (.units/) when it becomes the previous one, so a rollback puts back
# exactly the units it ran with; a unit it didn't have is removed. (Older versions kept epaperclip.service.prev.)
save_units() {
  local u; install -d -m 0755 "$1"
  for u in "${UNITS[@]}"; do [ -f "$UNIT_DIR/$u.service" ] && cp -f "$UNIT_DIR/$u.service" "$1/$u.service"; done
  return 0
}
restore_units() {
  local u src
  for u in "${UNITS[@]}"; do
    src="$1/$u.service"
    if [ ! -f "$src" ] && [ "$u" = epaperclip ]; then src="$SERVICE.prev"; fi
    if [ -f "$src" ]; then install -m 0644 "$src" "$UNIT_DIR/$u.service"
    else systemctl disable "$u" >/dev/null 2>&1 || true; rm -f "$UNIT_DIR/$u.service"; fi
  done
  rm -f "$SERVICE.prev"
  systemctl daemon-reload
}
start_all() { # the engine first, if this version has one
  [ -f "$ENGINE_SERVICE" ] && { systemctl enable epaperclip-engine >/dev/null 2>&1 || true; systemctl start epaperclip-engine || true; }
  systemctl enable epaperclip >/dev/null 2>&1 || true
  systemctl start epaperclip || true
}
healthy_all() { { [ ! -f "$ENGINE_SERVICE" ] || wait_engine; } && wait_healthy; }
stop_all() { systemctl stop epaperclip epaperclip-engine 2>/dev/null || true; }

ACTION="${1:-}"
case "$ACTION" in ""|--install|--status|--rollback|--uninstall|--purge) ;; *) die "unknown option $ACTION (use --status, --rollback, --uninstall or --purge)" ;; esac
[ "$#" -le 1 ] || die "one option at a time, please (got: $*)"

# ---- --status ---------------------------------------------------------------------------------------------------
if [ "$ACTION" = "--status" ]; then
  say "version: $(installed_version)$([ -d "$PREV" ] && echo " (previous: $(installed_version "$PREV"))")"
  say "engine: paperclipai $(engine_version "$PREFIX/engine")$([ -d "$PREV" ] && echo " (previous: $(engine_version "$PREV/engine"))")"
  say "agent container provider: $(plugin_version || echo none) ($PREFIX/$PLUGIN_REL)"
  for u in "${UNITS[@]}"; do if active "$u"; then say "$u.service: running"; else say "$u.service: not running"; fi; done
  if h="$(curl -fs --max-time 3 "$(engine_url)/api/health" 2>/dev/null)"; then
    say "engine health: ok on 127.0.0.1:$ENGINE_PORT (setup: $(echo "$h" | sed -n 's/.*"bootstrapStatus":"\([^"]*\)".*/\1/p'))"
  else say "engine health: no answer on 127.0.0.1:$ENGINE_PORT"; fi
  if EPC_HOST_WAIT=3 wait_healthy; then say "health: ok at https://$(host_ip):$PORT/"; else say "health: no answer on port $PORT"; fi
  b="$(latest_backup || true)"
  say "engine data: $ENGINE_HOME (latest hourly backup: ${b:+$BACKUPS/}${b:-none yet})"
  command -v pveversion >/dev/null && say "proxmox: $(pveversion)"
  exit 0
fi

# ---- --uninstall / --purge --------------------------------------------------------------------------------------
if [ "$ACTION" = "--uninstall" ] || [ "$ACTION" = "--purge" ]; then
  systemctl disable --now epaperclip epaperclip-engine epaperclip-update.path 2>/dev/null || true
  rm -f "$SERVICE" "$ENGINE_SERVICE" "$SERVICE.prev" "$UPDATE_SERVICE" "$UPDATE_PATH"
  systemctl daemon-reload 2>/dev/null || true
  rm -rf "${PREFIX:?}" "${PREV:?}" "${STAGE:?}" "${PREFIX:?}.failed"
  if [ "$ACTION" = "--purge" ]; then
    rm -rf "${ENGINE_HOME:?}" "${HOST_STATE:?}" "${ETC_DIR:?}"; rm -f "$DEFAULTS"
    for u in epaperclip "$ENGINE_USER"; do id "$u" >/dev/null 2>&1 && userdel "$u" 2>/dev/null || true; done
    say "removed, including all its data, settings and users."
  else
    say "removed. Kept, in case you install again (--purge removes them):"
    say "  engine data (organizations, agents, tasks) and its hourly backups: $ENGINE_HOME"
    say "  host service vault and settings: $HOST_STATE"
    say "  settings: $ETC_DIR and $DEFAULTS; the epaperclip and $ENGINE_USER users"
  fi
  say "Proxmox's own interface was never changed and is still at https://$(host_ip):8006/"
  exit 0
fi

# ---- --rollback -------------------------------------------------------------------------------------------------
if [ "$ACTION" = "--rollback" ]; then
  [ -d "$PREV" ] || die "there is no previous version to go back to"
  cur_engine="$(engine_version "$PREFIX/engine")"; prev_engine="$(engine_version "$PREV/engine")"
  stop_all
  rm -rf "${PREFIX:?}.failed"
  mv "$PREFIX" "$PREFIX.failed"
  mv "$PREV" "$PREFIX"
  restore_units "$PREFIX/.units"
  # A different engine version means a different database schema: put back the copy taken before the upgrade, and
  # keep the newer database beside it rather than deleting anything.
  if [ "$prev_engine" != "$cur_engine" ] && [ "$prev_engine" != "none" ] && [ -d "$DB_DIR" ]; then
    if [ -d "$SNAPSHOT/db" ] && [ "$(cat "$SNAPSHOT/ENGINE_VERSION" 2>/dev/null)" = "$prev_engine" ]; then
      aside="$DB_DIR.from-$cur_engine-$(date +%Y%m%d-%H%M%S)"
      mv "$DB_DIR" "$aside"; mv "$SNAPSHOT/db" "$DB_DIR"; rm -rf "${SNAPSHOT:?}"
      say "the engine's database went back to how it was before the upgrade to $cur_engine; the newer one is kept at $aside"
    else
      warn "no copy of the engine's database from before $cur_engine was found; engine $prev_engine will start on the newer database. If it won't, restore a backup from $BACKUPS"
    fi
  fi
  start_all
  if healthy_all; then rm -rf "${PREFIX:?}.failed"; say "rolled back to $(installed_version) (engine $(engine_version "$PREFIX/engine"))."; exit 0; fi
  die "rolled back, but the services didn't answer. See: journalctl -u epaperclip-engine -u epaperclip -n 50"
fi

# ---- preflight: find every problem before changing anything -----------------------------------------------------
problems=()
need() { problems+=("$1"); }
mb_free() { local d="$1"; while [ ! -d "$d" ]; do d="$(dirname "$d")"; done; df -Pk "$d" | awk 'NR==2{print int($4/1024)}'; }
dev_of() { local d="$1"; while [ ! -d "$d" ]; do d="$(dirname "$d")"; done; stat -c %d "$d"; }

command -v pveversion >/dev/null || need "this isn't a Proxmox VE host (pveversion wasn't found)"
if command -v pveversion >/dev/null; then
  pvemajor="$(pveversion 2>/dev/null | sed -n 's|^pve-manager/\([0-9]*\)\..*|\1|p' || true)"
  { [ -n "$pvemajor" ] && [ "$pvemajor" -ge 8 ]; } || need "Proxmox VE 8 or newer is needed (found: $(pveversion 2>&1 | head -n1))"
fi
case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64) ARCH=arm64 ;; *) ARCH=""; need "unsupported processor: $(uname -m) (x86_64 and aarch64 are supported)" ;; esac
for c in curl tar xz sha256sum useradd setpriv setsid ss systemctl; do command -v "$c" >/dev/null || need "the '$c' command is missing (apt-get install -y curl xz-utils util-linux iproute2)"; done
[ -f "$SRC_BUNDLE" ] || need "the service isn't built (expected $SRC_BUNDLE). From a checkout: pnpm install && pnpm build"
[ -f "$SRC_CONSOLE/index.html" ] || need "the console isn't built (expected $SRC_CONSOLE/index.html)"
for f in deploy/epaperclip.service deploy/epaperclip-engine.service deploy/engine-links.mjs engine/package.json engine/package-lock.json \
  $PLUGIN_REL/dist/manifest.js $PLUGIN_REL/dist/worker.js $PLUGIN_REL/package.json $PLUGIN_REL/package-lock.json $PLUGIN_REL/template/provision.sh $PLUGIN_REL/template/versions.sh; do
  [ -f "$ROOT/$f" ] || need "$f is missing from this download"
done
systemctl is-active -q pveproxy 2>/dev/null || need "Proxmox's own web service (pveproxy) isn't running, and ePaperclip signs people in through it"
if ss -Hltn "sport = :$PORT" 2>/dev/null | grep -q . && ! active epaperclip; then need "something else is listening on port $PORT; stop it, or set EPC_LISTEN=0.0.0.0:<another port> in $DEFAULTS and run this again"; fi
if ss -Hltn "sport = :$ENGINE_PORT" 2>/dev/null | grep -q . && ! active epaperclip-engine; then need "something else is listening on port $ENGINE_PORT, which the engine needs on 127.0.0.1; stop it and run this again"; fi
if [ "${EPC_SKIP_CERT_CHECK:-}" != "1" ]; then
  for f in /etc/pve/local/pve-ssl.pem /etc/pve/local/pve-ssl.key /etc/pve/pve-root-ca.pem; do
    [ -r "$f" ] || { need "$f can't be read (is the cluster filesystem up? try: systemctl status pve-cluster)"; continue; }
  done
fi

# Memory: the engine uses about 1 GB at idle (server and its PostgreSQL). ZFS's cache counts as used, so only the total
# can fail the check.
mem_kb() { sed -n "s/^$1: *\([0-9]*\) kB/\1/p" "${EPC_MEMINFO:-/proc/meminfo}"; }
mem_total="$(mem_kb MemTotal)"; mem_avail="$(mem_kb MemAvailable)"
if [ -n "$mem_total" ] && [ "$mem_total" -lt 2000000 ]; then need "the host has $((mem_total / 1024)) MB of memory; the engine needs at least 2 GB (4 GB or more recommended)"
elif [ -n "$mem_total" ] && [ "$mem_total" -lt 3900000 ]; then warn "the host has $((mem_total / 1024)) MB of memory; 4 GB or more is recommended (the engine uses about 1 GB)"; fi
if [ -n "$mem_avail" ] && [ "$mem_avail" -lt 1500000 ] && ! active epaperclip-engine; then warn "only $((mem_avail / 1024)) MB of memory is free right now; the engine needs about 1 GB"; fi

# The engine: installed fresh only when its lockfile changed; otherwise the installed copy is reused as it is.
engine_reuse=0
if [ -f "$PREFIX/$ENGINE_ENTRY" ] && [ "$(engine_fingerprint "$PREFIX/engine")" = "$(engine_fingerprint "$SRC_ENGINE")" ]; then engine_reuse=1; fi
old_engine="$(engine_version "$PREFIX/engine")"; new_engine="$(engine_version "$SRC_ENGINE")"
[ "$new_engine" != "none" ] || need "engine/package-lock.json doesn't name a paperclipai version"
snapshot_mb=0
if [ "$old_engine" != "none" ] && [ "$old_engine" != "$new_engine" ] && [ -d "$DB_DIR" ]; then
  snapshot_mb=$(( $(du -sk "$DB_DIR" | cut -f1) / 1024 + 1 ))
fi
# The provider's production packages: kept when its lockfile is unchanged.
plugin_fingerprint() { cat "$1/package.json" "$1/package-lock.json" 2>/dev/null | sha256sum | cut -d' ' -f1; }
plugin_reuse=0
if [ -d "$PREFIX/$PLUGIN_REL/node_modules" ] && [ "$(plugin_fingerprint "$PREFIX/$PLUGIN_REL")" = "$(plugin_fingerprint "$SRC_PLUGIN")" ]; then plugin_reuse=1; fi
if { [ "$engine_reuse" -eq 0 ] || [ "$plugin_reuse" -eq 0 ]; } && [ "${EPC_SKIP_ENGINE_NPM:-}" != "1" ]; then
  curl -fsI --max-time 15 https://registry.npmjs.org/paperclipai >/dev/null 2>&1 || need "the engine is installed from registry.npmjs.org, which this host can't reach right now"
fi

# Disk: about 1.4 GB for a new engine tree (the previous one is kept for rollback), 400 MB for the rest, and room for
# the engine's data, plus a copy of its database before an engine upgrade.
opt_mb=450; [ "$engine_reuse" -eq 1 ] || opt_mb=$((opt_mb + 1800))
var_mb=$((500 + snapshot_mb))
if [ "$(dev_of "$(dirname "$PREFIX")")" = "$(dev_of "$(dirname "$ENGINE_HOME")")" ]; then
  free="$(mb_free "$(dirname "$PREFIX")")"
  [ "$free" -ge $((opt_mb + var_mb)) ] || need "$((opt_mb + var_mb)) MB of free disk is needed where $PREFIX and $ENGINE_HOME go; there is $free MB"
else
  free="$(mb_free "$(dirname "$PREFIX")")"; [ "$free" -ge "$opt_mb" ] || need "$opt_mb MB of free disk is needed where $PREFIX goes; there is $free MB"
  free="$(mb_free "$(dirname "$ENGINE_HOME")")"; [ "$free" -ge "$var_mb" ] || need "$var_mb MB of free disk is needed where $ENGINE_HOME goes; there is $free MB"
fi

if [ "${#problems[@]}" -gt 0 ]; then
  echo "epaperclip: can't install yet:" >&2
  for p in "${problems[@]}"; do echo "  - $p" >&2; done
  echo "epaperclip: nothing was changed." >&2
  exit 1
fi

# ---- from here on, anything that fails before the swap is undone ---------------------------------------------------
SWAPPED=0; created=()
TMPDIR_EPC="$(mktemp -d)"; ENGINE_TEST_HOME=""
undo_created() {
  local p; for p in ${created[@]+"${created[@]}"}; do rm -rf "${p:?}"; done
  [ -z "${ENV_ORIG:-}" ] || cp -p "$ENV_ORIG" "$ENGINE_ENV"
}
on_exit() {
  local rc=$?
  [ -z "${ENGINE_TEST_PID:-}" ] || kill -KILL -- "-$ENGINE_TEST_PID" 2>/dev/null || true
  if [ "$rc" -ne 0 ] && [ "$SWAPPED" -eq 0 ]; then undo_created; fi
  rm -rf "${STAGE:?}" "${TMPDIR_EPC:-/nonexistent}" ${ENGINE_TEST_HOME:+"$ENGINE_TEST_HOME"}
}
trap on_exit EXIT

# The service users, and proof the host service can read the node's certificate the way Proxmox's own web service does.
id epaperclip >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin epaperclip
id "$ENGINE_USER" >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir "$ENGINE_HOME" --shell /usr/sbin/nologin "$ENGINE_USER"
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

# Data and settings directories. engine.env is written once, with fresh secrets, and its lines are never changed after.
# The engine's fixed settings (docs/ENGINE.md, "Contracts between the parts"); an upgrade only adds ones that are missing.
# The engine only listens on loopback and every sign-in reaches it from 127.0.0.1 through the host service, which limits
# sign-in attempts itself, so the engine's own per-address sign-in limit would only throttle everyone at once.
ENGINE_FIXED=(PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_DEPLOYMENT_EXPOSURE=private HOST=127.0.0.1 PORT=$ENGINE_PORT
  PAPERCLIP_PUBLIC_URL=http://127.0.0.1:$ENGINE_PORT PAPERCLIP_ALLOWED_HOSTNAMES=127.0.0.1,localhost
  PAPERCLIP_API_URL=http://127.0.0.1:$ENGINE_PORT PAPERCLIP_MIGRATION_AUTO_APPLY=true SERVE_UI=false
  PAPERCLIP_AUTH_RATE_LIMIT_ENABLED=false)
rand_hex() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }
[ -d "$ETC_DIR" ] || { install -d -m 0755 "$ETC_DIR"; created+=("$ETC_DIR"); }
if [ ! -f "$ENGINE_ENV" ]; then
  (umask 077
   { echo "# ePaperclip engine settings, written once at install with fresh secrets. Upgrades never change these lines."
     echo "# Restart after changing: systemctl restart epaperclip-engine"
     echo "BETTER_AUTH_SECRET=$(rand_hex)"
     echo "PAPERCLIP_AGENT_JWT_SECRET=$(rand_hex)"
     printf '%s\n' "${ENGINE_FIXED[@]}"
     echo "# Paperclip's anonymous usage reporting is off here. Remove this line to turn it on."
     echo "PAPERCLIP_TELEMETRY_DISABLED=1"
   } >"$ENGINE_ENV.tmp")
  chown root:root "$ENGINE_ENV.tmp"; chmod 0600 "$ENGINE_ENV.tmp"; mv "$ENGINE_ENV.tmp" "$ENGINE_ENV"
  created+=("$ENGINE_ENV")
else
  missing=(); for kv in "${ENGINE_FIXED[@]}"; do grep -q "^${kv%%=*}=" "$ENGINE_ENV" || missing+=("$kv"); done
  if [ "${#missing[@]}" -gt 0 ]; then
    ENV_ORIG="$TMPDIR_EPC/engine.env.orig"; cp -p "$ENGINE_ENV" "$ENV_ORIG"
    { echo "# Added by the upgrade to $(cat "$ROOT/VERSION" 2>/dev/null || echo this version):"; printf '%s\n' "${missing[@]}"; } >>"$ENGINE_ENV"
    say "added to $ENGINE_ENV: ${missing[*]%%=*}"
  fi
fi
for d in "$ENGINE_HOME:$ENGINE_USER" "$HOST_STATE:epaperclip"; do
  [ -d "${d%%:*}" ] && continue
  install -d -m 0700 "${d%%:*}"; chown "${d##*:}:${d##*:}" "${d%%:*}"; created+=("${d%%:*}")
done

# ---- stage the new version beside the old one --------------------------------------------------------------------
rm -rf "${STAGE:?}"
install -d -m 0755 "$STAGE" "$STAGE/console" "$STAGE/engine"
NODE="$STAGE/node/bin/node"; NPM_CLI="$STAGE/node/lib/node_modules/npm/bin/npm-cli.js"

if [ -x "$PREFIX/node/bin/node" ] && [ -f "$PREFIX/node/lib/node_modules/npm/bin/npm-cli.js" ] && [ "$("$PREFIX/node/bin/node" -p process.versions.node 2>/dev/null)" = "$NODE_VERSION" ]; then
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
  # npm stays: it installs the engine from its lockfile.
  rm -rf "$STAGE/node/share" "$STAGE/node/include" "$STAGE/node/lib/node_modules/corepack" "$STAGE/node/bin/corepack"
fi

install -m 0644 "$SRC_BUNDLE" "$STAGE/epaperclip.mjs"
cp -r "$SRC_CONSOLE/." "$STAGE/console/"
VERSION_OUT="$(cd "$ROOT" && { cat VERSION 2>/dev/null || git describe --tags --always 2>/dev/null || echo dev; })"
echo "$VERSION_OUT" > "$STAGE/VERSION"
# The update helper the console's "Update" button uses (root-owned, outside the sandboxed host service): this installer
# is kept beside it so a rollback can be asked for the same way. Releases from before the helper simply don't have it.
if [ -f "$ROOT/deploy/epaperclip-update.sh" ]; then
  install -d -m 0755 "$STAGE/update"
  install -m 0755 "$ROOT/deploy/epaperclip-update.sh" "$STAGE/update/run.sh"
  install -m 0755 "$ROOT/deploy/install.sh" "$STAGE/update/install.sh"
fi

install -m 0644 "$SRC_ENGINE/package.json" "$SRC_ENGINE/package-lock.json" "$STAGE/engine/"
engine_fresh=0
if [ "$engine_reuse" -eq 1 ]; then
  # Same lockfile: the installed engine is reused. Hard links make that instant and take no space; nothing writes to
  # these files (the tree is root's and read-only to the engine).
  cp -al "$PREFIX/engine/node_modules" "$STAGE/engine/node_modules" 2>/dev/null || cp -a "$PREFIX/engine/node_modules" "$STAGE/engine/node_modules"
elif [ "${EPC_SKIP_ENGINE_NPM:-}" = "1" ]; then
  # Testing only: a stand-in engine that answers /api/health (deploy/test/fake-engine.mjs).
  [ -f "${EPC_FAKE_ENGINE:-}" ] || die "EPC_SKIP_ENGINE_NPM=1 needs EPC_FAKE_ENGINE set to a stand-in entry point"
  install -D -m 0644 "$EPC_FAKE_ENGINE" "$STAGE/$ENGINE_ENTRY"
  engine_fresh=1
else
  say "installing the engine (Paperclip $new_engine) from its lockfile; this takes about 2 minutes"
  # Only the lockfile decides what's installed, every package is checked against its integrity hash, and no package's
  # install scripts run. The host's own npm settings aren't read.
  # (Settings on the command line win over any npm settings in the environment; a proxy in it is still used.)
  : >"$TMPDIR_EPC/npmrc-user"; : >"$TMPDIR_EPC/npmrc-global"
  (cd "$STAGE/engine" && HOME="$TMPDIR_EPC" "$NODE" "$NPM_CLI" ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error \
    --registry=https://registry.npmjs.org/ --userconfig="$TMPDIR_EPC/npmrc-user" --globalconfig="$TMPDIR_EPC/npmrc-global" \
    --cache="$TMPDIR_EPC/npm-cache" --update-notifier=false) >"$TMPDIR_EPC/npm.log" 2>&1 \
    || { tail -n 30 "$TMPDIR_EPC/npm.log" >&2; die "couldn't install the engine from registry.npmjs.org. Nothing was changed."; }
  "$NODE" "$ROOT/deploy/engine-links.mjs" "$STAGE/engine" >/dev/null || die "the engine's database binaries couldn't be prepared. Nothing was changed."
  [ -f "$STAGE/$ENGINE_ENTRY" ] || die "the engine installed, but $ENGINE_ENTRY isn't in it. Nothing was changed."
  engine_fresh=1
fi
# The provider the engine loads for agent containers (setup is done from the console, by a Proxmox administrator). It sits
# under the install prefix so an upgrade, a rollback and an uninstall move it with everything else. Its production
# packages come from its own lockfile, checked against integrity hashes, with no install scripts, like the engine's.
install -d -m 0755 "$STAGE/$PLUGIN_REL"
cp -r "$SRC_PLUGIN/dist" "$SRC_PLUGIN/template" "$STAGE/$PLUGIN_REL/"
install -m 0644 "$SRC_PLUGIN/package.json" "$SRC_PLUGIN/package-lock.json" "$STAGE/$PLUGIN_REL/"
[ ! -f "$SRC_PLUGIN/README.md" ] || install -m 0644 "$SRC_PLUGIN/README.md" "$STAGE/$PLUGIN_REL/"
if [ "$plugin_reuse" -eq 1 ]; then
  cp -al "$PREFIX/$PLUGIN_REL/node_modules" "$STAGE/$PLUGIN_REL/node_modules" 2>/dev/null || cp -a "$PREFIX/$PLUGIN_REL/node_modules" "$STAGE/$PLUGIN_REL/node_modules"
elif [ "${EPC_SKIP_ENGINE_NPM:-}" = "1" ]; then
  install -d "$STAGE/$PLUGIN_REL/node_modules"   # testing only
else
  say "installing the agent container provider's packages from its lockfile"
  : >"$TMPDIR_EPC/npmrc-user"; : >"$TMPDIR_EPC/npmrc-global"
  (cd "$STAGE/$PLUGIN_REL" && HOME="$TMPDIR_EPC" "$NODE" "$NPM_CLI" ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error \
    --registry=https://registry.npmjs.org/ --userconfig="$TMPDIR_EPC/npmrc-user" --globalconfig="$TMPDIR_EPC/npmrc-global" \
    --cache="$TMPDIR_EPC/npm-cache" --update-notifier=false) >"$TMPDIR_EPC/npm-plugin.log" 2>&1 \
    || { tail -n 30 "$TMPDIR_EPC/npm-plugin.log" >&2; die "couldn't install the agent container provider's packages from registry.npmjs.org. Nothing was changed."; }
  [ -f "$STAGE/$PLUGIN_REL/node_modules/@paperclipai/plugin-sdk/package.json" ] || die "the agent container provider installed, but its SDK isn't in it. Nothing was changed."
fi
chown -R root:root "$STAGE"
chmod -R a+rX,go-w "$STAGE"

# Start the staged host service on a spare local port, plain http, away from Proxmox, and make sure it answers.
spare_port() { # a random local port nothing answers on
  local p
  while :; do p=$((40000 + RANDOM % 20000)); (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null || { echo "$p"; return; }; done
}
test_port="$(spare_port)"
install -d -m 0700 "$TMPDIR_EPC/state"
EPC_DEV_HTTP=1 EPC_LISTEN="127.0.0.1:$test_port" EPC_PVE_CA=/dev/null EPC_STATIC="$STAGE/console" EPC_STATE_DIR="$TMPDIR_EPC/state" \
  EPC_ENGINE_URL="http://127.0.0.1:9" EPC_ENGINE_DIR="$STAGE/engine" "$NODE" "$STAGE/epaperclip.mjs" >"$TMPDIR_EPC/stage.log" 2>&1 &
stage_pid=$!
ok=0
for _ in $(seq 1 60); do curl -fs --max-time 1 "http://127.0.0.1:$test_port/api/health" >/dev/null 2>&1 && { ok=1; break; }; sleep 0.3; done
kill "$stage_pid" 2>/dev/null || true; wait "$stage_pid" 2>/dev/null || true
if [ "$ok" -ne 1 ]; then cat "$TMPDIR_EPC/stage.log" >&2; die "the new version doesn't start on this machine. Nothing was changed."; fi

# A newly installed engine is test-started too: as its own user, on a spare port, with a throwaway data directory, so the
# real data isn't touched until the swap.
if [ "$engine_fresh" -eq 1 ]; then
  ENGINE_TEST_HOME="$(mktemp -d "$(dirname "$ENGINE_HOME")/.epaperclip-engine-test.XXXXXX")"
  chown "$ENGINE_USER:$ENGINE_USER" "$ENGINE_TEST_HOME"
  etp="$(spare_port)"
  SETPRIV="$(command -v setpriv)"
  (cd "$STAGE/engine" && exec setsid env -i PATH=/usr/bin:/bin HOME="$ENGINE_TEST_HOME" PAPERCLIP_HOME="$ENGINE_TEST_HOME" \
    BETTER_AUTH_SECRET="$(rand_hex)" PAPERCLIP_AGENT_JWT_SECRET="$(rand_hex)" \
    PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_DEPLOYMENT_EXPOSURE=private HOST=127.0.0.1 PORT="$etp" \
    PAPERCLIP_PUBLIC_URL="http://127.0.0.1:$etp" PAPERCLIP_ALLOWED_HOSTNAMES=127.0.0.1,localhost PAPERCLIP_API_URL="http://127.0.0.1:$etp" \
    PAPERCLIP_MIGRATION_AUTO_APPLY=true SERVE_UI=false PAPERCLIP_TELEMETRY_DISABLED=1 PAPERCLIP_DB_BACKUP_ENABLED=false \
    "$SETPRIV" --reuid="$ENGINE_USER" --regid="$ENGINE_USER" --clear-groups "$NODE" "$STAGE/$ENGINE_ENTRY") >"$TMPDIR_EPC/engine.log" 2>&1 &
  ENGINE_TEST_PID=$!
  ok=0; wait_engine "http://127.0.0.1:$etp" "$ENGINE_TEST_PID" && ok=1
  kill -TERM -- "-$ENGINE_TEST_PID" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$ENGINE_TEST_PID" 2>/dev/null || break; sleep 0.5; done
  kill -KILL -- "-$ENGINE_TEST_PID" 2>/dev/null || true; wait "$ENGINE_TEST_PID" 2>/dev/null || true; ENGINE_TEST_PID=""
  if [ "$ok" -ne 1 ]; then tail -n 40 "$TMPDIR_EPC/engine.log" >&2; die "the new engine doesn't start on this machine. Nothing was changed."; fi
  rm -rf "${ENGINE_TEST_HOME:?}"; ENGINE_TEST_HOME=""
fi

# ---- swap it in, with the way back ready --------------------------------------------------------------------------
first_install=1; [ -d "$PREFIX" ] && first_install=0
SWAPPED=1
stop_all
# A new engine version migrates its database forward on first start. Keep a copy of the database as it is now, so a
# rollback (automatic below, or --rollback later) can put it back. Only the latest copy is kept.
snapshot_taken=0
if [ "$snapshot_mb" -gt 0 ]; then
  say "keeping a copy of the engine's database from before the upgrade ($snapshot_mb MB, in $SNAPSHOT)"
  rm -rf "${SNAPSHOT:?}"; install -d -m 0700 "$SNAPSHOT"
  cp -a "$DB_DIR" "$SNAPSHOT/db"; echo "$old_engine" > "$SNAPSHOT/ENGINE_VERSION"
  chown "$ENGINE_USER:$ENGINE_USER" "$SNAPSHOT"; snapshot_taken=1
fi
if [ "$first_install" -eq 0 ]; then rm -rf "${PREV:?}"; mv "$PREFIX" "$PREV"; rm -rf "${PREV:?}/.units"; save_units "$PREV/.units"; fi
mv "$STAGE" "$PREFIX"
rm -f "$SERVICE.prev"
install -d "$UNIT_DIR"
install -m 0644 "$ROOT/deploy/epaperclip.service" "$SERVICE"
install -m 0644 "$ROOT/deploy/epaperclip-engine.service" "$ENGINE_SERVICE"
if [ -f "$ROOT/deploy/epaperclip-update.path" ]; then
  install -m 0644 "$ROOT/deploy/epaperclip-update.service" "$UPDATE_SERVICE"
  install -m 0644 "$ROOT/deploy/epaperclip-update.path" "$UPDATE_PATH"
fi
[ -f "$DEFAULTS" ] || { install -d "$(dirname "$DEFAULTS")"; install -m 0644 "$ROOT/deploy/epaperclip.default" "$DEFAULTS"; created+=("$DEFAULTS"); }
systemctl daemon-reload
# The update helper's trigger is best effort: the console says so when "Update" isn't available, and nothing else depends on it.
if [ -f "$UPDATE_PATH" ]; then systemctl enable --now epaperclip-update.path >/dev/null 2>&1 || warn "couldn't enable the update helper (epaperclip-update.path); the console's Update button won't work, updating from the shell still does"; fi
start_all

if healthy_all; then
  # The service answers. Check it can also reach Proxmox's sign-in, which is what makes it useful.
  if curl -fsk --max-time 5 "$(health_url)/api/realms" >/dev/null 2>&1; then proxmox="reaches Proxmox's sign-in"; else proxmox="could NOT reach Proxmox's sign-in (journalctl -u epaperclip -n 30)"; fi
  say "installed $(installed_version): running, $proxmox."
  say "engine: Paperclip $new_engine on 127.0.0.1:$ENGINE_PORT (loopback only). Its data is in $ENGINE_HOME and it backs itself up every hour into $BACKUPS"
  say "open https://$(host_ip)$([ "$PORT" = 443 ] || echo ":$PORT")/ (or https://$(host_name)/) and sign in with your Proxmox account."
  say "Proxmox's own interface is untouched at https://$(host_ip):8006/ — keep it as your way back in."
  [ "$first_install" -eq 1 ] || say "to go back to the previous version: sudo ./deploy/install.sh --rollback"
  exit 0
fi

# ---- it didn't come up: put things back ---------------------------------------------------------------------------
warn "the new version didn't become healthy; putting things back."
journalctl -u epaperclip-engine -n 30 --no-pager 2>/dev/null || true
journalctl -u epaperclip -n 30 --no-pager 2>/dev/null || true
stop_all
if [ "$snapshot_taken" -eq 1 ]; then rm -rf "${DB_DIR:?}"; mv "$SNAPSHOT/db" "$DB_DIR"; rm -rf "${SNAPSHOT:?}"; fi
if [ "$first_install" -eq 0 ]; then
  rm -rf "${PREFIX:?}"; mv "$PREV" "$PREFIX"
  restore_units "$PREFIX/.units"
  undo_created
  start_all
  if healthy_all >/dev/null; then die "installation failed; the previous version ($(installed_version)) was restored and is running."; fi
  die "installation failed; the previous version ($(installed_version)) was restored, but it isn't answering yet. See: journalctl -u epaperclip-engine -u epaperclip -n 50"
fi
systemctl disable epaperclip epaperclip-engine epaperclip-update.path >/dev/null 2>&1 || true
rm -f "$SERVICE" "$ENGINE_SERVICE" "$UPDATE_SERVICE" "$UPDATE_PATH"; systemctl daemon-reload
rm -rf "${PREFIX:?}"
undo_created
die "installation failed and was removed. Proxmox's interface is unchanged at https://$(host_ip):8006/"
