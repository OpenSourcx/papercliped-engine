# Agent containers: why a container fails to start, and how setup now says so

Status: the root cause of the owner's failure is now **confirmed from the real host** (2026-11-09); the rest is still
simulated until a clean template build is run on the host. Where a real host is needed it says so.

## CONFIRMED: the real cause on the owner's host (2026-11-09)

Host `pve` (Proxmox VE 9.2.25, Intel Xeon W3520, **amd64**). The failed container was 104 on `drive2`. The host's own
`vzcreate:104` task log says:

```
extracting archive '/mnt/pve/drive2/template/cache/debian-13-standard_13.6-1_arm64.tar.zst'
Detected container architecture: arm64
```

and the `vzstart:104` task log says only:

```
sync_wait: 34 An error occurred in another process (expected sequence number 7)
__lxc_start: 2288 Failed to spawn container "104"
WARN: Systemd 257 detected. You may need to enable nesting.
TASK ERROR: startup for container '104' failed
```

Proxmox unpacked an **arm64** root filesystem on an **amd64** host. Its `/sbin/init` cannot execute, so the init process
dies and LXC reports only the generic handshake failure. The "Systemd 257 / nesting" line was a red herring.

Why it happened: `pveam`'s catalog on that host listed both
`debian-13-standard_13.1-2_amd64.tar.zst` and the newer `debian-13-standard_13.6-1_arm64.tar.zst`. Setup sorted only by
version, so the newer arm64 image won. `newestDebian()` did not know the host's architecture.

What was **ruled out with real evidence** (not assumptions): `drive2` is xfs on `/dev/sdb1`, mounted `rw,relatime` (so not
ntfs/exfat, not noexec/nodev/ro); `/etc/subuid` and `/etc/subgid` both contain `root:100000:65536`; `/sys/fs/cgroup` is
`cgroup2fs`; `user.max_user_namespaces` is 116600. The storage-ownership, idmap, cgroup and namespace hypotheses did not
apply to this host.

Fix in this release:
* `newestDebian(files, arch)` only considers templates for the host's processor. The setup never falls back to the other
  architecture; if the catalog has none for this host it says so and lists what it does have.
* After creating the container, setup reads the create task log's `Detected container architecture:` line and verifies it
  against the host. A mismatch is reported as a certain cause (`template-arch-mismatch`) and the half-made container is
  removed, rather than being started and failing generically.
* The built template's architecture is stored (`templateArch`). A stored template from the other architecture is removed
  and rebuilt instead of reused.
* The template container is created with `nesting=1,keyctl=1` (what systemd 257 needs in an unprivileged container), and
  the features are re-checked and set after creation if Proxmox did not apply them.

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

* **Picks the template for the host's processor** and verifies it from the create task's own `Detected container
  architecture:` line (see the confirmed section above). A mismatch is a certain cause, not a generic one.
* **Checks storage capability from what Proxmox reports.** For `dir` storage it reads `GET /storage/{id}` for the path and
  `GET /nodes/{node}/disks/directory` for the filesystem and mount options. NTFS/exFAT/FAT/fuseblk, `noexec` and read-only
  mounts are refused with the exact host command to confirm it; network storage is a warning (root squash); when the API
  cannot say, the verdict is "unknown" and names the missing host information (`findmnt -T <path>`). It never dresses a
  guess as a diagnosis. `lvmthin`, `lvm`, `zfspool`, `rbd` are accepted without a filesystem question.
* **Resumes from the first unfinished step.** A re-run checks what Proxmox and the engine already have and marks completed
  steps "already in place" instead of redoing them. A changed host setting is never treated as a resume.
* **Applies host-setting changes without a rebuild.** `POST /api/agent-containers/settings` validates the new storage,
  grants the token's rights on it and updates every organization's environment; the template is kept. A changed template
  storage takes effect the next time the template is built.
* **Bounds template retries.** Consecutive failed builds are counted; after three, setup refuses to retry until the
  administrator presses "Try the template again" (`POST /api/agent-containers/steps/template` with `force: true`), so a
  broken host is not hammered with new containers.
* On a failed task it reads the full task log, the container config (`pct config` equivalent), the storage status, and the
  node journal (`GET /nodes/{node}/journal`: AppArmor denials, cgroup and kernel messages), and matches them with
  `packages/proxmox-client/src/lxc-diagnose.ts`: 19 known causes (including the new architecture mismatch; template
  missing/corrupt, wrong arch, storage full / unavailable / ownership, mount denied, idmap, AppArmor, cgroup, namespaces,
  features, network, devices, locked, no init, memory, pre-start hook). When only LXC's generic failure is present it says
  so ("Proxmox gave no specific reason"), lists the checks in order and the exact
  `lxc-start -n <id> -F -l DEBUG -o /tmp/lxc-<id>.log` command. It never invents a cause.
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

## A stuck sandbox cleanup (ERR-CTR-002) and the sandbox bridge (ERR-SEC-001, ERR-SEC-005)

* The engine refuses any environment `config` change while a sandbox cleanup lease is pending (after five failed destroys
  it retries every 30 minutes, forever). Setup now reports state `needs_repair` with `Cleanup stuck: CT <vmid> (<reason>)`
  read from `GET /api/environments/{id}/leases?status=pending_cleanup`, and the environment step sends only the changed
  keys (and no `config` when only the status differs). **No repair action is offered**: the engine has no route that
  resolves a lease, and none is in `services/epaperclip/src/engine-allow.ts`. Fix the Proxmox cause (a locked or missing
  CT; see the provider worker log), wait for the sweep (or restart the engine), then press Set up again.
* Setup refuses a bridge that carries the host's own address (an address and a gateway, or the address ePaperclip reaches
  Proxmox on) unless the request carries `acceptLanBridge: "agents can reach my LAN"`. The default is `vmbr1`. Moving the
  bridge revokes `EPCSandboxNetwork` on the old one for the sandbox user and token.

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

* simulated: unit tests of every matcher rule and redaction (`packages/proxmox-client/test/lxc-diagnose.test.ts`), including
  the confirmed arm64-on-amd64 create log; template-architecture selection and storage verdicts
  (`services/epaperclip/test/containers-arch.test.ts`); setup flow against the fake Proxmox for the owner's exact log,
  nesting probe, journal-driven AppArmor, corrupt-template retry, inactive/full storage, old Proxmox, grant gaps (absent,
  not inherited, ineffective), single-step repair, resume-without-repeating, storage change without a rebuild
  (`services/epaperclip/test/containers-diagnosis.test.ts`, `containers.test.ts`).
* real Proxmox (evidence gathered 2026-11-09): the failed `vzcreate:104` / `vzstart:104` task logs, the template catalog
  containing both `13.1-2_amd64` and `13.6-1_arm64`, and `drive2`'s xfs mount. This confirmed the cause above.
* not yet run on a real host: a **successful** template build end to end with the fixed architecture selection (container
  104 was already removed; the next setup run on the host is the proof), the journal and `/access/permissions?userid=`
  endpoint shapes, `PUT .../config delete=features`, and whether `keyctl=1` is accepted on this host's AppArmor profile.
