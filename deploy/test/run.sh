#!/usr/bin/env bash
# Tests deploy/install.sh on simulated Proxmox hosts: no systemd, no real users, no network, about a minute.
#
#   bash deploy/test/run.sh                  every scenario
#   bash deploy/test/run.sh fresh uninstall  only the named ones (see the list at the bottom)
#   EPC_TEST_KEEP=1 bash deploy/test/run.sh  keep the simulated hosts afterwards, for a look
#   bash deploy/test/run.sh deb              the built .deb (release/epaperclip_*_all.deb): skipped when there is none
#   EPC_TEST_REAL_ENGINE=1 bash deploy/test/run.sh real-engine
#                                            as root, with internet: downloads the pinned Node.js, installs the real
#                                            engine from engine/ and runs it as nobody (about 3 minutes)
#
# Each host is a temporary folder. The stand-ins in stubs/ play Proxmox (pveversion), systemd (systemctl, journalctl),
# useradd/userdel/id/chown/setpriv and ss; the installer's EPC_* settings point every path it writes into the folder.
# The host service and the engine are small stand-ins (fake-epaperclip.mjs, fake-engine.mjs) on spare local ports.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
command -v node >/dev/null || { echo "run.sh: node is needed" >&2; exit 1; }
export no_proxy="127.0.0.1,localhost" NO_PROXY="127.0.0.1,localhost"
BASE_PATH="$PATH"
WORK="$(mktemp -d)"
HOSTS=()
pass=0; fail=0; failed=()

cleanup() {
  local h p
  for h in ${HOSTS[@]+"${HOSTS[@]}"}; do
    for p in "$h"/stub/*.pid; do [ -f "$p" ] && { kill -KILL -- "-$(cat "$p")" 2>/dev/null || kill -KILL "$(cat "$p")" 2>/dev/null; }; done
  done
  if [ "${EPC_TEST_KEEP:-}" = 1 ]; then echo "kept: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

ok()  { pass=$((pass + 1)); echo "  ok   $1"; }
bad() { fail=$((fail + 1)); failed+=("$SCEN: $1"); echo "  FAIL $1"; [ -f "$H/out" ] && sed 's/^/       | /' "$H/out" | tail -n 25; }
check() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
has() { grep -q -- "$1" "$H/out"; }
free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
active() { systemctl is-active -q "$1"; }
inactive() { ! systemctl is-active -q "$1"; }
version() { cat "$H/prefix/VERSION" 2>/dev/null; }
schema() { cat "$H/engine-home/instances/default/db/schema_version" 2>/dev/null; }
host_health() { curl -fs --max-time 2 "$EPC_HEALTH_URL/api/health"; }
engine_health() { curl -fs --max-time 2 "$EPC_ENGINE_HEALTH_URL/api/health"; }
sum_of() { cat "$@" 2>/dev/null | sha256sum | cut -d' ' -f1; }
# Everything the installer owns on the host, by name, size and mode, plus the contents of the files that matter.
host_state() {
  (cd "$H" && find prefix prefix.prev units etc engine-home host-state default -printf '%p %s %m\n' 2>/dev/null | sort
   cat etc/engine.env units/*.service prefix/VERSION 2>/dev/null) | sha256sum | cut -d' ' -f1
}
leftovers() { compgen -G "$H/.epaperclip-engine-test.*" >/dev/null || [ -e "$H/prefix.new" ]; }

# A fresh simulated host. new_host <name> [no-proxmox]
new_host() {
  H="$WORK/$1"; mkdir -p "$H/bin" "$H/stub"; HOSTS+=("$H")
  for s in "$HERE"/stubs/*; do ln -s "$s" "$H/bin/$(basename "$s")"; done
  [ "${2:-}" = no-proxmox ] && rm "$H/bin/pveversion"
  export PATH="$H/bin:$BASE_PATH"
  export STUB_STATE="$H/stub" EPC_PREFIX="$H/prefix" EPC_UNIT_DIR="$H/units" EPC_DEFAULTS="$H/default/epaperclip" \
    EPC_ETC_DIR="$H/etc" EPC_ENGINE_HOME="$H/engine-home" EPC_HOST_STATE_DIR="$H/host-state" EPC_MEMINFO="$H/meminfo"
  export EPC_SKIP_NODE=1 EPC_SKIP_CERT_CHECK=1 EPC_SKIP_ENGINE_NPM=1 EPC_ENGINE_WAIT=30 EPC_HOST_WAIT=20
  unset STUB_SS_BUSY STUB_PVEPROXY_DOWN STUB_PVE_VERSION STUB_RUN_AS_NOBODY
  printf 'MemTotal:       16303412 kB\nMemAvailable:   12000000 kB\n' >"$H/meminfo"
  local hp ep; hp="$(free_port)"; ep="$(free_port)"
  export EPC_HEALTH_URL="http://127.0.0.1:$hp" EPC_ENGINE_HEALTH_URL="http://127.0.0.1:$ep"
  printf 'EPC_DEV_HTTP=1\nEPC_LISTEN=127.0.0.1:%s\n' "$hp" >"$H/stub/env.epaperclip"
  printf 'PORT=%s\n' "$ep" >"$H/stub/env.epaperclip-engine"
  rm -f "$H/out"
}

# A release folder laid out like the downloaded one. make_release <version> <engine version> [variant]
#   variants: broken-host (won't start at all), host-fails-as-service, engine-fails-as-service, broken-engine
make_release() {
  R="$H/rel-$1"; rm -rf "$R"; mkdir -p "$R/deploy" "$R/console" "$R/engine" "$R/plugins/proxmox-sandbox/dist" "$R/plugins/proxmox-sandbox/template"
  cp "$REPO"/deploy/{install.sh,epaperclip.service,epaperclip-engine.service,epaperclip.default,engine-links.mjs} "$R/deploy/"
  cp "$HERE/fake-epaperclip.mjs" "$R/epaperclip.mjs"
  cp "$HERE/fake-engine.mjs" "$R/fake-engine.mjs"
  # The agent container provider, as the release carries it (built code and lockfile; packages are installed at install time).
  local P="$R/plugins/proxmox-sandbox"
  echo 'export default {};' >"$P/dist/manifest.js"; echo 'export {};' >"$P/dist/worker.js"
  printf '{\n  "name": "@epaperclip/plugin-proxmox-sandbox",\n  "version": "%s",\n  "dependencies": { "@paperclipai/plugin-sdk": "%s" }\n}\n' "$1" "$2" >"$P/package.json"
  printf '{\n  "name": "@epaperclip/plugin-proxmox-sandbox",\n  "lockfileVersion": 3,\n  "packages": {}\n}\n' >"$P/package-lock.json"
  echo '#!/usr/bin/env bash' >"$P/template/provision.sh"; echo 'NODE_VERSION="24.21.0"' >"$P/template/versions.sh"
  echo '<!doctype html><title>console</title>' >"$R/console/index.html"
  echo "$1" >"$R/VERSION"
  printf '{\n  "name": "epaperclip-engine",\n  "private": true,\n  "dependencies": {\n    "paperclipai": "%s"\n  }\n}\n' "$2" >"$R/engine/package.json"
  cat >"$R/engine/package-lock.json" <<EOF
{
  "name": "epaperclip-engine",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "epaperclip-engine",
      "dependencies": {
        "paperclipai": "$2"
      }
    },
    "node_modules/paperclipai": {
      "version": "$2",
      "resolved": "https://registry.npmjs.org/paperclipai/-/paperclipai-$2.tgz",
      "license": "MIT"
    }
  }
}
EOF
  case "${3:-}" in
    broken-host) echo 'process.exit(1);' >"$R/epaperclip.mjs" ;;
    host-fails-as-service) sed -i 's/^const failUnderSystemd = false;/const failUnderSystemd = true;/' "$R/epaperclip.mjs" ;;
    engine-fails-as-service) sed -i 's/^const failUnderSystemd = false;/const failUnderSystemd = true;/' "$R/fake-engine.mjs" ;;
    broken-engine) echo 'process.exit(1);' >"$R/fake-engine.mjs" ;;
  esac
}
# install [option]: runs the release in $R; the output lands in $H/out and the exit code in $RC.
install() { EPC_FAKE_ENGINE="$R/fake-engine.mjs" bash "$R/deploy/install.sh" "$@" >"$H/out" 2>&1; RC=$?; }

# ---- scenarios ----------------------------------------------------------------------------------------------------
s_fresh() {
  new_host fresh; make_release 1.0.0 2026.1005.0; install
  check "installs (exit 0)" [ "$RC" -eq 0 ]
  check "VERSION is 1.0.0" [ "$(version)" = 1.0.0 ]
  check "host service running and healthy" eval 'active epaperclip && host_health'
  check "engine running and healthy" eval 'active epaperclip-engine && engine_health'
  check "both units enabled" eval 'systemctl is-enabled epaperclip && systemctl is-enabled epaperclip-engine'
  check "units are the ones in deploy/" eval 'cmp "$H/units/epaperclip.service" "$REPO/deploy/epaperclip.service" && cmp "$H/units/epaperclip-engine.service" "$REPO/deploy/epaperclip-engine.service"'
  check "host service gets EPC_STATE_DIR and the EPC_ENGINE_* settings from its unit" eval 'host_health | grep -q "\"stateDir\":\"$H/host-state\",\"engineUrl\":\"http://127.0.0.1:3100\",\"enginePublicUrl\":\"http://127.0.0.1:3100\",\"engineDir\":\"$H/prefix/engine\""'
  check "engine.env is mode 0600" [ "$(stat -c %a "$H/etc/engine.env")" = 600 ]
  check "engine.env has two fresh 64-hex secrets" eval 'grep -Eq "^BETTER_AUTH_SECRET=[0-9a-f]{64}$" "$H/etc/engine.env" && grep -Eq "^PAPERCLIP_AGENT_JWT_SECRET=[0-9a-f]{64}$" "$H/etc/engine.env" && [ "$(sed -n "s/^BETTER_AUTH_SECRET=//p" "$H/etc/engine.env")" != "$(sed -n "s/^PAPERCLIP_AGENT_JWT_SECRET=//p" "$H/etc/engine.env")" ]'
  local line all=1
  for line in PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_DEPLOYMENT_EXPOSURE=private HOST=127.0.0.1 PORT=3100 \
    PAPERCLIP_PUBLIC_URL=http://127.0.0.1:3100 PAPERCLIP_ALLOWED_HOSTNAMES=127.0.0.1,localhost PAPERCLIP_API_URL=http://127.0.0.1:3100 \
    PAPERCLIP_MIGRATION_AUTO_APPLY=true SERVE_UI=false PAPERCLIP_AUTH_RATE_LIMIT_ENABLED=false; do grep -qx "$line" "$H/etc/engine.env" || all=0; done
  check "engine.env has the fixed values from the contract" [ "$all" = 1 ]
  check "engine data directory created, database set up" [ "$(schema)" = 2026.1005.0 ]
  check "both service users created" eval 'grep -qx epaperclip "$H/stub/users" && grep -qx epaperclip-engine "$H/stub/users"'
  check "new engine was test-started as its own user first" grep -q "setpriv --reuid=epaperclip-engine" "$H/stub/calls"
  check "says where the engine data and its backups are" has "backs itself up every hour into $H/engine-home/instances/default/data/backups"
  check "nothing left behind" eval '! leftovers'
  check "the agent container provider is installed (built code, template scripts, packages dir) and readable by the engine user" eval '[ -f "$H/prefix/plugins/proxmox-sandbox/dist/manifest.js" ] && [ -f "$H/prefix/plugins/proxmox-sandbox/template/provision.sh" ] && [ -d "$H/prefix/plugins/proxmox-sandbox/node_modules" ] && [ "$(stat -c %u "$H/prefix/plugins/proxmox-sandbox/dist/manifest.js")" = 0 ] && [ "$(stat -c %A "$H/prefix/plugins/proxmox-sandbox/dist/manifest.js" | cut -c8)" = r ] && [ "$(stat -c %A "$H/prefix/plugins" | cut -c10)" = x ]'
  install --status
  check "--status names the provider" has "agent container provider: 1.0.0"
  check "--status: both services" eval 'has "epaperclip.service: running" && has "epaperclip-engine.service: running"'
  check "--status: engine version and health" eval 'has "engine: paperclipai 2026.1005.0" && has "engine health: ok" && has "setup: bootstrap_pending"'
}

s_upgrade() {
  new_host upgrade; make_release 1.0.0 2026.1005.0; install
  local env_sum calls; env_sum="$(sum_of "$H/etc/engine.env")"; calls="$(grep -c "setpriv --reuid=epaperclip-engine" "$H/stub/calls")"
  make_release 2.0.0 2026.1005.0; install
  check "upgrade to 2.0.0 (exit 0)" eval '[ "$RC" -eq 0 ] && [ "$(version)" = 2.0.0 ] && [ "$(cat "$H/prefix.prev/VERSION")" = 1.0.0 ]'
  check "engine.env and its secrets kept" [ "$(sum_of "$H/etc/engine.env")" = "$env_sum" ]
  # An engine.env from before a fixed value existed: the upgrade adds it and changes nothing else.
  local secrets; secrets="$(grep SECRET= "$H/etc/engine.env")"
  sed -i '/^PAPERCLIP_AUTH_RATE_LIMIT_ENABLED=/d' "$H/etc/engine.env"
  make_release 2.1.0 2026.1005.0; install
  check "a missing fixed value is added on upgrade, secrets untouched" eval '[ "$RC" -eq 0 ] && grep -qx PAPERCLIP_AUTH_RATE_LIMIT_ENABLED=false "$H/etc/engine.env" && [ "$(grep SECRET= "$H/etc/engine.env")" = "$secrets" ] && [ "$(stat -c %a "$H/etc/engine.env")" = 600 ]'
  env_sum="$(sum_of "$H/etc/engine.env")"
  check "same engine lockfile: engine reused (hard links), not reinstalled or test-started" eval '[ "$(stat -c %i "$H/prefix/engine/node_modules/@paperclipai/server/dist/index.js")" = "$(stat -c %i "$H/prefix.prev/engine/node_modules/@paperclipai/server/dist/index.js")" ] && [ "$(grep -c "setpriv --reuid=epaperclip-engine" "$H/stub/calls")" = "$calls" ]'
  check "same engine: no database copy taken" [ ! -d "$H/engine-home/pre-upgrade" ]
  check "both running and healthy" eval 'host_health && engine_health'

  make_release 3.0.0 2026.1100.0; install
  check "upgrade to 3.0.0 with a new engine version (exit 0)" eval '[ "$RC" -eq 0 ] && [ "$(version)" = 3.0.0 ]'
  check "new engine running, database migrated" eval 'engine_health | grep -q 2026.1100.0 && [ "$(schema)" = 2026.1100.0 ]'
  check "database copied before the upgrade" eval '[ "$(cat "$H/engine-home/pre-upgrade/ENGINE_VERSION")" = 2026.1005.0 ] && [ "$(cat "$H/engine-home/pre-upgrade/db/schema_version")" = 2026.1005.0 ]'
  check "engine.env still untouched" [ "$(sum_of "$H/etc/engine.env")" = "$env_sum" ]
  install --status
  check "--status shows engine and previous engine" has "engine: paperclipai 2026.1100.0 (previous: 2026.1005.0)"
}

s_rollback() {
  new_host rollback; make_release 1.0.0 2026.1005.0; install; make_release 2.0.0 2026.1100.0; install
  local env_sum; env_sum="$(sum_of "$H/etc/engine.env")"
  install --rollback
  check "--rollback (exit 0) to 1.0.0" eval '[ "$RC" -eq 0 ] && [ "$(version)" = 1.0.0 ]'
  check "the previous version's agent container provider is back (and the newer one went with its version)" eval 'grep -q "\"version\": \"1.0.0\"" "$H/prefix/plugins/proxmox-sandbox/package.json" && [ -d "$H/prefix/plugins/proxmox-sandbox/node_modules" ]'
  check "previous engine back and healthy" eval 'engine_health | grep -q 2026.1005.0 && host_health'
  check "database from before the upgrade restored" [ "$(schema)" = 2026.1005.0 ]
  check "newer database kept aside, not deleted" eval 'compgen -G "$H/engine-home/instances/default/db.from-2026.1100.0-*" && grep -q 2026.1100.0 "$H"/engine-home/instances/default/db.from-2026.1100.0-*/schema_version'
  check "engine.env untouched" [ "$(sum_of "$H/etc/engine.env")" = "$env_sum" ]
  check "units are the previous version's" eval 'cmp "$H/units/epaperclip-engine.service" "$REPO/deploy/epaperclip-engine.service"'
  install --rollback
  check "a second --rollback has nowhere to go" eval '[ "$RC" -ne 0 ] && has "no previous version"'
}

s_broken() {
  new_host broken; make_release 1.0.0 2026.1005.0; install
  local before; before="$(host_state)"
  make_release 2.0.0 2026.1005.0 broken-host; install
  check "broken new host service: refused" eval '[ "$RC" -ne 0 ] && has "the new version doesn.t start on this machine. Nothing was changed."'
  check "broken new host service: nothing changed" [ "$(host_state)" = "$before" ]
  check "still running 1.0.0" eval '[ "$(version)" = 1.0.0 ] && host_health && engine_health'
  make_release 3.0.0 2026.1200.0 broken-engine; install
  check "broken new engine: refused" eval '[ "$RC" -ne 0 ] && has "the new engine doesn.t start on this machine. Nothing was changed."'
  check "broken new engine: nothing changed" [ "$(host_state)" = "$before" ]
  check "broken new engine: no test leftovers" eval '! leftovers'
  check "still running 1.0.0 with its engine" eval '[ "$(version)" = 1.0.0 ] && engine_health | grep -q 2026.1005.0'
}

s_service_fails() {
  new_host service-fails; make_release 1.0.0 2026.1005.0; install
  # With a fixed value missing, so the failed upgrade has something in engine.env to put back.
  sed -i '/^PAPERCLIP_AUTH_RATE_LIMIT_ENABLED=/d' "$H/etc/engine.env"
  local env_sum units_sum; env_sum="$(sum_of "$H/etc/engine.env")"; units_sum="$(sum_of "$H"/units/*.service)"
  make_release 2.0.0 2026.1005.0 host-fails-as-service; install
  check "host service won't run: previous restored" eval '[ "$RC" -ne 0 ] && has "the previous version (1.0.0) was restored and is running"'
  check "1.0.0 running again" eval '[ "$(version)" = 1.0.0 ] && host_health && engine_health'
  make_release 3.0.0 2026.1300.0 engine-fails-as-service; install
  check "engine won't run: previous restored" eval '[ "$RC" -ne 0 ] && has "the previous version (1.0.0) was restored and is running"'
  check "engine's database put back as it was" eval '[ "$(schema)" = 2026.1005.0 ] && [ ! -d "$H/engine-home/pre-upgrade" ]'
  check "previous engine running again" eval 'engine_health | grep -q 2026.1005.0 && host_health'
  check "engine.env and units unchanged" eval '[ "$(sum_of "$H/etc/engine.env")" = "$env_sum" ] && [ "$(sum_of "$H"/units/*.service)" = "$units_sum" ]'
  check "nothing left behind" eval '! leftovers && [ ! -e "$H/prefix.failed" ]'
}

s_first_fails() {
  new_host first-fails; make_release 1.0.0 2026.1005.0 engine-fails-as-service; install
  check "first install that won't run: removed" eval '[ "$RC" -ne 0 ] && has "installation failed and was removed"'
  check "nothing installed is left" eval '[ ! -e "$H/prefix" ] && [ -z "$(ls -A "$H/units" 2>/dev/null)" ] && [ ! -e "$H/etc" ] && [ ! -e "$H/engine-home" ] && [ ! -e "$H/host-state" ] && [ ! -e "$H/default/epaperclip" ]'
  check "no services running" eval 'inactive epaperclip && inactive epaperclip-engine'
}

s_from_pre_engine() {
  # A host running a version from before the engine existed: one unit, no engine, no engine.env.
  new_host pre-engine
  mkdir -p "$H/prefix/node/bin" "$H/prefix/console" "$H/units"; ln -s "$(command -v node)" "$H/prefix/node/bin/node"
  cp "$HERE/fake-epaperclip.mjs" "$H/prefix/epaperclip.mjs"; echo 0.9.0 >"$H/prefix/VERSION"; echo x >"$H/prefix/console/index.html"
  grep -v -e epaperclip-engine -e StateDirectory -e EPC_STATE_DIR -e '# Its vault' "$REPO/deploy/epaperclip.service" | sed 's/ epaperclip-engine.service//' >"$H/units/epaperclip.service"
  cp "$H/units/epaperclip.service" "$H/old-unit"
  systemctl start epaperclip
  make_release 1.0.0 2026.1005.0 engine-fails-as-service; install
  check "upgrade from pre-engine fails: previous restored" eval '[ "$RC" -ne 0 ] && has "the previous version (0.9.0) was restored and is running" && [ "$(version)" = 0.9.0 ] && host_health'
  check "the engine it added is gone again (unit, settings, data)" eval '[ ! -e "$H/units/epaperclip-engine.service" ] && [ ! -e "$H/etc" ] && [ ! -e "$H/engine-home" ] && cmp "$H/units/epaperclip.service" "$H/old-unit"'
  make_release 1.1.0 2026.1005.0; install
  check "upgrade from pre-engine works" eval '[ "$RC" -eq 0 ] && [ "$(version)" = 1.1.0 ] && engine_health && host_health'
  install --rollback
  check "rollback to pre-engine: engine unit removed, engine stopped" eval '[ "$RC" -eq 0 ] && [ "$(version)" = 0.9.0 ] && [ ! -e "$H/units/epaperclip-engine.service" ] && inactive epaperclip-engine'
  check "rollback to pre-engine: engine data and settings kept" eval '[ "$(schema)" = 2026.1005.0 ] && [ -f "$H/etc/engine.env" ] && cmp "$H/units/epaperclip.service" "$H/old-unit"'
}

s_preflight() {
  new_host not-proxmox no-proxmox; make_release 1.0.0 2026.1005.0; install
  check "not Proxmox: refused" eval '[ "$RC" -ne 0 ] && has "this isn.t a Proxmox VE host" && has "nothing was changed"'
  check "not Proxmox: nothing written" eval '[ ! -e "$H/prefix" ] && [ ! -e "$H/units" ] && [ ! -e "$H/etc" ] && [ ! -e "$H/engine-home" ] && [ ! -s "$H/stub/users" ]'
  new_host old-pve; export STUB_PVE_VERSION=7.4-3; make_release 1.0.0 2026.1005.0; install
  check "Proxmox 7: refused" eval '[ "$RC" -ne 0 ] && has "Proxmox VE 8 or newer is needed" && [ ! -e "$H/prefix" ]'
  new_host low-memory; printf 'MemTotal:        1500000 kB\nMemAvailable:    1000000 kB\n' >"$H/meminfo"; make_release 1.0.0 2026.1005.0; install
  check "1.5 GB of memory: refused" eval '[ "$RC" -ne 0 ] && has "the engine needs at least 2 GB" && [ ! -e "$H/prefix" ]'
  new_host small-memory; printf 'MemTotal:        3000000 kB\nMemAvailable:    2500000 kB\n' >"$H/meminfo"; make_release 1.0.0 2026.1005.0; install
  check "3 GB of memory: installs with a warning" eval '[ "$RC" -eq 0 ] && has "4 GB or more is recommended"'
  new_host port-busy; export STUB_SS_BUSY=3100; make_release 1.0.0 2026.1005.0; install
  check "port 3100 taken: refused" eval '[ "$RC" -ne 0 ] && has "listening on port 3100" && [ ! -e "$H/prefix" ]'
  new_host pveproxy-down; export STUB_PVEPROXY_DOWN=1; make_release 1.0.0 2026.1005.0; install
  check "pveproxy down: refused" eval '[ "$RC" -ne 0 ] && has "pveproxy" && [ ! -e "$H/prefix" ]'
  new_host no-provider; make_release 1.0.0 2026.1005.0; rm -rf "$R/plugins"; install
  check "a download without the agent container provider: refused" eval '[ "$RC" -ne 0 ] && has "plugins/proxmox-sandbox/dist/manifest.js is missing" && [ ! -e "$H/prefix" ]'
  new_host bad-option; make_release 1.0.0 2026.1005.0; install --frobnicate
  check "unknown option: refused" eval '[ "$RC" -ne 0 ] && has "unknown option --frobnicate" && [ ! -e "$H/prefix" ]'
}

s_uninstall() {
  new_host uninstall; make_release 1.0.0 2026.1005.0; install; make_release 1.1.0 2026.1005.0; install
  local env_sum; env_sum="$(sum_of "$H/etc/engine.env")"
  install --uninstall
  check "--uninstall (exit 0)" [ "$RC" -eq 0 ]
  check "programs (including the agent container provider) and units removed, services stopped" eval '[ ! -e "$H/prefix" ] && [ ! -e "$H/prefix/plugins" ] && [ ! -e "$H/prefix.prev" ] && [ -z "$(ls -A "$H/units")" ] && inactive epaperclip && inactive epaperclip-engine'
  check "engine data, vault and settings kept" eval '[ "$(schema)" = 2026.1005.0 ] && [ -d "$H/host-state" ] && [ "$(sum_of "$H/etc/engine.env")" = "$env_sum" ] && [ -f "$H/default/epaperclip" ]'
  check "says where the data is" has "$H/engine-home"
  install
  check "reinstall keeps the same engine.env and data" eval '[ "$RC" -eq 0 ] && [ "$(sum_of "$H/etc/engine.env")" = "$env_sum" ] && [ "$(schema)" = 2026.1005.0 ] && engine_health'
  install --purge
  check "--purge removes data, settings and users too" eval '[ "$RC" -eq 0 ] && [ ! -e "$H/prefix" ] && [ ! -e "$H/engine-home" ] && [ ! -e "$H/host-state" ] && [ ! -e "$H/etc" ] && [ ! -e "$H/default/epaperclip" ] && [ ! -s "$H/stub/users" ]'
}

s_deb() {
  # The built Debian package (release/epaperclip_*_all.deb, from scripts/build-deb.sh), unpacked: its maintainer scripts
  # parse, its files match their checksums, and its payload installs with the real host service.
  local deb; deb="$(ls -t "$REPO"/release/epaperclip_*_all.deb 2>/dev/null | head -n1)"
  [ -n "$deb" ] || { echo "  skip (no release/epaperclip_*_all.deb; run scripts/package-release.mjs and scripts/build-deb.sh)"; return 0; }
  command -v dpkg-deb >/dev/null || { echo "  skip (dpkg-deb not found)"; return 0; }
  new_host deb; local D="$H/deb"; dpkg-deb -R "$deb" "$D"
  check "maintainer scripts and the epaperclip command parse" eval 'for f in "$D"/DEBIAN/postinst "$D"/DEBIAN/prerm "$D"/DEBIAN/postrm "$D"/usr/sbin/epaperclip; do sh -n "$f" || exit 1; done'
  check "files match DEBIAN/md5sums" eval '(cd "$D" && md5sum -c --quiet DEBIAN/md5sums)'
  check "control: package, architecture, Proxmox dependency" eval 'grep -qx "Package: epaperclip" "$D/DEBIAN/control" && grep -qx "Architecture: all" "$D/DEBIAN/control" && grep -q "^Depends: pve-manager (>= 8.0)" "$D/DEBIAN/control"'
  check "postinst runs the bundled installer; purge alone deletes data" eval 'grep -q "bash /usr/share/epaperclip/deploy/install.sh$" "$D/DEBIAN/postinst" && grep -q -- "--uninstall" "$D/DEBIAN/prerm" && ! grep -q "/var/lib" "$D/DEBIAN/prerm" && grep -q "rm -rf /var/lib/epaperclip-engine" "$D/DEBIAN/postrm"'
  R="$D/usr/share/epaperclip"; cp "$HERE/fake-engine.mjs" "$R/fake-engine.mjs"
  install
  check "payload installs with the real host service (exit 0)" eval '[ "$RC" -eq 0 ] && [ "$(version)" = "$(cat "$R/VERSION")" ] && host_health && engine_health'
  check "real host service gets its state directory (vault key written)" [ -f "$H/host-state/vault.key" ]
  rm -f "$R/fake-engine.mjs"
}

s_npm() {
  # The npm package's command (npm/epaperclip/bin/epaperclip.js) with a release as its payload, the way it is packed.
  new_host npm; make_release 1.0.0 2026.1005.0
  local N="$H/npm"; mkdir -p "$N/bin" "$N/payload"; cp "$REPO/npm/epaperclip/bin/epaperclip.js" "$N/bin/"; cp -r "$R" "$N/payload/epaperclip"
  epc() { EPC_FAKE_ENGINE="$R/fake-engine.mjs" node "$N/bin/epaperclip.js" "$@" >"$H/out" 2>&1; RC=$?; }
  if [ "$(/usr/bin/id -u)" -ne 0 ]; then
    # The command checks for root itself (the id stand-in doesn't reach Node.js): all that can be tested is the refusal.
    epc status; check "refuses to run when not root" eval '[ "$RC" -ne 0 ] && has "run as root"'
    echo "  skip the rest (run as root, as CI does)"; return 0
  fi
  epc install
  check "epaperclip install (exit 0)" eval '[ "$RC" -eq 0 ] && [ "$(version)" = 1.0.0 ] && host_health && engine_health'
  epc status
  check "epaperclip status" eval '[ "$RC" -eq 0 ] && has "epaperclip-engine.service: running"'
  epc rollback
  check "epaperclip rollback passes through (nothing to go back to)" eval '[ "$RC" -ne 0 ] && has "no previous version"'
  epc frobnicate
  check "unknown command: usage, exit 2" eval '[ "$RC" -eq 2 ] && has "usage: epaperclip"'
  epc uninstall --purge
  check "epaperclip uninstall --purge" eval '[ "$RC" -eq 0 ] && [ ! -e "$H/prefix" ] && [ ! -e "$H/engine-home" ]'
  rm "$H/bin/pveversion"; export PATH="$H/bin:$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin"
  if [ -x /usr/bin/pveversion ] || [ -x /usr/sbin/pveversion ]; then echo "  skip not-Proxmox check (this machine has pveversion)"
  else epc install; check "refuses on a host without pveversion" eval '[ "$RC" -ne 0 ] && has "this isn.t a Proxmox VE host" && [ ! -e "$H/prefix" ]'; fi
  if [ "$(/usr/bin/id -u)" -eq 0 ]; then
    chmod 0755 "$WORK" "$H" "$N" "$N/bin"; chmod 0644 "$N/bin/epaperclip.js"
    /usr/bin/setpriv --reuid=65534 --regid=65534 --clear-groups node "$N/bin/epaperclip.js" status >"$H/out" 2>&1; RC=$?
    check "refuses to run when not root" eval '[ "$RC" -ne 0 ] && has "run as root"'
  fi
}

s_real_engine() {
  [ "${EPC_TEST_REAL_ENGINE:-}" = 1 ] || { echo "  skip (set EPC_TEST_REAL_ENGINE=1, as root, with internet)"; return 0; }
  [ "$(id -u)" -eq 0 ] || { bad "needs root"; return 0; }
  new_host real-engine; chmod 0755 "$WORK" "$H"
  unset EPC_SKIP_ENGINE_NPM EPC_SKIP_NODE; export STUB_RUN_AS_NOBODY=1 EPC_ENGINE_WAIT=300; touch "$H/stub/run-as-nobody"
  make_release 1.0.0 x
  cp "$REPO/engine/package.json" "$REPO/engine/package-lock.json" "$R/engine/"
  # The real provider (built, with its real lockfile) when it has been built here; its packages are installed for real.
  if [ -f "$REPO/plugins/proxmox-sandbox/dist/manifest.js" ]; then
    rm -rf "$R/plugins/proxmox-sandbox"; mkdir -p "$R/plugins/proxmox-sandbox"
    (cd "$REPO/plugins/proxmox-sandbox" && cp -r dist template package.json package-lock.json README.md "$R/plugins/proxmox-sandbox/")
    REAL_PLUGIN=1
  fi
  install
  check "real engine installs from engine/ with the pinned Node.js (exit 0)" [ "$RC" -eq 0 ]
  check "real engine healthy, running as nobody" eval 'engine_health | grep -q "\"status\":\"ok\"" && [ "$(stat -c %u "$H/engine-home/instances/default/db")" = 65534 ]'
  check "engine tree is root's and its database binaries are linked" eval '[ "$(stat -c %u "$H/prefix/engine/node_modules")" = 0 ] && [ -L "$H/prefix/engine/node_modules/@embedded-postgres/linux-$( [ "$(uname -m)" = aarch64 ] && echo arm64 || echo x64)/native/lib/libpq.so.5" ]'
  [ "${REAL_PLUGIN:-}" != 1 ] || check "the provider's production packages were installed from its lockfile, readable by the engine user" eval '[ -f "$H/prefix/plugins/proxmox-sandbox/node_modules/@paperclipai/plugin-sdk/package.json" ] && [ "$(stat -c %u "$H/prefix/plugins/proxmox-sandbox/node_modules")" = 0 ] && setpriv --reuid=65534 --regid=65534 --clear-groups node -e "import(process.argv[1]).then((m)=>{if(!m.default?.id)process.exit(1)})" "$H/prefix/plugins/proxmox-sandbox/dist/manifest.js"'
  check "installed paperclipai matches the lockfile" eval '[ "$(node -p "require(\"$H/prefix/engine/node_modules/paperclipai/package.json\").version")" = "$(node -p "require(\"$REPO/engine/package-lock.json\").packages[\"node_modules/paperclipai\"].version")" ]'
}

ALL=(fresh upgrade rollback broken service_fails first_fails from_pre_engine preflight uninstall deb npm real_engine)
want=("$@"); [ "${#want[@]}" -gt 0 ] || want=("${ALL[@]}")
for SCEN in "${want[@]}"; do
  SCEN="${SCEN//-/_}"
  declare -F "s_$SCEN" >/dev/null || { echo "run.sh: no scenario '$SCEN' (have: ${ALL[*]})" >&2; exit 2; }
  echo "== $SCEN"
  t0=$SECONDS; "s_$SCEN"; echo "  ($((SECONDS - t0)) s)"
  for h in ${HOSTS[@]+"${HOSTS[@]}"}; do (export STUB_STATE="$h/stub"; for p in "$h"/stub/*.pid; do [ -f "$p" ] && { kill -KILL -- "-$(cat "$p")" 2>/dev/null; rm -f "$p"; }; done); done
done
echo
echo "deploy/test: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || { printf '  - %s\n' "${failed[@]}"; exit 1; }
