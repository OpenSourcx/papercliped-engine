#!/usr/bin/env bash
# Read-only check of the reference node's reachable pieces, from the ePaperclip host or any machine on the tailnet.
# Usage: orion-probe.sh [tailscale-ip] [ssh-user]
# It never loads a model, changes Ollama or writes anything on the node. Exit 0 only when every reachable-piece check passes.
set -u
IP="${1:-100.93.29.26}"; USER_="${2:-kpnai}"; fail=0
ok() { echo "ok   $*"; }; bad() { echo "FAIL $*"; fail=1; }
tailscale ping -c 1 --timeout 5s "$IP" >/dev/null 2>&1 && ok "tailscale ping $IP" || bad "tailscale ping $IP"
for p in 22 11434; do
  timeout 5 bash -c "exec 3<>/dev/tcp/$IP/$p" 2>/dev/null && ok "tcp $p open" || bad "tcp $p closed or filtered"
done
tags=$(curl -fsS -m 5 "http://$IP:11434/api/tags" 2>/dev/null) && ok "ollama tags: $(echo "$tags" | grep -o '"name":"[^"]*"' | tr '\n' ' ')" || bad "ollama /api/tags"
curl -fsS -m 5 "http://$IP:11434/api/ps" >/dev/null 2>&1 && ok "ollama /api/ps" || bad "ollama /api/ps"
ssh -o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new "$USER_@$IP" 'uname -m; . /etc/os-release; echo "$PRETTY_NAME"; node -v 2>&1 | head -1' 2>&1 | sed 's/^/ssh  /' | head -4
[ "${PIPESTATUS[0]}" = 0 ] && ok "ssh $USER_@$IP" || bad "ssh $USER_@$IP (public key not authorized yet?)"
exit $fail
