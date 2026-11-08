#!/usr/bin/env bash
# Start the ePaperclip host (fake Proxmox, real engine) for parity runs. Writes its address to $PARITY_DIR/epc/host.url.
R=$(cd "$(dirname "$0")/../.." && pwd); PD=${PARITY_DIR:-/project/.work/parity}; mkdir -p "$PD/epc"; rm -f "$PD/epc/host.url"
cd "$R"; EPC_CONSOLE_DIST=${EPC_CONSOLE_DIST:-$R/apps/console/dist} nohup ${PARITY_NODE:-/project/.work/engine-1023/node-v24.21.0-linux-x64/bin/node} --experimental-strip-types scripts/parity/host.ts >"$PD/epc/host.log" 2>&1 &
echo $! > "$PD/epc/host.pid"; for i in $(seq 1 30); do [ -s "$PD/epc/host.url" ] && cat "$PD/epc/host.url" && exit 0; sleep 1; done; echo "host did not start" >&2; exit 1
