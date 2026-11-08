#!/usr/bin/env bash
# Disposable parity engines (paperclipai 2026.1023.0) on loopback, own data under /project/.work/parity.
#   engine.sh start native|epc   engine.sh stop native|epc   engine.sh status
# native = the stock package, UI served (reference). epc = the engine the ePaperclip host fronts (SERVE_UI=false).
# Secrets below are throwaway values for loopback test engines.
set -euo pipefail
ROOT=${PARITY_DIR:-/project/.work/parity}
TREE=${EPC_LIVE_ENGINE_DIR:-/project/.work/engine-1023/tree}
NODE=${PARITY_NODE:-/project/.work/engine-1023/node-v24.21.0-linux-x64/bin/node}
which_=${2:-native}
case "$which_" in native) PORT=3290; PG=54390; UI=true;; epc) PORT=3291; PG=54391; UI=false;; *) echo "native|epc"; exit 2;; esac
H=$ROOT/$which_
start() {
  mkdir -p "$H/db" "$H/data" "$H/secrets" "$H/logs"
  cat > "$H/config.json" <<JSON
{"\$meta":{"version":1,"updatedAt":"2026-11-08T00:00:00Z","source":"configure"},
 "database":{"mode":"embedded-postgres","embeddedPostgresDataDir":"$H/db","embeddedPostgresPort":$PG,"backup":{"enabled":false,"dir":"$H/backups"}},
 "logging":{"mode":"file","logDir":"$H/logs"},
 "server":{"deploymentMode":"authenticated","exposure":"private","host":"127.0.0.1","port":$PORT,"allowedHostnames":["127.0.0.1","localhost"],"serveUi":$UI},
 "telemetry":{"enabled":false},"updates":{"checkEnabled":false},
 "storage":{"provider":"local_disk","localDisk":{"baseDir":"$H/storage"}},
 "secrets":{"provider":"local_encrypted","strictMode":false,"localEncrypted":{"keyFilePath":"$H/secrets/master.key"}}}
JSON
  cd "$TREE"
  PAPERCLIP_CONFIG="$H/config.json" PAPERCLIP_HOME="$H/home" HOME="$H/home" \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_DEPLOYMENT_EXPOSURE=private HOST=127.0.0.1 PORT=$PORT \
  PAPERCLIP_PUBLIC_URL=http://127.0.0.1:$PORT PAPERCLIP_API_URL=http://127.0.0.1:$PORT PAPERCLIP_ALLOWED_HOSTNAMES=127.0.0.1,localhost \
  PAPERCLIP_MIGRATION_AUTO_APPLY=true SERVE_UI=$UI PAPERCLIP_AUTH_RATE_LIMIT_ENABLED=false PAPERCLIP_TELEMETRY_DISABLED=1 \
  PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=disposable-tool-action-signing-parity-0123456789abcdef0123 \
  BETTER_AUTH_SECRET=disposable-parity-secret-0123456789abcdef PAPERCLIP_AGENT_JWT_SECRET=disposable-parity-jwt-0123456789abcdef \
  nohup "$NODE" --max-old-space-size=1536 node_modules/@paperclipai/server/dist/index.js >"$H/engine.log" 2>&1 &
  echo $! > "$H/engine.pid"
  for i in $(seq 1 90); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && { echo "$which_ up on $PORT (pid $(cat "$H/engine.pid"))"; return; }; sleep 1; done
  echo "$which_ did not come up; see $H/engine.log" >&2; exit 1
}
stop() { [ -f "$H/engine.pid" ] && kill "$(cat "$H/engine.pid")" 2>/dev/null && echo "stopped $which_" || echo "$which_ not running"; }
case "${1:-status}" in
  start) start;; stop) stop;;
  status) for w in native epc; do p=$ROOT/$w/engine.pid; [ -f "$p" ] && kill -0 "$(cat "$p")" 2>/dev/null && echo "$w running" || echo "$w stopped"; done;;
esac
