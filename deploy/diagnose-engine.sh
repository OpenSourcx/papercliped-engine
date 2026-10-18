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
# With --bisect it then adds the real unit's sandbox settings to a plain unit one at a time, and names the one that breaks it.
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
KEEP=0
for a in "$@"; do case "$a" in --keep-running) KEEP=1 ;; --bisect) export EPC_DIAG_BISECT=1; ONLY="${EPC_DIAG_ONLY:-}" ;; esac; done

die() { echo "diagnose-engine: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# No installed engine (the installer rolled it back, or this is a spare host)? Build a scratch one from the bundle beside this
# script: the same pinned Node.js (checked against the same checksum), the same lockfile, the same npm flags, and a settings
# file like the installer's, with fresh secrets. Nothing outside $WORK is touched.
if [ ! -x "$NODE" ] || [ ! -f "$ENTRY" ]; then
  SRC="$HERE/../engine"
  [ -f "$SRC/package-lock.json" ] || die "no installed engine, and no engine/package-lock.json beside this script to build one from"
  case "$(uname -m)" in x86_64|amd64) ARCH=x64; SUM=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 ;; aarch64|arm64) ARCH=arm64; SUM=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2 ;; *) die "unsupported CPU $(uname -m)" ;; esac
  NV=24.21.0; SCR="$WORK/scratch"
  if [ ! -x "$SCR/node/bin/node" ] || [ ! -f "$SCR/engine/node_modules/@paperclipai/server/dist/index.js" ]; then
    echo "no installed engine: building a scratch copy in $SCR (Node $NV, then the engine from its lockfile; a few minutes)"
    rm -rf "$SCR"; install -d -m 0755 "$WORK" "$SCR" "$SCR/engine"
    curl -fsSL --retry 3 -o "$SCR/node.tar.xz" "https://nodejs.org/dist/v$NV/node-v$NV-linux-$ARCH.tar.xz" || die "couldn't download Node.js"
    [ "$(sha256sum "$SCR/node.tar.xz" | cut -d' ' -f1)" = "$SUM" ] || die "the Node.js download doesn't match its pinned checksum"
    tar -xJf "$SCR/node.tar.xz" -C "$SCR" && mv "$SCR/node-v$NV-linux-$ARCH" "$SCR/node" && rm -f "$SCR/node.tar.xz"
    install -m 0644 "$SRC/package.json" "$SRC/package-lock.json" "$SCR/engine/"
    (cd "$SCR/engine" && HOME="$SCR" "$SCR/node/bin/node" "$SCR/node/lib/node_modules/npm/bin/npm-cli.js" ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error) || die "npm ci failed"
    "$SCR/node/bin/node" "$HERE/engine-links.mjs" "$SCR/engine" >/dev/null || die "the engine's database binaries couldn't be prepared"
    chmod -R a+rX "$SCR"
  fi
  NODE="$SCR/node/bin/node"; ENTRY="$SCR/engine/node_modules/@paperclipai/server/dist/index.js"
fi
if [ ! -f "$ENVFILE" ]; then
  ENVFILE="$WORK/engine.env"; install -d -m 0755 "$WORK"
  rh() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }
  { echo "BETTER_AUTH_SECRET=$(rh)"; echo "PAPERCLIP_AGENT_JWT_SECRET=$(rh)"
    echo "PAPERCLIP_DEPLOYMENT_MODE=authenticated"; echo "PAPERCLIP_DEPLOYMENT_EXPOSURE=private"; echo "HOST=127.0.0.1"; echo "PORT=3100"
    echo "PAPERCLIP_ALLOWED_HOSTNAMES=127.0.0.1,localhost"; echo "PAPERCLIP_MIGRATION_AUTO_APPLY=true"; echo "SERVE_UI=false"
    echo "PAPERCLIP_AUTH_RATE_LIMIT_ENABLED=false"; echo "PAPERCLIP_TELEMETRY_DISABLED=1"; } >"$ENVFILE"; chmod 0600 "$ENVFILE"
fi
id "$EUSER" >/dev/null 2>&1 || { echo "no user $EUSER here; using nobody"; EUSER=nobody; }
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


# ---- --bisect: add the real unit's sandbox settings one at a time to a plain systemd unit, and say which one breaks it ----
SANDBOX=(NoNewPrivileges=yes ProtectSystem=strict ProtectHome=yes PrivateTmp=yes PrivateDevices=yes ProtectKernelTunables=yes
  ProtectKernelModules=yes ProtectKernelLogs=yes ProtectControlGroups=yes ProtectClock=yes ProtectHostname=yes RestrictNamespaces=yes
  RestrictRealtime=yes RestrictSUIDSGID=yes LockPersonality=yes RemoveIPC=yes ProtectProc=invisible
  "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX" SystemCallArchitectures=native UMask=0077 MemoryMax=4G TasksMax=4096
  LimitNOFILE=65536 CapabilityBoundingSet=)
probe() { # <label> <waitseconds> <props...>: starts the engine in a transient unit with those properties; prints and returns 0 if it answers
  local label="$1" wait="$2"; shift 2
  local home="$WORK/bisect/home" log="$WORK/bisect/engine.log" start=$SECONDS ok=1 e
  rm -rf "$WORK/bisect"; install -d -m 0755 "$WORK" "$WORK/bisect"; install -d -m 0700 -o "$EUSER" -g "$EGROUP" "$home"
  : >"$log"; chown "$EUSER:$EGROUP" "$log"
  local -a envs props=(-p "User=$EUSER" -p "Group=$EGROUP" -p "WorkingDirectory=$(dirname "$ENTRY")" -p "StandardOutput=file:$log" -p "StandardError=file:$log")
  mapfile -t envs < <(env_args "$home")
  for e in "${envs[@]}"; do props+=(-E "$e"); done
  for e in "$@"; do props+=(-p "$e"); done
  case " $* " in *ProtectSystem=strict*) props+=(-p "ReadWritePaths=$home"); case " $* " in *PrivateTmp=yes*) ;; *) props+=(-p PrivateTmp=yes) ;; esac ;; esac
  systemd-run --quiet --collect --unit=epc-diag-bisect "${props[@]}" "$NODE" "$ENTRY" >/dev/null 2>&1 || { printf '   %-52s could not start\n' "$label"; return 2; }
  while [ $((SECONDS - start)) -lt "$wait" ]; do
    sleep 1
    if curl -fs --max-time 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      printf '   %-52s ok (%s s)\n' "$label" "$((SECONDS - start))"; ok=0; break
    fi
  done
  if [ "$ok" -ne 0 ]; then
    if [ -z "$(pid_of)" ]; then printf '   %-52s BROKEN (the engine exited)\n' "$label"; else printf '   %-52s BROKEN (hung: no answer in %s s, cpu %s, %s MB)\n' "$label" "$wait" "$(cpu_of)" "$(rss_mb)"; fi
    grep -v '^[[:space:]]*at ' "$log" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | tail -n 3 | cut -c1-150 | sed 's/^/         log: /'
  fi
  systemctl stop epc-diag-bisect >/dev/null 2>&1 || true; pkill -u "$EUSER" -f "$ENTRY" >/dev/null 2>&1 || true; pkill -u "$EUSER" -x postgres >/dev/null 2>&1 || true
  sleep 2; return "$ok"
}
if [ "${EPC_DIAG_BISECT:-0}" = 1 ]; then
  [ "$HAVE_SYSTEMD" -eq 1 ] || die "--bisect needs systemd"
  BW="${EPC_DIAG_BISECT_WAIT:-50}"
  echo; echo "== bisect: the sandbox settings added one at a time to a plain unit (each gets $BW s)"
  probe "no sandbox at all" "$BW" || echo "   (the plain unit itself fails; nothing to bisect)"
  culprits=()
  [ -z "${EPC_DIAG_MAXPROPS:-}" ] || SANDBOX=("${SANDBOX[@]:0:$EPC_DIAG_MAXPROPS}")
  for prop in "${SANDBOX[@]}"; do
    probe "+ $prop" "$BW" "$prop"; rc=$?; [ "$rc" -eq 0 ] || culprits+=("$prop")
  done
  if true; then
    echo; echo "adding them cumulatively (the real unit is all of them together):"
    acc=(); for prop in "${SANDBOX[@]}"; do acc+=("$prop"); probe "cumulative up to $prop" "$BW" "${acc[@]}" || { culprits+=("(first broken when '$prop' is added on top of the ones before it)"); break; }; done
  fi
  echo; echo "BISECT RESULT: ${culprits[*]:-no sandbox setting breaks it}"
  RESULT[bisect]="${culprits[*]:-none}"
fi

echo; echo "================ summary ================"
for v in $ONLY; do [ -n "${RESULT[$v]:-}" ] && echo "$v: ${RESULT[$v]}"; done
echo "The real service (full sandbox, journal output) did not answer in 4 minutes and grew past 1.9 GB."
echo "Send this summary, and the 'first log lines' above, back. Test data is in $WORK (delete it with: rm -rf $WORK)."
