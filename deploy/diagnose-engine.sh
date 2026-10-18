#!/usr/bin/env bash
# Finds out why the ePaperclip engine doesn't come up on a host. It starts the installed engine four ways, each on its own
# spare port with a throwaway data directory (the real data is never touched), and says which ones answer:
#
#   A  plain process, output to a file          (what the installer's own trial start does)
#   B  a systemd unit with no sandbox, output to a file
#   C  a systemd unit with no sandbox, output to the journal
#   D  a systemd unit with the real unit's sandbox, output to a file
#
# Compare them with the real service (journal output, full sandbox): the first one that stops answering names the cause.
# Run it as root, on a host where ePaperclip's engine is installed:   bash deploy/diagnose-engine.sh
# It stops epaperclip-engine while it runs (and starts it again after) unless you pass --keep-running.
set -uo pipefail

NODE="${EPC_NODE:-/opt/epaperclip/node/bin/node}"
ENTRY="${EPC_ENGINE_ENTRY:-/opt/epaperclip/engine/node_modules/@paperclipai/server/dist/index.js}"
ENVFILE="${EPC_ENGINE_ENV:-/etc/epaperclip/engine.env}"
EUSER="${EPC_ENGINE_USER:-epaperclip-engine}"
WAIT="${EPC_DIAG_WAIT:-150}"
PORT="${EPC_DIAG_PORT:-3199}"
WORK="${EPC_DIAG_DIR:-/var/lib/epc-diagnose}"
ONLY="${EPC_DIAG_ONLY:-A B C D}"
KEEP=0; [ "${1:-}" = "--keep-running" ] && KEEP=1

die() { echo "diagnose-engine: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root"
[ -x "$NODE" ] || die "no Node at $NODE (is the engine installed?)"
[ -f "$ENTRY" ] || die "no engine at $ENTRY (is the engine installed?)"
[ -f "$ENVFILE" ] || die "no settings at $ENVFILE"
id "$EUSER" >/dev/null 2>&1 || die "no user $EUSER"
EGROUP="$(id -gn "$EUSER")"
command -v setpriv >/dev/null || die "setpriv is missing"
HAVE_SYSTEMD=0; [ -d /run/systemd/system ] && command -v systemd-run >/dev/null && HAVE_SYSTEMD=1

RESTART=0
if [ "$KEEP" -eq 0 ] && systemctl is-active -q epaperclip-engine 2>/dev/null; then
  echo "stopping epaperclip-engine while the tests run (it is started again at the end)"
  systemctl stop epaperclip-engine; RESTART=1
fi
cleanup() {
  for v in a b c d; do systemctl stop "epc-diag-$v" >/dev/null 2>&1 || true; done
  pkill -u "$EUSER" -f "$ENTRY" >/dev/null 2>&1 || true
  [ "$RESTART" -eq 1 ] && systemctl start epaperclip-engine >/dev/null 2>&1 && echo "epaperclip-engine started again"
  return 0
}
trap cleanup EXIT

# The engine's own settings, with the port and the data directory pointed at the throwaway copy.
env_args() { # <home>
  local k v
  while IFS='=' read -r k v; do
    case "$k" in ''|\#*) continue ;; esac
    case "$k" in PORT|PAPERCLIP_HOME|HOME|PAPERCLIP_PUBLIC_URL|PAPERCLIP_API_URL) continue ;; esac
    printf '%s=%s\n' "$k" "$v"
  done <"$ENVFILE"
  printf 'PORT=%s\nPAPERCLIP_HOME=%s\nHOME=%s\nPAPERCLIP_PUBLIC_URL=http://127.0.0.1:%s\nPAPERCLIP_API_URL=http://127.0.0.1:%s\n' "$PORT" "$1" "$1" "$PORT" "$PORT"
  echo "NODE_OPTIONS=--max-old-space-size=2048"
}

pid_of() { pgrep -u "$EUSER" -f "$ENTRY" | head -n1; }
rss_mb() { local p; p="$(pid_of)"; [ -n "$p" ] && ps -o rss= -p "$p" 2>/dev/null | awk '{printf "%d", $1/1024}' || printf 0; }
cpu_of() { local p; p="$(pid_of)"; [ -n "$p" ] && ps -o time= -p "$p" 2>/dev/null | tr -d ' ' || printf '?'; }

declare -A RESULT
run_variant() { # <letter> <description>
  local v="$1" desc="$2" home="$WORK/$1/home" log="$WORK/$1/engine.log" start=$SECONDS ok=0 peak=0 r
  rm -rf "$WORK/$v"; install -d -m 0755 "$WORK" "$WORK/$v"; install -d -m 0700 -o "$EUSER" -g "$EGROUP" "$home"
  : >"$log"; chown "$EUSER:$EGROUP" "$log"
  echo; echo "== $v: $desc"
  local -a envs; mapfile -t envs < <(env_args "$home")
  case "$v" in
    A) ( cd "$(dirname "$ENTRY")" && exec setsid env -i PATH=/usr/bin:/bin "${envs[@]}" setpriv --reuid="$EUSER" --regid="$EGROUP" --clear-groups "$NODE" "$ENTRY" ) >"$log" 2>&1 & ;;
    B|C|D)
      local -a props=(-p "User=$EUSER" -p "Group=$EGROUP" -p "WorkingDirectory=$(dirname "$ENTRY")")
      local e; for e in "${envs[@]}"; do props+=(-E "$e"); done
      [ "$v" = C ] || props+=(-p "StandardOutput=file:$log" -p "StandardError=file:$log")
      if [ "$v" = D ]; then
        props+=(-p NoNewPrivileges=yes -p ProtectSystem=strict -p "ReadWritePaths=$home" -p ProtectHome=yes -p PrivateTmp=yes -p PrivateDevices=yes
          -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectKernelLogs=yes -p ProtectControlGroups=yes -p ProtectClock=yes
          -p ProtectHostname=yes -p RestrictNamespaces=yes -p RestrictRealtime=yes -p RestrictSUIDSGID=yes -p LockPersonality=yes -p RemoveIPC=yes
          -p ProtectProc=invisible -p "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX" -p SystemCallArchitectures=native -p UMask=0077
          -p MemoryMax=4G -p TasksMax=4096 -p LimitNOFILE=65536 -p "CapabilityBoundingSet=")
      fi
      systemd-run --quiet --collect --unit="epc-diag-$(echo "$v" | tr A-Z a-z)" "${props[@]}" "$NODE" "$ENTRY" >/dev/null 2>&1 || { RESULT[$v]="could not start the unit"; echo "   could not start the unit"; return; } ;;
  esac
  while [ $((SECONDS - start)) -lt "$WAIT" ]; do
    sleep 1
    r="$(rss_mb)"; [ "${r:-0}" -gt "$peak" ] && peak="$r"
    if curl -fs --max-time 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then ok=1; break; fi
    if [ $((SECONDS - start)) -ge 10 ] && [ -z "$(pid_of)" ]; then echo "   the engine process is not running (it exited)"; break; fi
    if [ $(((SECONDS - start) % 20)) -eq 0 ]; then echo "   $((SECONDS - start)) s: cpu $(cpu_of), ${r:-0} MB, log lines: $(wc -l <"$log" 2>/dev/null || echo 0)"; fi
  done
  local took=$((SECONDS - start)) lines; lines="$(wc -l <"$log" 2>/dev/null || echo 0)"
  if [ "$ok" -eq 1 ]; then RESULT[$v]="HEALTHY in $took s (peak ${peak} MB, $lines log lines)"
  else RESULT[$v]="NOT healthy after $took s (cpu $(cpu_of), ${peak} MB peak, $lines log lines in the file)"; fi
  echo "   -> ${RESULT[$v]}"
  echo "   first log lines:"; grep -v '^[[:space:]]*at ' "$log" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | head -n 4 | cut -c1-170 | sed 's/^/     /'
  [ "$v" = C ] && { echo "   journal (first lines):"; journalctl -u epc-diag-c -n 4 --no-pager -o cat 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-170 | sed 's/^/     /'; }
  systemctl stop "epc-diag-$(echo "$v" | tr A-Z a-z)" >/dev/null 2>&1 || true
  pkill -u "$EUSER" -f "$ENTRY" >/dev/null 2>&1 || true
  pkill -u "$EUSER" -x postgres >/dev/null 2>&1 || true
  sleep 3
}

for v in $ONLY; do
  case "$v" in
    A) run_variant A "plain process, output to a file" ;;
    B) [ "$HAVE_SYSTEMD" -eq 1 ] && run_variant B "systemd unit, no sandbox, output to a file" || echo "== B: skipped (no systemd here)" ;;
    C) [ "$HAVE_SYSTEMD" -eq 1 ] && run_variant C "systemd unit, no sandbox, output to the journal" || echo "== C: skipped (no systemd here)" ;;
    D) [ "$HAVE_SYSTEMD" -eq 1 ] && run_variant D "systemd unit, the real unit's sandbox, output to a file" || echo "== D: skipped (no systemd here)" ;;
  esac
done

echo; echo "================ summary ================"
for v in $ONLY; do [ -n "${RESULT[$v]:-}" ] && echo "$v: ${RESULT[$v]}"; done
echo "The real service (full sandbox, journal output) did not answer in 4 minutes and grew past 1.9 GB."
echo "Send this summary, and the 'first log lines' above, back. Test data is in $WORK (delete it with: rm -rf $WORK)."
