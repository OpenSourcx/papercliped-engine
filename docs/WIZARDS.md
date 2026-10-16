# Create machine wizards

ePaperclip replaces Proxmox's Create VM and Create CT wizards. One dialog, **New machine**, switches between a container and a virtual machine and offers every choice Proxmox's wizards do, plus cloud-init and hardware passthrough. Everything is done through the Proxmox API **as the signed-in person**, so Proxmox's own permissions decide who may create what. The host service checks every request before it reaches Proxmox, and passwords, SSH keys and cloud-init secrets are write-only: sent to Proxmox, never returned, shown or logged.

Code: shared checks `packages/proxmox-client/src/wizard-schema.ts`, host `services/epaperclip/src/features/wizard.ts`, console `apps/console/src/pages/machines/NewMachine.tsx` and `wizard/`, data layer `apps/console/src/data/engine/wizard.ts`. The demo runs the same dialog on in-browser data and the same checks, so both modes accept and refuse exactly the same requests.

## The screens

Steps are tabs, not a one-way march: click any step, or press Review to jump to Confirm. Nothing is flagged until a step has been visited; then a step with a problem shows a warning mark, the field shows the reason, and Create stays off until it is fixed. A size starter (Small, Medium, Large) on the first step fills CPU, memory and disk; every value stays editable.

| Virtual machine | Choices |
| --- | --- |
| General | Name, machine number (checked for use as you type), owner (the device, or an organization, which puts it in that organization's resource group and checks it fits), resource group, start at boot, start order, start delay, shutdown timeout, tags, note |
| OS | Install media: ISO image from any storage, the device's physical drive, or none. Guest OS type and version (Linux 6.x and 2.4, Windows 11 down to 2000, Solaris, Other). Picking one applies its usual hardware; a Windows ISO's name moves a Linux default to Windows 11 |
| System | Graphic card (std, VirtIO-GPU, VirGL, SPICE qxl 1-4, VMware, Cirrus, serial terminal, none) and video memory, machine type (default, q35, versioned), BIOS (SeaBIOS or UEFI), SCSI controller, QEMU guest agent, EFI disk and pre-enrolled keys, TPM 1.2 or 2.0 |
| Disks | Any number: bus (SCSI, VirtIO block, SATA, IDE) and the next free slot, storage, size, format (only on file storage), cache, discard, SSD emulation, IO thread, include in backups. Options a bus can't do are switched off with the reason. **Start from** an image on an import storage (disk image, OVA or ESXi machine) instead of an empty disk; the size then comes from the image |
| CPU | Sockets, cores, type (common types, custom models and every model the device lists), active CPUs, CPU limit, CPU weight, NUMA |
| Memory | Fixed or ballooning (minimum, shares) |
| Network | Any number of devices: bridge or SDN vnet, model, VLAN tag, MAC, firewall, disconnected, rate limit, MTU and multiqueue (VirtIO) |
| Cloud-init | Drive storage, user, password, SSH keys, upgrade on first boot, DNS servers and domain, and DHCP, static or SLAAC addresses with gateways per network device |
| Hardware | PCI devices (raw, or a saved mapping; PCIe, primary GPU, ROM-bar), USB (device, mapping or SPICE; USB 3), serial ports, audio device |
| Confirm | Plain-words summary, every warning, a Start after created switch, and the exact Proxmox request with secrets hidden |

| Container | Choices |
| --- | --- |
| General | Hostname, machine number, owner and resource group, start at boot and start order, tags, note, root password, SSH keys, unprivileged (default on) |
| Template | Any template from any storage, with a link to the catalog when there are none |
| Disk | Storage and root disk size |
| CPU | Cores, CPU limit, CPU weight |
| Memory | Memory and swap |
| Network | Any number of devices: name, bridge, VLAN, MAC, firewall, disconnected, rate, MTU, IPv4 (DHCP, static with gateway, manual, none) and IPv6 (SLAAC, DHCP, static with gateway, manual, none) |
| Mounts and devices | Up to ten extra mount points (a new volume on a storage, or a host folder), read only, include in backups; device nodes passed through (path, mode, group ID). Host folders and devices are root@pam only |
| DNS and features | DNS servers and domain; nesting, keyctl (unprivileged only), FUSE |
| Confirm | As above |

## Host routes

All need the Proxmox session; writes need `X-EPC-Request: 1`. The body of a write is limited to 96 KiB, must be JSON, and an unknown field anywhere in it is refused with its path (`Unknown field cpu.turbo`).

| Route | What |
| --- | --- |
| `GET /api/wizard/options` | What the node offers: `nextid`, `templates`, `isos`, `imports` (images on import storages), `vmStorages` and `ctStorages` (with `type`, `avail`, allowed `formats`), `pools`, `bridges` (bridges and SDN vnets), `cpuTypes` (`common`, `custom`, device models), `machines`, `rawPassthrough` (true for root@pam only), `pci`, `usb`, `pciMappings`, `usbMappings`, `isAdmin`, `notes`. A list the person may not read comes back empty with a note, never an error |
| `GET /api/wizard/vmid?vmid=N` | `{ free, message }` |
| `POST /api/wizard/preview` | `{ kind: "vm" \| "ct", spec }` returns `{ vmid, params, warnings }`: exactly what would be sent, secrets replaced by `(set, hidden)`. Creates nothing |
| `POST /api/wizard/create` | The same body; returns `202 { vmid, task, warnings }`. A chosen machine number that is taken is `409 vmid_taken`; an invalid request is `400 invalid` with the reason; Proxmox's own refusal comes back as `400 proxmox_rejected` with its words, scrubbed of any secret the request carried |

The request shapes are the `VmWizardSpec` and `CtWizardSpec` types in `wizard-schema.ts`.

## Proxmox API used

Names, enums and ranges were checked against the API viewer (`apidoc.js`) for `POST /nodes/{node}/qemu` and `POST /nodes/{node}/lxc`. Permissions are Proxmox's (`VM.Allocate`, `Datastore.AllocateSpace`, `Pool.Allocate`, `SDN.Use`, `VM.Config.*`, `Mapping.Use`, root@pam for raw device passthrough); a refusal becomes "Your Proxmox account doesn't have permission for this".

| Choice | Parameter |
| --- | --- |
| Virtual machine | `vmid name ostype pool start onboot startup tags description bios machine scsihw agent vga sockets cores cpu vcpus cpulimit cpuunits numa memory balloon shares boot` |
| Disks, media | `scsiN virtioN sataN ideN` as `storage:GiB[,format,cache,discard=on,ssd=1,iothread=1,backup=0]`; `ide2` is the media (`volid,media=cdrom` or `cdrom,media=cdrom`); `efidisk0` (`efitype=4m,pre-enrolled-keys`), `tpmstate0` (`version`) |
| Network | `netN` as `model,macaddr,bridge,firewall=1,link_down=1,mtu,queues,rate,tag` |
| Cloud-init | `ide0` (else `sata5`, `scsi30`) as `storage:cloudinit`; `citype ciuser cipassword sshkeys` (URL-encoded) `ciupgrade nameserver searchdomain ipconfigN` (`ip`, `gw`, `ip6`, `gw6`) |
| Hardware | `hostpciN` (`host` or `mapping`, `pcie`, `x-vga`, `rombar`), `usbN` (`host`, `mapping` or `spice`, `usb3`), `serialN=socket`, `audio0` (`device`, `driver`) |
| Container | `vmid ostemplate hostname password ssh-public-keys unprivileged pool start onboot startup tags description cores cpulimit cpuunits memory swap rootfs mpN devN nameserver searchdomain features` |
| Disk from an image | `scsiN` (or another bus) as `storage:0,import-from=<volid>` for a volume on an import storage |
| Container network | `netN` as `name,bridge,hwaddr,firewall=1,link_down=1,mtu,rate,tag,ip,gw,ip6,gw6` |
| Options read | `GET /nodes/{node}/storage` (content `images`, `rootdir`, `iso`, `vztmpl`, `import`), `.../storage/{id}/content`, `.../network?type=any_bridge`, `/cluster/sdn/vnets`, `.../capabilities/qemu/cpu`, `.../capabilities/qemu/machines`, `.../hardware/pci`, `.../hardware/usb`, `/cluster/mapping/pci`, `/cluster/mapping/usb`, `/pools`, `/cluster/nextid` |

## What is checked

Strictly, before anything reaches Proxmox, in `wizard-schema.ts` (the same code runs in the console):

- Names are DNS names (labels of at most 63 characters, no leading or trailing hyphen). Tags use letters, digits and `_ - + .`. The machine number is 100 to 999999999.
- Every enum (OS type, BIOS, SCSI controller, bus, cache, format, NIC model, graphic card, audio device and driver, TPM version) is a list from the API description. Sockets 1 to 4, cores 1 to 512, memory 16 MiB and up, minimum memory not above memory, active CPUs not above sockets times cores, VLAN 1 to 4094, MTU and multiqueue on VirtIO only, MAC unicast.
- Disks: the bus's slot count (IDE 4, SATA 6, SCSI 31, VirtIO 16) with `ide2` kept for the media and the cloud-init drive placed on a free slot; SSD not on VirtIO; IO thread only on VirtIO or SCSI with the VirtIO SCSI single controller; QCOW2 and VMDK only on file storage (dir, NFS, CIFS, GlusterFS, CephFS, Btrfs); storage must hold disks for this kind of machine and be active.
- Addresses: IPv4 and IPv6 are parsed (no `256`, no `:::`, prefix required, no loopback, multicast or zero network), and an IPv4 gateway must be inside the address's network. Gateways need an address. DHCP, SLAAC and manual refuse a typed address.
- Bridges must exist on the node (or be an SDN vnet) when the node could list them; a resource group must exist; CPU types must be a common one or one the node reports; PCIe passthrough needs q35; an EFI disk needs UEFI; keyctl needs an unprivileged container.
- Passwords are 8 to 128 characters on one line; SSH keys one per line in a recognised format. A cloud-init password or key is URL-encoded as Proxmox expects.

Non-blocking warnings: Windows 11 without UEFI and a TPM, under 64 GB of disk or 4 GB of memory; no network device; ballooning or no UEFI with PCI passthrough; IDE on q35; cloud-init without a user, password or key; a container without a password or key; a privileged container.

## Secrets

The container root password, container SSH keys, cloud-init password and cloud-init keys are `write-only`: the console keeps them only while the dialog is open, they are in the one create request body, the preview and summary never contain them (they show "password set"), the host never writes them to a log or response, and any error text Proxmox returns is scrubbed of them before it reaches the browser. Tests cover a Proxmox error that repeats the password.

## Demo

The demo's storage, templates and ISOs come from its in-browser storage; bridges, CPU types and a PCI and USB device are stand-ins. Creating validates with the shared checks, then adds the machine to the demo data with the fields the demo's machine model has (name, CPU, memory, disk total, OS); it doesn't keep per-device hardware.

## Tests and screenshots

- Shared checks: `packages/proxmox-client/test/wizard-schema.test.ts`.
- Host: `services/epaperclip/test/wizard.test.ts` against `test/fakes-wizard.ts`, a Proxmox stand-in that validates the create calls as the API description does (known parameter names, enums, ranges, property-string keys, slot counts) so a wrongly built request fails there as it would on a host. It is layered over the shared fake and does not replace it.
- Console: `apps/console/test/wizard.test.tsx` (demo and live, with a stubbed host).
- In a real browser, against the real host service and the fake Proxmox:

```sh
pnpm --filter @papercliped-engine/console build
node --experimental-strip-types services/epaperclip/scripts/wizard-live.ts &        # http://127.0.0.1:4480, sign in as sam / pve / "right"
node services/epaperclip/scripts/wizard-shots.mjs /tmp/wizard-shots                 # every step, 1440 and 390 wide, demo and live
node services/epaperclip/scripts/wizard-flow.mjs /tmp/wizard-shots                  # creates a Windows 11 VM and a container through the UI, asserts what Proxmox was asked
```

## Not verified against a real Proxmox

Everything above was built from the API description and exercised against a stand-in. These were not run on a real host and are the first things to check on one:

- That `macaddr=` is accepted inside `netN` on every supported version (older versions write `virtio=MAC`).
- `sshkeys` URL-encoding for cloud-init, and `ciupgrade` (newer versions only).
- Cloud-init on `ide0` together with a CD on `ide2` under q35.
- `hostpci` `host=` with a full PCI address, `mapping=` permissions (`Mapping.Use`), and the root@pam rule for raw devices.
- Passing a vnet as `bridge=` needs `SDN.Use` on it.
- The `agent=enabled=1` spelling and `balloon=0` for fixed memory on every version.
- `startup` values (`order`, `up`, `down`) and `tags` separators on 8 and 9.
- Which storages report `rootdir` and `images` content to a non-administrator.

## Clone to Cloud-Init and importing

Cloning a template (or any VM) into a ready machine (WZ-016) is in the **Clone** dialog on the machine page (`docs/MACHINE.md`): name, storage, linked or full, machine number, node, format, snapshot, speed limit, resource group, and a Cloud-Init section (user, password, SSH keys, first address, grow the disk, start when ready). Importing (WZ-017) is the disk choice above. An OVA or OVF is not imported as a whole machine and the ESXi import wizard is not rebuilt, because Proxmox does those through its own tools rather than the API: create the VM here with its disk taken from the image, then adjust the hardware on the machine page.

## Not built

Container OCI image pulls (ND-060), importing an OVA or OVF's machine settings, and the ESXi wizard.
