# ePaperclip Worker Fabric

Status: in implementation on branch `feat/worker-fabric`. This file is the contract the console, the docs and the
tests are built from. Evidence labels used throughout: **implemented**, **locally tested**, **CI**, **live-engine
tested**, **real-device (Orion) validated**. The current label of every item is in the checklist in
[STABLE-V1-LEDGER.md](STABLE-V1-LEDGER.md#worker-fabric).

The Worker Fabric lets a compatible computer be adopted as a **persistent managed execution environment** for
Paperclip agents. It is generic. Orion (a Jetson Orin Nano Super, hostname `kpnai`) is only the first reference node.

## 1. Source-backed plan: no second orchestrator

Everything an agent run needs is already a Paperclip contract, so the Fabric is a *provider* plus a *node service*,
not a job system. All evidence below is from the exact engine `2026.1023.0` installed at `/project/.work/engine-1023`
(`node_modules/@paperclipai/...`).

| Question | Answer | Evidence |
| --- | --- | --- |
| How does an engine environment point at a plugin? | Core `driver: "sandbox"` with `config.provider = <driverKey>`; the plugin declares `environmentDrivers[]` with `kind: "sandbox_provider"`. | `shared/dist/types/plugin.d.ts:143-153`; `server/dist/services/plugin-environment-driver.js:92,124` |
| Which lifecycle hooks exist? | `onEnvironmentValidateConfig`, `Probe`, `AcquireLease`, `ResumeLease`, `ReleaseLease`, `StopLease`, `DestroyLease`, `RealizeWorkspace`, `Execute` (plus sync, interactive-setup and ingress hooks, all optional). | `plugin-sdk/dist/define-plugin.d.ts:292-337` |
| Hook parameter and result shapes | `PluginEnvironmentLease { providerLeaseId, metadata, expiresAt }`; `Release/Destroy` params carry `resourceDisposition: "stop_and_retain"` and `cancelActiveWork`; a stop/destroy must return a termination receipt `{providerLeaseId, state: "stopped" \| "destroyed"}`. | `plugin-sdk/dist/protocol.d.ts:474-600` |
| Can output stream? | Yes: `ctx.execution.log("stdout" \| "stderr", chunk)` while `Execute` runs. | `plugin-sdk/dist/types.d.ts:1668-1688` |
| Can a lease be reused across runs? | Yes, when the driver declares `sandboxCapabilities.reusableLeases` and implements resume/release/destroy. | `plugin-environment-driver.js:5-15,160-170` |
| Does managed-sandbox-only policy allow it? | Yes. The policy refuses only the `local` driver; a `sandbox` environment with any provider key is allowed. ePaperclip already turns the policy on (`AgentContainers.enforce`), and it stays on. | `server/dist/services/execution-allowlist.js` (`isLocalExecutionDenied`) |
| How are environments created and agents assigned? | `POST /api/companies/:id/environments {driver:"sandbox", config:{provider,...}}`; `PATCH /api/agents/:id {defaultEnvironmentId}`. ePaperclip already does this for the Proxmox provider. | `services/epaperclip/src/containers.ts:918,926-951` |
| How are secrets given to a plugin? | Config fields typed `format: "secret-ref"` hold a Paperclip secret id; the host resolves them to values before calling the worker. | `plugins/proxmox-sandbox/src/manifest.ts` (`apiTokenSecret`) |

**Limitations proven, none blocking.** (1) The `Execute` params carry no abort signal (`protocol.d.ts:561-587`), so
a running command is cancelled through its timeout, through `StopLease` / `DestroyLease` with `cancelActiveWork`, or
by the provider noticing the engine closed the request. (2) A plugin worker is a child process of the engine and can
restart at any time (the Proxmox provider notes the same in `plugin.ts` "Lost on a worker restart"), so all durable
state (workers, leases, identities, audit) lives in the ePaperclip host service, never in the plugin. (3) `Execute`
returns whole stdout/stderr strings; the provider streams while running and returns capped tails.
Because the SDK supports everything required, **no second orchestration surface is built**. Scheduling in the Fabric
is *worker selection inside `AcquireLease`*, not a competing job queue.

### Components

```
Paperclip engine 2026.1023.0
   |  environment {driver: sandbox, provider: remote-worker}
   v
plugins/remote-worker          sandbox provider, runs in the engine's plugin process, stateless
   |  HTTP + NDJSON, loopback only, per-organization bearer token   (Control API, section 5)
   v
services/epaperclip  (host service)
   src/fabric/hub.ts           registry, pairing, sessions, leases, scheduler use, audit    (durable in state.json)
   src/fabric/listener.ts      worker WebSocket listener + loopback control listener
   features/fabric.ts          console API /api/fabric/*  (section 4)
   ^
   |  outbound persistent WebSocket from the worker, AEAD-encrypted, Ed25519-authenticated  (section 3)
   |
packages/worker-daemon         systemd service on the node: identity, capabilities, shell, workspaces, inference gate
packages/worker-fabric         shared: secure channel, protocol types, scheduler, transport providers
```

Workers vs the Proxmox sandbox: the Proxmox provider creates a fresh unprivileged LXC per run on the host's own
cluster and deletes it; a remote worker is a *machine you own that keeps running*. `release` only frees scheduler
capacity, `destroy` removes the run's lease and workspace, and **nothing in the provider or the Control API can remove
or power off a node** (tests prove it). Both are managed `sandbox` environments, so the fail-closed policy applies to
both.

## 2. Identity, trust and the three separate concerns

* **Who may approve** a worker: a signed-in Proxmox administrator in the ePaperclip console (this host's own login,
  or a Papercliped-authenticated session where Connect is used). The Fabric stores no user password or OAuth secret
  anywhere, and none is ever sent to a worker. No KpnIdentity / KpnSolute is involved.
* **What a worker may do**: decided by ePaperclip: adoption state, `companies` scope, slot limits, drain/disable, and
  the per-lease checks in the hub.
* **How the two machines reach each other**: a *transport provider* (section 6). Tailscale is never an identity.

Keys: the host has one Ed25519 *fabric key* (private half sealed in the host vault). Each worker has its own Ed25519
key generated on the node (`/var/lib/epaperclip-worker/identity.json`, mode 0600, owned by the service user). The
worker pins the host's public key at adoption; the host stores each worker's public key and its SHA-256 fingerprint.

## 3. Wire protocol (worker to host)

One outbound WebSocket per worker to `ws(s)://<host>:<fabric port>/fabric/v1/connect`. No new protocol family: JSON
messages over WebSocket, wrapped in a small authenticated-encryption layer so that the channel is secure on any
network, including a tailnet, a LAN or the open internet, with or without TLS (TLS on top is allowed and
recommended off-tailnet).

Handshake (a signed ephemeral X25519 exchange; the Noise_XX idea built from `node:crypto` primitives, 100 lines, no
dependency):

1. `C→S hello {v:1, mode:"auth"|"adopt", workerId?, eph, nc}` (plain; `eph` is a fresh X25519 public key, `nc` a
   fresh nonce).
2. `S→C challenge {eph, ns, hostPub, sig}`: `sig` is Ed25519 over `"epw1-host" ‖ eph_c ‖ eph_s ‖ nc ‖ ns`. The
   worker verifies `hostPub` equals the pinned key (at first adoption, the key in the pairing code).
3. Both derive `k_c2s`, `k_s2c` = HKDF-SHA256(X25519 shared secret, salt = SHA256(nc‖ns)). Every following message
   is ChaCha20-Poly1305 with a strictly increasing 64-bit counter nonce per direction; any gap, repeat or tag failure
   closes the socket (replay and reorder proof).
4. `C→S auth {pub, sig, pairing?}` (encrypted): `sig` is Ed25519 over `"epw1-worker" ‖ transcript hash`. In `auth`
   mode the host requires `pub` to equal the stored public key of `workerId` **and** the worker to be `adopted`;
   revoked, pending, disabled-by-revocation or unknown identities are refused with a generic error and no detail.
   In `adopt` mode the host consumes the single-use pairing code atomically, or creates a *pending* request for a
   human to approve.
5. Then request/response RPC and events, all `{id, op, args}` → `{id, ok, result | error}` plus `{id, ev}` streams.

Worker to host messages: `caps` (full capability report, on connect and on change), `hb` (heartbeat every 10 s with
load, free memory, running jobs, inference queue depth), `ev` streams for output. Host to worker ops: `ws.ensure`,
`ws.remove`, `exec` (streamed `out`/`exit`), `cancel`, `caps.refresh`, `infer.status`, `drain`, `revoked`,
`upgrade.check`. A worker holds no listening port for the host; it keeps the outbound connection and reconnects with
jittered exponential backoff (1 s to 60 s). Already-paired workers never contact papercliped.co or Connect.

Pairing codes: `epw1.<base64url JSON>` carrying the host's fabric URL candidates, the host key fingerprint, a pairing
id and a 160-bit secret. Single use, 15 minute lifetime, only the SHA-256 of the secret is stored. A pairing issued
from the console is itself an administrator's approval. Without a code, a worker can ask to be adopted: the host shows
the pending request with its hardware and a short verification string derived from the worker's key; an administrator
approves or denies; pending requests expire after 15 minutes and are capped.

Revocation is durable: the worker record is kept with `state: "revoked"` and its key fingerprint on a deny list. A
revoked identity is rejected at step 4 forever, its live session is closed immediately, and its leases are destroyed.
Adopting the same machine again needs a new key and a new approval.

## 4. Console API (session auth, `X-EPC-Request: 1`, Proxmox administrators only, audited)

All JSON. Errors: `{error, code}`.

```
GET    /api/fabric
  -> { enabled, hostKey:{fingerprint}, listen:{url, port}, transports:[Transport], workers:[Worker], pending:[Pending],
       pairings:[{id, name, createdAt, expiresAt}], environments:[EnvView] }
GET    /api/fabric/workers                       -> { workers: Worker[] }
GET    /api/fabric/workers/:id                   -> { worker: Worker, leases: Lease[], audit: Audit[] }
PATCH  /api/fabric/workers/:id   { name?, companies?: string[]|null, shellSlots?, inferenceSlots?, drain?: boolean, disabled?: boolean }
POST   /api/fabric/workers/:id/revoke            -> { ok:true }   (durable; closes the session; destroys leases)
DELETE /api/fabric/workers/:id                   -> { ok:true }   (only a revoked or never-seen record; the deny list is kept)
POST   /api/fabric/workers/:id/refresh           -> { ok }        (asks the worker for fresh capabilities)
POST   /api/fabric/pairings      { name?, companies?: string[]|null, transport?: string }
  -> 201 { id, code, expiresAt, installCommand }                 (the code is shown once)
DELETE /api/fabric/pairings/:id
GET    /api/fabric/pending                       -> { pending: Pending[] }
POST   /api/fabric/pending/:id/approve  { name?, companies?: string[]|null }  -> { worker: Worker }
POST   /api/fabric/pending/:id/deny
GET    /api/fabric/transports                    -> { transports: Transport[] }   (detection: tailscale, lan, custom)
POST   /api/fabric/environments  { companyId, name?, workerId?, requirements?: Requirements, assignAgents?: string[] }
  -> 201 { environment: EnvView }        (creates the Paperclip environment {driver:"sandbox", provider:"remote-worker"}
                                          with a per-organization control token as a Paperclip secret)
GET    /api/fabric/audit?after=<n>&limit=<n>     -> { events: Audit[], latest: n }
GET    /api/fabric/stream                         -> text/event-stream; events: worker, lease, pending, audit
```

Types (stable):

```ts
Worker   = { id, name, state: "pending"|"adopted"|"revoked", online: boolean, draining: boolean, disabled: boolean,
             fingerprint, version, lastSeen: number|null, connectedSince: number|null, transport: {provider, address},
             companies: string[]|null, shellSlots: number, inferenceSlots: number,
             usage: { shellLeases: number, inferenceRunning: number, inferenceQueued: number, loadAvg: number|null, freeMemMb: number|null },
             capabilities: Capabilities }
Capabilities = { os:{name,version}, arch, hostname, cpu:{model,cores}, memMb, gpu:{present, name?, kind?: "jetson"|"nvidia"|"other"},
                 storage:{path,totalGb,freeGb}[], tools:{git?,gh?,node?,pnpm?,npm?,python?,uv?,docker?,make?,gcc?: string},
                 inference:{ runtime:"ollama", url, models:{name,sizeMb?}[], maxContext?: number }|null,
                 networks:[{provider:"tailscale"|"lan"|"other", address}], workspaceRoot }
Lease    = { id, workerId, companyId, agentId, runId, environmentId, workspace: string, state: "active"|"released"|"stopped"|"destroyed",
             createdAt, releasedAt?: number }
Pending  = { id, name, verification: "ABCD-EFGH", fingerprint, requestedAt, expiresAt, capabilities: Capabilities, remote: string }
Requirements = { arch?: string, tools?: string[], gpu?: boolean, localModel?: string, minFreeMemMb?: number }
Transport = { provider: "tailscale"|"lan"|"custom", label, available: boolean, recommended?: boolean, address?: string, detail: string }
EnvView  = { id, companyId, name, workerId: string|null, requirements, agents: string[] }
Audit    = { n, at, actor, action, workerId?, detail? }
```

## 5. Control API (provider to hub; loopback listener `EPC_FABRIC_CONTROL`, default `127.0.0.1:3130`)

Bearer token per organization (`Authorization: Bearer fct_...`); the hub resolves the token to a company and refuses
any request whose `companyId` differs. The API deliberately has **no** route to add, remove, revoke, power off or
rename a node.

```
POST /control/v1/probe      { requirements?, workerId? }                           -> { ok, candidates:[{workerId,name,online,reasons[]}], summary }
POST /control/v1/leases     { agentId, runId, environmentId, workerId?, requirements?, reuse?, workspaceKey?, needsInference? }
                            -> 201 { leaseId, workerId, workerName, workspace }     409 { code:"no_capacity"|"no_match"|"offline", reasons[] }
POST /control/v1/leases/:id/resume   -> { leaseId, workspace } | 410 { code:"expired" }
POST /control/v1/leases/:id/workspace { mode?: "directory"|"worktree", repo?, ref? }   -> { cwd }
POST /control/v1/leases/:id/exec     { command, args?, cwd?, env?, stdin?, timeoutMs? }
                            -> 200 application/x-ndjson: {"ev":"out","stream":"stdout","data":"..."} ... {"ev":"exit","exitCode":0,"signal":null,"timedOut":false}
POST /control/v1/leases/:id/release   { retain?: boolean }  -> { state }         (frees scheduler capacity only)
POST /control/v1/leases/:id/stop      -> { state:"stopped" }                       (kills the lease's processes, keeps the workspace)
POST /control/v1/leases/:id/destroy   -> { state:"destroyed" }                     (kills processes, removes the workspace and the lease)
```

## 6. Scheduling

Deterministic, in `packages/worker-fabric/src/scheduler.ts`; a pure function over the worker list so it is table
tested. A worker is a candidate only if it is `adopted`, online, not draining/disabled, allows the organization,
matches `arch`, has every required tool, free memory, `gpu`, and the named local model, and has a free **shell slot**.
Shell capacity and **inference capacity are separate**: shell slots default to `max(1, cores/2)`; inference slots
default to 1 per worker with a local runtime. Among candidates the order is: pinned `workerId` first, then lowest
`(shellLeases + 1) / shellSlots`, then fewest total leases, then name, then id. The same input always selects the same
worker. Orion is never hardcoded.

Inference is queued **on the worker**: the daemon runs a loopback *inference gate* in front of the node's Ollama that
admits `inferenceSlots` generations at a time (Orion: 1), queues the rest FIFO, optionally clamps `num_ctx` to the
node's `maxContext` (Orion: 4096), and never starts a second copy of a model. Every command run through the Fabric gets
`OLLAMA_HOST` and `EPAPERCLIP_INFERENCE_URL` pointing at the gate. Model choice is independent of the execution
environment: a cloud-model agent may execute on Orion, and a local-model agent may execute anywhere that has the model.

## 7. Transport providers

`packages/worker-fabric/src/transport.ts` turns "how do I reach the host" into an ordered list of candidate URLs. The
agent logic never sees a Tailscale address.

| Provider | Detection | Address |
| --- | --- | --- |
| `tailscale` (recommended) | `tailscale status --json`, `tailscale ip -4`; uses the existing tailnet | the host's tailnet IPv4 / MagicDNS name |
| `lan` | non-loopback private IPv4 interfaces | host LAN IPs |
| `custom` | operator supplied (VPN, WireGuard, corporate network, reverse proxy) | `EPC_FABRIC_PUBLIC_URL` |

Room is left for `headscale` (it is Tailscale-compatible), `userspace` and a Papercliped Connect `relay` provider by
adding an entry to the provider table; nothing else changes. Because the channel authenticates and encrypts itself, a
provider only has to deliver bytes.

## 8. Worker daemon, installer

`packages/worker-daemon` builds to one bundled file (`epaperclip-worker.mjs`, no npm dependencies) that needs Node 22
or newer (installer checks and prints how to get it). It runs as the unprivileged system user `epaperclip-worker`
under systemd (`Restart=always`, starts at boot), keeps `/var/lib/epaperclip-worker` (identity, config) and
`/workspaces` (default workspace root). Commands: `run`, `adopt <code>`, `status`, `diagnose`, `version`, `caps`.
`deploy/worker/install.sh` is a deterministic script that verifies a SHA-256 checked tarball, checks prerequisites,
creates the user, directories and unit, supports `upgrade` and `uninstall`, and prints the adoption instructions. There
is deliberately no `curl | sh` endpoint.

## 9. Orion

See [WORKER-FABRIC-GUIDE.md](WORKER-FABRIC-GUIDE.md) for the runbook, and the ledger for what was validated on the
real device and what was not.
