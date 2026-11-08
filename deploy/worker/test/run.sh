#!/usr/bin/env bash
# Tests deploy/worker/install.sh on simulated machines: no systemd, no real users. About ten seconds.
#   bash deploy/worker/test/run.sh
# Each scenario is a temporary folder; EPW_TEST=1 and the EPW_* settings point every path into it, and stand-ins for
# useradd, id, chown and getent record what the installer asks for. The packaged bundle really runs (version, caps, config, status).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ok   $1"; }
bad() { fail=$((fail+1)); echo "  FAIL $1"; [ -f "$H/out" ] && sed 's/^/       | /' "$H/out" | tail -n 15; }
check() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
nocheck() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then bad "$d"; else ok "$d"; fi; }

bash "$REPO/scripts/package-worker.sh" "$WORK/release" >"$WORK/pkg.out" 2>&1 || { cat "$WORK/pkg.out"; echo "packaging failed"; exit 1; }
TAR="$(ls "$WORK"/release/epaperclip-worker-*.tar.gz)"; SUM="$(cut -d' ' -f1 "$WORK/release/SHA256SUMS")"

mkdir -p "$WORK/pkg" && tar -xzf "$TAR" -C "$WORK/pkg" && PKG="$(dirname "$(find "$WORK/pkg" -name install.sh | head -1)")"
new_host() {
  H="$WORK/$1"; mkdir -p "$H/bin" "$H/log"
  for c in useradd userdel chown; do printf '#!/bin/sh\necho "%s $*" >> "%s/log/calls"\nexit 0\n' "$c" "$H" > "$H/bin/$c"; chmod +x "$H/bin/$c"; done
  printf '#!/bin/sh\n[ "$1" = "-u" ] && [ -z "$2" ] && { echo 0; exit 0; }\n[ "$1" = "-un" ] && { echo epwtest; exit 0; }\nexit 1\n' > "$H/bin/id"; chmod +x "$H/bin/id"
  printf '#!/bin/sh\nexit 2\n' > "$H/bin/getent"; chmod +x "$H/bin/getent"
  export PATH="$H/bin:$(echo "$PATH" | sed "s|$WORK/[^:]*/bin:||g")"
  export EPW_TEST=1 EPW_PREFIX="$H/opt" EPW_UNIT_DIR="$H/units" EPW_DATA="$H/data" EPW_WORKSPACES="$H/ws" EPW_BIN_DIR="$H/usrbin" EPW_USER=epwtest
  unset EPW_NODE
}
inst() { bash "$PKG/install.sh" "$@" >"$H/out" 2>&1; }
run_in_tmp() { ( cd "$(mktemp -d "$WORK/x.XXXX")" && "$@" ); }

echo "scenario: fresh install from a verified tarball"
new_host fresh
inst --tarball "$TAR" --sha256 "$SUM" --name Orion --ollama-url http://127.0.0.1:11434 --max-context 4096 --slots 1 && ok "install succeeds" || bad "install succeeds"
check "bundle installed" test -s "$H/opt/epaperclip-worker.mjs"
check "unit file filled in" grep -q "ExecStart=.*epaperclip-worker.mjs run" "$H/units/epaperclip-worker.service"
nocheck "no unfilled placeholders in the unit" grep -q "@[A-Z]*@" "$H/units/epaperclip-worker.service"
check "unit runs as the service user" grep -q "^User=epwtest" "$H/units/epaperclip-worker.service"
check "boots with the machine" grep -q "WantedBy=multi-user.target" "$H/units/epaperclip-worker.service"
check "restarts on failure" grep -q "Restart=always" "$H/units/epaperclip-worker.service"
check "system user created, no shell, no home creation" grep -q "useradd --system --user-group --home-dir .* --no-create-home --shell /usr/sbin/nologin epwtest" "$H/log/calls"
check "state folder is private" test "$(stat -c %a "$H/data")" = 750
check "settings written" grep -q '"maxContext": 4096' "$H/data/config.json"
check "name written" grep -q '"name": "Orion"' "$H/data/config.json"
check "prints how to adopt" grep -q "epaperclip-worker adopt" "$H/out"
check "prints ePaperclip Worker ready" grep -q "ePaperclip Worker ready" "$H/out"
check "command wrapper exists" test -x "$H/usrbin/epaperclip-worker"
check "packaged daemon answers status" bash -c "EPW_DIR='$H/data' node '$H/opt/epaperclip-worker.mjs' status | grep -q 'not adopted'"
check "packaged daemon reports capabilities" bash -c "EPW_DIR='$H/data' EPW_WORKSPACES='$H/ws' node '$H/opt/epaperclip-worker.mjs' caps | grep -q '\"workspaceRoot\"'"
check "opens no port (no listen in the unit)" bash -c "! grep -qi 'ListenStream' '$H/units/epaperclip-worker.service'"

echo "scenario: upgrade keeps settings and the machine key, and rolls back"
new_host upgrade
inst && ok "first install" || bad "first install"
EPW_DIR="$H/data" node "$H/opt/epaperclip-worker.mjs" config name=Keep >/dev/null
echo '{"privatePem":"KEEP-ME","publicKey":"x"}' > "$H/data/identity.json"
cp "$H/opt/epaperclip-worker.mjs" "$H/v1.mjs"
D2="$WORK/pkg2"; mkdir -p "$D2"; cp "$PKG/install.sh" "$PKG/epaperclip-worker.service" "$D2/"; ( cat "$H/v1.mjs"; echo "// v2" ) > "$D2/epaperclip-worker.mjs"
bash "$D2/install.sh" >"$H/out" 2>&1 && ok "upgrade succeeds" || bad "upgrade succeeds"
check "settings preserved" grep -q '"name": "Keep"' "$H/data/config.json"
check "machine key untouched" grep -q KEEP-ME "$H/data/identity.json"
check "previous version kept" test -f "$H/opt/epaperclip-worker.mjs.prev"
check "new version in place" grep -q "// v2" "$H/opt/epaperclip-worker.mjs"
inst --rollback && ok "rollback succeeds" || bad "rollback succeeds"
nocheck "rolled back to v1" grep -q "// v2" "$H/opt/epaperclip-worker.mjs"
check "re-running the same install is harmless" bash "$PKG/install.sh"

echo "scenario: refuses before changing anything"
new_host badsum
inst --tarball "$TAR" --sha256 0000000000000000000000000000000000000000000000000000000000000000 && bad "wrong checksum refused" || ok "wrong checksum refused"
check "says nothing was installed" grep -q "Nothing was installed" "$H/out"
nocheck "no files written after a checksum failure" test -e "$H/opt/epaperclip-worker.mjs"
inst --tarball "$TAR" && bad "tarball without checksum refused" || ok "tarball without checksum refused"
new_host oldnode
printf '#!/bin/sh\ncase "$*" in *versions*) echo 18;; *-v*) echo v18.0.0;; *) exit 0;; esac\n' > "$H/oldnode"; chmod +x "$H/oldnode"
EPW_NODE="$H/oldnode" inst && bad "old Node refused" || ok "old Node refused"
check "explains the Node requirement" grep -q "Node.js 22 or newer" "$H/out"
nocheck "nothing created for an old Node" test -e "$H/opt"
new_host nonode
PATH="$H/bin:/usr/bin-nonexistent" EPW_NODE=/no/such/node inst && bad "missing Node refused" || ok "missing Node refused"
new_host checkonly
inst --check && ok "--check passes on a good machine" || bad "--check passes on a good machine"
nocheck "--check changes nothing" test -e "$H/opt"

echo "scenario: uninstall"
new_host remove
inst && ok "install" || bad "install"
echo secret > "$H/data/identity.json"; mkdir -p "$H/ws/co/agent/run"; echo work > "$H/ws/co/agent/run/f"
inst --uninstall && ok "uninstall succeeds" || bad "uninstall succeeds"
nocheck "service files gone" test -e "$H/units/epaperclip-worker.service"
nocheck "program gone" test -e "$H/opt"
check "key and settings kept by default" test -f "$H/data/identity.json"
check "workspaces kept by default" test -f "$H/ws/co/agent/run/f"
inst && inst --uninstall --purge && ok "purge succeeds" || bad "purge succeeds"
nocheck "purge removes the key" test -e "$H/data"
check "purge keeps workspaces" test -d "$H/ws"
check "purge removes the user" grep -q "userdel epwtest" "$H/log/calls"
inst && inst --uninstall --purge-workspaces && ok "purge workspaces" || bad "purge workspaces"
nocheck "workspaces removed" test -e "$H/ws"

echo "scenario: per-user install with no root (--user)"
new_host userinst
unset EPW_PREFIX EPW_UNIT_DIR EPW_DATA EPW_WORKSPACES EPW_BIN_DIR EPW_USER
export HOME="$H/home"; mkdir -p "$HOME"
inst --user --name Orion --max-context 4096 && ok "user install succeeds" || bad "user install succeeds"
check "files under ~/.local" test -s "$HOME/.local/epaperclip-worker/epaperclip-worker.mjs"
check "user unit written" test -f "$HOME/.config/systemd/user/epaperclip-worker.service"
nocheck "user unit has no User= line" grep -q "^User=" "$HOME/.config/systemd/user/epaperclip-worker.service"
check "user unit starts with the user manager" grep -q "WantedBy=default.target" "$HOME/.config/systemd/user/epaperclip-worker.service"
check "workspaces default to ~/epaperclip-workspaces" grep -q "$HOME/epaperclip-workspaces" "$HOME/.config/systemd/user/epaperclip-worker.service"
check "key and settings in ~/.local/share" test -f "$HOME/.local/share/epaperclip-worker/config.json"
nocheck "no system user created" test -s "$H/log/calls"
check "wrapper in ~/.local/bin" test -x "$HOME/.local/bin/epaperclip-worker"
inst --user --uninstall && ok "user uninstall succeeds" || bad "user uninstall succeeds"
nocheck "user program gone" test -e "$HOME/.local/epaperclip-worker"
check "user settings kept" test -f "$HOME/.local/share/epaperclip-worker/config.json"
nocheck "no Node and no --fetch-node: refused" env PATH="$H/bin:/nonexistent" EPW_NODE=/no/node bash "$PKG/install.sh" --user --check

echo; echo "worker installer: $pass passed, $fail failed"
[ "$fail" = 0 ]
