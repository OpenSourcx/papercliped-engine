# The machine page

A machine's page (`/<device>/machines/<id>`) stands in for Proxmox's VM and container panels. Everything is a Proxmox API call made **as the signed-in person**, so Proxmox decides who may do what; a refusal (403) reads "Your Proxmox account doesn't have permission for this". The host service validates every value before it reaches Proxmox, every edit carries the configuration **digest** from the last read (a machine changed since gives 409 `stale` and the page reloads), changes need the same-site header, and anything destructive needs a typed confirmation. Proxmox's own reason is passed on when it refuses.

Code: host `services/epaperclip/src/features/guest.ts` (routes) and `guestCheck.ts` (validation and device strings); console `apps/console/src/pages/machines/Machine*.tsx` and `Hardware.tsx`, data layer `apps/console/src/data/engine/guestApi.ts` (live) and `guestDemo.ts` (the demo answers the same calls in the browser, with the same rules). Disks stay in `docs/DISKS.md`.

## What the page has

| Where | What |
| --- | --- |
| Header | Start or Shut down, and Console, as buttons; status, kind, OS, protection and the machine's tags. Stop, reboot, reset, clone, back up, delete stay in Pin's island menu. A machine that does not exist (or was deleted) gets a not-found page with a way back, never an endless wait. |
| Overview | Hostname and addresses (below), and Notes and tags (editable, with the digest). |
| Hardware | Processor and memory, Options, Disks, **Firmware and devices** (VM), **Network devices**, **DNS** and **Features** (container), **Host devices**. |
| Permissions | Who may use this machine: entries on `/vms/<id>`, and what reaches it from `/`, `/vms` and its pool. |

### Addresses and hostname

`GET /api/guests/:id/addresses`. A running VM with the guest agent: `GET .../agent/network-get-interfaces` and `.../agent/get-host-name`. A running container: `GET .../lxc/<id>/interfaces`, and the hostname from its configuration. A stopped machine, or one whose agent doesn't answer, falls back to the addresses set in the configuration (`netN` ip, `ipconfigN`) and says so. When there is nothing to show the answer carries a sentence saying why (start it, turn on the agent, install the agent, no permission); Proxmox's error text is never shown. Loopback and link-local addresses are folded away behind "Show more".

### Network devices

`GET /api/guests/:id/devices` (everything the Hardware cards need, plus the digest), `POST /api/guests/:id/network` (add when `key` is absent, edit when present), `POST /api/guests/:id/network/:key/delete` (the key, `net0`, must be typed).

- **VM** (`net[n]`): model (all 14 Proxmox models), bridge, VLAN tag, trunks (ids and ranges), MAC (empty keeps the current one; group addresses refused), firewall, disconnected (`link_down`), rate (MB/s), MTU and queues (VirtIO only). Changing the model keeps the MAC; settings the form doesn't manage (for example `host-tunnel`) are kept.
- **Container** (`net[n]`): name (unique in the container), bridge, VLAN tag, trunks, MAC (`hwaddr`), IPv4 (DHCP, none, or address with prefix, plus gateway), IPv6 (automatic, DHCP, none, or address with prefix, plus gateway), firewall, disconnected, rate, MTU 64 to 65535. A gateway is only accepted with a static address.
- Bridges offered are the node's bridges and SDN networks when this account can list them; otherwise the name is typed.

### Container DNS and features

`POST /api/guests/:id/dns`: up to 3 servers (IPv4, IPv6, link-local with interface) and 6 search domains; empty means "use the host's", sent to Proxmox as `delete=nameserver,searchdomain`. `POST /api/guests/:id/features`: nesting, keyctl, FUSE, mknod, writable `/sys` and mount types, written as the `features` property string; unknown keys are kept and an all-off result deletes the setting. Proxmox lets only some accounts change some features; its message is shown.

### Resources

`POST /api/guests/:id/resources`: cores (VM 1 to 512, container 1 to 8192), sockets (VM), memory in MiB (16 to 4 TiB, **any whole number**; the console takes MiB or GiB), swap (container), minimum memory/balloon (VM, not above memory, 0 turns ballooning off), CPU limit (VM up to 128, container up to 8192, empty deletes) and CPU weight (VM 1 to 262144, container 0 to 500000). Only changed fields are sent.

### Notes and tags

`POST /api/guests/:id/notes`: notes up to 8192 characters; up to 20 tags, lowercased and de-duplicated, `[a-z0-9_][a-z0-9_.+-]*`. Empty values are deleted.

### Firmware and devices (VM)

`POST /api/guests/:id/items/{display,bios,serial,audio,efi,tpm}` with `action` `set`, `add` or `remove`. Display (14 types, video memory 4 to 512 MiB, VNC clipboard); BIOS (SeaBIOS or UEFI, with a warning when UEFI has no EFI disk); serial ports 0 to 3 (virtual socket for everyone, a host `/dev/ttyS|USB|ACM` port for administrators only); audio (device and SPICE or no output); EFI disk (storage, 4m or 2m, pre-enrolled Secure Boot keys only with 4m, optionally switching the BIOS to UEFI in the same change); TPM (storage, v2.0 or v1.2; the version can't change later). Removing the EFI disk or the TPM needs `efidisk0` or `tpmstate0` typed; the volume is kept as an unused disk (Disks card).

### Host devices

`GET /api/guests/:id/passthrough` lists host PCI devices (vendor, device, IOMMU group), USB devices (hubs left out) and resource mappings; a refusal becomes a sentence. The Hardware card shows the configured `hostpciN`, `usbN` (VM) and `devN` (container) with names resolved. **Read only**: adding and removing host devices is not built (GU-042, GU-043, GU-059 stay partial).

### Permissions

`GET /api/guests/:id/permissions` returns the entries on `/vms/<id>`, the ones that reach it from above, the roles, users and groups to choose from, and whether this account has Permissions.Modify. `POST` with `action` `grant` (user, group or token, a role) or `revoke` (the name typed). The role, user and group must exist when Proxmox lets the account list them.

## Other changes made with it

- The terminal relay passes `?cmd=upgrade` on `/api/console/node` to Proxmox's node terminal (`ProxmoxClient.termproxyCommand`), so the Updates screen runs the package upgrade directly. Any other value, or the parameter on a machine, is refused in the terminal.
- `main.ts` starts a `TlsReloader`, so a changed node certificate is served without a restart (docs/NODE.md).
- The node switcher shows in the device header of the sidebar when the datacenter has more than one node.
- Unknown addresses, bad machine numbers, the agent-containers dialog, Settings and Connected apps, firewall tables on a phone, the Machines list (search, sort, New machine) and the Storage first tab were fixed from `docs/QA-FINDINGS.md`; each finding has a status line there.

## Tests

Host: `services/epaperclip/test/guest.test.ts` against the fake Proxmox in `test/fakes-guest.ts` (every route: happy path, strict validation, stale digest, busy machine, typed confirmation, permission denial), `containers-errors.test.ts`, and the upgrade command in `app.test.ts`. Console: `apps/console/test/machine.test.tsx` (header buttons, not-found, memory field, network, DNS, features, EFI and TPM, host devices, permissions, settings copy).

Screenshots at 1440 and 390 wide, demo and live (the real host service on the built console over the fake Proxmox): `node --experimental-strip-types services/epaperclip/scripts/guest-shots.mts` (see the file for the environment it needs). It also reports page errors and any sideways scrolling at phone width.

## Not verified against a real Proxmox

Everything was checked against the API viewer data and a fake, not a real node: the exact `net[n]`/`features`/`vga`/`audio0`/`efidisk0`/`tpmstate0` strings Proxmox writes back, the guest-agent and `lxc/<id>/interfaces` answers, `/access/acl` filtering and the Permissions.Modify check, which features a non-root account may change, hot-plug versus pending-restart behaviour per field, whether `PUT .../config` answers with a task for these keys, and the node terminal's `cmd=upgrade`.
