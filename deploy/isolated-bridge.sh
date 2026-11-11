#!/usr/bin/env bash
# Creates an isolated sandbox bridge with DHCP and NAT on a Proxmox host, so Agent Containers never put guests on
# the management LAN. Run once, as root, before ePaperclip's Agent Containers setup.
#
#   curl -fsSL https://raw.githubusercontent.com/OpenSourcx/papercliped-engine/<sha>/deploy/isolated-bridge.sh | bash
#
# Defaults: bridge vmbr1, 10.77.0.1/24, DHCP 10.77.0.100-250, NAT via the host's default route.
# Override with EPC_SANDBOX_BRIDGE, EPC_SANDBOX_CIDR, EPC_SANDBOX_DHCP_START/END, EPC_SANDBOX_DNS.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "isolated-bridge: run as root" >&2; exit 1; }
command -v pveversion >/dev/null || { echo "isolated-bridge: this isn't a Proxmox VE host (pveversion not found)" >&2; exit 1; }

BRIDGE="${EPC_SANDBOX_BRIDGE:-vmbr1}"
CIDR="${EPC_SANDBOX_CIDR:-10.77.0.1/24}"
ADDR="${CIDR%/*}"
PREFIX="${CIDR#*/}"
NET="$(echo "$ADDR" | awk -F. '{print $1"."$2"."$3".0"}')"
START="${EPC_SANDBOX_DHCP_START:-10.77.0.100}"
END="${EPC_SANDBOX_DHCP_END:-10.77.0.250}"
DNS="${EPC_SANDBOX_DNS:-1.1.1.1,8.8.8.8}"
UPLINK="${EPC_SANDBOX_UPLINK:-$(ip route | awk '/^default/{print $5; exit}')}"
FW=/usr/local/sbin/epaperclip-sandbox-firewall.sh
[ -n "$UPLINK" ] || { echo "isolated-bridge: no default route; set EPC_SANDBOX_UPLINK" >&2; exit 1; }

say() { echo "isolated-bridge: $*"; }

MARK="# ePaperclip sandbox network"
# A bridge that is there but wasn't made by this script is someone else's: leave it alone. One this script made earlier
# (it carries our marker) is finished off below, so a run that stopped halfway can simply be run again.
if ip link show "$BRIDGE" >/dev/null 2>&1 && ! grep -qF "$MARK" /etc/network/interfaces; then
  say "$BRIDGE already exists and wasn't made by this script; leaving it alone. Choose another with EPC_SANDBOX_BRIDGE."
  exit 0
fi

say "creating $BRIDGE ($CIDR), DHCP $START-$END, NAT via $UPLINK"
say "writing the sandbox firewall ($FW): guests reach the internet, not the LAN, the tailnet or this host"
cat >"$FW" <<FWSH
#!/bin/sh
# Sandbox guests on $BRIDGE may reach the internet, but not private networks, the tailnet or this host. Idempotent.
B=$BRIDGE
add() { iptables -C "\$@" 2>/dev/null || iptables -I "\$@"; }
for n in 169.254.0.0/16 100.64.0.0/10 192.168.0.0/16 172.16.0.0/12 10.0.0.0/8; do add FORWARD -i "\$B" -d "\$n" -j DROP; done
for d in $(echo "$DNS" | tr ',' ' '); do
  add FORWARD -i "\$B" -d "\$d" -p udp --dport 53 -j ACCEPT
  add FORWARD -i "\$B" -d "\$d" -p tcp --dport 53 -j ACCEPT
done
add INPUT -i "\$B" -j DROP
add INPUT -i "\$B" -p udp --dport 67 -j ACCEPT
# The host reaches into its sandboxes (ssh); their replies come back in on this bridge and must get through.
add INPUT -i "\$B" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
FWSH
chmod 755 "$FW"
if ! grep -qF "$MARK" /etc/network/interfaces; then
cp /etc/network/interfaces "/root/interfaces.pre-epaperclip-$(date +%Y%m%d%H%M%S)"
cat >>/etc/network/interfaces <<NET

# ePaperclip sandbox network: isolated guests with DHCP and NAT.
auto $BRIDGE
iface $BRIDGE inet static
	address $CIDR
	bridge-ports none
	bridge-stp off
	bridge-fd 0
	post-up   iptables -t nat -C POSTROUTING -s $NET/$PREFIX -o $UPLINK -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s $NET/$PREFIX -o $UPLINK -j MASQUERADE
	post-down iptables -t nat -D POSTROUTING -s $NET/$PREFIX -o $UPLINK -j MASQUERADE 2>/dev/null || true
	post-up   $FW
NET
fi

if ! ip link show "$BRIDGE" >/dev/null 2>&1; then
  ip link add name "$BRIDGE" type bridge
  ip addr add "$CIDR" dev "$BRIDGE"
fi
ip link set "$BRIDGE" up
sysctl -w net.ipv4.ip_forward=1 >/dev/null
printf 'net.ipv4.ip_forward=1\n' >/etc/sysctl.d/99-epaperclip-sandbox.conf
iptables -t nat -C POSTROUTING -s "$NET/$PREFIX" -o "$UPLINK" -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s "$NET/$PREFIX" -o "$UPLINK" -j MASQUERADE

"$FW"

if ! dpkg -s dnsmasq >/dev/null 2>&1; then
  say "installing dnsmasq"
  # A Proxmox host without a subscription usually has the enterprise repository enabled, which answers 401 and makes
  # `apt-get update` exit non-zero even though the other repositories updated. That must not stop the install.
  DEBIAN_FRONTEND=noninteractive apt-get update -qq || say "warning: apt-get update reported errors (often the enterprise repository without a subscription); trying the install anyway"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq dnsmasq || { echo "isolated-bridge: couldn't install dnsmasq (is this host online?). Install it yourself (apt install dnsmasq) and run this again." >&2; exit 1; }
fi
cat >/etc/dnsmasq.d/epaperclip-sandbox.conf <<DNS
# ePaperclip sandbox DHCP: DHCP only, no DNS service on this bridge.
port=0
interface=$BRIDGE
bind-dynamic
dhcp-authoritative
dhcp-range=$START,$END,255.255.255.0,12h
dhcp-option=option:router,$ADDR
dhcp-option=option:dns-server,$DNS
DNS
systemctl enable dnsmasq >/dev/null 2>&1 || true
systemctl restart dnsmasq
sleep 1
systemctl is-active dnsmasq >/dev/null || { echo "isolated-bridge: dnsmasq did not start" >&2; exit 1; }

say "ready. In ePaperclip's Agent Containers setup choose bridge $BRIDGE."
say "verify inside a sandbox with: ip -4 addr show eth0; ping -c1 1.1.1.1  (must work)"
say "isolation check inside a sandbox: ping -c1 <your LAN gateway> and curl -sk https://10.77.0.1:8006 must both FAIL"
