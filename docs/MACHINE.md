# The machine page

A machine's page (`/<device>/machines/<id>`) stands in for Proxmox's VM and container panels. Everything is a Proxmox API call made **as the signed-in person**, so Proxmox decides who may do what; a refusal (403) reads "Your Proxmox account doesn't have permission for this". The host service validates every value before it reaches Proxmox, every edit carries the configuration **digest** from the last read (a machine changed since gives 409 `stale` and the page reloads), changes need the same-site header, and anything destructive needs a typed confirmation. Proxmox's own reason is passed on when it refuses.

Code: host `services/epaperclip/src/features/guest.ts` (routes) and `guestCheck.ts` (validation and device strings), plus `machineSettings.ts`, `machineCloud.ts`, `machineRun.ts` and `machineDc.ts` for everything on this page beyond the basics (shared checks in `packages/proxmox-client/src/machine-schema.ts` and `machine-extra.ts`, which also run in the demo); console `apps/console/src/pages/machines/Machine*.tsx` and `Hardware.tsx`, data layer `apps/console/src/data/engine/guestApi.ts` (live) and `guestDemo.ts` (the demo answers the same calls in the browser, with the same rules), and `machineApi.ts` for the newer calls. Disks stay in `docs/DISKS.md`.

## What the page has

| Where | What |
| --- | --- |
| Header | Start or Shut down, Console and **Power options** (pause, hibernate, resume, reset, timeouts) as buttons; status, kind, OS, protection and the machine's tags. Stop, reboot, reset, clone, back up, delete stay in Pin's island menu. A machine that does not exist (or was deleted) gets a not-found page with a way back, never an endless wait. |
| Overview | Hostname and addresses (below), and Notes and tags (editable, with the digest). |
| Hardware | Pending-changes banner, Processor and memory, Options, Disks, **Firmware and devices** (VM), **Network devices**, **DNS** and **Features** (container), **Host devices** (add and remove), and for a VM **Processor details**, **Machine type and memory details**, **Other devices** and **More options**; for a container **Container options**. |
| Cloud-Init (VM) | The drive, user, password, SSH keys, DNS, addresses per network device, custom files, regenerate, generated files. |
| Guest agent (VM) | What the agent reports, and trim, freeze, set password, run a command, read a file. |
| Console | Built-in screen and serial terminal, plus a SPICE viewer file and the QEMU monitor. A terminal's corner button opens it in a window of its own (`/:device/console/:vmid`, the host shell at `/:device/console/host`) and the page shows where it went until that window is closed; a blocked pop-up falls back to full screen. A container's console is one shared session that Proxmox reattaches to, so the relay sends Ctrl-L once after connecting to redraw the prompt (it runs nothing). |
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

`GET /api/guests/:id/host-devices` lists host PCI devices (vendor, device, IOMMU group, mediated-capable), USB devices (hubs left out) and the resource mappings this account can see, and says whether the account is root@pam. `POST /api/guests/:id/host-devices` adds, changes or removes one: `{ digest, kind: "pci" | "usb" | "dev", action: "add" | "set" | "remove", key?, ... }`. The slot is the next free `hostpciN` (0 to 15), `usbN` (0 to 13) or `devN` (0 to 31).

| Device | What can be chosen | Who may |
| --- | --- | --- |
| VM, PCI | A saved mapping (`mapping=`), or one to eight raw PCI addresses (`host=`), with PCI Express (needs the q35 machine type, checked), primary GPU (`x-vga`), ROM-BAR off, a mediated (vGPU) type from `GET /api/hardware/pci/mdev?id=` | A mapping: anyone with `Mapping.Use` and `VM.Config.HWType`. A raw address, `romfile`, `legacy-igd` and the vendor and device ID overrides: **root@pam only** |
| VM, USB | A saved mapping, SPICE redirection (`host=spice`), a device (`vendor:product`) or a port (`1-2.3`), USB 3 | A mapping and SPICE: anyone with `VM.Config.HWType`. A device or port: **root@pam only** |
| Container | A device node under `/dev` with mode, user and group ID, read only | **root@pam only** |

The page says this plainly instead of failing late: a raw device for anyone else is refused with "Proxmox lets only root@pam hand a raw host device to a machine. Everyone else uses a saved mapping: an administrator creates it under Datacenter, Resource mappings, and gives you the Mapping.Use permission on it." The same device can't be passed through twice on one machine, a running VM keeps the old devices until it restarts (the change is "Pending restart"), and the page warns that such a VM can't be live-migrated, that ballooning doesn't work with passthrough, and that a primary GPU wants UEFI. Resource mappings themselves are edited in the node area (Datacenter, Resource mappings; `docs/NODE.md`).

### Pending changes

`GET /api/guests/:id/pending` lists what waits for a restart (secrets are never shown) and `POST /api/guests/:id/pending/revert { digest, keys }` takes changes back with Proxmox's `revert` option. The Hardware tab shows a banner with a Review dialog when anything waits.

### Processor details, machine type, memory details, small devices (VM)

All through `POST /api/guests/:id/settings/<group>` with the digest; `GET /api/guests/:id/settings` reads everything (and `/settings/choices` the CPU models, flags, machine types, directory mappings and storages the editors offer). The checks are shared code (`packages/proxmox-client/src/machine-schema.ts`) that also runs in the demo.

| Group | Keys | Notes |
| --- | --- | --- |
| `cpu` | `cpu` (type, `flags=+aes;-pcid`, `hidden`, `phys-bits`), `vcpus`, `affinity`, `numa` | Type and flags are checked against what the node reports. Spectre and Meltdown mitigations are CPU flags (`spec-ctrl`, `ssbd`, `pcid`, `md-clear`), shown with their meaning. Active CPUs can't exceed sockets times cores. Keys we don't manage inside `cpu` are kept |
| `numa` | `numa0` to `numa7` | CPUs, host nodes, memory, policy; adding one turns NUMA on |
| `memory` | `shares` (0 to 50000), `hugepages` (any, 2, 1024), `keephugepages` | Minimum memory stays in Processor and memory |
| `machine` | `machine` (type, `viommu`, `aw-bits`, `enable-s3`, `enable-s4`), `scsihw` | A virtual IOMMU needs q35; changing the type warns about the layout change |
| `rng` | `rng0` | `/dev/random` and `/dev/hwrng` only for administrators |
| `watchdog` | `watchdog` | Model and action; warns that the guest must feed it |
| `virtiofs` | `virtiofs0` to `virtiofs9` | Needs a directory mapping that exists; cache, direct I/O, ACLs, extended attributes |
| `parallel` | `parallel0` to `parallel2` | Host `/dev/parportN` or `/dev/usb/lpN`, administrators only |
| `vmoptions` | `tablet`, `acpi`, `kvm`, `freeze`, `localtime`, `startdate`, `hotplug`, `keyboard`, `tdf`, `allow-ksm`, `vmstatestorage`, `agent` (freeze for backups, trim cloned disks, channel), `spice_enhancements`, `smbios1` (stored base64), `args` | `args` is administrators only (Proxmox enforces root@pam). Defaults are written as a delete, not as a value |

### Container options

`settings/ctoptions`: `cmode` (tty, console, shell), `tty` (0 to 6), `console`, `timezone`, `hookscript` (a snippet, administrators), `arch`, `ostype`, `debug`. Whether the container is privileged is shown with an explanation; Proxmox fixes it at creation, so the page says to restore a backup as a new container to switch. Features, DNS and network are in their own cards above.

### Cloud-Init (VM tab)

`GET /api/guests/:id/cloudinit` returns the settings (never the password: only whether one is set), the snippets for custom files, the storages that can hold the drive, and the values the generated image doesn't have yet (`GET .../cloudinit` pending). `POST` with `digest` and any of `drive: { storage }` (next free of `ide0`, `ide2`, `sata5`, `scsi30`), `user`, `password` (8 to 128 characters, write-only; `clearPassword: true` removes it), `sshKeys` (validated and URL-encoded as Proxmox wants), `upgrade`, `type`, `nameserver`, `searchdomain`, `ipconfig: { ipconfig0: { ip, gw, ip6, gw6 } }` (a prefix is required, a gateway needs a static address; `null` clears), `custom: { user, network, meta, vendor }` (a `storage:snippets/file` volume). `POST .../cloudinit/drive/remove` needs the slot typed, `POST .../cloudinit/regenerate` rebuilds the image, `GET .../cloudinit/dump?type=user|network|meta` shows the generated file with password hashes hidden. A change shows "The image is out of date" until it is regenerated (Proxmox also does it at the next start).

Clone to Cloud-Init (WZ-016) is in the clone dialog below; the Create VM wizard already builds a cloud-init drive for a new VM.

### Power

`POST /api/guests/:id/status { action, timeout?, forceStop?, skipLock?, statestorage?, overrule? }` with action `start`, `shutdown`, `stop`, `reboot`, `reset`, `suspend` (pause in RAM), `hibernate` (`todisk`), `resume`. The Power options dialog offers them with plain explanations. Containers can't be suspended or resumed (refused with a reason); a template can't be started. Header buttons and Pin's menu keep using `/api/guests/:id/power`.

### Snapshots

The list is a tree (a snapshot under its parent, branches indented) with the description editable (`POST .../snapshots/:name/describe`), a details dialog (`GET .../snapshots/:name/config`: memory volume and the settings at that time), and a rollback dialog that needs the snapshot's name typed and can start the machine afterwards (`POST .../snapshots/:name/restore { confirm, start }`).

### Clone

`GET /api/guests/:id/clone-options` returns the free number, nodes, resource groups, snapshots, storages and whether a linked clone is possible. `POST` takes `newid`, `name`, `target` (node), `storage` and `format` (full clones), `full`, `snapname`, `pool`, `bwlimit` (KiB/s), `description`, and for a VM `cloudInit` (as above), `growGb` and `start`. A linked clone needs a template and stays on its storage. With Cloud-Init, growing or starting, the host waits up to two minutes for the copy, then applies each step and reports it (`steps`); if the copy is slower it says so and the new machine's Cloud-Init tab finishes the job. A taken number is a 409.

### Delete

`POST /api/guests/:id/delete { confirm, purge, destroyUnreferenced, skipLock }`: the name must be typed, running and protected machines are refused, and the dialog's Options choose whether the machine is removed from backup and replication jobs and whether unreferenced disks are destroyed (both on by default, as before).

### Console extras

SPICE: `POST /api/guests/:id/spice { proxy? }` builds the `.vv` file from Proxmox's answer (the ticket is short-lived and never logged) and the browser saves it; the address defaults to the one the page was opened with. QEMU monitor: `POST /api/guests/:id/monitor { command }` runs one line. The built-in screen (noVNC) and the serial terminal (xterm.js) are unchanged.

### Guest agent

`GET /api/guests/:id/agent/<info|osinfo|fsinfo|users|time|timezone|vcpus|memory-blocks|host-name>` and `POST /api/guests/:id/agent { action }` with `ping`, `fstrim`, `freeze` (type `freeze`), `thaw`, `freeze-status`, `set-password` (write-only, scrubbed from any Proxmox error), `exec` (type `run`; no shell; the host waits ten seconds for it to end) and `read-file` (full path, up to 64 KiB). An agent that doesn't answer is a 409 `agent_down` with what to do. Proxmox's `VM.GuestAgent.*` privileges decide who may do what.

### CPU models and what the device supports

Datacenter, **CPU models**: custom models (`/cluster/qemu/custom-cpu-models`: a base model, flags, hidden hypervisor, vendor ID, physical bits; delete needs the name typed) and a read-only tab for the node's CPU types, flags, machine types and migration CPU (`/api/capabilities/qemu`).

### Machines list

Search by name, number, tag or OS; filter by running or stopped, kind (VM, container, template) and tag; sort by number, name, CPU, memory or running first. **Select** shows a checkbox on each machine and, once some are picked, a bar to start, shut down, suspend (optionally to disk) or migrate them (`POST /api/bulk/guests` through `/cluster/bulk-action/guest/*`, or `/api/bulk/node` through the node's start all, stop all, suspend all and migrate all). Anything but start asks for the count typed. Templates can't be selected. The node area's Host, All machines page does the same for a whole node.

### Permissions

`GET /api/guests/:id/permissions` returns the entries on `/vms/<id>`, the ones that reach it from above, the roles, users and groups to choose from, and whether this account has Permissions.Modify. `POST` with `action` `grant` (user, group or token, a role) or `revoke` (the name typed). The role, user and group must exist when Proxmox lets the account list them.

## Other changes made with it

- The terminal relay passes `?cmd=upgrade` on `/api/console/node` to Proxmox's node terminal (`ProxmoxClient.termproxyCommand`), so the Updates screen runs the package upgrade directly. Any other value, or the parameter on a machine, is refused in the terminal.
- `main.ts` starts a `TlsReloader`, so a changed node certificate is served without a restart (docs/NODE.md).
- The node switcher shows in the device header of the sidebar when the datacenter has more than one node.
- Unknown addresses, bad machine numbers, the agent-containers dialog, Settings and Connected apps, firewall tables on a phone, the Machines list (search, sort, New machine) and the Storage first tab were fixed from `docs/QA-FINDINGS.md`; each finding has a status line there.

## Tests

Host: `services/epaperclip/test/guest.test.ts` against the fake Proxmox in `test/fakes-guest.ts` (every route: happy path, strict validation, stale digest, busy machine, typed confirmation, permission denial), `containers-errors.test.ts`, and the upgrade command in `app.test.ts`. Host: `services/epaperclip/test/machine.test.ts` against `test/fakes-machine.ts` (which checks parameter names, enums and root-only rules the way Proxmox does and lets you sign in as `root` in realm `pam`). Shared checks: `packages/proxmox-client/test/machine-schema.test.ts`. Console: `apps/console/test/machine-more.test.tsx`, and `apps/console/test/machine.test.tsx` (header buttons, not-found, memory field, network, DNS, features, EFI and TPM, host devices, permissions, settings copy).

Screenshots at 1440 and 390 wide, demo and live (the real host service on the built console over the fake Proxmox): `node --experimental-strip-types services/epaperclip/scripts/guest-shots.mts` (see the file for the environment it needs). It also reports page errors and any sideways scrolling at phone width.

## Not verified against a real Proxmox

Everything was checked against the API viewer data and a fake, not a real node: the exact `net[n]`/`features`/`vga`/`audio0`/`efidisk0`/`tpmstate0` strings Proxmox writes back, the guest-agent and `lxc/<id>/interfaces` answers, `/access/acl` filtering and the Permissions.Modify check, which features a non-root account may change, hot-plug versus pending-restart behaviour per field, whether `PUT .../config` answers with a task for these keys, and the node terminal's `cmd=upgrade`.
Also not run on a real node: the exact strings Proxmox writes back for `cpu` (flags), `machine` (viommu), `rng0`, `watchdog`, `virtiofsN`, `smbios1` and `agent`; that `revert` accepts the keys we send; `hostpciN`/`usbN`/`devN` permission outcomes for accounts with and without `Mapping.Use` (we only enforce the root@pam rule up front and let Proxmox decide the rest); suspend, hibernate (`todisk`, `statestorage`) and resume on the supported versions; the SPICE answer's keys and the `.vv` file with `remote-viewer`; the QEMU monitor's permission (`Sys.Audit` or `Sys.Modify`); guest agent `exec`, `exec-status` and `file-read` (newer versions only) and their privileges; `cloudinit` pending values and `cicustom`; clone onto another node, `format` and `bwlimit`; the cluster-wide bulk actions (newer versions only); custom CPU model endpoints.

## Not built

Importing an OVA or OVF as a whole machine (settings from the OVF) and the ESXi import wizard are not possible through the API alone: Proxmox builds those from a command-line tool or its own import dialog. What the API does give is creating a VM whose **disk comes from an image** on an import storage (a disk image, the disk inside an OVA, or an ESXi virtual machine's disk); the Create VM wizard offers it (`docs/WIZARDS.md`). Container OCI image pulls (ND-060) are not built either. AMD SEV and Intel TDX options stay out of the options dialog.
