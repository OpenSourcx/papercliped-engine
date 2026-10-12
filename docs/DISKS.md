# Disks, storage and machine disks

ePaperclip replaces Proxmox's Disks, Storage and Hardware (disk) screens. Everything below is done through the Proxmox API **as the signed-in person**, so Proxmox's own permissions decide what each person may do. The host service validates every request before it reaches Proxmox, requires a typed confirmation for anything destructive, and never returns or logs a secret.

Code: host `services/epaperclip/src/features/disks*.ts`, shared schema `packages/proxmox-client/src/storage-schema.ts`, console `apps/console/src/features/disks.tsx` and `src/pages/disks/`, `src/pages/storage/`, `src/pages/machines/HardwareDisks*.tsx`. The demo runs the same screens on in-browser data (`src/data/engine/disksDemo.ts`) with the same rules.

## Screens

| Screen | Where | What it does |
| --- | --- | --- |
| Disks | Host, Disks | Physical disks (type, size, model, serial, what uses them, wear, SMART health). SMART detail, Initialize with GPT, Wipe. Tabs for LVM, LVM-Thin, ZFS (with the pool's status tree) and directories on disks, each with create and remove. |
| Create storage on a disk | Disks, Create storage | Directory (ext4 or XFS), LVM, LVM-Thin, ZFS. ZFS shows plain-language guidance per RAID level, a live capacity preview and how many disks may fail. |
| Storage settings | Datacenter, Storage settings | Every storage definition: add, edit, remove. The form is built from the schema for the chosen type. |
| Storage detail | Host, Storage, a storage | Gains Edit and Remove (with the same warnings), and a Details dialog per file (copy volume id, protect and notes for backups, delete). |
| Machine Disks card | A machine, Hardware | Add disk or mount point, edit options, grow, move, detach, attach, destroy, CD/DVD drive, container mount points and bind mounts. |

## Proxmox API used

Every path and parameter was checked against the API viewer (`apidoc.js`), including the permission each one needs.

| Area | Calls |
| --- | --- |
| Disks | `GET /nodes/{node}/disks/list` (`include-partitions`), `GET .../disks/smart` (`disk`), `POST .../disks/initgpt`, `PUT .../disks/wipedisk` |
| On disks | `GET/POST /nodes/{node}/disks/{directory,lvm,lvmthin,zfs}`, `DELETE .../disks/{kind}/{name}` (`cleanup-config`, `cleanup-disks`, plus `volume-group` for LVM-Thin), `GET .../disks/zfs/{name}` |
| Storage definitions | `GET /storage`, `GET/PUT/DELETE /storage/{id}` (`digest`, `delete`), `POST /storage` |
| Scans | `GET /nodes/{node}/scan/{nfs,cifs,pbs,iscsi,lvm,lvmthin,zfs}` |
| Volumes | `GET .../storage/{id}/content`, `PUT .../content/{volume}` (`notes`, `protected`) |
| Machines | `GET/PUT .../{qemu,lxc}/{vmid}/config` (`digest`, `delete`), `GET .../pending`, `POST .../qemu/{vmid}/move_disk`, `POST .../lxc/{vmid}/move_volume`, `PUT .../qemu/{vmid}/unlink` |

Things the API does not have, and what is done instead:

- **`reassign_disk`** does not exist in the current API. Reassigning a disk to another machine is `move_disk` / `move_volume` with `target-vmid` (and optionally `target-disk` / `target-volume`, `target-digest`). The target must be the same kind of machine on the same device.
- **GlusterFS** is not in the current API and is not offered.
- **Exporting or downloading a VM disk image** is not supported by the API (there is only upload and download-from-URL into a storage), so there is no export button. Restoring backups stays on the Backups page.
- **Renaming ISO images and templates** is not supported by Proxmox, so it is not offered.

## Routes (host service)

All need a signed-in session. Changes need the `X-EPC-Request: 1` header and a matching Origin. Errors are `{ error, code }`; Proxmox's own reason is passed on when it refuses, and a 403 reads "Your Proxmox account doesn't have permission for this".

**Node disks**

- `GET /api/disks/list` returns `{ node, disks[] }`: `devpath, name, type, sizeBytes, model, vendor, serial, wwn, usedBy, mounted, gpt, health, wearoutPct (life left, 100 is new), rpm, parent, inUseReason`.
- `GET /api/disks/smart?disk=/dev/sda` returns `{ disk, health, type, text, attributes[] }`.
- `POST /api/disks/initgpt` and `POST /api/disks/wipe` take `{ disk, confirm }`.
- `GET /api/disks/{directory,lvm,lvmthin,zfs}` returns `{ items[] }`; `GET /api/disks/zfs/{name}` returns the pool's status tree.
- `POST /api/disks/{kind}` creates. Directory, LVM, LVM-Thin: `{ name, device, filesystem?, addStorage? }`. ZFS: `{ name, devices[], raidlevel, ashift?, compression?, draidConfig?, addStorage? }`. Returns `{ task }`.
- `POST /api/disks/{kind}/{name}/delete` takes `{ confirm, cleanupConfig?, cleanupDisks?, volumeGroup? }`.

**Storage definitions**

- `GET /api/storage-config` returns `{ storages[] }`; `GET /api/storage-config/{id}` one. Each is `{ id, type, content[], nodes[], enabled, shared, prune, bwlimit, config, secretsSet[], digest }`. `secretsSet` names the write-only settings that are stored (password, fingerprint, key ring, encryption key); their values are never sent.
- `POST /api/storage-config` creates: `{ type, storage, ...fields, content[], nodes[], disable?, shared?, "prune-backups"?, bwlimit? }`.
- `POST /api/storage-config/{id}` edits and requires `digest`. Fields Proxmox fixes at creation (server, path, share, vgname ...) are refused. An empty secret keeps the stored one; an emptied optional field is sent to Proxmox as `delete`.
- `GET /api/storage-config/{id}/usage` returns `{ counts, readable, guests[], backupJobs[] }`.
- `POST /api/storage-config/{id}/delete` takes `{ confirm, acknowledgeInUse? }`. If machines or backup jobs still use it, the answer is 409 `in_use` until `acknowledgeInUse` is true.
- `POST /api/storage-config/scan/{nfs,cifs,pbs,iscsi,lvm,lvmthin,zfs}` returns `{ items[] }`. Credentials travel in the body, never the URL.
- `POST /api/storage/{id}/attributes` takes `{ volid, notes?, protected? }`.

**Machine disks** (`/api/guests/{vmid}/disks`)

- `GET` returns `{ type, status, digest, locked, isAdmin, pendingKeys[], disks[], unused[], hotplug }`. Disks carry their parsed options; changes Proxmox has staged for the next start are marked `staged`.
- `POST .../add` (VM disk), `.../mount` (container mount point or bind mount), `.../cdrom` (`{ key?, iso: volid | "none" | "physical" }`), and `POST .../{key}/{edit,detach,reattach,destroy,move,reassign}`.
- Every change requires `digest` (from the last `GET`); a stale page gets 409 `stale`, and Proxmox checks it again on the write.

## Destructive-action rules

1. **Typed confirmation, enforced at the API.** The `confirm` field must equal the disk's name (`sdb` or `/dev/sdb`) for Wipe and Initialize, the storage name for removing a storage or a LVM/ZFS/directory, and the volume's name for destroying a detached disk. The console's button stays off until it matches, but the host service refuses without it (409 `confirm`).
2. **Disks in use are refused before Proxmox is asked** when they are mounted, hold the boot loader or EFI partition, or belong to LVM, ZFS, the device mapper or Ceph. The message says what to remove first. Anything else goes to Proxmox, whose own refusal is shown as it said it.
3. **Detach is not delete.** Detaching a disk makes it a detached (`unusedN`) disk; nothing is destroyed. Destroying is a separate, typed step and only works on detached disks.
4. **Attaching a detached disk never sends `delete` for it.** Combining the two could destroy the volume that was just attached.
5. **Digests everywhere.** Machine and storage edits send Proxmox's `digest`, so a change made elsewhere in the meantime is refused instead of overwritten.
6. **Removing a storage forgets it in Proxmox; it does not delete data.** The warning lists the machines and backup jobs that still use it.
7. **Bind mounts hand a host folder to a container.** Only Proxmox administrators (Sys.Modify on `/`) can add or change them here, with a warning; Proxmox itself restricts them to `root@pam`. Host paths must be absolute and clean, and system folders (`/proc`, `/sys`, `/dev`, `/run`, `/boot`, `/etc/pve`) are refused.
8. **Secrets are write-only.** Passwords, certificate fingerprints, key rings and encryption keys are never returned, never logged and never put in a URL; only "is set" is reported.

## Storage types

Dir, NFS, SMB/CIFS, Proxmox Backup Server, LVM, LVM-Thin, ZFS pool, iSCSI, iSCSI direct, CephFS, Ceph RBD, BTRFS, ZFS over iSCSI and the ESXi importer. Each has a field list, the content types it can hold, and the options that apply (shared flag, node restriction, retention, bandwidth limits). The lists are checked against `POST /storage` and `PUT /storage/{id}` in the API viewer, so no key is invented. Fields that `PUT` doesn't accept are shown but locked when editing.

Content types, node restriction, enable/disable, `shared`, backup retention (`keep-all` or `keep-last/hourly/daily/weekly/monthly/yearly`) and bandwidth limits (`default`, `restore`, `move`, `clone`, `migration`, in MiB/s in the form and KiB/s on the wire) are available for every type that supports them.

## Not verified against a real Proxmox

Everything was checked against the API viewer and a fake Proxmox that behaves like it (digests, unused disks, pending changes, tasks). Not yet seen on real hardware: how `wearout` is reported for every disk model, the exact text of Proxmox's refusals, hot-plug behaviour for running VMs, and `move_disk` with `target-vmid` across storage types. After attaching a detached disk the service reports `staleUnused` if Proxmox did not drop the detached entry itself.
