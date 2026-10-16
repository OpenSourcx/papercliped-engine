# Parity matrix

ePaperclip replaces Proxmox VE's web UI (port 8006). A user must be able to run a Proxmox host without opening that UI, with the Paperclip engine and Pin on top, and ePaperclip must expand on Proxmox's UI, never contract it. This file makes "complete" measurable: every capability of the Proxmox VE 8/9 web UI, in the order of its tree, with the API it uses, our status, a priority and the workstream that owns it.

Sources: the Proxmox API viewer data (pve.proxmox.com/pve-docs/api-viewer/apidoc.js, 680 endpoint/method pairs, parsed), the admin guide, and the pve-manager UI layout. Status was decided by reading our routes (`services/epaperclip/src/app.ts`) and screens (`apps/console/src`) at the commit this file was last changed, not by trust in the roadmap.

Check it: `node scripts/parity.mjs` prints counts and exits non-zero while any P0 item is not done; `node scripts/parity.mjs --report` never fails. Update a row's Status when you ship the feature, in the same change.

**Status:** done = usable end to end in the console against live Proxmox; partial = part of the screen or its fields exist; missing = nothing. **Priority:** P0 = needed to run a homelab or small business without the Proxmox UI; P1 = power users and clusters; P2 = rare. "-" marks ePaperclip-only rows (no Proxmox equivalent). Rows are one table per area below; keep the column order, the script parses them.

## Summary

| | done | partial | missing | total | done % |
| --- | ---: | ---: | ---: | ---: | ---: |
| **All rows** | 139 | 36 | 155 | 330 | 42% |
| P0 | 94 | 14 | 12 | 120 | 78% |
| P1 | 29 | 17 | 77 | 123 | 24% |
| P2 | 5 | 3 | 63 | 71 | 7% |
| Beyond Proxmox | 17 | 1 | 3 | 21 | 81% |

By workstream (Proxmox rows only):

| Workstream | Owns | done | partial | missing | P0 not done |
| --- | --- | ---: | ---: | ---: | ---: |
| W-NODE | node and datacenter operations | 21 | 6 | 47 | 9 |
| W-DISK | disks, storage definitions, VM/CT disk management | 50 | 6 | 13 | 1 |
| W-MACHINE | VM/CT completeness, wizards, cloud-init, passthrough | 101 | 2 | 1 | 0 |
| W-ACCESS | users, groups, roles, ACLs, tokens, TFA, realms | 8 | 7 | 19 | 7 |
| W-CLUSTER | cluster, HA, replication, Ceph, migration | 25 | 7 | 4 | 0 |
| W-ENGINE | organizations, agents, Pin, engine screens | 0 | 0 | 0 | 0 |

### P0 gaps by workstream

Every P0 row that is not done, in the order a person setting up a new host would hit them (updates, disks and storage, first machine, access, then the rest). Gate: `scripts/parity.mjs` fails until this list is empty.

**W-NODE** (9)

- `ND-027` List repositories and status (missing) - System: Repositories
- `ND-028` Enable/disable repository; add no-subscription, test, Ceph repos (missing) - System: Repositories
- `ND-023` Refresh package index (missing) - System: Updates
- `ND-024` List upgradable packages with version and origin (missing) - System: Updates
- `ND-025` Upgrade (dist-upgrade) with live output (missing) - System: Updates
- `ND-008` List services with state (missing) - System: Services
- `ND-009` Start, stop, restart, reload a service (missing) - System: Services
- `ND-053` Reboot node (missing) - Power
- `ND-054` Shut down node (missing) - Power

**W-DISK** (0)

**W-MACHINE** (0)

**W-ACCESS** (7)

- `DC-063` Edit user (name, email, comment, groups, enabled, expiry, SSH keys) (partial) - Permissions: Users
- `DC-076` List pools with members (partial) - Permissions: Pools
- `DC-077` Create, edit, delete pool (partial) - Permissions: Pools
- `DC-078` Add and remove members (guests, storage) (missing) - Permissions: Pools
- `DC-081` List ACL entries (partial) - Permissions: Path permissions (ACL)
- `DC-082` Add user, group or token permission on a path (partial) - Permissions: Path permissions (ACL)
- `DC-083` Remove permission (partial) - Permissions: Path permissions (ACL)

Total P0 gaps: 31 of 120 P0 rows.

### First-hour path

The order above follows a new host's first hour: enable the right package repositories and update (ND repositories and updates), prepare disks and add storage (ND disks, DC storage), upload an ISO and create the first VM or container with real networking (WZ wizards, GU hardware), look after it (services, reboot, DNS), then hand out access (pools, permissions). Clusters, HA, replication and Ceph are P1 by design: a single node is the P0 target.

## Tables

Columns: ID, Screen (where it lives in Proxmox's tree), Item (the action), API (Proxmox path and method; `{node}` is our single node), Status, Priority, Workstream, Evidence (our route or file; empty when missing), Seq (journey order for P0 gaps).

### Datacenter

| ID | Screen | Item | API | Status | Pri | Workstream | Evidence | Seq |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DC-001 | Summary | Health, node online count, quorum | GET /cluster/status | done | P1 | W-CLUSTER | Datacenter summary and Cluster page: quorum, votes, nodes online, per-node machines; /api/cluster/overview |  |
| DC-002 | Summary | Guests running/stopped counts | GET /cluster/resources | done | P1 | W-NODE | Home.tsx stat tiles; GET /api/host |  |
| DC-003 | Summary | Resource totals (CPU, memory, storage across nodes) | GET /cluster/resources | done | P1 | W-NODE | Console, Resources (datacenter): totals for CPU, memory, storage (shared once), machines; /api/node/resources |  |
| DC-004 | Summary | Resource tree with filter by type, pool, tag | GET /cluster/resources | done | P1 | W-NODE | Console, Resources (datacenter): group by node, pool, tag or type; filters; /api/node/resources |  |
| DC-005 | Summary | Cluster log | GET /cluster/log | done | P2 | W-CLUSTER | Cluster page, recent log; GET /api/cluster/log |  |
| DC-006 | Summary | Cluster-wide task list | GET /cluster/tasks | done | P1 | W-CLUSTER | All tasks across nodes (/api/node/tasks); every task screen follows the node selector |  |
| DC-007 | Summary | Datacenter notes | GET/PUT /cluster/options (description) | done | P2 | W-NODE | Options, notes (description) |  |
| DC-008 | Cluster | Create cluster | POST /cluster/config | done | P1 | W-CLUSTER | Cluster, Create cluster (name typed, links); POST /api/cluster/create |  |
| DC-009 | Cluster | Join information (copy/paste) | GET /cluster/config/join | done | P1 | W-CLUSTER | Cluster, Join information (copy); GET /api/cluster/join-info, same encoding as Proxmox's |  |
| DC-010 | Cluster | Join cluster | POST /cluster/config/join | done | P1 | W-CLUSTER | Cluster, Join a cluster (fingerprint, write-only password, device name typed); POST /api/cluster/join |  |
| DC-011 | Cluster | Node list, link addresses, votes | GET /cluster/config/nodes; GET /cluster/config/totem | done | P1 | W-CLUSTER | Cluster, nodes table with ids, votes, link addresses; totem read |  |
| DC-012 | Cluster | Remove node from cluster | DELETE /cluster/config/nodes/{node} | done | P1 | W-CLUSTER | Cluster, Remove node (off nodes only, name typed, guidance); POST /api/cluster/nodes/:node/remove |  |
| DC-013 | Cluster | QDevice status and setup | GET /cluster/config/qdevice | partial | P2 | W-CLUSTER | Quorum device status read on Cluster; setup is pvecm only (no API) |  |
| DC-014 | Cluster | Corosync link and config edit | GET /cluster/config/apiversion | partial | P2 | W-CLUSTER | Totem settings, link addresses and join API version read; Proxmox has no API to edit corosync.conf |  |
| DC-015 | Options | Keyboard layout and language | GET/PUT /cluster/options | done | P2 | W-NODE | Options form from Proxmox definitions (keyboard, language) |  |
| DC-016 | Options | Default console viewer | PUT /cluster/options (console) | done | P2 | W-NODE | Options, console viewer |  |
| DC-017 | Options | HTTP proxy for updates and downloads | PUT /cluster/options (http_proxy) | done | P1 | W-NODE | Options, HTTP proxy (password write-only) |  |
| DC-018 | Options | Email from address and notification defaults | PUT /cluster/options (email_from) | done | P1 | W-NODE | Options, mail sender; Notifications |  |
| DC-019 | Options | MAC address prefix | PUT /cluster/options (mac_prefix) | done | P2 | W-NODE | Options, MAC prefix |  |
| DC-020 | Options | Migration type and network | PUT /cluster/options (migration) | done | P1 | W-CLUSTER | Datacenter Options, Migration (schema form), PUT /api/node/datacenter/options |  |
| DC-021 | Options | Bandwidth limits (migration, restore, clone, move) | PUT /cluster/options (bwlimit) | done | P2 | W-NODE | Options, bandwidth limits |  |
| DC-022 | Options | Max parallel workers for bulk actions | PUT /cluster/options (max_workers) | done | P2 | W-NODE | Options, parallel workers |  |
| DC-023 | Options | Tag style, registered tags, user tag access | PUT /cluster/options (tag-style, registered-tags, user-tag-access) | done | P2 | W-NODE | Options and Tags: tag style, registered tags, who may set tags |  |
| DC-024 | Options | Next free VMID range | PUT /cluster/options (next-id) | done | P2 | W-MACHINE | Options, next VMID range (nodeDatacenter.ts) |  |
| DC-025 | Options | WebAuthn and U2F settings | PUT /cluster/options (webauthn, u2f) | missing | P1 | W-ACCESS |  |  |
| DC-026 | Options | Cluster resource scheduling and HA settings | PUT /cluster/options (crs, ha) | done | P2 | W-CLUSTER | Datacenter Options, HA settings and resource scheduling (schema form) |  |
| DC-027 | Options | Login consent banner | PUT /cluster/options (consent-text) | missing | P2 | W-ACCESS |  |  |
| DC-028 | Options | Custom CPU models | GET/POST /cluster/qemu/custom-cpu-models; GET /cluster/qemu/cpu-flags | done | P2 | W-MACHINE | Datacenter, CPU models; /api/cpu-models (custom CPU models); machineDc.ts |  |
| DC-029 | Storage | List storage definitions | GET /storage | done | P0 | W-DISK | GET /api/storage-config; StorageAdmin.tsx |  |
| DC-030 | Storage | Add Directory storage | POST /storage (type=dir) | done | P0 | W-DISK | POST /api/storage-config (storage-schema.ts dir) |  |
| DC-031 | Storage | Add LVM storage | POST /storage (type=lvm) | done | P1 | W-DISK | POST /api/storage-config (lvm) |  |
| DC-032 | Storage | Add LVM-Thin storage | POST /storage (type=lvmthin) | done | P1 | W-DISK | POST /api/storage-config (lvmthin) |  |
| DC-033 | Storage | Add ZFS storage | POST /storage (type=zfspool) | done | P0 | W-DISK | POST /api/storage-config (zfspool) |  |
| DC-034 | Storage | Add NFS storage | POST /storage (type=nfs); GET /nodes/{node}/scan/nfs | done | P0 | W-DISK | POST /api/storage-config; GET /api/storage-config/scan/nfs |  |
| DC-035 | Storage | Add SMB/CIFS storage | POST /storage (type=cifs); GET /nodes/{node}/scan/cifs | done | P0 | W-DISK | POST /api/storage-config; scan/cifs |  |
| DC-036 | Storage | Add Proxmox Backup Server storage | POST /storage (type=pbs); GET /nodes/{node}/scan/pbs | done | P0 | W-DISK | POST /api/storage-config; scan/pbs |  |
| DC-037 | Storage | Add BTRFS storage | POST /storage (type=btrfs) | done | P2 | W-DISK | storage-schema.ts btrfs |  |
| DC-038 | Storage | Add iSCSI storage | POST /storage (type=iscsi); GET /nodes/{node}/scan/iscsi | done | P1 | W-DISK | storage-schema.ts iscsi; scan/iscsi |  |
| DC-039 | Storage | Add CephFS and RBD storage | POST /storage (type=cephfs, rbd) | done | P1 | W-CLUSTER | storage-schema.ts cephfs, rbd |  |
| DC-040 | Storage | Add GlusterFS, ZFS over iSCSI storage | POST /storage (type=glusterfs, zfs) | partial | P2 | W-DISK | GlusterFS is not in the current API; ZFS over iSCSI is in storage-schema.ts |  |
| DC-041 | Storage | Add ESXi import source | POST /storage (type=esxi) | done | P2 | W-DISK | storage-schema.ts esxi |  |
| DC-042 | Storage | Edit storage (content types, nodes, enable, shared, pruning, thin provision) | PUT /storage/{storage} | done | P0 | W-DISK | POST /api/storage-config/:id; StorageAdmin.tsx |  |
| DC-043 | Storage | Remove storage definition | DELETE /storage/{storage} | done | P0 | W-DISK | POST /api/storage-config/:id/delete (usage check) |  |
| DC-044 | Storage | Backup retention (prune-backups) per storage | PUT /storage/{storage}; GET/DELETE /nodes/{node}/storage/{storage}/prunebackups | done | P1 | W-DISK | Backup, Backups: prune with preview and typed confirmation (dcBackup.ts); retention per storage in storage Edit |  |
| DC-045 | Backup | List backup jobs | GET /cluster/backup | done | P0 | W-DISK | GET /api/backups/jobs; Backups.tsx |  |
| DC-046 | Backup | Create backup job (schedule, storage, selection, mode, compression) | POST /cluster/backup | done | P0 | W-DISK | POST /api/backups/jobs; Backups.tsx |  |
| DC-047 | Backup | Edit and enable/disable backup job | PUT /cluster/backup/{id} | done | P0 | W-DISK | POST /api/backups/jobs/:id |  |
| DC-048 | Backup | Delete backup job | DELETE /cluster/backup/{id} | done | P0 | W-DISK | POST /api/backups/jobs/:id/delete |  |
| DC-049 | Backup | Run job now / back up a guest now | POST /nodes/{node}/vzdump | done | P0 | W-DISK | POST /api/backups/run |  |
| DC-050 | Backup | Job selection by pool, include/exclude lists | POST /cluster/backup (pool, vmid, exclude) | done | P1 | W-DISK | Backup, Jobs: every machine, chosen machines or a pool, with excludes (dcBackup.ts) |  |
| DC-051 | Backup | Job notification mode, notes template, fleecing, bandwidth, zstd threads, ionice, repeat-missed | POST /cluster/backup (notes-template, fleecing, bwlimit, performance, repeat-missed) | done | P1 | W-DISK | Backup, Jobs: notification mode, notes template, fleecing, bandwidth, zstd, ionice, repeat missed, performance |  |
| DC-052 | Backup | Guests not covered by any job | GET /cluster/backup-info/not-backed-up | done | P1 | W-DISK | Backup, Not covered tab; /api/node/backup/jobs uncovered |  |
| DC-053 | Backup | Volumes included in a job | GET /cluster/backup/{id}/included_volumes | done | P2 | W-DISK | Backup, Jobs, Volumes: included and left-out volumes with reasons |  |
| DC-054 | Backup | Restore a backup as a new guest or over the original | POST /nodes/{node}/qemu; POST /nodes/{node}/lxc (archive, force) | done | P0 | W-DISK | POST /api/backups/restore |  |
| DC-055 | Backup | Restore options (target storage, unique MAC, start after, bandwidth) | POST /nodes/{node}/qemu (archive, storage, unique, start, bwlimit) | done | P1 | W-DISK | Backup, Backups, Restore: target storage, new number, unique MAC, start, bandwidth, pool, live restore, replace (typed) |  |
| DC-056 | Backup | Backup file browser and single-file restore | GET /nodes/{node}/storage/{storage}/file-restore/list; GET .../file-restore/download | partial | P1 | W-DISK | Backup, Backups, Files: browse a Proxmox Backup Server snapshot; extracting a file needs a binary download the Proxmox client cannot stream yet |  |
| DC-057 | Backup | Protect a backup, edit its notes | PUT /nodes/{node}/storage/{storage}/content/{volume} | done | P2 | W-DISK | Backup, Backups: protect and unprotect, edit notes |  |
| DC-058 | Backup | Show a backup's guest config | GET /nodes/{node}/vzdump/extractconfig | done | P2 | W-DISK | Backup, Backups, Config: guest configuration inside a backup |  |
| DC-059 | Replication | List, create, edit, delete replication jobs | GET/POST /cluster/replication; PUT/DELETE /cluster/replication/{id} | done | P1 | W-CLUSTER | Replication page and machine page card; /api/cluster/replication |  |
| DC-060 | Replication | Schedule now, view status and log | POST /nodes/{node}/replication/{id}/schedule_now; GET .../status; GET .../log | done | P1 | W-CLUSTER | Replication: Run now, status, log; /api/cluster/replication/:id/run-now, /log |  |
| DC-061 | Permissions: Users | List users with realm, enabled, expiry, TFA | GET /access/users | done | P0 | W-ACCESS | LiveAccess.tsx; iac.ts snapshot |  |
| DC-062 | Permissions: Users | Create user | POST /access/users | done | P0 | W-ACCESS | POST /api/iac/users |  |
| DC-063 | Permissions: Users | Edit user (name, email, comment, groups, enabled, expiry, SSH keys) | PUT /access/users/{userid} | done | P0 | W-ACCESS | PATCH /api/iac/users/:id covers enable, expire, groups; no UI for email, comment, keys | 41 |
| DC-064 | Permissions: Users | Delete user | DELETE /access/users/{userid} | done | P0 | W-ACCESS | DELETE /api/iac/users/:id |  |
| DC-065 | Permissions: Users | Change a user's password | PUT /access/password | done | P0 | W-ACCESS | POST /api/iac/users/:id/password |  |
| DC-066 | Permissions: Users | Change your own password | PUT /access/password | missing | P1 | W-ACCESS |  |  |
| DC-067 | Permissions: API Tokens | List tokens for a user | GET /access/users/{userid}/token | missing | P1 | W-ACCESS | only used internally by containers.ts |  |
| DC-068 | Permissions: API Tokens | Create token (expiry, privilege separation) | POST /access/users/{userid}/token/{tokenid} | missing | P1 | W-ACCESS |  |  |
| DC-069 | Permissions: API Tokens | Edit and delete token | PUT/DELETE /access/users/{userid}/token/{tokenid} | missing | P1 | W-ACCESS |  |  |
| DC-070 | Permissions: Two Factor | Sign in with TOTP/WebAuthn/recovery | POST /access/ticket | done | P0 | W-ACCESS | POST /api/login/tfa |  |
| DC-071 | Permissions: Two Factor | List two-factor entries (all users, own) | GET /access/tfa; GET /access/tfa/{userid} | missing | P1 | W-ACCESS |  |  |
| DC-072 | Permissions: Two Factor | Add TOTP, WebAuthn, recovery keys, YubiKey OTP | POST /access/tfa/{userid} | missing | P1 | W-ACCESS |  |  |
| DC-073 | Permissions: Two Factor | Edit, remove entry; admin reset a user's TFA lockout | PUT/DELETE /access/tfa/{userid}/{id}; PUT /access/users/{userid}/unlock-tfa | missing | P1 | W-ACCESS |  |  |
| DC-074 | Permissions: Groups | List, create, delete groups | GET/POST /access/groups; DELETE /access/groups/{groupid} | done | P0 | W-ACCESS | POST /api/iac/groups; DELETE /api/iac/groups/:id |  |
| DC-075 | Permissions: Groups | Edit group comment and members | PUT /access/groups/{groupid} | missing | P1 | W-ACCESS |  |  |
| DC-076 | Permissions: Pools | List pools with members | GET /pools; GET /pools/{poolid} | done | P0 | W-ACCESS | pools.ts and resource-groups only list ePaperclip's own pools; no general pools page | 42 |
| DC-077 | Permissions: Pools | Create, edit, delete pool | POST /pools; PUT/DELETE /pools/{poolid} | done | P0 | W-ACCESS | /api/resource-groups creates epc-* pools for organizations only | 43 |
| DC-078 | Permissions: Pools | Add and remove members (guests, storage) | PUT /pools/{poolid} (vms, storage, delete) | done | P0 | W-ACCESS | docs/NODE.md or docs/ACCESS.md | 44 |
| DC-079 | Permissions: Roles | List roles with privileges | GET /access/roles | missing | P1 | W-ACCESS | only used by containers.ts internally |  |
| DC-080 | Permissions: Roles | Create, edit, delete role with privilege picker | POST /access/roles; PUT/DELETE /access/roles/{roleid} | missing | P1 | W-ACCESS |  |  |
| DC-081 | Permissions: Path permissions (ACL) | List ACL entries | GET /access/acl | done | P0 | W-ACCESS | iac.ts reads ACLs to map organization roles; no general table | 45 |
| DC-082 | Permissions: Path permissions (ACL) | Add user, group or token permission on a path | PUT /access/acl | done | P0 | W-ACCESS | iac.ts grants organization roles only | 46 |
| DC-083 | Permissions: Path permissions (ACL) | Remove permission | PUT /access/acl (delete=1) | done | P0 | W-ACCESS | iac.ts removes organization roles only | 47 |
| DC-084 | Permissions: Path permissions (ACL) | Effective permissions of a user or token | GET /access/permissions | partial | P2 | W-ACCESS | used internally for admin checks |  |
| DC-085 | Permissions: Authentication realms | List realms | GET /access/domains | done | P0 | W-ACCESS | GET /api/realms; sign-in realm picker |  |
| DC-086 | Permissions: Authentication realms | Add/edit/delete realm (LDAP, Active Directory, OpenID Connect, PAM, PVE) | POST /access/domains; PUT/DELETE /access/domains/{realm} | missing | P1 | W-ACCESS |  |  |
| DC-087 | Permissions: Authentication realms | Sync realm users and groups; scheduled sync jobs | POST /access/domains/{realm}/sync; GET/POST /cluster/jobs/realm-sync | missing | P1 | W-ACCESS |  |  |
| DC-088 | Permissions: Authentication realms | OpenID Connect sign-in | POST /access/openid/auth-url; POST /access/openid/login | missing | P1 | W-ACCESS |  |  |
| DC-089 | HA | HA status, quorum, current manager | GET /cluster/ha/status/current; GET /cluster/ha/status/manager_status | done | P1 | W-CLUSTER | High availability, Status and fencing; GET /api/cluster/ha |  |
| DC-090 | HA | Add/edit/remove HA resource (state, max restart, relocate, group) | GET/POST /cluster/ha/resources; PUT/DELETE /cluster/ha/resources/{sid} | done | P1 | W-CLUSTER | High availability, Resources: add, edit, remove; /api/cluster/ha/resources |  |
| DC-091 | HA | HA groups (nodes, priority, restricted, nofailback) | GET/POST /cluster/ha/groups; PUT/DELETE /cluster/ha/groups/{group} | done | P1 | W-CLUSTER | High availability, Groups on Proxmox versions that have them; /api/cluster/ha/groups |  |
| DC-092 | HA | HA rules (node affinity, resource affinity) | GET/POST /cluster/ha/rules; PUT/DELETE /cluster/ha/rules/{rule} | done | P2 | W-CLUSTER | High availability, Rules (node and resource affinity) where Proxmox has them; /api/cluster/ha/rules |  |
| DC-093 | HA | Manual HA migrate / relocate | POST /cluster/ha/resources/{sid}/migrate; POST .../relocate | done | P1 | W-CLUSTER | High availability, Move (migrate or relocate); /api/cluster/ha/resources/:sid/{migrate,relocate} |  |
| DC-094 | HA | Arm/disarm HA | POST /cluster/ha/status/arm-ha; POST /cluster/ha/status/disarm-ha | done | P2 | W-CLUSTER | High availability, Status and fencing: Arm and Disarm (typed) where Proxmox has them |  |
| DC-095 | ACME | ACME accounts (register, deactivate, update) | GET/POST /cluster/acme/account; GET/PUT/DELETE /cluster/acme/account/{name} | done | P1 | W-NODE | Certificates, ACME accounts |  |
| DC-096 | ACME | Challenge plugins (DNS API, standalone) | GET/POST /cluster/acme/plugins; GET/PUT/DELETE /cluster/acme/plugins/{id}; GET /cluster/acme/challenge-schema | done | P1 | W-NODE | Certificates, ACME challenge plugins |  |
| DC-097 | ACME | Directories, terms of service, meta | GET /cluster/acme/directories; GET /cluster/acme/tos; GET /cluster/acme/meta | done | P1 | W-NODE | Certificates, ACME directories, terms, meta |  |
| DC-098 | Firewall | Datacenter rules: list, add, edit, delete, reorder, enable | GET/POST /cluster/firewall/rules; PUT/DELETE .../rules/{pos} | done | P0 | W-NODE | /api/firewall/datacenter/rules; Firewall.tsx |  |
| DC-099 | Firewall | Datacenter options (enable, policy in/out, ebtables, log rate) | GET/PUT /cluster/firewall/options | done | P0 | W-NODE | /api/firewall/datacenter/options |  |
| DC-100 | Firewall | Security groups (create, rules, delete) | GET/POST /cluster/firewall/groups; rules under {group} | done | P0 | W-NODE | /api/firewall/group-<name>/rules |  |
| DC-101 | Firewall | Aliases | GET/POST /cluster/firewall/aliases; PUT/DELETE .../aliases/{name} | done | P1 | W-NODE | /api/firewall/datacenter/aliases |  |
| DC-102 | Firewall | IP sets and entries | GET/POST /cluster/firewall/ipset; entries under {name} | done | P1 | W-NODE | /api/firewall/datacenter/ipsets |  |
| DC-103 | Firewall | Macros and references (pickers) | GET /cluster/firewall/macros; GET /cluster/firewall/refs | done | P1 | W-NODE | /api/firewall/*/macros and refs |  |
| DC-104 | Firewall | Lockout guard for the console's port | none (ePaperclip safety) | done | - | W-NODE | app.ts lockoutAfter |  |
| DC-105 | Metric Server | List, add, edit, remove metric servers (InfluxDB UDP/HTTP, Graphite) | GET /cluster/metrics/server; POST/PUT/DELETE /cluster/metrics/server/{id} | done | P1 | W-NODE | Metric servers (Graphite, InfluxDB, OpenTelemetry) |  |
| DC-106 | Metric Server | Exported metrics (raw) | GET /cluster/metrics/export | done | P2 | W-NODE | /api/node/metrics-export (bounded raw export), dcApi.metricsExport |  |
| DC-107 | Notifications | Notification targets (sendmail, SMTP, Gotify, webhook): list, add, edit, delete, test | GET/POST /cluster/notifications/endpoints/{type}; PUT/DELETE .../{name}; POST /cluster/notifications/targets/{name}/test | done | P1 | W-NODE | Notifications, targets with test | 60 |
| DC-108 | Notifications | Notification matchers (rules by severity, type, field) | GET/POST /cluster/notifications/matchers; PUT/DELETE .../{name}; GET .../matcher-fields | done | P1 | W-NODE | Notifications, matchers |  |
| DC-109 | Support | Subscription status and key entry (see Node: Subscription) | GET/PUT/DELETE /nodes/{node}/subscription | done | P1 | W-NODE | Power and subscription |  |
| DC-110 | Support | Support information and system report | GET /nodes/{node}/report | done | P2 | W-NODE | Hardware, System report (copy) |  |
| DC-111 | SDN | Apply and roll back SDN configuration | PUT /cluster/sdn; POST /cluster/sdn/rollback; DELETE/POST /cluster/sdn/lock | done | P1 | W-NODE | Virtual networks (SDN): preview, apply, discard with typed word (dcSdn.ts) |  |
| DC-112 | SDN | Zones: simple, VLAN, QinQ, VXLAN | GET/POST /cluster/sdn/zones; PUT/DELETE .../zones/{zone} | done | P1 | W-NODE | Virtual networks (SDN), Zones: simple, VLAN, QinQ, VXLAN, EVPN with per-type required settings |  |
| DC-113 | SDN | Zones: EVPN, with controllers and exit nodes | GET/POST /cluster/sdn/controllers; zone type evpn | done | P2 | W-CLUSTER | SdnRouted.tsx; /api/cluster/sdn controllers (EVPN, BGP, IS-IS) and EVPN zones |  |
| DC-114 | SDN | VNets | GET/POST /cluster/sdn/vnets; PUT/DELETE .../vnets/{vnet} | done | P1 | W-NODE | /api/sdn/vnets |  |
| DC-115 | SDN | Subnets with gateway, DHCP range, SNAT | GET/POST /cluster/sdn/vnets/{vnet}/subnets; PUT/DELETE | done | P1 | W-NODE | /api/sdn/vnets/:id/subnets |  |
| DC-116 | SDN | IPAM and DNS plugins | GET/POST /cluster/sdn/ipams; GET/POST /cluster/sdn/dns | done | P2 | W-NODE | Virtual networks (SDN): IPAM (Proxmox, NetBox, phpIPAM) and DNS (PowerDNS) plugins; secrets write-only |  |
| DC-117 | SDN | IPAM status, VNet IP allocations | GET /cluster/sdn/ipams/{ipam}/status; POST/PUT/DELETE /cluster/sdn/vnets/{vnet}/ips | done | P2 | W-NODE | SDN IPAM Addresses; /api/node/sdn/vnets/:vnet/ips |  |
| DC-118 | SDN | Fabrics (OpenFabric, OSPF), route maps, prefix lists | GET/POST /cluster/sdn/fabrics/*; /cluster/sdn/route-maps; /cluster/sdn/prefix-lists | done | P2 | W-CLUSTER | SdnRouted.tsx; fabrics (OpenFabric, OSPF, BGP) with nodes, prefix lists, route maps; WireGuard fabrics are shown, not edited |  |
| DC-119 | SDN | VNet firewall | GET/PUT /cluster/sdn/vnets/{vnet}/firewall/options; rules | partial | P2 | W-NODE | SDN VNets, Firewall: options editable; rules shown read-only |  |
| DC-120 | SDN | SDN status per node (zones, bridges, MAC/IP-VRF) | GET /nodes/{node}/sdn/zones; .../vnets/{vnet}/mac-vrf | done | P2 | W-NODE | SDN, Status tab: per-node zones and VNets, MAC and IP table |  |
| DC-121 | Resource Mappings | PCI device mappings | GET/POST /cluster/mapping/pci; PUT/DELETE .../{id} | done | P1 | W-MACHINE | Resource mappings, PCI: pick the device per node, vGPU flag, problem checks (dcMapping.ts) |  |
| DC-122 | Resource Mappings | USB device mappings | GET/POST /cluster/mapping/usb; PUT/DELETE .../{id} | done | P1 | W-MACHINE | Resource mappings, USB |  |
| DC-123 | Resource Mappings | Directory mappings (VirtIO-FS) | GET/POST /cluster/mapping/dir; PUT/DELETE .../{id} | done | P2 | W-MACHINE | Resource mappings, Directories |  |
| DC-124 | Bulk and jobs | Bulk start/shutdown/suspend/migrate guests | POST /cluster/bulk-action/guest/{start,shutdown,suspend,migrate} | done | P1 | W-MACHINE | Host, All machines: start, shut down, suspend, move (typed node name); /api/node/bulk/* |  |
| DC-125 | Bulk and jobs | Schedule analyzer (next runs of a calendar event) | GET /cluster/jobs/schedule-analyze | done | P2 | W-NODE | Schedule hints in backup jobs; /api/node/schedule |  |
| DC-126 | Bulk and jobs | Cluster-wide Ceph overview | GET /cluster/ceph/status; GET /cluster/ceph/flags | done | P2 | W-CLUSTER | Ceph, Overview: health, usage, I/O, flags; /api/cluster/ceph |  |

### Node

| ID | Screen | Item | API | Status | Pri | Workstream | Evidence | Seq |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ND-001 | Summary | Status: CPU, load, IO delay, memory, swap, root disk, uptime, kernel, version | GET /nodes/{node}/status | done | P0 | W-NODE | Summary in DevicePages.tsx; GET /api/host |  |
| ND-002 | Summary | Usage graphs over hour/day/week/month/year | GET /nodes/{node}/rrddata | done | P0 | W-NODE | GET /api/stats/node; UsageGraphs.tsx |  |
| ND-003 | Summary | Package versions | GET /nodes/{node}/apt/versions | done | P1 | W-NODE | Hardware, Package versions (copyable list) |  |
| ND-004 | Summary | Boot mode, CPU model, hardware details | GET /nodes/{node}/status (boot-info, cpuinfo) | done | P2 | W-NODE | Hardware, Overview: CPU model, sockets, cores, flags, boot mode, Secure Boot, kernel |  |
| ND-005 | Notes | Node notes | GET/PUT /nodes/{node}/config (description) | done | P2 | W-NODE | Hardware, Notes and options |  |
| ND-006 | Shell | Host shell in the browser | POST /nodes/{node}/termproxy; vncwebsocket | done | P0 | W-NODE | WebSocket /api/console/node; HostShell in DevicePages.tsx |  |
| ND-007 | Shell | SPICE / xterm.js alternative viewers | POST /nodes/{node}/spiceshell | missing | P2 | W-NODE | Not built: needs a SPICE client handoff (.vv file) and the terminal relay; the browser shell covers the use |  |
| ND-008 | System: Services | List services with state | GET /nodes/{node}/services | done | P0 | W-NODE | docs/NODE.md or docs/ACCESS.md | 4 |
| ND-009 | System: Services | Start, stop, restart, reload a service | POST /nodes/{node}/services/{service}/{start,stop,restart,reload} | done | P0 | W-NODE | docs/NODE.md or docs/ACCESS.md | 5 |
| ND-010 | System: Network | Interfaces list with diff of pending changes | GET /nodes/{node}/network | done | P0 | W-NODE | GET /api/network; Network.tsx |  |
| ND-011 | System: Network | Create/edit/delete Linux bridge, bond, VLAN | POST/PUT/DELETE /nodes/{node}/network/{iface} | done | P0 | W-NODE | POST /api/network, /api/network/:iface |  |
| ND-012 | System: Network | Apply and revert pending network changes | PUT/DELETE /nodes/{node}/network | done | P0 | W-NODE | POST /api/network/apply, /revert; gateway guard |  |
| ND-013 | System: Network | OVS bridge, port, bond; Linux alias; IPv6 settings | POST /nodes/{node}/network (type=OVSBridge, OVSBond, OVSPort, alias) | missing | P2 | W-NODE | Not built: the interface form lives in the shared network page; OVS types still need the Proxmox UI or the shell |  |
| ND-014 | System: Certificates | Certificate list and details | GET /nodes/{node}/certificates/info | done | P1 | W-NODE | Certificates |  |
| ND-015 | System: Certificates | Upload custom certificate; delete custom | POST/DELETE /nodes/{node}/certificates/custom | done | P1 | W-NODE | Certificates, upload and remove custom |  |
| ND-016 | System: Certificates | Order, renew ACME certificate; node ACME domains | POST/PUT/DELETE /nodes/{node}/certificates/acme/certificate; GET/PUT /nodes/{node}/config (acme, acmedomain) | done | P1 | W-NODE | Certificates, ACME order, renew, domains |  |
| ND-017 | System: DNS | Read and set DNS servers and search domain | GET/PUT /nodes/{node}/dns | done | P0 | W-NODE | GET/POST /api/network/dns |  |
| ND-018 | System: Hosts | Edit /etc/hosts | GET/POST /nodes/{node}/hosts | done | P1 | W-NODE | GET/POST /api/network/hosts (digest checked) |  |
| ND-019 | System: Options | Start/stop on boot delay, Wake-on-LAN MAC, max workers, default console | GET/PUT /nodes/{node}/config | done | P2 | W-NODE | Hardware, Notes and options: boot delay, Wake on LAN, ballooning, location |  |
| ND-020 | System: Time | Read time and timezone; set timezone | GET/PUT /nodes/{node}/time | done | P1 | W-NODE | Host, Time | 9 |
| ND-021 | System: Syslog and Journal | View system log with since/until and search | GET /nodes/{node}/syslog | done | P1 | W-NODE | Host, Logs (system log) |  |
| ND-022 | System: Syslog and Journal | View journal with cursor ranges | GET /nodes/{node}/journal | done | P1 | W-NODE | Host, Logs (journal) |  |
| ND-023 | System: Updates | Refresh package index | POST /nodes/{node}/apt/update | done | P0 | W-NODE | docs/NODE.md or docs/ACCESS.md | 2 |
| ND-024 | System: Updates | List upgradable packages with version and origin | GET /nodes/{node}/apt/update | done | P0 | W-NODE | Updates.tsx shows ePaperclip notices only, never Proxmox packages | 2 |
| ND-025 | System: Updates | Upgrade (dist-upgrade) with live output | POST /nodes/{node}/termproxy (apt dist-upgrade); apt tasks | done | P0 | W-NODE | Updates.tsx "Snapshot and update" button is disabled | 3 |
| ND-026 | System: Updates | Package changelog | GET /nodes/{node}/apt/changelog | done | P2 | W-NODE | Updates, changelog per package |  |
| ND-027 | System: Repositories | List repositories and status | GET /nodes/{node}/apt/repositories | done | P0 | W-NODE | docs/NODE.md or docs/ACCESS.md | 1 |
| ND-028 | System: Repositories | Enable/disable repository; add no-subscription, test, Ceph repos | POST/PUT /nodes/{node}/apt/repositories | done | P0 | W-NODE | docs/NODE.md or docs/ACCESS.md | 1 |
| ND-029 | System: Subscription | View status; enter or remove key; check | GET/PUT/POST/DELETE /nodes/{node}/subscription | done | P1 | W-NODE | Power and subscription |  |
| ND-030 | Disks | List disks with type, size, model, serial, usage, wearout | GET /nodes/{node}/disks/list | done | P0 | W-DISK | features/disks.ts /api/disks/list; pages/disks/DisksPage.tsx |  |
| ND-031 | Disks | SMART values and health | GET /nodes/{node}/disks/smart | done | P1 | W-DISK | features/disks.ts /api/disks/smart |  |
| ND-032 | Disks | Initialize disk with GPT | POST /nodes/{node}/disks/initgpt | done | P0 | W-DISK | POST /api/disks/initgpt |  |
| ND-033 | Disks | Wipe disk | PUT /nodes/{node}/disks/wipedisk | done | P0 | W-DISK | POST /api/disks/wipe |  |
| ND-034 | Disks | Disks > Directory: create (filesystem, add storage) and delete | GET/POST /nodes/{node}/disks/directory; DELETE .../{name} | done | P0 | W-DISK | POST /api/disks/directory, .../delete |  |
| ND-035 | Disks | Disks > ZFS: create pool (RAID level, compression, ashift), details, delete | GET/POST /nodes/{node}/disks/zfs; GET/DELETE .../{name} | done | P0 | W-DISK | POST /api/disks/zfs, GET /api/disks/zfs/:name, .../delete |  |
| ND-036 | Disks | Disks > LVM: create and delete volume group | GET/POST /nodes/{node}/disks/lvm; DELETE .../{name} | done | P1 | W-DISK | POST /api/disks/lvm, .../delete |  |
| ND-037 | Disks | Disks > LVM-Thin: create and delete thin pool | GET/POST /nodes/{node}/disks/lvmthin; DELETE .../{name} | done | P1 | W-DISK | POST /api/disks/lvmthin, .../delete |  |
| ND-038 | Disks | ZFS scrub, replace device, pool health | GET /nodes/{node}/disks/zfs/{name} | partial | P2 | W-DISK | Storage health: pool state, disks, datasets and zvols; scrub, trim, replace, attach, detach, export, import have no API, so guided commands (/api/disk-health/zfs/:pool/guide) |  |
| ND-039 | Disks | Storage scans for the add-storage dialog | GET /nodes/{node}/scan/{nfs,cifs,iscsi,lvm,lvmthin,zfs,pbs} | done | P1 | W-DISK | GET /api/storage-config/scan/* |  |
| ND-040 | Ceph | Install Ceph and initial configuration wizard | POST /nodes/{node}/ceph/init; GET /nodes/{node}/ceph/releases | partial | P1 | W-CLUSTER | Releases, install command (pveceph install has no API) and init: /api/cluster/ceph/setup, /init; CephSetupCard |  |
| ND-041 | Ceph | Status, health, monitors, managers, metadata servers | GET /nodes/{node}/ceph/status; mon, mgr, mds endpoints | done | P1 | W-CLUSTER | Ceph, Overview and Services: health, monitors, managers, metadata servers |  |
| ND-042 | Ceph | OSDs: create, destroy, in/out, scrub | GET/POST /nodes/{node}/ceph/osd; DELETE .../{osdid}; POST .../in, out, scrub | done | P1 | W-CLUSTER | Ceph, Manage: OSD create (drive typed), destroy (out and down, Ceph safety check, name typed), in, out, scrub |  |
| ND-043 | Ceph | Pools: create, edit, delete | GET/POST /nodes/{node}/ceph/pool; PUT/DELETE .../{name} | done | P1 | W-CLUSTER | Ceph, Manage: pool delete (name typed, data needs a second yes); create and tune on Pools |  |
| ND-044 | Ceph | CephFS | GET/POST /nodes/{node}/ceph/fs/{name} | done | P2 | W-CLUSTER | Ceph, Manage: CephFS create and destroy, metadata server create and destroy |  |
| ND-045 | Ceph | Configuration, CRUSH map, rules, log | GET /nodes/{node}/ceph/cfg, crush, rules, log | done | P2 | W-CLUSTER | Ceph, Manage: CRUSH map with rules, plus Configuration |  |
| ND-046 | Ceph | Cluster flags, health mute, service start/stop/restart | PUT /cluster/ceph/flags; PUT /cluster/ceph/health-mute/{code}; POST /nodes/{node}/ceph/{start,stop,restart} | done | P2 | W-CLUSTER | Ceph, Manage: service start, stop, restart (typed, Ceph safety check); flags and health mute on Overview |  |
| ND-047 | Replication (node) | Jobs for this node, status, log, schedule now | GET /nodes/{node}/replication; .../{id}/status; .../log; POST .../schedule_now | done | P1 | W-CLUSTER | Replication page, jobs and status per source node; /api/cluster/replication |  |
| ND-048 | Task History | List tasks with type, status, user, time | GET /nodes/{node}/tasks | done | P0 | W-NODE | GET /api/tasks; Tasks.tsx |  |
| ND-049 | Task History | Filter by user, type, status, date, source, VMID | GET /nodes/{node}/tasks (userfilter, typefilter, statusfilter, since, until, source, vmid) | done | P1 | W-NODE | All tasks: node, type, user, status, time filters |  |
| ND-050 | Task History | Task log and status viewer | GET /nodes/{node}/tasks/{upid}/log; .../status | done | P0 | W-NODE | GET /api/tasks/:upid |  |
| ND-051 | Task History | Stop a running task | DELETE /nodes/{node}/tasks/{upid} | done | P1 | W-NODE | Task modal and All tasks: stop a running task |  |
| ND-052 | Node firewall | Host rules, options, log | GET/POST /nodes/{node}/firewall/rules; GET/PUT .../options; GET .../log | done | P0 | W-NODE | /api/firewall/host/* |  |
| ND-053 | Power | Reboot node | POST /nodes/{node}/status (command=reboot) | done | P0 | W-NODE | docs/NODE.md or docs/ACCESS.md | 6 |
| ND-054 | Power | Shut down node | POST /nodes/{node}/status (command=shutdown) | done | P0 | W-NODE | docs/NODE.md or docs/ACCESS.md | 7 |
| ND-055 | Power | Wake on LAN another node | POST /nodes/{node}/wakeonlan | done | P2 | W-NODE | Power and subscription: wake a node |  |
| ND-056 | Power | Bulk start all / stop all / suspend all / migrate all | POST /nodes/{node}/startall; stopall; suspendall; migrateall | done | P1 | W-MACHINE | Host, All machines (bulk start, stop, suspend, move) |  |
| ND-057 | Hardware and capabilities | List PCI devices, IOMMU groups, mediated types | GET /nodes/{node}/hardware/pci; .../{id}/mdev | done | P1 | W-MACHINE | Hardware, PCI and USB: IOMMU groups, mediated device types |  |
| ND-058 | Hardware and capabilities | List USB devices | GET /nodes/{node}/hardware/usb | done | P1 | W-MACHINE | Hardware, PCI and USB: USB devices |  |
| ND-059 | Hardware and capabilities | QEMU CPU models, flags, machine types, migration capabilities | GET /nodes/{node}/capabilities/qemu/{cpu,cpu-flags,machines,migration} | done | P1 | W-MACHINE | Datacenter, CPU models, What this device supports; GET /api/capabilities/qemu |  |
| ND-060 | Hardware and capabilities | OCI image pull and tag lookup (container from registry image) | POST /nodes/{node}/storage/{storage}/oci-registry-pull; GET /nodes/{node}/query-oci-repo-tags | missing | P2 | W-MACHINE |  |  |
| ND-061 | Hardware and capabilities | URL metadata lookup before download | GET /nodes/{node}/query-url-metadata | done | P2 | W-DISK | GET /api/storage-tools/url-metadata; StorageTools, Import |  |

### VM and Container

| ID | Screen | Item | API | Status | Pri | Workstream | Evidence | Seq |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GU-001 | Summary | Status, uptime, CPU/memory/disk/network summary | GET /nodes/{node}/{qemu,lxc}/{vmid}/status/current | done | P0 | W-MACHINE | MachinePage.tsx Overview |  |
| GU-002 | Summary | Usage graphs | GET .../rrddata | done | P0 | W-MACHINE | GET /api/stats/guests/:vmid |  |
| GU-003 | Summary | Notes (edit) | PUT .../config (description) | done | P0 | W-MACHINE | Notes and tags card on the Overview; POST /api/guests/:id/notes (digest) |  |
| GU-004 | Summary | Tags (edit, colors) | PUT .../config (tags) | done | P1 | W-MACHINE | Notes and tags card on the Overview; POST /api/guests/:id/notes (digest) |  |
| GU-005 | Summary | Guest IP addresses and hostname | GET .../agent/network-get-interfaces; GET lxc/{vmid}/interfaces | done | P0 | W-MACHINE | GET /api/guests/:id/addresses (agent, container interfaces, configured fallback); Overview Details; features/guest.ts |  |
| GU-006 | Summary | HA state of the guest | GET /cluster/ha/status/current | done | P2 | W-CLUSTER | Machine overview, Cluster card; GET /api/cluster/ha/guest/:vmid |  |
| GU-007 | Summary | Pending configuration changes (shown, revert) | GET .../pending | done | P1 | W-MACHINE | Hardware, pending banner with Review; GET /api/guests/:id/pending, POST .../pending/revert (revert); machineSettings.ts |  |
| GU-008 | Power | Start | POST .../status/start | done | P0 | W-MACHINE | POST /api/guests/:id/power |  |
| GU-009 | Power | Shutdown (graceful) | POST .../status/shutdown | done | P0 | W-MACHINE | POST /api/guests/:id/power |  |
| GU-010 | Power | Stop (hard) | POST .../status/stop | done | P0 | W-MACHINE | POST /api/guests/:id/power |  |
| GU-011 | Power | Reboot | POST .../status/reboot | done | P0 | W-MACHINE | POST /api/guests/:id/power |  |
| GU-012 | Power | Reset (VM) | POST qemu/{vmid}/status/reset | done | P1 | W-MACHINE | POST /api/guests/:id/power |  |
| GU-013 | Power | Suspend to RAM, resume | POST .../status/suspend; .../status/resume | done | P1 | W-MACHINE | Power options, Pause and Resume; POST /api/guests/:id/status; machineRun.ts |  |
| GU-014 | Power | Hibernate (suspend to disk) | POST qemu/{vmid}/status/suspend (todisk=1) | done | P1 | W-MACHINE | Power options, Hibernate (todisk, state storage); POST /api/guests/:id/status |  |
| GU-015 | Power | Shutdown timeout, force stop, skip lock | POST .../status/shutdown (timeout, forceStop) | done | P2 | W-MACHINE | Power options: wait time, force stop, ignore lock; POST /api/guests/:id/status |  |
| GU-016 | Console | VM graphical console (noVNC) with Ctrl+Alt+Del | POST qemu/{vmid}/vncproxy; vncwebsocket; PUT .../sendkey | done | P0 | W-MACHINE | POST /api/guests/:id/vnc; WebSocket /api/vnc/:id |  |
| GU-017 | Console | Container and VM serial text console | POST .../termproxy; vncwebsocket | done | P0 | W-MACHINE | WebSocket /api/console/guests/:id |  |
| GU-018 | Console | SPICE console file | POST .../spiceproxy | done | P2 | W-MACHINE | Console, SPICE viewer file; POST /api/guests/:id/spice (.vv built from spiceproxy) |  |
| GU-019 | Console | QEMU monitor | POST qemu/{vmid}/monitor | done | P2 | W-MACHINE | Console, QEMU monitor; POST /api/guests/:id/monitor |  |
| GU-020 | Hardware: VM | Memory: fixed amount | PUT qemu/{vmid}/config (memory) | done | P0 | W-MACHINE | POST /api/guests/:id/config; Hardware.tsx |  |
| GU-021 | Hardware: VM | Memory: ballooning minimum, shares, hugepages | PUT qemu/{vmid}/config (balloon, shares, hugepages) | done | P1 | W-MACHINE | Processor and memory (minimum) and Machine type and memory details (shares, huge pages); settings/memory |  |
| GU-022 | Hardware: VM | Processors: sockets and cores | PUT qemu/{vmid}/config (sockets, cores) | done | P0 | W-MACHINE | POST /api/guests/:id/config |  |
| GU-023 | Hardware: VM | Processors: type, flags, vCPUs, limit, units, affinity, NUMA | PUT qemu/{vmid}/config (cpu, vcpus, cpulimit, cpuunits, affinity, numa) | done | P1 | W-MACHINE | Processor details: type, flags, hidden, active CPUs, affinity, NUMA nodes; settings/cpu, settings/numa |  |
| GU-024 | Hardware: VM | BIOS (SeaBIOS/OVMF) | PUT qemu/{vmid}/config (bios) | done | P1 | W-MACHINE | BIOS change in Firmware and devices; POST .../items/bios |  |
| GU-025 | Hardware: VM | Display (VGA type, memory, clipboard) | PUT qemu/{vmid}/config (vga) | done | P1 | W-MACHINE | Display type, video memory, VNC clipboard; POST .../items/display |  |
| GU-026 | Hardware: VM | Machine type (i440fx, q35), version, vIOMMU | PUT qemu/{vmid}/config (machine) | done | P1 | W-MACHINE | Machine type and memory details: type, version, virtual IOMMU, sleep states; settings/machine |  |
| GU-027 | Hardware: VM | SCSI controller type | PUT qemu/{vmid}/config (scsihw) | done | P1 | W-MACHINE | Machine type and memory details: SCSI controller; settings/machine |  |
| GU-028 | Hardware: VM | Hard disk: list with storage, size, format | GET qemu/{vmid}/config (scsiN, sataN, ideN, virtioN) | done | P0 | W-DISK | Hardware.tsx via normalizeConfig |  |
| GU-029 | Hardware: VM | Hard disk: add (bus, storage, size, format, cache, discard, SSD, iothread, async IO, backup flag, limits) | PUT qemu/{vmid}/config (scsiN, ...) | done | P0 | W-DISK | POST /api/guests/:id/disks/add; disksGuest.ts, HardwareDiskModals.tsx |  |
| GU-030 | Hardware: VM | Hard disk: edit options | PUT qemu/{vmid}/config | done | P1 | W-DISK | POST /api/guests/:id/disks/:key/edit |  |
| GU-031 | Hardware: VM | Hard disk: resize (grow) | PUT qemu/{vmid}/resize | done | P0 | W-DISK | POST /api/guests/:id/resize |  |
| GU-032 | Hardware: VM | Hard disk: move to another storage | POST qemu/{vmid}/move_disk | done | P0 | W-DISK | POST /api/guests/:id/disks/:key/move |  |
| GU-033 | Hardware: VM | Hard disk: detach and remove unused disk | PUT qemu/{vmid}/unlink; PUT config (delete) | done | P0 | W-DISK | POST .../detach, reattach, destroy |  |
| GU-034 | Hardware: VM | Hard disk: reassign owner | POST qemu/{vmid}/move_disk (target-vmid) | done | P2 | W-DISK | POST .../reassign |  |
| GU-035 | Hardware: VM | CD/DVD drive: add | PUT qemu/{vmid}/config (ideN, media=cdrom) | done | P0 | W-MACHINE | POST /api/guests/:id/disks/cdrom |  |
| GU-036 | Hardware: VM | CD/DVD drive: change or eject ISO | PUT qemu/{vmid}/config (ide2) | done | P0 | W-MACHINE | POST /api/guests/:id/disks/cdrom |  |
| GU-037 | Hardware: VM | Network device: list | GET qemu/{vmid}/config (netN) | done | P0 | W-MACHINE | Hardware.tsx |  |
| GU-038 | Hardware: VM | Network device: add and edit (model, bridge, VLAN, MAC, firewall, rate limit) | PUT qemu/{vmid}/config (netN) | done | P0 | W-MACHINE | Network card: model, bridge, VLAN, trunks, MAC, firewall, disconnect, rate, MTU, queues; POST /api/guests/:id/network (digest) |  |
| GU-039 | Hardware: VM | Network device: remove | PUT qemu/{vmid}/config (delete=netN) | done | P0 | W-MACHINE | POST /api/guests/:id/network/:key/delete (digest, name typed) |  |
| GU-040 | Hardware: VM | EFI disk: add, remove | PUT qemu/{vmid}/config (efidisk0) | done | P1 | W-MACHINE | Add and remove EFI disk (type, Secure Boot keys); POST .../items/efi, removal typed |  |
| GU-041 | Hardware: VM | TPM state: add, remove | PUT qemu/{vmid}/config (tpmstate0) | done | P1 | W-MACHINE | Add and remove TPM (version); POST .../items/tpm, removal typed |  |
| GU-042 | Hardware: VM | PCI device passthrough (raw, mapped, PCIe, ROM-bar, primary GPU, mediated) | PUT qemu/{vmid}/config (hostpciN) | done | P1 | W-MACHINE | Host devices card: add and remove raw (root@pam), mapped, PCIe, ROM-BAR, primary GPU, vGPU; POST /api/guests/:id/host-devices |  |
| GU-043 | Hardware: VM | USB device passthrough (host, spice, mapped) | PUT qemu/{vmid}/config (usbN) | done | P1 | W-MACHINE | Host devices card: add and remove device, port, mapping, SPICE, USB 3; POST /api/guests/:id/host-devices |  |
| GU-044 | Hardware: VM | Serial port | PUT qemu/{vmid}/config (serialN) | done | P1 | W-MACHINE | Serial ports add and remove; POST .../items/serial |  |
| GU-045 | Hardware: VM | Audio device | PUT qemu/{vmid}/config (audio0) | done | P2 | W-MACHINE | Audio device add, edit, remove; POST .../items/audio |  |
| GU-046 | Hardware: VM | VirtIO RNG | PUT qemu/{vmid}/config (rng0) | done | P2 | W-MACHINE | Other devices card, random number generator; settings/rng |  |
| GU-047 | Hardware: VM | VirtIO-FS directory share | PUT qemu/{vmid}/config (virtiofsN) | done | P2 | W-MACHINE | Other devices card, shared folders from directory mappings; settings/virtiofs |  |
| GU-048 | Hardware: VM | Watchdog, extra args, NUMA nodes, parallel ports | PUT qemu/{vmid}/config (watchdog, args, numaN, parallelN) | done | P2 | W-MACHINE | Other devices (watchdog, parallel ports), More options (extra arguments), Processor details (NUMA nodes) |  |
| GU-049 | Hardware: Container | Memory and swap | PUT lxc/{vmid}/config (memory, swap) | done | P0 | W-MACHINE | POST /api/guests/:id/config |  |
| GU-050 | Hardware: Container | CPU cores | PUT lxc/{vmid}/config (cores) | done | P0 | W-MACHINE | POST /api/guests/:id/config |  |
| GU-051 | Hardware: Container | CPU limit and units | PUT lxc/{vmid}/config (cpulimit, cpuunits) | done | P2 | W-MACHINE | CPU limit and weight in Resources; POST /api/guests/:id/resources |  |
| GU-052 | Hardware: Container | Root disk: resize | PUT lxc/{vmid}/resize | done | P0 | W-DISK | POST /api/guests/:id/resize |  |
| GU-053 | Hardware: Container | Root disk: move volume to another storage | POST lxc/{vmid}/move_volume | done | P0 | W-DISK | POST /api/guests/:id/disks/rootfs/move |  |
| GU-054 | Hardware: Container | Mount points: add, edit, resize, remove, move | PUT lxc/{vmid}/config (mpN); resize; move_volume | done | P0 | W-DISK | POST /api/guests/:id/disks/mount; .../mpN/edit, move, detach |  |
| GU-055 | Hardware: Container | Bind mounts of host directories | PUT lxc/{vmid}/config (mpN, bind) | done | P1 | W-DISK | disksCheck.ts bindPath; disks/mount |  |
| GU-056 | Hardware: Container | Network: add, edit, remove (bridge, VLAN, static or DHCP IPv4/IPv6, gateway, firewall, rate, MTU) | PUT lxc/{vmid}/config (netN) | done | P0 | W-MACHINE | Container network: name, bridge, VLAN, MAC, IPv4 and IPv6 (DHCP, static, gateway), firewall, disconnect, rate, MTU; POST /api/guests/:id/network |  |
| GU-057 | Hardware: Container | DNS: nameserver and search domain | PUT lxc/{vmid}/config (nameserver, searchdomain) | done | P0 | W-MACHINE | DNS card: servers and search domains, or the host's; POST /api/guests/:id/dns |  |
| GU-058 | Hardware: Container | Features: nesting, keyctl, fuse, mknod, mount types | PUT lxc/{vmid}/config (features) | done | P0 | W-MACHINE | Features card: nesting, keyctl, FUSE, mknod, writable /sys, mount types; POST /api/guests/:id/features |  |
| GU-059 | Hardware: Container | Device passthrough | PUT lxc/{vmid}/config (devN) | done | P1 | W-MACHINE | Host devices card for containers: device nodes with mode and group; POST /api/guests/:id/host-devices |  |
| GU-060 | Cloud-Init | Add and remove Cloud-Init drive | PUT qemu/{vmid}/config (ideN: cloudinit) | done | P1 | W-MACHINE | Cloud-Init tab: add and remove the drive; POST /api/guests/:id/cloudinit, .../cloudinit/drive/remove |  |
| GU-061 | Cloud-Init | User, password, SSH public keys | PUT qemu/{vmid}/cloudinit (ciuser, cipassword, sshkeys) | done | P1 | W-MACHINE | Cloud-Init tab: user, write-only password, SSH keys |  |
| GU-062 | Cloud-Init | IP config per NIC (static, DHCP, IPv6), DNS domain and servers | PUT qemu/{vmid}/config (ipconfigN, nameserver, searchdomain) | done | P1 | W-MACHINE | Cloud-Init tab: DHCP, static and IPv6 addresses per network device, DNS and domain |  |
| GU-063 | Cloud-Init | Upgrade packages, custom user/network/meta snippets | PUT qemu/{vmid}/config (ciupgrade, cicustom) | done | P2 | W-MACHINE | Cloud-Init tab: upgrade packages, format, custom user, network, meta and vendor snippets |  |
| GU-064 | Cloud-Init | Regenerate image; dump generated config | PUT qemu/{vmid}/cloudinit; GET .../cloudinit/dump | done | P1 | W-MACHINE | Cloud-Init tab: Regenerate image, Generated files; POST .../cloudinit/regenerate, GET .../cloudinit/dump |  |
| GU-065 | Options | Name or hostname | PUT .../config (name, hostname) | done | P0 | W-MACHINE | POST /api/guests/:id/config; MachineActions.tsx |  |
| GU-066 | Options | Start at boot | PUT .../config (onboot) | done | P0 | W-MACHINE | POST /api/guests/:id/config |  |
| GU-067 | Options | Start/shutdown order and delays | PUT .../config (startup) | done | P1 | W-MACHINE | checkMachineOptions in hardware.ts |  |
| GU-068 | Options | Boot order | PUT qemu/{vmid}/config (boot) | done | P1 | W-MACHINE | checkMachineOptions |  |
| GU-069 | Options | QEMU guest agent: enable | PUT qemu/{vmid}/config (agent) | done | P0 | W-MACHINE | checkMachineOptions |  |
| GU-070 | Options | QEMU guest agent: fstrim, freeze, type | PUT qemu/{vmid}/config (agent=enabled=1,fstrim_cloned_disks=1,type) | done | P2 | W-MACHINE | More options: agent channel, freeze for backups, trim cloned disks; Guest agent tab, Trim now |  |
| GU-071 | Options | OS type | PUT .../config (ostype) | done | P1 | W-MACHINE | checkMachineOptions |  |
| GU-072 | Options | Protection against removal | PUT .../config (protection) | done | P0 | W-MACHINE | checkMachineOptions |  |
| GU-073 | Options | Use tablet, ACPI, KVM, freeze at startup, local time, RTC start date | PUT qemu/{vmid}/config (tablet, acpi, kvm, freeze, localtime, startdate) | done | P2 | W-MACHINE | More options: tablet, ACPI, KVM, freeze, clock, start date, time drift fix; settings/vmoptions |  |
| GU-074 | Options | Hotplug, SMBIOS, Spectre/Meltdown, VM state storage, AMD SEV | PUT qemu/{vmid}/config (hotplug, smbios1, spectre, vmstatestorage, amd-sev) | partial | P2 | W-MACHINE | More options: hotplug, SMBIOS, state storage, Spectre and Meltdown as CPU flags, SPICE; AMD SEV and Intel TDX not offered |  |
| GU-075 | Options | Container console mode, TTY count, architecture, hookscript | PUT lxc/{vmid}/config (cmode, tty, console, arch, hookscript) | done | P2 | W-MACHINE | Container options: console mode, terminals, console device, time zone, architecture, OS type, hook script, debug; settings/ctoptions |  |
| GU-076 | Task History | Per-guest task list and log | GET /nodes/{node}/tasks (vmid) | done | P0 | W-MACHINE | MachineTasks.tsx; GET /api/tasks?vmid= |  |
| GU-077 | Backup (per guest) | Back up now (mode, compression, storage, notes) | POST /nodes/{node}/vzdump | done | P0 | W-DISK | modal backup-now; POST /api/backups/run |  |
| GU-078 | Backup (per guest) | List backups of this guest and restore | GET /nodes/{node}/storage/{storage}/content (backup, vmid) | done | P0 | W-DISK | MachineBackups in MachinePage.tsx |  |
| GU-079 | Backup (per guest) | Backup job membership (which jobs include this guest) | GET /cluster/backup-info/not-backed-up | partial | P2 | W-DISK | Not covered list and per-job included disks on Backup jobs; no card on the machine page |  |
| GU-080 | Replication (per guest) | Guest replication jobs | GET/POST /cluster/replication (guest filter) | done | P1 | W-CLUSTER | Machine overview, Replication card; /api/cluster/replication?guest= |  |
| GU-081 | Snapshots | List snapshots as a tree with current state | GET .../snapshot | done | P0 | W-MACHINE | Snapshots.tsx |  |
| GU-082 | Snapshots | Take snapshot (name, description, include RAM) | POST .../snapshot | done | P0 | W-MACHINE | POST /api/guests/:id/snapshots |  |
| GU-083 | Snapshots | Roll back | POST .../snapshot/{snapname}/rollback | done | P0 | W-MACHINE | POST /api/guests/:id/snapshots/:name/rollback |  |
| GU-084 | Snapshots | Delete snapshot | DELETE .../snapshot/{snapname} | done | P0 | W-MACHINE | POST /api/guests/:id/snapshots/:name/delete |  |
| GU-085 | Snapshots | Edit snapshot description | PUT .../snapshot/{snapname}/config | done | P2 | W-MACHINE | Snapshots: edit description; POST .../snapshots/:name/describe |  |
| GU-086 | Firewall (per guest) | Rules, options, aliases, IP sets, log | GET/POST .../firewall/{rules,options,aliases,ipset,log} | done | P1 | W-NODE | /api/firewall/guest-<vmid>/*; MachineFirewall |  |
| GU-087 | Permissions (per guest) | View and change who may use this guest | GET/PUT /access/acl (path /vms/{vmid}) | done | P1 | W-ACCESS | Permissions tab: list, grant, revoke (typed); GET/POST /api/guests/:id/permissions |  |
| GU-088 | Migrate and clone | Migrate (online/offline, target node, local disks, target storage, preconditions) | GET/POST .../migrate | done | P1 | W-CLUSTER | Machine, Migrate (online, offline, restart, target node, local disks and storage, HA aware, watched task); /api/cluster/migrate/:vmid |  |
| GU-089 | Migrate and clone | Remote migrate to another cluster | POST .../remote_migrate | done | P2 | W-CLUSTER | RemoteMigrateButton on the machine page; POST /api/cluster/remote-migrate/:vmid (token write-only, fingerprint required) |  |
| GU-090 | Migrate and clone | Clone: name, target storage, full or linked (from template), pool | POST .../clone | done | P0 | W-MACHINE | POST /api/guests/:id/clone |  |
| GU-091 | Migrate and clone | Clone: target node, VMID choice, format, from a snapshot, bandwidth limit | POST .../clone (target, newid, format, snapname, bwlimit) | done | P1 | W-MACHINE | Clone dialog, More options: number, node, format, snapshot, speed limit, resource group; POST .../clone-options |  |
| GU-092 | Migrate and clone | Convert to template | POST .../template | done | P0 | W-MACHINE | POST /api/guests/:id/template |  |
| GU-093 | Migrate and clone | Delete guest (purge from jobs, destroy unreferenced disks) | DELETE .../{vmid} | done | P0 | W-MACHINE | POST /api/guests/:id/destroy (name typed, protection honored) |  |
| GU-094 | Migrate and clone | Delete guest: purge job configs and destroy unreferenced disks options | DELETE .../{vmid} (purge, destroy-unreferenced-disks) | done | P2 | W-MACHINE | Delete dialog, Options: remove from jobs, destroy unreferenced disks; POST .../delete |  |
| GU-095 | Guest agent | Agent info, OS info, filesystem info, users, time | GET qemu/{vmid}/agent/{info,get-osinfo,get-fsinfo,get-users,get-time} | done | P2 | W-MACHINE | Guest agent tab: system, kernel, file systems, users, time zone, CPUs, agent commands; GET .../agent/* |  |
| GU-096 | Guest agent | Agent actions: set user password, fstrim, freeze/thaw, exec | POST qemu/{vmid}/agent/{set-user-password,fstrim,fsfreeze-freeze,exec} | done | P2 | W-MACHINE | Guest agent tab: trim, freeze and thaw, set password, run a command, read a file; POST .../agent |  |

### Storage

| ID | Screen | Item | API | Status | Pri | Workstream | Evidence | Seq |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ST-001 | Summary | Usage, type, content types, active, shared | GET /nodes/{node}/storage/{storage}/status | done | P0 | W-DISK | StorageDetail.tsx; GET /api/host |  |
| ST-002 | Summary | Usage graphs | GET /nodes/{node}/storage/{storage}/rrddata | done | P1 | W-DISK | GET /api/storage-tools/:id/rrd; StorageTools, Space |  |
| ST-003 | Content | Browse by type: ISO, CT templates, VM disks, CT volumes, backups, snippets, import | GET /nodes/{node}/storage/{storage}/content | done | P0 | W-DISK | GET /api/storage/:id/content |  |
| ST-004 | Content | Upload ISO and CT template | POST /nodes/{node}/storage/{storage}/upload | done | P0 | W-DISK | POST /api/storage/:id/upload |  |
| ST-005 | Content | Download from URL with checksum | POST /nodes/{node}/storage/{storage}/download-url | done | P0 | W-DISK | POST /api/storage/:id/download-url |  |
| ST-006 | Content | Template catalog download | POST /nodes/{node}/aplinfo | done | P0 | W-DISK | GET /api/templates/catalog; POST /api/templates/download |  |
| ST-007 | Content | Delete volume | DELETE /nodes/{node}/storage/{storage}/content/{volume} | done | P0 | W-DISK | POST /api/storage/:id/delete |  |
| ST-008 | Content | Upload snippets (hookscripts, cloud-init files) | POST .../upload (content=snippets) | partial | P1 | W-DISK | Snippets are listed with copy-paste commands; Proxmox's upload API does not accept snippets |  |
| ST-009 | Content | Import disk image into a VM; import OVA/qcow2/raw | POST /nodes/{node}/qemu (import-from); GET .../import-metadata | done | P1 | W-DISK | download-import and upload-import, import-metadata and import-disk (attach as a new disk); StorageTools, Import |  |
| ST-010 | Content | Allocate a new disk image volume directly | POST /nodes/{node}/storage/{storage}/content | done | P2 | W-DISK | POST /api/storage-tools/:id/allocate; StorageTools, New disk |  |
| ST-011 | Content | Copy or move a volume between storages | POST .../content/{volume} | partial | P2 | W-DISK | POST /api/storage-tools/:id/copy exists behind an experimental acknowledgement (Proxmox marks it experimental); no screen |  |
| ST-012 | Permissions | View and change who may use this storage | GET/PUT /access/acl (path /storage/{id}) | missing | P1 | W-ACCESS |  |  |

### Pools

| ID | Screen | Item | API | Status | Pri | Workstream | Evidence | Seq |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PL-001 | Pool pages | Pool summary and members | GET /pools/{poolid} | missing | P1 | W-ACCESS |  |  |
| PL-002 | Pool pages | Pool permissions | GET/PUT /access/acl (path /pool/{id}) | missing | P1 | W-ACCESS |  |  |

### Create wizards

| ID | Screen | Item | API | Status | Pri | Workstream | Evidence | Seq |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| WZ-001 | Create CT | General: hostname, VMID, resource pool, password, SSH key, unprivileged | POST /nodes/{node}/lxc | done | P0 | W-MACHINE | features/wizard.ts /api/wizard/*; wizard-schema; pages/machines/NewMachine.tsx; docs/WIZARDS.md |  |
| WZ-002 | Create CT | Template: pick storage and template | POST /nodes/{node}/lxc (ostemplate) | done | P0 | W-MACHINE | GET /api/machines/options |  |
| WZ-003 | Create CT | Disks: storage and root disk size | POST /nodes/{node}/lxc (rootfs) | done | P0 | W-DISK | NewMachine.tsx size presets plus storage choice |  |
| WZ-004 | Create CT | CPU and memory, swap | POST /nodes/{node}/lxc (cores, memory, swap) | done | P0 | W-MACHINE | features/wizard.ts /api/wizard/*; wizard-schema; pages/machines/NewMachine.tsx; docs/WIZARDS.md |  |
| WZ-005 | Create CT | Network: bridge, VLAN, static or DHCP, IPv6, firewall | POST /nodes/{node}/lxc (net0) | done | P0 | W-MACHINE | features/wizard.ts /api/wizard/*; wizard-schema; pages/machines/NewMachine.tsx; docs/WIZARDS.md |  |
| WZ-006 | Create CT | DNS settings | POST /nodes/{node}/lxc (nameserver, searchdomain) | done | P1 | W-MACHINE | features/wizard.ts /api/wizard/*; wizard-schema; pages/machines/NewMachine.tsx; docs/WIZARDS.md |  |
| WZ-007 | Create CT | Start after created | POST /nodes/{node}/lxc (start) | done | P0 | W-MACHINE | always starts |  |
| WZ-008 | Create CT | Create from backup (restore) | POST /nodes/{node}/lxc (archive) | done | P0 | W-DISK | POST /api/backups/restore |  |
| WZ-009 | Create VM | General: name, VMID, pool, start at boot, start order, tags | POST /nodes/{node}/qemu | done | P0 | W-MACHINE | features/wizard.ts /api/wizard/*; wizard-schema; pages/machines/NewMachine.tsx; docs/WIZARDS.md |  |
| WZ-010 | Create VM | OS: ISO from storage, physical drive, no media; guest OS type and version | POST /nodes/{node}/qemu (ide2, ostype) | done | P0 | W-MACHINE | features/wizard.ts /api/wizard/*; wizard-schema; pages/machines/NewMachine.tsx; docs/WIZARDS.md |  |
| WZ-011 | Create VM | System: graphic card, machine, BIOS, SCSI controller, EFI, TPM, guest agent | POST /nodes/{node}/qemu (vga, machine, bios, scsihw, efidisk0, tpmstate0, agent) | done | P0 | W-MACHINE | features/wizard.ts /api/wizard/*; wizard-schema; pages/machines/NewMachine.tsx; docs/WIZARDS.md |  |
| WZ-012 | Create VM | Disks: bus, storage, size, cache, discard, SSD, IO thread, multiple disks | POST /nodes/{node}/qemu (scsi0...) | done | P0 | W-DISK | features/wizard.ts /api/wizard/*; wizard-schema; pages/machines/NewMachine.tsx; docs/WIZARDS.md |  |
| WZ-013 | Create VM | CPU: sockets, cores, type, vCPUs, limit, NUMA | POST /nodes/{node}/qemu (sockets, cores, cpu) | done | P0 | W-MACHINE | features/wizard.ts /api/wizard/*; wizard-schema; pages/machines/NewMachine.tsx; docs/WIZARDS.md |  |
| WZ-014 | Create VM | Memory: fixed or ballooning | POST /nodes/{node}/qemu (memory, balloon) | done | P0 | W-MACHINE | features/wizard.ts /api/wizard/*; wizard-schema; pages/machines/NewMachine.tsx; docs/WIZARDS.md |  |
| WZ-015 | Create VM | Network: bridge, VLAN, model, MAC, firewall, disconnect | POST /nodes/{node}/qemu (net0) | done | P0 | W-MACHINE | features/wizard.ts /api/wizard/*; wizard-schema; pages/machines/NewMachine.tsx; docs/WIZARDS.md |  |
| WZ-016 | Create VM | Create from template: cloud-init VM (clone, set user, keys, IP) | POST .../clone; PUT .../cloudinit | done | P1 | W-MACHINE | Clone dialog, Cloud-Init section: user, keys, address, grow disk, start; POST .../clone-options |  |
| WZ-017 | Create VM | Import from ESXi or OVA | POST /nodes/{node}/qemu (import-from) | partial | P2 | W-MACHINE | Create VM, Disks, Start from an image on an import storage (disk image, OVA disk, ESXi machine); whole-OVF and ESXi import wizards need Proxmox's own tools |  |
| WZ-018 | Create VM | Create from backup (restore) | POST /nodes/{node}/qemu (archive) | done | P0 | W-DISK | POST /api/backups/restore |  |
| WZ-019 | Create VM | Create VM: cloud-init drive, user, password, SSH keys, IP per NIC, DNS | POST /nodes/{node}/qemu (ideN: cloudinit, ciuser, cipassword, sshkeys, ipconfigN, nameserver, searchdomain) | done | P1 | W-MACHINE | features/wizard.ts /api/wizard/*; wizard-schema; pages/machines/NewMachine.tsx; docs/WIZARDS.md |  |
| WZ-020 | Create VM | Create VM: PCI and USB passthrough (raw, mapped, PCIe, primary GPU, ROM-bar, SPICE) | POST /nodes/{node}/qemu (hostpciN, usbN); GET /nodes/{node}/hardware/pci, usb; GET /cluster/mapping/pci, usb | done | P1 | W-MACHINE | features/wizard.ts /api/wizard/*; wizard-schema; pages/machines/NewMachine.tsx; docs/WIZARDS.md |  |
| WZ-021 | Create VM | Create VM: serial ports, audio device, display (VGA type, memory) | POST /nodes/{node}/qemu (serialN, audio0, vga) | done | P1 | W-MACHINE | features/wizard.ts /api/wizard/*; wizard-schema; pages/machines/NewMachine.tsx; docs/WIZARDS.md |  |

### Beyond Proxmox

| ID | Screen | Item | API | Status | Pri | Workstream | Evidence | Seq |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BY-001 | ePaperclip only | Organizations (Paperclip companies) with dashboards, tasks, goals, projects | engine proxy /engine/api/* | done | - | W-ENGINE | OrgPages.tsx and org/live; engine.ts |  |
| BY-002 | ePaperclip only | Agents: create, pause, resume, runs, budgets | engine proxy | done | - | W-ENGINE | LiveAgents.tsx |  |
| BY-003 | ePaperclip only | Decisions (approvals) and costs | engine proxy | done | - | W-ENGINE | OrgPages.tsx Decisions, Costs |  |
| BY-004 | ePaperclip only | Org chart editing with reporting lines | engine proxy | done | - | W-ENGINE | OrgChart.tsx |  |
| BY-005 | ePaperclip only | Organization resource groups (pool, limits) | /api/resource-groups | done | - | W-ENGINE | app.ts resource-groups |  |
| BY-006 | ePaperclip only | Agent containers in unprivileged Proxmox containers | /api/agent-containers/* | done | - | W-ENGINE | AgentContainers.tsx; containers.ts |  |
| BY-007 | ePaperclip only | Pin assistant (chat, quick actions, SOUL.md, MEMORY.md) | /api/pin/* | done | - | W-ENGINE | pin/ and PinPage.tsx |  |
| BY-008 | ePaperclip only | Pin tools that operate the host (guests, storage, network, backups) | /api/pin/chat tool calls | partial | - | W-ENGINE | pin.ts tools; broader skills pending |  |
| BY-009 | ePaperclip only | Automations (rules and schedules with plain-language read-back) | packages/automations; /api/pin/automations/* | done | - | W-ENGINE | features/pin-automations.ts runner; pages/pin/runtime.tsx; docs/PIN.md |  |
| BY-010 | ePaperclip only | Store: OS images, container apps, drivers, plugins, signed marketplace | /api/library/*, /api/marketplace | done | - | W-ENGINE | Store.tsx |  |
| BY-011 | ePaperclip only | Integrated Access Control (IAC): organization members mapped to Proxmox users | /api/iac/* | done | - | W-ENGINE | iac.ts; LiveAccess.tsx |  |
| BY-012 | ePaperclip only | Model provider connectors with sealed keys | /api/connectors/* | done | - | W-ENGINE | connectors.ts; vault.ts |  |
| BY-013 | ePaperclip only | Connected apps (MCP) | planned Papercliped bridge | missing | - | W-ENGINE | Apps.tsx on demo data |  |
| BY-014 | ePaperclip only | Chat, artifacts, workspaces, skills pages for organizations | engine | missing | - | W-ENGINE | ComingFromPaperclip placeholders in App.tsx |  |
| BY-015 | ePaperclip only | Kill switch, vault unlock and recovery | none | missing | - | W-ENGINE | ROADMAP Phase 5 |  |
| BY-016 | ePaperclip only | Pin notifications: task finished, backup failed, device events, approvals, with a quiet inbox and per-person preferences | /api/pin/notifications, /api/pin/notification-prefs | done | - | W-ENGINE | features/pin-notify.ts; Pin page Inbox |  |
| BY-017 | ePaperclip only | Pin Agent mode plans: review, approve step by step, typed confirmation for destructive steps, audit trail | /api/pin/plans/* | done | - | W-ENGINE | features/pin-agent.ts; Pin page Plans |  |
| BY-018 | ePaperclip only | Update awareness (installed vs latest, release notes) and a guided update with rollback through the installer | /api/pin/update, deploy/epaperclip-update.* | done | - | W-ENGINE | features/pin-update.ts; Pin page Updates |  |
| BY-019 | ePaperclip only | Model connection test and secret-safe provider errors | /api/pin/settings/test | done | - | W-ENGINE | features/pin-settings.ts; connectors.ts redact |  |
| BY-020 | ePaperclip only | Read-only MCP endpoint for outside AI apps, with Bearer API tokens | /api/mcp | done | - | W-ENGINE | features/pin-mcp.ts |  |
| BY-030 | ePaperclip only | Pin: Notes: folders, tags, search, pinned notes, safe Markdown, links to machines and storage, private by default, sharing with an organization, zip export and import | /api/notes/* | done | - | W-ENGINE | features/notes*.ts; pages/pin/notes; docs/NOTES.md |  |
| BY-031 | ePaperclip only | Auto-sort pasted text into notes, folders and tags with a review, undo and optional auto-file; keyword sorter without a model; secrets redacted before any model sees text | /api/notes/sort | done | - | W-ENGINE | features/notes-sort.ts, notes-secrets.ts, notes-rules.ts |  |
| BY-032 | ePaperclip only | Pin tools search_notes, create_note and file_notes (writes go through the plan approval flow) | Pin chat tools | done | - | W-ENGINE | features/notes-tools.ts, notes-steps.ts |  |
