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
- Links and the quorum device are **read only**: Proxmox has no API for editing `corosync.conf` or setting up a QDevice (`pvecm`).

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

Writes are limited to what is reversible and cannot lose data: OSD **in**, **out** (typed `osd.N`, because it starts moving data) and **scrub**; cluster **flags** (`pause` needs `pause` typed because it stops all I/O); health **mute**; pool **create** (at least 2 copies, minimum not above copies) and pool **tune** (autoscale mode, minimum copies, target ratio; changing the number of copies needs the pool name typed). Installing Ceph, creating or destroying monitors, managers, metadata servers, OSDs and pools, CephFS create/destroy, and starting or stopping services stay in `pveceph`, where long-running work and its prompts belong. A Proxmox that has no Ceph answers with a calm "isn't set up".

## The node selector for existing screens

The console sends the node it is managing as the `X-EPC-Node` header on every host-level request (`src/lib/selectedNode.ts`, used by `data/api.ts`; the node picker in the sidebar and "Manage" on the Cluster screen set it, and changing it refetches everything). The host service (`features/clusterNode.ts`) checks it against `GET /nodes` (cached 30 seconds per sign-in; 400 for a malformed name, 404 `unknown_node` for one the cluster doesn't have) and the existing routes read it instead of this device's name: host figures, graphs, storage content, templates, uploads, tasks, network and DNS, firewall (host level), machine creation, backups and restore. Without the header, or with this device's own name, nothing changes. Machine routes already find a machine's node from the cluster, so machines on other nodes work without it. The host shell (`/api/console/node`) still opens on this device.

## Routes

All need the Proxmox session; changes need `X-EPC-Request: 1`. Shapes are in `apps/console/src/data/engine/clusterApi.ts`.

`GET /api/cluster/overview` · `GET /api/cluster/join-info`, `POST /api/cluster/join-info/parse` · `POST /api/cluster/create`, `POST /api/cluster/join` · `GET /api/cluster/nodes/:node/removal`, `POST /api/cluster/nodes/:node/remove` · `GET /api/cluster/log` · `GET /api/cluster/ha`, `GET /api/cluster/ha/guest/:vmid`, `POST|PUT|DELETE /api/cluster/ha/resources[/:sid]`, `POST …/resources/:sid/{migrate,relocate}`, `POST|PUT|DELETE /api/cluster/ha/groups[/:group]`, `POST|PUT|DELETE /api/cluster/ha/rules[/:rule]`, `POST /api/cluster/ha/arm` · `GET|POST /api/cluster/replication`, `PUT|DELETE /api/cluster/replication/:id`, `POST …/:id/run-now`, `GET …/:id/log` · `GET|POST /api/cluster/migrate/:vmid`, `GET …/storages` · `POST /api/cluster/backup/run` · `GET /api/cluster/ceph`, `GET …/ceph/config`, `POST …/ceph/osd/:id/{in,out,scrub}`, `PUT …/ceph/flags`, `PUT …/ceph/health-mute`, `POST|PUT /api/cluster/ceph/pools[/:name]`.

## Tests

Host service: `services/epaperclip/test/cluster.test.ts` (every route: happy path, validation refusals, permission denials, typed confirmations, groups versus rules, single device, the node header, secrets never in answers) against `test/fakes-cluster.ts`. Console: `apps/console/test/cluster.test.tsx`. Screenshots: `services/epaperclip/scripts/cluster-shots.mts` (demo, live cluster with Ceph, live older Proxmox with groups, live single device; 1440 and 390 wide).

## Not verified against a real Proxmox

Everything above was checked against the API viewer data and a fake Proxmox, not a real cluster. Not yet seen on real hardware:

- Creating and joining: the exact text Proxmox gives for a wrong password or fingerprint, the shape of `GET /cluster/config/nodes` (the viewer documents only `node`; the screen also reads `name`, `nodeid`, `quorum_votes` and `ringN_addr` when present), and what the session does when pve-cluster restarts during a join.
- HA: rules `PUT` is sent with the rule's `type` (the schema is selected by it); `GET /cluster/ha/status/manager_status` is read only for the manager node; the armed state exists only on Proxmox versions that list a `fencing` status entry.
- Replication: the `source` field of a job before its first run (the machine's current node is used), and `schedule_now` when the source node is the one signed in to.
- Migration: preconditions for containers use hyphenated keys (`allowed-nodes`) and have no disk list; both spellings are read. HA machines are moved with `migrate` when running VMs stay online and `relocate` otherwise.
- Ceph: the exact shape of `ceph status` and of the OSD tree on each Ceph release (read defensively), and which Proxmox errors mean "not set up" (matched by words: ceph, rados, not installed, binary).
- The `X-EPC-Node` header on uploads and the machine creation wizard against a node that isn't the one signed in to.
