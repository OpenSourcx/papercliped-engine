#!/usr/bin/env bash
# epaperclip-mcp-check: does an agent container reach Paperclip's MCP servers, with Paperclip's own authentication, while the
# engine stays on host loopback? Run as root on the Proxmox host that runs ePaperclip, against a disposable agent container
# while an agent run in it is active (the provider opens the container's tunnel when it first runs a command there).
#
#   /opt/epaperclip/update/mcp-check.sh <container id> [--run <run id>]      (also: epaperclip mcp-check ...)
#
# It changes nothing: no service is touched and no container is started or stopped. It sends a few requests from inside the
# container. With --run it reads that run's own MCP bearer tokens from the run's retained mcp-config.json (a Claude CLI run)
# and sends them to the container on stdin, never on a command line and never printed; or set EPC_MCP_TOKEN_RUNTIME and
# EPC_MCP_TOKEN_PROJECT for a run that kept none. Paperclip revokes a run's tokens when the run ends, so a token from a
# finished run is answered 401: that still shows the request reached the engine, and the report says so.
# Exit status: 0 when every check passed, 1 when one failed, 2 on a usage error.
set -uo pipefail
CT="${1:-}"; shift || true
RUN=""
while [ "$#" -gt 0 ]; do case "$1" in --run) RUN="${2:-}"; shift 2 ;; *) echo "unknown option: $1" >&2; exit 2 ;; esac; done
case "$CT" in ''|*[!0-9]*) echo "usage: $0 <container id> [--run <run id>]" >&2; exit 2 ;; esac
[ "$(id -u)" = 0 ] || { echo "run as root (the engine's run folders and pct need it)" >&2; exit 2; }

PREFIX="${EPC_PREFIX:-/opt/epaperclip}"
ENGINE_HOME="${EPC_ENGINE_HOME:-/var/lib/epaperclip-engine}"
NODE="$PREFIX/node/bin/node"; [ -x "$NODE" ] || NODE="$(command -v node || true)"
PORT="${EPC_ENGINE_PORT:-3100}"
fails=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; fails=$((fails+1)); }
info() { echo "INFO  $*"; }
json() { "$NODE" -e "$@" 2>/dev/null; }   # the script is the first argument; JSON text, if any, arrives on stdin

echo "ePaperclip $(cat "$PREFIX/VERSION" 2>/dev/null || echo '?') ($(cat "$PREFIX/CHANNEL" 2>/dev/null || echo '?')), container $CT"

# ---- the build has the fix -------------------------------------------------------------------------------------------------
if [ -f "$PREFIX/plugins/proxmox-sandbox/dist/mcp-relay.js" ] && [ -f "$PREFIX/plugins/proxmox-sandbox/dist/mcp-tunnel.js" ]; then pass "this build has the MCP relay and tunnel"; else fail "this build has no MCP relay or tunnel (install a release that includes it)"; fi

# ---- the engine stays on host loopback ---------------------------------------------------------------------------------------
bound="$(ss -ltnH "( sport = :$PORT )" 2>/dev/null | awk '{print $4}' | sort -u | tr '\n' ' ')"
if [ -z "$bound" ]; then fail "nothing listens on port $PORT (is the engine running?)";
elif printf '%s' "$bound" | tr ' ' '\n' | grep -v '^$' | grep -vqE '^(127\.0\.0\.1|\[::1\]):'"$PORT"'$'; then fail "port $PORT is not loopback-only: $bound";
else pass "the engine listens on host loopback only ($bound)"; fi

# ---- the container ---------------------------------------------------------------------------------------------------------
state="$(pct status "$CT" 2>/dev/null | awk '{print $2}')"
[ "$state" = running ] || { fail "container $CT is not running (status: ${state:-unknown}; is pct allowed in this shell?)"; echo; echo "RESULT: FAIL ($fails)"; exit 1; }
pct config "$CT" 2>/dev/null | grep -Eq '^tags:.*epaperclip' && pass "container $CT is one ePaperclip manages" || info "container $CT does not carry the ePaperclip tag"
cfg="$(pct exec "$CT" -- sshd -T 2>/dev/null | grep -E '^(allowtcpforwarding|permitlisten) ' | tr '\n' ';')"
case "$cfg" in
  *"allowtcpforwarding remote"*"permitlisten 127.0.0.1:$PORT"*|*"permitlisten 127.0.0.1:$PORT"*"allowtcpforwarding remote"*) pass "its sshd allows only a remote forward of 127.0.0.1:$PORT ($cfg)" ;;
  *) fail "its sshd is not set for the forward (got: ${cfg:-nothing}); a command must have run in it through ePaperclip first" ;;
esac

# From inside the container. The optional token is read from this function's stdin, so it is never in a process listing.
ct_http() { # method path body -> prints the HTTP status, then the body
  pct exec "$CT" -- sh -c 'IFS= read -r t; if [ -n "$t" ]; then h="Authorization: Bearer $t"; else h="X-Epc-Check: 1"; fi
    if [ -n "$3" ]; then curl -s -m 10 -w "\n%{http_code}" -X "$1" -H "$h" -H "content-type: application/json" -H "accept: application/json, text/event-stream" --data "$3" "http://127.0.0.1:'"$PORT"'$2";
    else curl -s -m 10 -w "\n%{http_code}" -X "$1" -H "$h" "http://127.0.0.1:'"$PORT"'$2"; fi' sh "$1" "$2" "$3" 2>/dev/null
}
status_of() { tail -n1 <<<"$1"; }
body_of() { sed '$d' <<<"$1"; }

if pct exec "$CT" -- sh -c "timeout 3 bash -c '</dev/tcp/127.0.0.1/$PORT'" 2>/dev/null; then pass "inside the container, 127.0.0.1:$PORT accepts connections"; else fail "inside the container nothing answers on 127.0.0.1:$PORT (no tunnel yet: run a command in this container through an agent first)"; fi

# The relay is not a general proxy: other engine routes are refused before they reach the engine.
for p in /api/health /api/companies /api/openapi.json; do
  r="$(ct_http GET "$p" "" <<<"")"; s="$(status_of "$r")"
  [ "$s" = 404 ] && pass "GET $p from the container: 404 (not forwarded)" || fail "GET $p from the container answered $s (expected 404)"
done

# The two MCP routes reach the engine, which does its own authentication.
init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"mcp-check","version":"1"}}}'
list='{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
declare -A TOKEN=()
if [ -n "$RUN" ]; then
  cfgfile="$(find "$ENGINE_HOME" -path "*$RUN*" -name mcp-config.json 2>/dev/null | head -n1)"
  if [ -n "$cfgfile" ]; then
    while IFS=$'\t' read -r path tok; do [ -n "$path" ] && TOKEN["$path"]="$tok"; done < <(json '
      const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      for (const s of Object.values(c.mcpServers ?? {})) {
        const h = s.headers ?? {}; const a = h.Authorization ?? h.authorization ?? "";
        try { console.log(new URL(s.url).pathname + "\t" + String(a).replace(/^Bearer /, "")); } catch {}
      }' "$cfgfile" <<<"")
    info "read the run's MCP tokens from its retained mcp-config.json (not shown)"
  else info "run $RUN has no retained mcp-config.json (an ACP run keeps none): set EPC_MCP_TOKEN_RUNTIME / EPC_MCP_TOKEN_PROJECT to test with a token"; fi
fi
[ -n "${EPC_MCP_TOKEN_RUNTIME:-}" ] && TOKEN["/mcp/runtime-tools"]="$EPC_MCP_TOKEN_RUNTIME"
[ -n "${EPC_MCP_TOKEN_PROJECT:-}" ] && TOKEN["/api/mcp/project-tools"]="$EPC_MCP_TOKEN_PROJECT"

for route in /mcp/runtime-tools /api/mcp/project-tools; do
  tok="${TOKEN[$route]:-}"
  # Without a token the engine itself must refuse, which proves the request got through the relay to Paperclip's authentication.
  r="$(ct_http POST "$route" "$list" <<<"")"; s="$(status_of "$r")"
  case "$s" in 401|403) pass "POST $route with no token: $s from the engine (reached Paperclip, which refuses)" ;;
    404) fail "POST $route with no token: 404 (the relay or tunnel does not forward this route)" ;;
    200) fail "POST $route with no token: 200 (Paperclip should have required a token)" ;;
    *) fail "POST $route with no token: ${s:-no answer}" ;; esac
  if [ -z "$tok" ]; then info "POST $route with a token: skipped (no token given)"; continue; fi
  ri="$(ct_http POST "$route" "$init" <<<"$tok")"; si="$(status_of "$ri")"
  rl="$(ct_http POST "$route" "$list" <<<"$tok")"; sl="$(status_of "$rl")"
  case "$sl" in
    200) names="$(body_of "$rl" | json 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{try{const r=JSON.parse(t).result.tools;console.log(r.length+" tools: "+r.map(x=>x.name).slice(0,8).join(", "))}catch{console.log("")}})')"
         [ -n "$names" ] && pass "POST $route tools/list with the run's token: 200, $names" || fail "POST $route tools/list answered 200 but not with a tool list" ;;
    401|403) info "POST $route tools/list: $sl (the run's token is revoked or expired; run this while the run is active for a 200. The request did reach the engine.)" ;;
    *) fail "POST $route tools/list with a token: ${sl:-no answer}" ;;
  esac
done

echo
[ "$fails" -eq 0 ] && { echo "RESULT: PASS"; exit 0; } || { echo "RESULT: FAIL ($fails)"; exit 1; }
