#!/usr/bin/env bash
# Read-only check of where an agent's Paperclip MCP servers point and whether that address works from inside a container.
#   sudo bash scripts/diagnose-mcp-routing.sh <run-id> [<running disposable container id>]
# It prints server names, transports, hosts and ports only: no tokens, headers, URL paths with ids, or environment variables.
# It never starts, stops or changes anything. With a container id it only runs a TCP connect test inside that container.
set -u
RUN="${1:-}"; CT="${2:-}"
[ -n "$RUN" ] || { echo "usage: $0 <run-id> [<container id>]" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "run as root (the engine's run folders are private)" >&2; exit 2; }
ENGINE_HOME="${EPC_ENGINE_HOME:-/var/lib/epaperclip-engine}"
node_json() { /opt/epaperclip/node/bin/node "$@" 2>/dev/null || node "$@"; }

echo "== engine"
echo "version: $(cat /opt/epaperclip/VERSION 2>/dev/null) ($(cat /opt/epaperclip/CHANNEL 2>/dev/null))"
grep -E '^(PAPERCLIP_DEPLOYMENT_MODE|PAPERCLIP_API_URL|HOST|PORT)=' /etc/epaperclip/engine.env /etc/epaperclip/engine.env.d/* 2>/dev/null | sed 's/^[^:]*://'
ss -ltnH '( sport = :3100 or sport = :3120 )' 2>/dev/null | awk '{print "listening:", $4}'

echo "== retained MCP configuration for run $RUN (Claude CLI path)"
found=0
while IFS= read -r f; do
  found=1
  echo "file: ${f#"$ENGINE_HOME"/}"
  node_json -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const [name, s] of Object.entries(c.mcpServers ?? {})) {
      let host = "?"; try { const u = new URL(s.url); host = u.hostname + ":" + (u.port || (u.protocol === "https:" ? 443 : 80)); } catch {}
      console.log(JSON.stringify({ server: name, transport: s.type ?? (s.url ? "http" : "stdio"), destination: host }));
    }' "$f"
done < <(find "$ENGINE_HOME" -path "*$RUN*" -name mcp-config.json 2>/dev/null)
[ "$found" = 1 ] || echo "none retained (the run folder is gone or the run used the ACP path)"

echo "== retained launch metadata (ACP path): names of files only"
find "$ENGINE_HOME" -path "*$RUN*" \( -name '*.json' -o -name '*.ndjson' \) 2>/dev/null | sed "s|^$ENGINE_HOME/||" | head -20

if [ -n "$CT" ]; then
  echo "== from inside container $CT"
  pct status "$CT" | sed 's/^/status: /'
  for target in "127.0.0.1 3100"; do
    set -- $target
    if pct exec "$CT" -- sh -c "timeout 3 bash -c '</dev/tcp/$1/$2' 2>/dev/null"; then echo "$1:$2 -> open (something answers inside the container)"; else echo "$1:$2 -> refused or no answer inside the container"; fi
  done
  gw="$(pct exec "$CT" -- sh -c "ip -4 route show default | awk '{print \$3}'" 2>/dev/null | tr -d '\r')"
  [ -n "$gw" ] && { if pct exec "$CT" -- sh -c "timeout 3 bash -c '</dev/tcp/$gw/3100' 2>/dev/null"; then echo "$gw:3100 (bridge gateway) -> open"; else echo "$gw:3100 (bridge gateway) -> refused (expected: the engine is host-loopback only)"; fi; }
fi
