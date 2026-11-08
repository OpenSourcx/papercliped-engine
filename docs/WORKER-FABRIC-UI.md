# Worker Fabric console UI

Where: Sidebar, Datacenter, **Workers** (`/<device>/datacenter/workers`, detail at `.../workers/:id`). Adopting and assigning are
addressable modals: `?modal=adopt-worker` and `?modal=use-worker`. The area is a feature module (`apps/console/src/features/workers.tsx`),
so it is live-only like Cluster and Disks. Code: `src/pages/workers/`, data layer `src/data/engine/fabric.ts` (contract:
[WORKER-FABRIC.md](WORKER-FABRIC.md) section 4).

## Views

| View | What it shows or does |
| --- | --- |
| Workers list | One card per worker: name, status word with icon (Online, Offline, Draining, Disabled, Low memory, Revoked), hardware summary, OS and architecture, connection provider and address, GPU, local models, active shell and inference leases, last seen, CPU load and memory meters when the worker reports them (otherwise "Not reported"). Pending join requests sit on top with the worker's hardware, a check string and Approve/Deny. Revoked workers are listed apart. Environments on workers are listed below. |
| Empty state | Explains adoption in three steps and that no passwords are copied to the machine. |
| Worker detail | Tabs Overview (capabilities, connection: provider, address, connected since, last seen, version, key fingerprint, organization scope, slots; rename), Leases, Activity (audit). Actions: Drain / Stop draining, Disable / Enable, Refresh capabilities, Re-pair (offline workers), Revoke (always asks first), Remove record (revoked only). |
| Revoke | Confirmation dialog: revoking is permanent for that identity, the connection closes, leases are destroyed, the key goes on a deny list, the computer itself is not touched. |
| Add a worker | Provider choice (Tailscale recommended with its detection state, Local network, Custom; Headscale and a Connect relay are shown as "Not available yet" and cannot be chosen), optional name, organization scope. Then a single-use code and install command with a live countdown. When the worker connects the dialog shows its reported hardware. Expired, used-without-arrival and failed-to-create states each have their own message. |
| Run agents on a worker | Creates the remote-worker environment for an organization: any matching worker or a pinned one, requirements (GPU, architecture, local model, tools, free memory) and the agents that use it. Says plainly that model choice is a separate setting on the agent. |

## Honest states

Demo: "Workers need a connected device", nothing is fetched. Host without the routes (404): "doesn't offer the Worker Fabric". Fabric
off (`enabled: false` or 503 `fabric_unavailable`): "turned off". 403: administrators only. Network failure: "Can't reach this
device" with Try again. A worker that has not reported capabilities shows "Hardware not reported yet", never made-up numbers.

## Security notes for the UI

No reusable password or OAuth secret is asked for, stored or shown anywhere. The pairing code is held in component state only (never
local storage, never the URL), is shown once, and is gone when the dialog closes. The browser sends `X-EPC-Request: 1` on every change.

## Checks

`corepack pnpm --filter ./apps/console typecheck | test | build | check:design`; component tests in `apps/console/test/workers.test.tsx`;
browser pass `apps/console/scripts/worker-fabric-audit.mjs` (stubbed API, both palettes, 390 and 1280 px).
