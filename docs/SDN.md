# Virtual networks (SDN)

Zones, VNets and subnets that span the datacenter, as the signed-in person. Page: Datacenter, Virtual networks. Code: `services/epaperclip/src/features/dcSdn.ts`, `apps/console/src/pages/node/Sdn.tsx`; routes under `/api/node/sdn/…`. The older simple SDN tab on the Network page (for organizations) still works and uses `/api/sdn`.

Proxmox stages every SDN change. Nothing reaches the network until **Apply** (a task that reloads the network on every node). The page shows how many changes are staged, **Preview changes** (Proxmox's dry run for the chosen node), **Apply**, and **Discard** (rollback; the word `rollback` is typed).

## What can be managed

| Object | Types | Notes |
| --- | --- | --- |
| Zones | simple, VLAN, QinQ, VXLAN, EVPN | Each type shows only its own settings and requires what Proxmox requires (VLAN: bridge; QinQ: bridge and tag; VXLAN: peers or a fabric; EVPN: controller and VRF VXLAN). Zone names are up to 8 lowercase letters and digits. |
| VNets | in a zone | Tag, alias, VLAN aware, isolate ports. Firewall options (on, forward policy, log level); rules are listed read-only. |
| Subnets | per VNet | Network, gateway, source NAT, DHCP ranges (start and end), DHCP DNS server, DNS zone prefix. |
| IPAM | Proxmox, NetBox, phpIPAM | Addresses in use (`ipams/{name}/status`); static address assignments via `POST/PUT/DELETE vnets/{vnet}/ips`. |
| DNS | PowerDNS | |
| Controllers | EVPN, BGP, IS-IS | |
| Status | per node | Zones and VNets as applied on a node; the MAC and IP table of EVPN VNets. |

Editing sends the `digest`. Deleting anything needs its name typed. Plugin secrets (NetBox and phpIPAM tokens, PowerDNS key) are write-only: never returned, never logged, scrubbed from Proxmox error text.

## Not built or not verified

Fabrics, route maps and prefix lists (DC-118), VNet firewall rule editing, Faucet zones. Unverified against a real cluster: the exact settings of each controller type, EVPN exit-node behaviour and the dry-run text.
