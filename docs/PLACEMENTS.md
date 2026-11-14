# Placements: following a run to its machine and back

The engine owns the run and its environment lease. The provider owns the container or the worker. ePaperclip keeps the one
link between them, so a person can go from a task to the machine that ran it and from a machine to the runs it served,
including after a throwaway container has been deleted. Code: `services/epaperclip/src/placements.ts` (the ledger),
`features/placements.ts` (the routes), `AgentContainers.leaseRows` (the engine reader). Tests:
`services/epaperclip/test/placements.test.ts`.

## Where the facts come from

Every minute the host reads the engine's own lease rows (`GET /api/environments/{id}/leases`, for every environment of every
active organization) and records, for the two providers it ships:

| Provider | Resource | Taken from |
| --- | --- | --- |
| `proxmox` | container: node and guest id | the lease's `providerLeaseId` (`node/vmid`, or `node_vmid` for a failed creation), else the metadata's `node` and `vmid` |
| `remote-worker` | worker id | the lease metadata's `workerId` |

The run is the lease's `heartbeatRunId`; the organization is its `companyId`. Nothing is taken from a display name, a chat
transcript or the order machines appear in. A lease that does not name a resource we can verify is reported **unplaced**.
The ledger stores no address, user name or key: the provider metadata is read for the ids above and dropped.

The engine's lease statuses (`active`, `released`, `expired`, `failed`, `retained`, `pending_cleanup`) and cleanup statuses
(`pending`, `success`, `failed`) map to five placement states: `active`, `retained`, `cleanup_pending`, `failed`, `retired`.
`released` or `expired` is `retired` only once cleanup succeeded; until then it is `cleanup_pending`.

## Rules the ledger keeps

- **Stable.** Once a lease names its resource, that never changes. A lease never moves to another organization, and never
  moves back from a later state: a replayed or stale `active` row cannot revive a retired placement.
- **History.** Retired placements are kept (up to 5000, oldest finished ones dropped first; live ones are never dropped) with
  the time window they covered. A reused VMID is a separate placement with its own window, so an old run is never attributed
  to the container's new owner, and the reverse.
- **Honest freshness.** The device counts as synced only when every environment was read. A live placement the engine has not
  confirmed for 10 minutes reads **stale**, not running. If the engine cannot be asked, the answer is **unavailable**.
- **Withheld, not redacted.** A caller sees only placements of organizations they belong to (the engine's own answer to
  `GET /api/companies` as that person). Others are returned as a count (`hidden`) and nothing else, no run id, organization or
  machine.

## Routes

Any signed-in person; read-only.

```
GET /api/placements/runs/<runId>
GET /api/placements/resources?kind=lxc&node=<node>&vmid=<id>
GET /api/placements/resources?kind=worker&workerId=<id>
```

```json
{ "runId": "…", "status": "active", "placements": [ { "leaseId": "…", "runId": "…", "companyId": "…", "issueId": null,
  "provider": "proxmox", "resource": { "kind": "lxc", "device": "pve", "node": "pve", "vmid": 104 },
  "state": "active", "acquiredAt": 1794650400000, "releasedAt": null } ], "hidden": 0, "lastSyncAt": 1794650460000 }
```

`status` is one of `unplaced`, `active`, `retained`, `cleanup_pending`, `failed`, `retired`, `stale`, `unavailable` or
`restricted` (matches exist, none in an organization the caller may see). For a machine the answer lists every run it
served, oldest first, and `status` describes the current one.

## What is not done yet

- Nothing in the console reads these routes yet (no link from a run to its machine, or back).
- The routes check organization membership, not the caller's Proxmox permission on the guest.
- `device` is this host's node name; a cluster with several devices needs a stable device id.
- Verified against fakes and the engine's lease schema (`paperclipai@2026.1023.0`, `environment_leases`), not against a real
  run on a real host: label `tested`, not `real-host`.
