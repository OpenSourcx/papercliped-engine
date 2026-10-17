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

# Fixture signing keys, made fresh for every run in the work folder (which is deleted afterwards): "fx" is the project's key as
# the simulated releases pin it, "other" is somebody else's. No private key is ever kept in the repository.
KEYS="$WORK/keys"; mkdir -p "$KEYS"
node --input-type=module -e '
import { generateReleaseKey } from "'"$REPO"'/scripts/release-lib.mjs";
import { writeFileSync } from "node:fs";
for (const n of ["fx", "other"]) { const k = generateReleaseKey(); writeFileSync(process.argv[1] + "/" + n + ".pem", k.privatePem); writeFileSync(process.argv[1] + "/" + n + ".pub", k.publicPem); }
' "$KEYS" || { echo "run.sh: couldn't make the fixture signing keys" >&2; exit 1; }

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
  cp "$REPO"/deploy/{install.sh,epaperclip.service,epaperclip-engine.service,epaperclip.default,engine-links.mjs,epaperclip-update.sh,epaperclip-update.service,epaperclip-update.path,verify-release.sh} "$R/deploy/"
  cp "$KEYS/fx.pub" "$R/deploy/release-signing.pub"
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
# publish_release <release folder> <web folder> [signing key name]: lays the release out the way GitHub serves it:
# the tarball, its checksum, and the manifest and signature the real scripts/sign-release.mjs makes (default key: fx).
publish_release() {
  local src="$1" out="$2" key="${3:-fx}" pk="$H/pack-$$"
  rm -rf "$pk"; mkdir -p "$out" "$pk"; cp -a "$src" "$pk/epaperclip"
  tar -czf "$out/epaperclip.tar.gz" --owner=0 --group=0 -C "$pk" epaperclip; rm -rf "$pk"
  (cd "$out" && sha256sum epaperclip.tar.gz >epaperclip.tar.gz.sha256)
  RELEASE_SIGNING_KEY="$(cat "$KEYS/$key.pem")" node "$REPO/scripts/sign-release.mjs" --dir "$out" --public "$KEYS/$key.pub" >"$H/sign.out" 2>&1 || { echo "run.sh: sign-release failed: $(cat "$H/sign.out")" >&2; return 1; }
}
# install [option]: runs the release in $R; the output lands in $H/out and the exit code in $RC.
install() { EPC_FAKE_ENGINE="$R/fake-engine.mjs" bash "$R/deploy/install.sh" "$@" >"$H/out" 2>&1; RC=$?; }

# ---- scenarios ----------------------------------------------------------------------------------------------------
s_fresh() {
  new_host fresh; make_release 1.0.0 2026.1005.0; install
  check "installs (exit 0)" [ "$RC" -eq 0 ]
  check "the engine unit gives Node a 2 GB heap (the 1.5 GB default ran out on a slow machine)" grep -q "NODE_OPTIONS=--max-old-space-size=2048" "$REPO/deploy/epaperclip-engine.service"
  check "the engine is given 15 minutes to start by default" grep -q "EPC_ENGINE_WAIT:-900" "$REPO/deploy/install.sh"
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
  local N="$H/npm"; mkdir -p "$N/bin" "$N/payload"; cp "$REPO/npm/epaperclip/bin/epaperclip.js" "$N/bin/"
  # The payload as prepack.mjs makes it: the signed tarball, its manifest and signature, and the pinned public key.
  publish_release "$R" "$H/npmrel"; cp "$H"/npmrel/epaperclip.{tar.gz,manifest.json,manifest.sig} "$N/payload/"; cp "$KEYS/fx.pub" "$N/payload/release-signing.pub"
  epc() { EPC_FAKE_ENGINE="$R/fake-engine.mjs" node "$N/bin/epaperclip.js" "$@" >"$H/out" 2>&1; RC=$?; }
  if [ "$(/usr/bin/id -u)" -ne 0 ]; then
    # The command checks for root itself (the id stand-in doesn't reach Node.js): all that can be tested is the refusal.
    epc status; check "refuses to run when not root" eval '[ "$RC" -ne 0 ] && has "run as root"'
    echo "  skip the rest (run as root, as CI does)"; return 0
  fi
  # Fail closed: a payload that doesn't verify installs nothing.
  local P="$N/payload"
  echo tampered >>"$P/epaperclip.tar.gz"; epc install
  check "a tampered payload is refused, nothing installed" eval '[ "$RC" -ne 0 ] && has "doesn.t match its signed checksum" && [ ! -e "$H/prefix" ]'
  cp "$H/npmrel/epaperclip.tar.gz" "$P/"
  mv "$P/epaperclip.manifest.sig" "$P/sig.bak"; epc install
  check "a payload with no signature is refused" eval '[ "$RC" -ne 0 ] && has "incomplete or unsigned" && [ ! -e "$H/prefix" ]'
  mv "$P/sig.bak" "$P/epaperclip.manifest.sig"
  cp "$KEYS/other.pub" "$P/release-signing.pub"; epc install
  check "a payload signed by another key is refused" eval '[ "$RC" -ne 0 ] && has "signature is not valid" && [ ! -e "$H/prefix" ]'
  rm "$P/release-signing.pub"; epc install
  check "a payload with no pinned key says to run release-keygen" eval '[ "$RC" -ne 0 ] && has "release-keygen" && [ ! -e "$H/prefix" ]'
  cp "$KEYS/fx.pub" "$P/release-signing.pub"
  epc version
  check "epaperclip version reads the signed manifest" eval '[ "$RC" -eq 0 ] && has "^1.0.0$"'
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

# The console's Update button: the host service leaves a request, the root helper downloads, checks and installs it.
s_update_helper() {
  new_host update-helper; make_release 1.0.0 2026.1005.0; install
  check "installs with the update helper (run.sh, a copy of the installer, both units)" eval '[ -x "$H/prefix/update/run.sh" ] && [ -f "$H/prefix/update/install.sh" ] && [ -f "$H/units/epaperclip-update.path" ] && [ -f "$H/units/epaperclip-update.service" ]'
  check "the helper is root's and the path unit watches the request file" eval '[ "$(stat -c %u "$H/prefix/update/run.sh")" = 0 ] && grep -q "^PathExists=/var/lib/epaperclip/update/request$" "$H/units/epaperclip-update.path"'
  local old="$R" web="$H/web" st="$H/host-state/update"
  # A release server: v1.1.0 as a tarball with its checksum, laid out like GitHub's release downloads.
  make_release 1.1.0 2026.1005.0; local new="$R"
  publish_release "$new" "$web/v1.1.0"
  local urun; urun() { EPC_RELEASE_DOWNLOAD="file://$web" EPC_FAKE_ENGINE="$old/fake-engine.mjs" bash "$H/prefix/update/run.sh" >"$H/out" 2>&1; RC=$?; }
  local uask; uask() { mkdir -p "$st"; printf '%s' "$1" >"$st/request"; }
  local ustat; ustat() { sed -n "s/^$1=//p" "$st/status" 2>/dev/null; }

  uask $'action=update\nversion=1.1.0\nrequestedBy=sam@pve\nat=1\n'; urun
  check "an update request installs that release (exit 0)" [ "$RC" -eq 0 ]
  check "now at 1.1.0, status done, request consumed, services healthy" eval '[ "$(version)" = 1.1.0 ] && [ "$(ustat phase)" = done ] && [ ! -e "$st/request" ] && host_health && engine_health'
  check "the previous version is kept for rollback" [ "$(cat "$H/prefix.prev/VERSION")" = 1.0.0 ]

  uask $'action=rollback\nversion=previous\nrequestedBy=sam@pve\nat=1\n'; urun
  check "a rollback request goes back to 1.0.0 and says done" eval '[ "$(version)" = 1.0.0 ] && [ "$(ustat phase)" = done ] && host_health'

  # A tampered download is refused before anything is changed.
  echo tampered >>"$web/v1.1.0/epaperclip.tar.gz"
  uask $'action=update\nversion=1.1.0\nrequestedBy=sam@pve\nat=1\n'; urun
  check "a download that doesn't match the signed manifest's checksum is refused, nothing changed" eval '[ "$(ustat phase)" = failed ] && ustat message | grep -q checksum && [ "$(version)" = 1.0.0 ] && ! leftovers && host_health'

  # Bad requests are ignored, not run.
  for bad in $'action=update\nversion=1.1.0;touch /tmp/pwned\n' $'action=update\nversion=../../etc\n' $'action=reinstall\nversion=1.1.0\n' $'action=update\n'; do
    uask "$bad"; urun
    check "a bad request is refused: $(printf %s "$bad" | tr '\n' ' ' | cut -c1-40)" eval '[ "$(ustat phase)" = failed ] && [ "$(version)" = 1.0.0 ] && [ ! -e "$st/request" ] && [ ! -e /tmp/pwned ]'
  done
  mkdir -p "$st"; ln -sf /etc/hostname "$st/request"; urun
  check "a request that is a link is ignored" eval '[ "$(ustat phase)" = failed ] && [ ! -e "$st/request" ]'
  check "no request, no change" eval 'urun; [ "$RC" -eq 0 ] && [ "$(version)" = 1.0.0 ]'

  # The folder belongs to the unprivileged host service, so the helper (root) must not follow anything it plants there.
  uask $'action=update\nversion=0.9.0\nrequestedBy=sam@pve\nat=1\n'; urun
  check "an older release than the one running is refused (use rollback for that)" eval '[ "$(ustat phase)" = failed ] && ustat message | grep -q "older" && [ "$(version)" = 1.0.0 ] && [ ! -e "$st/request" ]'

  local victim="$H/victim"; printf 'precious\n' >"$victim"; chmod 0600 "$victim"
  ln -sf "$victim" "$st/log"; ln -sf "$victim" "$st/status"
  uask $'action=reinstall\n'; urun
  check "links named log and status can't make the helper truncate, fill or chmod another file" eval '[ "$(cat "$victim")" = precious ] && [ "$(stat -c %a "$victim")" = 600 ] && [ ! -L "$st/status" ] && [ ! -L "$st/log" ] && [ "$(ustat phase)" = failed ]'
  ln -sf "$victim" "$st/log"
  uask $'action=update\nversion=1.1.0\nrequestedBy=sam@pve\nat=1\n'; echo tampered >>"$web/v1.1.0/epaperclip.tar.gz"; urun
  check "the same through a whole run (log written, status written)" eval '[ "$(cat "$victim")" = precious ] && [ "$(stat -c %a "$victim")" = 600 ] && [ ! -L "$st/log" ]'

  mkdir -p "$H/elsewhere"; rm -rf "$st"; ln -s "$H/elsewhere" "$st"
  printf 'action=rollback\n' >"$H/elsewhere/request"; urun
  check "an update folder that has been swapped for a link is left alone" eval '[ "$RC" -eq 0 ] && [ -e "$H/elsewhere/request" ] && [ ! -e "$H/elsewhere/status" ] && [ ! -e "$H/elsewhere/log" ] && [ "$(version)" = 1.0.0 ]'
  rm -f "$st"; mkdir -p "$st"; rm -rf "$H/elsewhere"

  mkfifo "$st/request"; timeout 20 bash -c 'EPC_RELEASE_DOWNLOAD="file://$0" bash "$1/prefix/update/run.sh"' "$web" "$H" >"$H/out" 2>&1; RC=$?
  check "a pipe in place of the request can't hold the helper up" eval '[ "$RC" -eq 0 ] && [ ! -e "$st/request" ] && [ "$(ustat phase)" = failed ]'
  mkdir "$st/request"; urun
  check "a folder in place of the request is cleared away, so the path unit doesn't loop" eval '[ ! -e "$st/request" ] && [ "$(ustat phase)" = failed ]'

  install --uninstall 2>/dev/null; R="$old" install --uninstall
  check "uninstall removes the helper's units" eval '[ ! -e "$H/units/epaperclip-update.path" ] && [ ! -e "$H/units/epaperclip-update.service" ]'
}

# What the update helper (root) does with a release that isn't properly signed: every case ends with nothing changed.
s_signing() {
  new_host signing; make_release 1.0.0 2026.1005.0; install
  local old="$R" web="$H/web" st="$H/host-state/update"
  make_release 1.1.0 2026.1005.0; local r11="$R"; make_release 1.2.0 2026.1005.0; local r12="$R"; make_release 0.9.0 2026.1005.0; local r09="$R"
  local urun; urun() { EPC_RELEASE_DOWNLOAD="file://$web" EPC_FAKE_ENGINE="$old/fake-engine.mjs" bash "$H/prefix/update/run.sh" >"$H/out" 2>&1; RC=$?; }
  local ustat; ustat() { sed -n "s/^$1=//p" "$st/status" 2>/dev/null; }
  local ask11; ask11() { mkdir -p "$st"; printf 'action=update\nversion=1.1.0\nrequestedBy=sam@pve\nat=1\n' >"$st/request"; urun; }
  local refused; refused() { WANT="$2"; check "$1" eval '[ "$(ustat phase)" = failed ] && ustat message | grep -q -- "$WANT" && [ "$(version)" = 1.0.0 ] && ! leftovers && host_health'; }
  check "the install pinned the release key and the verifier for the helper" eval '[ -f "$H/prefix/update/release-signing.pub" ] && [ -f "$H/prefix/update/verify-release.sh" ] && cmp "$H/prefix/update/release-signing.pub" "$KEYS/fx.pub"'

  publish_release "$r11" "$web/v1.1.0" other; ask11
  refused "a release signed by a different key is refused" "not valid for the pinned key"
  publish_release "$r11" "$web/v1.1.0"; rm "$web/v1.1.0/epaperclip.manifest.sig"; ask11
  refused "a release with no signature is refused" "signature"
  publish_release "$r11" "$web/v1.1.0"; rm "$web/v1.1.0/epaperclip.manifest.json"; ask11
  refused "a release with no manifest is refused" "manifest"
  publish_release "$r11" "$web/v1.1.0"; echo "not a signature" >"$web/v1.1.0/epaperclip.manifest.sig"; ask11
  refused "a signature that isn't one is refused" "not a valid Ed25519 signature"
  publish_release "$r11" "$web/v1.1.0"; sed -i 's/"version": "1.1.0"/"version": "1.1.1"/' "$web/v1.1.0/epaperclip.manifest.json"; ask11
  refused "an edited manifest no longer verifies" "not valid for the pinned key"
  publish_release "$r11" "$web/v1.1.0"; echo tampered >>"$web/v1.1.0/epaperclip.tar.gz"; ask11
  refused "a tampered tarball (signature intact) is refused" "checksum"
  publish_release "$r11" "$web/v1.1.0"; publish_release "$r12" "$H/web-12"; cp "$H"/web-12/epaperclip.manifest.{json,sig} "$web/v1.1.0/"; ask11
  refused "another release's signed manifest swapped in is refused" "checksum"
  rm -rf "$web/v1.1.0"; publish_release "$r12" "$web/v1.1.0"; ask11
  refused "a whole different signed release served under this version's address is refused" "not the 1.1.0"
  rm -rf "$web/v1.1.0"; publish_release "$r09" "$web/v1.1.0"; ask11
  refused "an older signed release replayed under a newer address is refused" "not the 1.1.0"
  publish_release "$r11" "$web/v1.1.0"; mv "$H/prefix/update/release-signing.pub" "$H/pub.bak"; ask11
  refused "an installation with no pinned key refuses, and says to run release-keygen" "release-keygen"
  mv "$H/pub.bak" "$H/prefix/update/release-signing.pub"
  mv "$H/prefix/update/verify-release.sh" "$H/vr.bak"; ask11
  refused "an installation from before signing can't update itself, and says how to reinstall" "predates signed releases"
  mv "$H/vr.bak" "$H/prefix/update/verify-release.sh"
  # Good path, and then the key rotation story: a release signed by the old key may carry a new key; the next one needs the new key.
  ask11
  check "the properly signed release installs (exit 0, done)" eval '[ "$RC" -eq 0 ] && [ "$(ustat phase)" = done ] && [ "$(version)" = 1.1.0 ] && host_health && engine_health'
  cp "$KEYS/other.pub" "$r12/deploy/release-signing.pub"; rm -rf "$web/v1.2.0"; publish_release "$r12" "$web/v1.2.0"
  mkdir -p "$st"; printf 'action=update\nversion=1.2.0\nrequestedBy=sam@pve\nat=1\n' >"$st/request"; urun
  check "rotation: a release signed by the old key installs and brings the new key" eval '[ "$(version)" = 1.2.0 ] && cmp "$H/prefix/update/release-signing.pub" "$KEYS/other.pub"'
  make_release 1.3.0 2026.1005.0; cp "$KEYS/other.pub" "$R/deploy/release-signing.pub"; publish_release "$R" "$web/v1.3.0" fx
  printf 'action=update\nversion=1.3.0\nrequestedBy=sam@pve\nat=1\n' >"$st/request"; urun
  check "rotation: after it, a release signed only by the old key is refused" eval '[ "$(ustat phase)" = failed ] && ustat message | grep -q "not valid for the pinned key" && [ "$(version)" = 1.2.0 ]'
  publish_release "$R" "$web/v1.3.0" other
  printf 'action=update\nversion=1.3.0\nrequestedBy=sam@pve\nat=1\n' >"$st/request"; urun
  check "rotation: and one signed by the new key installs" eval '[ "$(ustat phase)" = done ] && [ "$(version)" = 1.3.0 ]'
  R="$old" install --uninstall >/dev/null 2>&1
}

# get.sh (the one a release carries) and install.sh --tarball: signature, checksum and version before anything is unpacked.
s_get() {
  new_host get; make_release 1.1.0 2026.1005.0; local r11="$R" web="$H/web" fe="$R/fake-engine.mjs"
  make_release 1.0.0 2026.1005.0; local r10="$R"
  build_get() { node --input-type=module -e 'import { buildGetSh } from "'"$REPO"'/scripts/release-lib.mjs"; import { readFileSync } from "node:fs"; process.stdout.write(buildGetSh("'"$REPO"'/", process.argv[1] ? readFileSync(process.argv[1], "utf8") : ""));' "$1"; }
  build_get "$KEYS/fx.pub" >"$H/get.sh"; build_get "" >"$H/get-nokey.sh"
  local gget; gget() { EPC_RELEASE_BASE="file://$web" EPC_FAKE_ENGINE="$fe" bash "${1:-$H/get.sh}" >"$H/out" 2>&1; RC=$?; }
  local refused; refused() { WANT="$2"; check "$1" eval '[ "$RC" -ne 0 ] && has "$WANT" && [ ! -e "$H/prefix/VERSION" ] && ! leftovers'; }
  check "get.sh built for a release parses and carries the verifier and the key" eval 'bash -n "$H/get.sh" && grep -q "epc_verify_release()" "$H/get.sh" && grep -q "BEGIN PUBLIC KEY" "$H/get.sh"'
  check "the verifier in get.sh is deploy/verify-release.sh itself" eval 'grep -qF -f <(grep -v "^#" "$REPO/deploy/verify-release.sh" | grep -v "^$") "$H/get.sh"'

  gget "$REPO/deploy/get.sh"
  refused "the unsigned template get.sh refuses and points to the release's copy" "unsigned template"
  publish_release "$r11" "$web"; gget "$H/get-nokey.sh"
  refused "a get.sh built with no key refuses and says to run release-keygen" "release-keygen"
  publish_release "$r11" "$web" other; gget
  refused "a release signed by a different key is refused" "not valid for the pinned key"
  publish_release "$r11" "$web"; rm "$web/epaperclip.manifest.sig"; gget
  refused "a release with no signature is refused" "signature"
  publish_release "$r11" "$web"; echo tampered >>"$web/epaperclip.tar.gz"; gget
  refused "a tampered tarball is refused" "checksum"
  publish_release "$r11" "$web"; publish_release "$r10" "$H/web-10"; cp "$H"/web-10/epaperclip.manifest.{json,sig} "$web/"; gget
  refused "a swapped (validly signed) manifest is refused" "checksum"
  publish_release "$r11" "$web"; gget
  check "a properly signed release installs (exit 0)" eval '[ "$RC" -eq 0 ] && has "signature and checksum verified (version 1.1.0)" && [ "$(version)" = 1.1.0 ] && host_health'
  publish_release "$r10" "$web"; gget
  check "an older signed release than the installed one is refused (replay)" eval '[ "$RC" -ne 0 ] && has "older than the 1.1.0" && [ "$(version)" = 1.1.0 ]'
  EPC_ALLOW_DOWNGRADE=1 gget
  check "...unless the person says so with EPC_ALLOW_DOWNGRADE=1" eval '[ "$RC" -eq 0 ] && [ "$(version)" = 1.0.0 ]'

  # install.sh --tarball (key: the installed one, else EPC_SIGNING_KEY or the one beside the script)
  install --uninstall >/dev/null 2>&1; rm -rf "$H/prefix.prev"
  local tb; tb() { EPC_SIGNING_KEY="$KEYS/${2:-fx}.pub" EPC_FAKE_ENGINE="$fe" bash "$r11/deploy/install.sh" --tarball "$1" >"$H/out" 2>&1; RC=$?; }
  publish_release "$r11" "$web"; tb "$web/epaperclip.tar.gz" other
  refused "install.sh --tarball with a different key is refused" "not valid for the pinned key"
  rm "$web/epaperclip.manifest.json"; tb "$web/epaperclip.tar.gz"
  refused "install.sh --tarball with no manifest is refused" "manifest"
  publish_release "$r11" "$web"; echo tampered >>"$web/epaperclip.tar.gz"; tb "$web/epaperclip.tar.gz"
  refused "install.sh --tarball with a tampered file is refused" "checksum"
  publish_release "$r11" "$web"; tb "$web/epaperclip.tar.gz"
  check "install.sh --tarball installs a verified release" eval '[ "$RC" -eq 0 ] && [ "$(version)" = 1.1.0 ] && host_health'
  publish_release "$r10" "$web"; tb "$web/epaperclip.tar.gz"
  check "install.sh --tarball refuses an older release than the installed one" eval '[ "$RC" -ne 0 ] && has "older than the 1.1.0" && [ "$(version)" = 1.1.0 ]'

  # Versions: a release candidate is older than its release; the comparison the helper and get.sh share.
  local ok=1 a b exp
  for t in "1.0.0-rc1 1.0.0 lt" "1.0.0 1.0.0-rc1 ge" "1.0.0-rc1 1.0.0-rc2 lt" "1.0.0-rc2 1.0.0-rc10 lt" "0.9.9 1.0.0-rc1 lt" "1.0.0-rc1 0.9.9 ge" "1.2.0 1.10.0 lt" "1.0.0 1.0.0 ge"; do
    set -- $t; a=$1; b=$2; exp=$3
    got=$(bash -c '. "$1"; if epc_ver_lt "$2" "$3"; then echo lt; else echo ge; fi' _ "$REPO/deploy/verify-release.sh" "$a" "$b")
    [ "$got" = "$exp" ] || { ok=0; echo "       $a vs $b: got $got, wanted $exp"; }
  done
  check "version order: release candidates sort before their release, numbers numerically" [ "$ok" = 1 ]
  install --uninstall >/dev/null 2>&1
}

ALL=(update_helper signing get fresh upgrade rollback broken service_fails first_fails from_pre_engine preflight uninstall deb npm real_engine)
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
