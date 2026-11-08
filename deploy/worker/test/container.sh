#!/usr/bin/env bash
# Full bootstrap test on a disposable CLEAN Debian 12 with real systemd (docker, privileged). Needs docker and ~2 GB of disk; no root on the host
# beyond docker. Real in this test: apt, the Tailscale apt repo and package, Node.js (pinned download), install.sh, systemd units, users, sudo rules,
# the worker daemon, the host-signed management path against a real FabricHub. Faked: the Ollama binary (a small python server; the SHA-256 and
# unpacking path are still exercised with a local mirror). Not testable here: a tailnet login (no /dev/net/tun), a GPU, Jetson/L4T.
#   bash deploy/worker/test/container.sh [--keep]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"
KEEP=0; [ "${1:-}" = --keep ] && KEEP=1
IMG=epb-clean-target:1; C=epb-clean; W="${EPB_WORK:-/project/.work/epb-container}"; mkdir -p "$W"; rm -rf "$W/host-state"
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ok   $1"; }
bad() { fail=$((fail+1)); echo "  FAIL $1"; }
t()   { local d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
nt()  { local d="$1"; shift; if "$@" >/dev/null 2>&1; then bad "$d"; else ok "$d"; fi; }
X()   { docker exec "$C" bash -c "$*"; }
admin() { curl -fsS -m 120 -H 'content-type: application/json' "http://127.0.0.1:3140$1" ${2:+-d "$2"}; }
cleanup() { [ "$KEEP" = 1 ] || { docker rm -f "$C" >/dev/null 2>&1; }; [ -z "${HOSTPID:-}" ] || kill "$HOSTPID" 2>/dev/null; }
trap cleanup EXIT

echo "build the clean target and the worker release"
docker build -q -t "$IMG" "$HERE/container" >/dev/null || { echo "image build failed"; exit 1; }
bash "$REPO/scripts/package-worker.sh" "$W/release" >/dev/null || { echo "packaging failed"; exit 1; }
docker rm -f "$C" >/dev/null 2>&1
docker run -d --name "$C" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock "$IMG" >/dev/null || { echo "docker run failed"; exit 1; }
for i in $(seq 1 30); do X 'systemctl is-system-running 2>/dev/null | grep -qE "running|degraded"' && break; sleep 1; done
GW="$(docker inspect -f '{{.NetworkSettings.Gateway}}' "$C")"
docker exec "$C" mkdir -p /root/rel && docker cp "$W/release/." "$C:/root/rel/" && X 'cd /root/rel && tar xzf epaperclip-worker-*.tar.gz && mv epaperclip-worker-*/ pkg'
X 'cd /mirror && nohup python3 -m http.server 8099 --bind 127.0.0.1 >/dev/null 2>&1 &'
(cd "$REPO/services/epaperclip" && node --experimental-strip-types "$HERE/container/host.ts" "$W/host-state" "$GW" >"$W/host.log" 2>&1) & HOSTPID=$!
for i in $(seq 1 20); do admin /workers >/dev/null 2>&1 && break; sleep 0.5; done
B='cd /root/rel/pkg && EPB_MIRROR=http://127.0.0.1:8099 ./bootstrap.sh'

echo "1. a clean machine: nothing installed"
nt "no curl yet" X 'command -v curl'
nt "no sudo yet" X 'command -v sudo'
nt "no ollama user" X 'id ollama'

echo "2. --check changes nothing"
X "$B --check --ollama-version v0.0.1 --name ct" >"$W/check.out" 2>&1; t "check exits 0" test $? = 0
grep -q 'class      : x86' "$W/check.out" && ok "check reports the hardware class" || bad "check reports the hardware class"
nt "check created no state log" X 'test -e /var/lib/epaperclip-worker/bootstrap.log'
nt "check installed no curl" X 'command -v curl'
nt "check created no user" X 'id epaperclip-worker'

echo "3. a tampered download is refused"
X 'cp /mirror/v0.0.1/sha256sum.txt /root/sums.good && sed -i "s/^./0/" /mirror/v0.0.1/sha256sum.txt'
nt "bootstrap stops on a checksum mismatch" X "$B --yes --models none --ollama-version v0.0.1 --no-tailscale --name ct"
nt "ollama binary not installed after mismatch" X 'test -x /usr/local/bin/ollama'
X 'cp /root/sums.good /mirror/v0.0.1/sha256sum.txt'

echo "4. real setup (with Tailscale package, fake Ollama binary, pairing code)"
CODE="$(admin /pair '{"name":"ct"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["code"])')"
X "$B --yes --models auto --ollama-version v0.0.1 --name ct --host-code '$CODE'" >"$W/setup.out" 2>&1; rc=$?
[ $rc = 0 ] && ok "bootstrap exits 0" || { bad "bootstrap exits 0 (rc=$rc)"; tail -30 "$W/setup.out"; }
t "tailscale package installed from the official repo" X 'dpkg -s tailscale'
t "ollama service active" X 'systemctl is-active ollama'
t "worker service active" X 'systemctl is-active epaperclip-worker'
t "ollama starts at boot" X 'systemctl is-enabled ollama'
t "worker starts at boot (system unit, no linger)" X 'systemctl is-enabled epaperclip-worker'
t "worker runs as its own non-root user" X '[ "$(ps -o user= -p $(systemctl show -p MainPID --value epaperclip-worker))" = epaperclip-worker ]'
t "ollama runs as the ollama user" X '[ "$(ps -o user= -p $(systemctl show -p MainPID --value ollama))" = ollama ]'
t "ollama bound to loopback (no tailnet in a container)" X 'ss -ltnH | grep -q "127.0.0.1:11434"'
nt "no listener on all interfaces (0.0.0.0 or [::])" X 'ss -ltnH | awk "{print \$4}" | grep -E "^(0\.0\.0\.0|\*|\[::\]):"'
t "limits written: one model, one request, context from RAM" X 'grep -q OLLAMA_MAX_LOADED_MODELS=1 /etc/systemd/system/ollama.service.d/epaperclip.conf && grep -q OLLAMA_NUM_PARALLEL=1 /etc/systemd/system/ollama.service.d/epaperclip.conf && grep -qE "OLLAMA_CONTEXT_LENGTH=[0-9]+" /etc/systemd/system/ollama.service.d/epaperclip.conf'
t "recommended model pulled" X 'curl -fsS 127.0.0.1:11434/api/tags | grep -q qwen2.5-coder'
t "change log written" X 'test -s /var/lib/epaperclip-worker/bootstrap.log'
t "manifest lists what was created" X 'grep -q "^user epaperclip-worker" /var/lib/epaperclip-worker/bootstrap.manifest'
t "sudoers rule valid" X 'visudo -cf /etc/sudoers.d/epaperclip-worker'
t "host key pinned for signed updates" X 'test -s /etc/epaperclip-worker/host.pub'
t "helper is root-owned and not writable by the worker" X '[ "$(stat -c %U:%a /usr/local/lib/epaperclip-worker/epw-admin)" = root:755 ]'
nt "worker user cannot run arbitrary commands as root" X 'sudo -u epaperclip-worker sudo -n /bin/true'
nt "worker user cannot call the helper with another verb" X 'sudo -u epaperclip-worker sudo -n /usr/local/lib/epaperclip-worker/epw-admin shell'

echo "5. idempotent re-run"
X "$B --yes --models auto --ollama-version v0.0.1 --name ct" >"$W/rerun.out" 2>&1; t "second run exits 0" test $? = 0
t "no duplicate manifest lines" X '[ "$(sort /var/lib/epaperclip-worker/bootstrap.manifest | uniq -d | wc -l)" = 0 ]'
t "services still up" X 'systemctl is-active ollama epaperclip-worker'

echo "6. adoption, health and signed management from the host"
ID=""; for i in $(seq 1 40); do ID="$(admin /workers | python3 -c 'import sys,json;w=[x for x in json.load(sys.stdin) if x["online"]];print(w[0]["id"] if w else "")')"; [ -n "$ID" ] && break; sleep 1; done
[ -n "$ID" ] && ok "worker adopted and online ($ID)" || bad "worker adopted and online"
for i in $(seq 1 40); do admin "/stats?id=$ID" | grep -q '"latest":{' && break; sleep 1; done
S="$(admin "/stats?id=$ID")"
echo "$S" | python3 -c 'import sys,json;s=json.load(sys.stdin)["latest"];assert s["mem"]["totalMb"]>0 and s["cpu"]["cores"]>0' && ok "host has a health sample (memory, cores)" || bad "host has a health sample"
echo "$S" | python3 -c 'import sys,json;s=json.load(sys.stdin)["latest"];assert s["services"]["ollama"]=="active" and s["services"]["worker"]=="active";assert s["ollama"]["up"]' && ok "sample shows ollama and worker services active, ollama reachable" || bad "sample shows services"
echo "$S" | python3 -c 'import sys,json;s=json.load(sys.stdin)["latest"];assert any("qwen" in m["name"] for m in s["ollama"]["available"])' && ok "sample lists the pulled model" || bad "sample lists the pulled model"
m() { admin /manage "{\"id\":\"$ID\",\"action\":\"$1\",\"params\":${2:-{\}}}"; }
m logs '{"unit":"ollama","lines":20}' | grep -q '"text"' && ok "logs of ollama through the signed path" || bad "logs of ollama"
m logs '{"unit":"worker","lines":20}' | grep -q 'connected as' && ok "worker log shows it connected" || bad "worker log"
m model-pull '{"name":"llama3.2:1b"}' >/dev/null; sleep 2; X 'curl -fsS 127.0.0.1:11434/api/tags | grep -q llama3.2:1b' && ok "model pulled from the console path" || bad "model pull"
m model-remove '{"name":"llama3.2:1b"}' >/dev/null; X 'curl -fsS 127.0.0.1:11434/api/tags | grep -q llama3.2:1b' && bad "model removed" || ok "model removed from the console path"
P1="$(X 'systemctl show -p MainPID --value ollama')"; m restart-ollama >/dev/null; sleep 2; P2="$(X 'systemctl show -p MainPID --value ollama')"
[ "$P1" != "$P2" ] && X 'systemctl is-active ollama' >/dev/null && ok "restart-ollama restarted the service (pid changed)" || bad "restart-ollama"
P1="$(X 'systemctl show -p MainPID --value epaperclip-worker')"; m restart-worker >/dev/null; sleep 6; P2="$(X 'systemctl show -p MainPID --value epaperclip-worker')"
[ "$P1" != "$P2" ] && ok "restart-worker restarted the worker (pid changed)" || bad "restart-worker"
for i in $(seq 1 30); do admin /workers | grep -q '"online":true' && break; sleep 1; done; admin /workers | grep -q '"online":true' && ok "worker reconnected after its restart" || bad "worker reconnected"
admin /manage "{\"id\":\"$ID\",\"action\":\"model-pull\",\"params\":{\"name\":\"x;rm -rf /\"}}" 2>&1 | grep -q . ; nt "a malformed model name is refused" admin /manage "{\"id\":\"$ID\",\"action\":\"model-pull\",\"params\":{\"name\":\"x;id\"}}"
admin /audit | python3 -c 'import sys,json;a=[e["action"] for e in json.load(sys.stdin)];assert "manage.restart-ollama" in a and "manage.logs" in a' && ok "management actions are in the audit log" || bad "audit log"

echo "7. signed update over https (local CA), then rollback is available"
X 'cd /root && mkdir -p up && cd up && tar xzf ../rel/epaperclip-worker-*.tar.gz && echo "// update-proof" >> epaperclip-worker-*/epaperclip-worker.mjs && tar czf /root/update.tar.gz epaperclip-worker-* && openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" -keyout /root/k.pem -out /root/c.pem 2>/dev/null && mkdir -p /srv/up && cp /root/update.tar.gz /srv/up/ && cd /srv/up && nohup python3 -c "import http.server,ssl;s=http.server.HTTPServer((\"127.0.0.1\",8443),http.server.SimpleHTTPRequestHandler);c=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);c.load_cert_chain(\"/root/c.pem\",\"/root/k.pem\");s.socket=c.wrap_socket(s.socket,server_side=True);s.serve_forever()" >/dev/null 2>&1 &'
X 'mkdir -p /etc/systemd/system/epaperclip-worker.service.d && printf "[Service]\nEnvironment=NODE_EXTRA_CA_CERTS=/root/c.pem\n" > /etc/systemd/system/epaperclip-worker.service.d/test-ca.conf && chmod 644 /root/c.pem && systemctl daemon-reload && systemctl restart epaperclip-worker'
for i in $(seq 1 30); do admin /workers | grep -q '"online":true' && break; sleep 1; done
SHA="$(X 'sha256sum /root/update.tar.gz | cut -d" " -f1')"
nt "an update with the wrong checksum is refused" admin /manage "{\"id\":\"$ID\",\"action\":\"update\",\"params\":{\"url\":\"https://127.0.0.1:8443/update.tar.gz\",\"sha256\":\"$(printf 'a%.0s' $(seq 64))\"}}"
nt "http (not https) update address refused" admin /manage "{\"id\":\"$ID\",\"action\":\"update\",\"params\":{\"url\":\"http://127.0.0.1:8443/update.tar.gz\",\"sha256\":\"$SHA\"}}"
m update "{\"url\":\"https://127.0.0.1:8443/update.tar.gz\",\"sha256\":\"$SHA\"}" >/dev/null; sleep 10
t "update installed the new bundle" X 'grep -q "update-proof" /opt/epaperclip-worker/epaperclip-worker.mjs'
t "previous version kept for rollback" X 'test -f /opt/epaperclip-worker/epaperclip-worker.mjs.prev'
for i in $(seq 1 30); do admin /workers | grep -q '"online":true' && break; sleep 1; done; admin /workers | grep -q '"online":true' && ok "worker back online on the new version" || bad "worker back online after update"
X 'rm -f /etc/epaperclip-worker/host.pub'; X 'mkdir -p /var/lib/epaperclip-worker/staging'
nt "update is refused when no host key is pinned in root's file" X 'sudo -u epaperclip-worker sudo -n /usr/local/lib/epaperclip-worker/epw-admin update-worker'
X "$B --pin-host-key" >/dev/null 2>&1; t "--pin-host-key restores the pin" X 'test -s /etc/epaperclip-worker/host.pub'

echo "8. uninstall reverses it"
X "$B --uninstall --purge --purge-models" >"$W/uninstall.out" 2>&1; t "uninstall exits 0" test $? = 0
nt "ollama service gone" X 'systemctl is-enabled ollama'
nt "worker service gone" X 'systemctl is-enabled epaperclip-worker'
nt "ollama binary gone" X 'test -e /usr/local/bin/ollama'
nt "sudo rule gone" X 'test -e /etc/sudoers.d/epaperclip-worker'
nt "helper gone" X 'test -e /usr/local/lib/epaperclip-worker'
nt "worker user gone" X 'id epaperclip-worker'
nt "ollama user gone" X 'id ollama'
t "tailscale left alone and says so" grep -q "Tailscale was left" "$W/uninstall.out"

echo; echo "container bootstrap test: $pass passed, $fail failed"
[ "$fail" = 0 ]
