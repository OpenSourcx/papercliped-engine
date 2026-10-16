# Cluster, high availability, replication, migration and Ceph

These screens stand in for the cluster parts of Proxmox's own web UI. Like the node and disk screens, every call is a Proxmox API call made **as the signed-in person**, so Proxmox decides who may do what; a refusal (403) reads "Your Proxmox account doesn't have permission for this". The host service validates every field against the API viewer data before Proxmox sees it, requires the same-site header on changes, and asks for a typed confirmation for anything destructive or irreversible. The root password used to join a cluster is write-only: it travels in the request body once, is scrubbed from any error text Proxmox sends back, and is never returned, logged or stored.

Code: host `services/epaperclip/src/features/cluster*.ts` (routes under `/api/cluster/…`), console `apps/console/src/features/cluster.tsx`, `src/pages/cluster/**` and `src/data/engine/clusterApi.ts`. The fake Proxmox for tests and screenshots is `services/epaperclip/test/fakes-cluster.ts`.

## A single device

Nothing here needs a cluster. On a device that is not in one, the cluster screens say "This device is not in a cluster" and offer **Create cluster** (HA and Replication), or both **Create cluster** and **Join a cluster** (the Cluster screen). Ceph says it isn't set up. Machines show no cluster card. No call fails; the host service answers `clustered: false`, empty lists and `installed: false` instead.

## Screens

| Screen | Where | What it does |
| --- | --- | --- |
| Cluster | Datacenter, Cluster | Name, quorum, votes, nodes online, Proxmox version; a nodes table (id, votes, link addresses, machines, Manage); join information to copy; recent cluster log; totem and quorum-device status. Create cluster, Join a cluster, Remove node. |
| High availability | Datacenter, High availability | Resources (add, edit, remove, move), placement (rules or groups), manager status per node, fencing and Arm/Disarm. |
| Replication | Datacenter, Replication; a machine's overview | Jobs with state, last and next copy, duration, failures; add, edit, remove, Run now, log. |
| Migrate | A machine's overview (Cluster card) and Pin's More menu | Target node, online/offline/restart, local disks and target storage, advanced options, followed as a task. |
| Ceph | Datacenter, Ceph | Overview (health, warnings, capacity, I/O, flags), Services, OSDs, Pools, Configuration. |
| Node selector | the node picker in the sidebar | Every existing screen works on the node you pick (below). |

### Create, join and remove

- **Create cluster** takes a name (letters, numbers and `-`, up to 15 characters), optional corosync links with priorities and the cluster name typed to confirm. `POST /cluster/config`; the task is followed. Refused when the device is already clustered.
- **Join information** is the same base64 JSON Proxmox's own screen produces (`ipAddress`, `fingerprint`, `peerLinks`, `ringAddress`, `totem`) from `GET /cluster/config/join`, so either screen can read the other's. It holds an address and a public fingerprint, no secrets.
- **Join a cluster** reads that text (or takes the address and certificate fingerprint by hand), the root password of the peer (write-only), optional links and this device's name typed. It is refused before Proxmox is asked if the device is already in a cluster or has machines (Proxmox won't join a device that has any). After it succeeds Proxmox replaces this device's cluster state, so the person's sign-in ends and they sign in again.
- **Remove node** works on a node that is **off** (an online node is refused, and so is the device you are signed in to). The dialog lists the machines, HA resources and replication jobs still tied to it, and the steps that follow: keep it off, never switch it on again with the same name and address, and delete its leftover folder under `/etc/pve/nodes/` if wanted. The node's name must be typed.
- Links and the quorum device are **read**; changing them has a guide (below), because Proxmox has no API for editing `corosync.conf` or setting up a QDevice (`pvecm`).

### High availability

Which of groups and rules exists is decided by asking this Proxmox, not by guessing from its version: if `GET /cluster/ha/rules` answers, the screen shows **Rules** (node affinity: prefer or avoid nodes, strict or not, with priorities; resource affinity: keep together or apart), and any groups that remain are shown as deprecated and still editable. If it doesn't (Proxmox 8), the screen shows **Groups** (nodes with priorities, restricted, don't move back). `failback` on a resource exists only where rules do. A rule's kind is read from Proxmox and can't be changed; edits carry the page's digest. Deleting a group needs its name typed and is refused while a resource still uses it.

Moving a resource goes through the HA manager (`migrate` keeps it running, `relocate` stops and restarts it); that request is queued and has no task. Fencing shows the datacenter option (watchdog, hardware or both) and, where Proxmox has the endpoints, whether HA is armed. **Disarm** releases the watchdogs on every node and needs `disarm` typed and a choice of what happens to HA machines meanwhile (freeze or ignore). Hardware fence devices live in `fence.cfg`, which has no API.

### Replication

A job copies a machine's disks to another node on a Proxmox calendar schedule (presets plus free text, validated for shape and by Proxmox), with an optional speed limit (MB/s). The job id is `<vmid>-<n>` with the next free number; one job per target node. Status comes from the node that runs the machine (`GET /nodes/{node}/replication`); if that node is offline the job still lists, with a notice. **Run now** is `schedule_now` on that node. **Remove** needs the job id typed; it deletes the copies on the target unless Keep is chosen. Replication needs ZFS with the same storage name on both nodes; Proxmox checks that on the first run and says what is wrong in the job's log.

### Migration

The Cluster card on a machine reads where it runs, its HA state and its replication, and has **Migrate**. The dialog asks Proxmox for the preconditions (`GET …/migrate`): which nodes are allowed and why the others are not (offline, a storage is missing there, an HA rule forbids it), local disks, devices tied to the node, mapped devices and HA machines that move with it.

- A running VM moves online (optionally with its local disks, to a chosen target storage); a stopped one moves off. A running container is a restart migration (shut down, move, start) unless live migration (experimental) is chosen.
- Local devices block the move; migrating anyway needs the machine number typed.
- Bandwidth, encrypted or unencrypted traffic and the migration network are under Advanced options, and are checked (CIDR, whole numbers, enum values).
- Machines under HA are moved by the HA manager, which refuses a direct migration; the dialog says so, local-disk options don't apply, and the answer is "request sent" instead of a task.
- Everything else is a Proxmox task on the node the machine leaves, shown with its live log and a Stop button.

**Backups across nodes**: `POST /api/cluster/backup/run` groups the chosen machines by the node that holds them and starts one `vzdump` per node (or one per online node for "all"). The console's Back up now uses it, follows the first task, and the rest run on their nodes (all are in All tasks).

### Ceph

Read first. The Overview shows health, each warning (with Mute for a day / Unmute), capacity, I/O and the cluster flags; Services lists monitors, managers, metadata servers and CephFS; OSDs show state, in/out, class, use and PGs; Pools show copies, minimum, PGs, autoscaling and use; Configuration shows `ceph.conf` (lines that look like keys are hidden), the placement rules and the log.

Reversible writes sit on the other tabs: OSD **in**, **out** (typed `osd.N`, because it starts moving data) and **scrub**; cluster **flags** (`pause` needs `pause` typed because it stops all I/O); health **mute**; pool **create** and **tune** (changing the number of copies needs the pool name typed).

The **Manage** tab holds what changes what the cluster stores. Each step asks Ceph first (`GET /nodes/{node}/ceph/cmd-safety`) and wants the name typed; where Ceph or arithmetic warns, a second switch is needed (`acknowledgeUnsafe` or `acknowledgeData`).

| Step | Rules |
| --- | --- |
| Create OSD | The drive is picked from the unused ones, its name typed (it is erased), a drive in use (mounted, boot, LVM, ZFS, device mapper) is refused. Optional database drive, encryption, device class. |
| Destroy OSD | Only when it is **out and down** (otherwise refused with what to do first), Ceph's safety check passes or is overridden, `osd.N` typed. Optionally wipes the drive's logical volumes. |
| Delete pool | Name typed. A pool holding data (or one Ceph can't say about) needs a second yes. Can remove its storages. |
| Monitors, managers, metadata servers | Create takes an optional name (and, for monitors, an address). Destroy needs `mon.<id>` etc. typed. A monitor is refused when the rest would not be a majority in quorum or it is the last; the only manager takes an override; Ceph's check covers monitors and metadata servers. |
| CephFS | Create needs a metadata server first; optional placement groups and "add as storage". Destroy needs the name typed; taking the pools along needs a second yes. |
| Services | Start is free. Stop and restart (`ceph.target`, `osd.N`, `mon.x`, `mgr.x`, `mds.x`) need the service typed and pass Ceph's check or an override. |
| CRUSH map | Read only: its rules, bucket and device counts, and the text. |
| First set-up | Releases this node can install, the `pveceph install` command (Proxmox's own screen runs it in a shell; there is no API), then **init** with the public network (and an optional cluster network, copies, minimum copies) with `ceph` typed. Turning authentication off also needs `disable cephx` typed. |

A Proxmox that has no Ceph answers with a calm "isn't set up" and the set-up card.

## Quorum device and corosync links

Read: whether a quorum device is set up, the node count and whether it is even. Changes have **guides**, because there is no API: `GET /api/cluster/qdevice/guide?action=setup&address=...` (install `corosync-qnetd` on the outside machine, `corosync-qdevice` on every node, `pvecm qdevice setup <address>`), `?action=remove`, and `GET /api/cluster/corosync/guide?action=add-link|change-link|expected-votes`. Addresses and names are validated; the steps say where to run each command, work on a copy of `corosync.conf`, remind about `config_version`, and keep the old link until the new one works. `pvecm expected 1` is given only with a warning about two parts of a cluster both thinking they are the cluster.

The Cluster screen also has a short guide for **adding and removing nodes**: same version, empty node, ports, join information, a second link, and for removing: move machines, think about quorum, keep the node off, remove, clean up `/etc/pve/nodes/`.

## Moving a machine to another cluster

`POST /api/cluster/remote-migrate/:vmid` (Proxmox marks it experimental). The other cluster's address, **certificate fingerprint** (required, so nothing can pose as it), API token ID and secret are checked and sent as `target-endpoint`; the secret is write-only (never returned, logged, or left in an error, and the console clears it after sending). Storage and bridge mappings (`source:target` or one for all), an optional new number, live move, speed limit (and, for containers, restart). Typed: the machine number; deleting the original afterwards also needs `delete` typed. Templates, HA machines and locked machines are refused with the reason.

## Cluster resources

`GET /api/cluster/resources[?type=vm|storage|node|sdn]`: every node, machine and storage with CPU, memory and disk, plus totals (shared storage counted once, only online nodes counted for processors and memory) and machine counts. The Resources screen filters by kind and by text (name, node, pool, tag).

## Routed networks (SDN)

Datacenter, Routed networks (`clusterSdn.ts`, `SdnRouted.tsx`). Checked against the API viewer tables for each kind; edits carry the digest, and an emptied field is sent as `delete`.

- **Controllers**: EVPN (AS number, peers or a fabric, route maps in and out, multihop), BGP (node, AS, peers, loopback) and IS-IS. Removing one a zone uses is refused with the zone's name.
- **EVPN zones**: controller, VRF VXLAN number, exit nodes (the primary must be one of them), advertise subnets, ARP/ND suppression, anycast MAC, route-target import. Removing a zone with VNets is refused. Simple, VLAN, QinQ and VXLAN zones, VNets and subnets stay under Network.
- **Fabrics** (Proxmox 9 and later): OpenFabric, OSPF and BGP, with their redistribution sources (and route maps), a route filter (prefix list) and nodes with their interfaces. WireGuard fabrics are shown but not edited. On a Proxmox without them the screen says so.
- **Prefix lists** and **route maps** (one entry at a time): permit or deny, prefix with `ge`/`le`, match and set keys from the viewer's lists. Removing something another object points at is refused with the object's name.
- **Apply** is the same call as for the simpler zones; changes wait until applied.

## The node selector for existing screens

The console sends the node it is managing as the `X-EPC-Node` header on every host-level request (`src/lib/selectedNode.ts`, used by `data/api.ts`; the node picker in the sidebar and "Manage" on the Cluster screen set it, and changing it refetches everything). The host service (`features/clusterNode.ts`) checks it against `GET /nodes` (cached 30 seconds per sign-in; 400 for a malformed name, 404 `unknown_node` for one the cluster doesn't have) and the existing routes read it instead of this device's name: host figures, graphs, storage content, templates, uploads, tasks, network and DNS, firewall (host level), machine creation, backups and restore. Without the header, or with this device's own name, nothing changes. Machine routes already find a machine's node from the cluster, so machines on other nodes work without it. The host shell (`/api/console/node`) still opens on this device.

## Routes

All need the Proxmox session; changes need `X-EPC-Request: 1`. Shapes are in `apps/console/src/data/engine/clusterApi.ts`.

`GET /api/cluster/overview` · `GET /api/cluster/join-info`, `POST /api/cluster/join-info/parse` · `POST /api/cluster/create`, `POST /api/cluster/join` · `GET /api/cluster/nodes/:node/removal`, `POST /api/cluster/nodes/:node/remove` · `GET /api/cluster/log` · `GET /api/cluster/ha`, `GET /api/cluster/ha/guest/:vmid`, `POST|PUT|DELETE /api/cluster/ha/resources[/:sid]`, `POST …/resources/:sid/{migrate,relocate}`, `POST|PUT|DELETE /api/cluster/ha/groups[/:group]`, `POST|PUT|DELETE /api/cluster/ha/rules[/:rule]`, `POST /api/cluster/ha/arm` · `GET|POST /api/cluster/replication`, `PUT|DELETE /api/cluster/replication/:id`, `POST …/:id/run-now`, `GET …/:id/log` · `GET|POST /api/cluster/migrate/:vmid`, `GET …/storages` · `POST /api/cluster/backup/run` · `GET /api/cluster/ceph`, `GET …/ceph/config`, `POST …/ceph/osd/:id/{in,out,scrub}`, `PUT …/ceph/flags`, `PUT …/ceph/health-mute`, `POST|PUT /api/cluster/ceph/pools[/:name]`.

Added: `GET …/ceph/setup`, `POST …/ceph/init`, `GET …/ceph/crush`, `POST …/ceph/osds`, `POST …/ceph/osd/:id/destroy`, `POST …/ceph/pools/:name/delete`, `POST …/ceph/{mon,mgr,mds}` and `POST …/ceph/{mon,mgr,mds}/:id/destroy`, `POST …/ceph/fs` and `…/fs/:name/destroy`, `POST …/ceph/service/{start,stop,restart}` · `GET /api/cluster/qdevice[/guide]`, `GET /api/cluster/corosync/guide` · `GET|POST /api/cluster/remote-migrate/:vmid` · `GET /api/cluster/resources` · `GET /api/cluster/sdn`, `POST|PUT|DELETE …/sdn/controllers[/:id]`, `…/sdn/evpn-zones[/:id]`, `…/sdn/fabrics[/:id]`, `POST|DELETE …/sdn/fabrics/:id/nodes/:node`, `POST|DELETE …/sdn/prefix-lists[/:id[/entries[/:seq]]]`, `POST|PUT|DELETE …/sdn/route-maps/:id/entries[/:order]`.

## Tests

Host service: `services/epaperclip/test/cluster-more.test.ts` (Ceph writes, guides, remote migration, resources, routed SDN, against `test/fakes-diskcluster.ts`) and `services/epaperclip/test/cluster.test.ts` (every route: happy path, validation refusals, permission denials, typed confirmations, groups versus rules, single device, the node header, secrets never in answers) against `test/fakes-cluster.ts`. Console: `apps/console/test/cluster.test.tsx`, `diskcluster.test.tsx`. Screenshots: `services/epaperclip/scripts/cluster-shots.mts` and `diskcluster-shots.mts` (demo, live cluster with Ceph, live older Proxmox with groups, live single device; 1440 and 390 wide).

## Not verified against a real Proxmox

Everything above was checked against the API viewer data and a fake Proxmox, not a real cluster. Not yet seen on real hardware:

- Creating and joining: the exact text Proxmox gives for a wrong password or fingerprint, the shape of `GET /cluster/config/nodes` (the viewer documents only `node`; the screen also reads `name`, `nodeid`, `quorum_votes` and `ringN_addr` when present), and what the session does when pve-cluster restarts during a join.
- HA: rules `PUT` is sent with the rule's `type` (the schema is selected by it); `GET /cluster/ha/status/manager_status` is read only for the manager node; the armed state exists only on Proxmox versions that list a `fencing` status entry.
- Replication: the `source` field of a job before its first run (the machine's current node is used), and `schedule_now` when the source node is the one signed in to.
- Migration: preconditions for containers use hyphenated keys (`allowed-nodes`) and have no disk list; both spellings are read. HA machines are moved with `migrate` when running VMs stay online and `relocate` otherwise.
- Ceph: the exact shape of `ceph status` and of the OSD tree on each Ceph release (read defensively), and which Proxmox errors mean "not set up" (matched by words: ceph, rados, not installed, binary).
- The `X-EPC-Node` header on uploads and the machine creation wizard against a node that isn't the one signed in to.

Also not yet seen on real hardware for the additions: the shape of `cmd-safety` answers (read defensively: `safe`, `ok` or `status`), how `ceph/osd` reports an OSD that is down and out, the format Proxmox wants for `target-endpoint` on every version (built from its documented `apitoken=...,host=...,fingerprint=...,port=...`), `remote_migrate` for containers, array-valued SDN parameters (`interfaces`, `redistribute`, `match`, `set`, sent as repeated keys), and the fabric and route-map endpoints on Proxmox 9 releases other than the one the viewer data came from.
