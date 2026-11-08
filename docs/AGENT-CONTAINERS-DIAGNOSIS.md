# Agent containers: why a container fails to start, and how setup now says so

Status: simulated only. Nothing here has run against a real Proxmox host. Where a real host is needed it says so.

## The owner's failure

Settings, Agent containers, on a real device (older build), storage `drive2` for both container and template:

```
Starting the container failed: Proxmox reported an error (500) without saying why. Its task log and system log have the details.
(sync_wait: 34 An error occurred in another process (expected sequence number 7) /
 __lxc_start: 2288 Failed to spawn container "104" / TASK ERROR: startup for container '104' failed)
```

### What the setup does (services/epaperclip/src/containers.ts)

check (ssh, plugin files, storages, bridge) → access (roles, user, token) → key → template (download Debian base with
`pveam`, create an unprivileged container with `nesting=1` on the chosen storage, **start it**, SSH in, run
`provision.sh`, shut down, convert to template) → grant → plugin → environments → enforce. Every Proxmox call is made with
the signed-in administrator's own session.

### Findings (code, certain)

1. The 500 text was our own. `waitTask` threw `ProxmoxError("Proxmox task failed: <exitstatus>", 500)` with no `detail`, and
   `errText` then printed the generic "500 without saying why". The exit status ("startup for container '104' failed") was
   dropped. The log tail (last 4 lines) was appended, which is why the LXC lines show. Fixed: the exit status is the detail.
2. The failing step is the template container's **start**, not the token rights. The checklist's "Missing: /pool/epc-agents,
   /vms/104" was a second, separate bug: setup granted rights only after the template, and the status asked for
   `/vms/<id>` for a template that did not exist yet, so it was a perpetual gap. Fixed: the pool, storage, bridge and node
   rights are granted before the template; `/vms/<template>` only once the template exists (and is granted at the end of the
   template step). Pool rights are propagating, so later vmids are covered.
3. Rights are now computed exactly (path, role, user or token, absent / not inherited / ineffective with the lacking
   privileges), applied only where missing, and verified with `GET /access/permissions?userid=...&path=...` (what Proxmox
   will really allow, the token's overlap with its user).
4. `newestDebian` accepts amd64 and arm64 alike; on a host whose catalog lists both, the wrong one could be picked. Not
   changed (the catalog lists the host's own architecture); the diagnosis recognizes the resulting "Exec format error".

### What the LXC message means (certain vs. not)

`sync_wait ... expected sequence number N` + `Failed to spawn container` = the container's child process died during start
and LXC lost the handshake. The reason is written to LXC's own debug log, **not** to the Proxmox task log, so the API cannot
show it. Which causes fit this setup (unprivileged, `nesting=1`, rootfs on a non-default storage "drive2"), most likely first:

1. The drive behind `drive2` is ntfs/exfat/vfat, or mounted `noexec`/`nodev`/`ro`, or a root-squashed share: unprivileged
   containers need ownership and xattrs.
2. `/etc/subuid` and `/etc/subgid` lack `root:100000:65536`, or a custom `lxc.idmap` clashes.
3. AppArmor or cgroup trouble, typical when Proxmox itself runs in an LXC container or a restricted VM (nesting not allowed
   by the outer layer).
4. Kernel namespaces disabled or out of memory.
5. Wrong-architecture or damaged template; full or inactive storage; bridge missing.

I cannot say which one the owner's host has. That needs the debug log (runbook below) or a real host.

## What the setup now does

* On a failed task it reads the full task log, the container config (`pct config` equivalent), the storage status, and the
  node journal (`GET /nodes/{node}/journal`: AppArmor denials, cgroup and kernel messages), and matches them with
  `packages/proxmox-client/src/lxc-diagnose.ts`: 18 known causes (template missing/corrupt, wrong arch, storage full /
  unavailable / ownership, mount denied, idmap, AppArmor, cgroup, namespaces, features, network, devices, locked, no init,
  memory, pre-start hook). When only LXC's generic failure is present it says so ("Proxmox gave no specific reason"), lists
  the checks in order and the exact `lxc-start -n <id> -F -l DEBUG -o /tmp/lxc-<id>.log` command. It never invents a cause.
* A generic start failure triggers one probe: start the throwaway template container again without its features. If it
  starts, the diagnosis is "the host refuses nesting"; if not, "nesting is not the cause". Features are restored.
* A damaged base template (zstd/tar errors) is deleted and downloaded again once, automatically. A pre-existing file under
  20 MiB is treated as cut off and replaced. Proxmox itself checks fresh downloads against the catalog sha512.
* Before building: Proxmox VE 8+ (SDN.Use), storage active, at least 4 GiB free, and a warning for dir/nfs/cifs storage.
* Task log lines are relayed to the job log as they appear (download percentages throttled to every 10%).
* The failure is shown in the UI: cause, numbered fixes, and an expandable "What Proxmox said" (secrets removed:
  `user@realm!name=secret`, cookies, Authorization, private keys, `password=` style values).
* A failed template no longer hides the rest: grant and the provider install still run; environments and enforce are
  marked skipped ("Waits for the template").
* "Run only this step" for rights, provider and environments: `POST /api/agent-containers/steps/{grant|plugin|environments}`.
* The same matcher (a copy, kept identical by a test) enriches the sandbox plugin's `ProxmoxTaskError` for agent runs.

## Runbook: what an administrator runs on the Proxmox host (as root)

Replace 104 with the container id from the error.

```sh
# 1. Proxmox's own task log for the failed start
ls -t /var/log/pve/tasks/*/*:vzstart:104:* | head -1 | xargs cat
# 2. LXC's real error (the API cannot show it): run in the foreground with debug logging
lxc-start -n 104 -F -l DEBUG -o /tmp/lxc-104.log ; grep -E 'ERROR|WARN' /tmp/lxc-104.log | head -30
# 3. Journal and kernel messages
journalctl -b -u pve-container@104 ; journalctl -k -b | grep -iE 'apparmor|audit|cgroup|seccomp' | tail -30
# 4. The container as Proxmox sees it, and its storage
pct config 104 ; pvesm status ; findmnt -T "$(pvesm path drive2:104 2>/dev/null || echo /mnt)"
# 5. The usual suspects
cat /etc/subuid /etc/subgid              # need: root:100000:65536
stat -fc %T /sys/fs/cgroup               # cgroup2fs
sysctl user.max_user_namespaces          # not 0
free -m ; df -h
/usr/share/lxc/hooks/lxc-pve-prestart-hook 104 lxc pre-start   # prints the hook's own message
```

Likely fixes: put container disks on ext4/xfs/btrfs/ZFS/LVM storage (not ntfs/exfat/vfat, not noexec/nodev mounts); add
the subuid/subgid line; run Proxmox on bare metal or in a VM rather than an LXC container; `systemctl restart apparmor`.
After a fix, press Resume setup (a half-made container has already been removed).

## Validation (honest labels)

* simulated: unit tests of every matcher rule and redaction (`packages/proxmox-client/test/lxc-diagnose.test.ts`); setup
  flow against the fake Proxmox for the owner's exact log, nesting probe, journal-driven AppArmor, corrupt-template retry,
  inactive/full storage, old Proxmox, grant gaps (absent, not inherited, ineffective), single-step repair
  (`services/epaperclip/test/containers-diagnosis.test.ts`).
* real Proxmox: none. Unverified against a real host: the journal and `/access/permissions?userid=` endpoint shapes,
  `PUT .../config delete=features`, that the matcher patterns hit real LXC wording, and whether the owner's host fails for
  one of the causes above. Needs a disposable Proxmox host (or the owner running the runbook and pasting the lxc-start
  ERROR lines).
