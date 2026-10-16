# Backup

Everything Proxmox's backup screens do, as the signed-in person (Proxmox decides permissions). Page: Datacenter, Backup. Code: `services/epaperclip/src/features/dcBackup.ts`, `apps/console/src/pages/node/Backup.tsx`. Routes are under `/api/node/backup/…`. Input is validated against Proxmox's own parameter definitions (`dcSchema.ts`); deprecated and risky options (hook scripts, dump and temp directories, the old day-of-week fields) are not offered.

## Jobs

Every option Proxmox has: schedule (with the next five runs shown as you type), storage, enabled, comment, machines (every machine, chosen machines or a pool, with machines to leave out), mode, compression, zstd threads, bandwidth limit, I/O priority, notes template, notification mode, fleecing, performance, retention (keep last, hourly, daily, weekly, monthly, yearly or keep all), repeat missed, mark as protected, skip temporary files, paths to skip in containers, change detection for Proxmox Backup Server, lock and stop waits, and the node to run on.

- Exactly one way to select machines; switching clears the others. "Keep all" with other keep settings is refused with an explanation.
- Edits send the Proxmox `digest`; a stale edit is refused.
- Deleting a job needs its name typed. Backups it made stay.
- **Volumes** shows which disks each machine contributes and why one is left out.
- **Not covered** lists machines that no job includes, with a shortcut to create a job for them (`/cluster/backup-info/not-backed-up`).

## Backups on a storage

Per storage and machine number: date, size, notes, protection, verification. Per backup:

- **Restore**: as a new machine (own number or the next free one, new MAC addresses, start after, bandwidth limit, pool, target storage, live restore for VMs on Proxmox Backup Server) or over the original (the machine must be stopped; its number is typed).
- **Files**: browse a Proxmox Backup Server snapshot (`file-restore/list`). Taking a single file out needs a binary download; the Proxmox client used here does not stream binary responses yet, so the page says to restore as a new machine or use the Backup Server's own browser. This is why the single-file restore row is partial.
- **Config**: the guest configuration stored in the backup.
- **Notes** and **Protect / Unprotect** (protected backups cannot be pruned or deleted; delete is disabled for them).
- **Delete**: the file name is typed.
- **Prune**: choose a retention, **Preview** shows what would be kept, protected or removed, then removing needs the storage name typed. Without a retention Proxmox uses the storage's own.

## Not verified against a real Proxmox

The restore parameter set for containers and live restore, the `file-restore` listing format, and the prune preview marks were taken from the API viewer data and tested on a fake.
