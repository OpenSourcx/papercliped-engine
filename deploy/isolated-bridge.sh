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
[ -n "$UPLINK" ] || { echo "isolated-bridge: no default route; set EPC_SANDBOX_UPLINK" >&2; exit 1; }

say() { echo "isolated-bridge: $*"; }

if ip link show "$BRIDGE" >/dev/null 2>&1; then
  say "$BRIDGE already exists; leaving it alone. Choose another with EPC_SANDBOX_BRIDGE."
  exit 0
fi

say "creating $BRIDGE ($CIDR), DHCP $START-$END, NAT via $UPLINK"
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
NET

ip link add name "$BRIDGE" type bridge
ip addr add "$CIDR" dev "$BRIDGE"
ip link set "$BRIDGE" up
sysctl -w net.ipv4.ip_forward=1 >/dev/null
iptables -t nat -C POSTROUTING -s "$NET/$PREFIX" -o "$UPLINK" -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s "$NET/$PREFIX" -o "$UPLINK" -j MASQUERADE

if ! dpkg -s dnsmasq >/dev/null 2>&1; then
  say "installing dnsmasq"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq dnsmasq
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
say "verify inside a sandbox with: ip -4 addr show eth0; ping -c1 1.1.1.1"
