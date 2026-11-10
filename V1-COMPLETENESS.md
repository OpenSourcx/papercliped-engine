# Papercliped V1 — Completeness

Status: **implementation complete and ready for testing.** This is a release candidate, not a production release. The
comprehensive TestSprite/browser/physical-host qualification is the next step (Claude). Nothing in this document claims
that hardware tests have already passed.

Date: 2026-11-09. Repository: `OpenSourcx/papercliped-engine`. Integration branch: `v1/integration` (merged to `main`).
Base: `d5f484f`.

---

## 1. What "complete" means here

The intended V1 flow is connected through real code, not placeholders:

```
Install ePaperclip → Sign in → Configure Agent Containers → Create organization → Allocate resource group
→ Create CEO → Connect model → Create and execute task → Use Pin → Configure remote access
→ Pair Papercliped account → Access the system remotely
```

Every step below is backed by a host route, an engine API call, and a console surface. What is *not* claimed: that the
flow has been exercised end to end on the physical Proxmox host with a deployed build. That is tomorrow's work.

---

## 2. The confirmed Agent Containers failure (real host evidence)

Host `pve` (`192.168.1.200`, Proxmox VE 9.2.25, Intel Xeon W3520, **amd64**). The failed container was CT 104 on
storage `drive2`.

The host's own `vzcreate:104` task log:

```
extracting archive '/mnt/pve/drive2/template/cache/debian-13-standard_13.6-1_arm64.tar.zst'
Detected container architecture: arm64
```

The `vzstart:104` task log only said:

```
sync_wait: 34 An error occurred in another process (expected sequence number 7)
__lxc_start: 2288 Failed to spawn container "104"
WARN: Systemd 257 detected. You may need to enable nesting.
TASK ERROR: startup for container '104' failed
```

**Cause:** an arm64 root filesystem was unpacked on an amd64 host. `/sbin/init` cannot execute, so LXC reports only that
the init process died. The nesting warning was a red herring.

**Ruled out with real evidence:** `drive2` is xfs on `/dev/sdb1`, mounted `rw,relatime` (not ntfs/exfat, not
noexec/nodev/ro); `/etc/subuid` and `/etc/subgid` contain `root:100000:65536`; `/sys/fs/cgroup` is `cgroup2fs`;
`user.max_user_namespaces` is 116600. The storage-ownership, idmap, cgroup and namespace hypotheses do not apply.

**Fix:** the template is selected for the host's architecture, the created container's architecture is verified from
Proxmox's own task log, the template architecture is recorded and a wrong-arch template is rebuilt, and the template is
created with `nesting=1,keyctl=1`. Storage capability is now read from `/storage/{id}` and
`/nodes/{node}/disks/directory` instead of guessed.

---

## 3. Implemented, by lane

### Lane A — Agent Containers and Proxmox (`v1/agent-containers`)

Commits: `574eb10`, `f5046cb`, `da2786c`.

| Area | What changed |
| --- | --- |
| Template architecture | `newestDebian(files, arch)`; `hostArch()`; verify `Detected container architecture` from the create log; `templateArch` recorded; wrong-arch template rebuilt; clear error when the catalogue has no image for the host. |
| Nesting | Create with `nesting=1,keyctl=1`; re-read the config after creation and set the features if Proxmox did not apply them. |
| Storage capability | `storageVerdict()` + `storageFacts()` from `/storage/{id}` and `/nodes/{node}/disks/directory`: refuse ntfs/exfat/fat/fuseblk, `noexec`, `ro`; warn on network shares and `nodev`; verdict `unknown` with the exact `findmnt` command when the API cannot report the filesystem. |
| Resume | Setup snapshots what is already in place and marks completed steps “already in place”; a changed host setting is never treated as a resume. |
| Host settings without a rebuild | `POST /api/agent-containers/settings` validates the new storage, grants the token’s rights and updates every organization’s environment; the template is kept. |
| Retry bound | Consecutive template failures counted; after three, an explicit “Try the template again” (`steps/template` with `force: true`) is required. |
| Organization isolation | An organization without a resource group no longer receives the shared `epc-agents` environment; it gets an environment only for its own pool, and the setup says why. |
| Diagnosis | New `template-arch-mismatch` cause; 19 known causes total, evidence redacted. |
| Console | Storage verdicts, host architecture, retry action, apply-changes action. |
| Standalone builder | `build-template.sh` uses `dpkg --print-architecture` and `nesting=1,keyctl=1`. |

### Lane B — Organizations, agents and readiness (`v1/org-lifecycle`)

Commit: `4d6bc64`.

- Resource-group repair: a stored group whose Proxmox pool was deleted outside ePaperclip is recreated under the same
  name; a Proxmox refusal is returned as `proxmox_rejected` and no group is persisted.
- Verified against `@paperclipai/server@2026.1023.0`: `onboarding-seed` creates the real CEO agent (structural `role:
  ceo`) and a real first issue; the model step patches `adapterType`. No parallel orchestration was introduced.
- New `GET /api/agent-readiness?companyId=…` (members only) computes `ready` from live engine data: adapter supported
  for sandbox, a credential (AI connection, agent environment binding, or engine auth signal `present`), and an active
  sandbox environment owned by the organization. `unknown` auth is never ready. Returns per-check issues.
- Console consumes the endpoint (`host.agentReadiness`, `useAgentReadiness`, `Agent.readiness`).

### Lane C — Identity, Connect and Cloudflare (`v1/connect-access`)

Commits: `e6252e3`, `367d815`, `9ff6429`.

- Reused PR #30’s token popup on Remote access; fixed Resume/Replace to use the deployment’s recorded zone and label.
- Connect pairing: a denied/cancelled approval is reported immediately; a stale pairing token is removed on proof
  failure.
- Device-side identity links (contract v2.1): start/status/poll/confirm/cancel, list/unlink, link-requests, admin
  approve/deny, pre-approvals, reconcile, principal revocation. PKCE-style verifier sealed in the vault and deleted on
  every terminal path; session-bound confirm; exact approved account checked; no implicit role or ACL.
- “Sign in with Papercliped”: per-device OIDC client registration, only the agreed `papercliped` Proxmox realm, a local
  link gate that refuses a federated ticket without an active link, 8-hour federated sessions, and unlink that ends
  exactly the sessions/grants carrying the link.
- Unpair revokes identity links before forgetting the device; a 15-minute reconciler retries pending revocations
  independent of the access mode.

### Lane D — Console and onboarding (`v1/console-onboarding`)

Commits: `34443fe` (PR #31 cherry-pick), `c998202`.

- The model step re-reads the persisted agent: an existing connection shows `Next`/`Connected`; “Skip for now” is
  carried to the task step, which states plainly that the agent cannot execute and offers “Connect a model”.
- Replaced the silent container spinner with real host state: containers not set up, environment missing, unhealthy,
  query failure with retry, and a working “Create it now” action.
- Readiness pill and panel on agent cards, the agent header and the Overview tab, with the three checks and blockers.
- Dashboard’s setup step counts subscription/Vault-backed model connections, not only org AI connections.
- V2 language: “Papercliped family” card in Settings (ePaperclip, Pin, Papercliped MCP, Connect); engine `active` is
  labelled **Active**, not **Ready**.

> Integration decision: Lane D’s pill/panel and Lane B’s endpoint overlapped. The merged hook asks the host service first
> and uses its three checks as the authoritative answer; the multi-signal derivation remains only as the fallback when the
> endpoint is absent, and a bare `{ ready }` without checks stays conservative (derived blockers win). Lifecycle stops
> always win.

### Recovered fixes integrated

Two commits from the pre-existing recovery branches were reviewed and merged:

- `6ea6c98` (recovered `130acd9`) — Worker Fabric: set the lease state before cancelling processes on stop/release and
  delete the lease before destroying it, so an exec arriving during cancellation is refused; regression test included.
- `0ebea29` (recovered `2e595c9`) — de-flake the worker-daemon gate-ordering test (poll instead of a fixed sleep), which
  was the only intermittent failure observed in the integrated run; passed three consecutive runs afterwards.

### Lane E — Jev task routing (`v1/jev-routing`)

Commit: `843d0f2`.

- Ported `packages/task-router` (18 tests) and `packages/model-eval` (11 tests) from PR #28, keeping the existing
  interfaces (`TaskContract`, `RouteDecision`, `createTaskRouter`, `createJevProvider`, `createOrgRouter`).
- Ported the host-side per-organization route, vault key and decisions from PR #29.
- New `task-router-assign.ts`: decision → selected agent → real engine issue → execution environment → escalation;
  deterministic agent choice (explicit tier mapping, then adapter match, preferring the target environment). Reports
  `unassigned` with a reason instead of guessing.
- Decisions persisted (last 100 per organization) with task facts, agent, environment, issue id, delegation and
  escalation chain.
- High-risk tasks (auth, tenancy, billing, permissions, secrets, Proxmox, …) escalate to Claude and are never sent.
- Consent gate: `active = enabled && key && consent`; an internal `TYPESAFE_API_KEY` is not consent. **TypeSafe is not
  configured**, so the deterministic rules fallback is what runs; no external API call was made or claimed.

---

## 4. Products and how each was built

| Product | Where | How it is built |
| --- | --- | --- |
| **ePaperclip host service** | `services/epaperclip` | TypeScript, Node 22 ESM, no web framework (a small router in `http.ts`/`app.ts`), systemd unit. One process serves the console TLS, the Proxmox API proxy, the engine gateway, Pin, the model router and Agent Containers. State is JSON under `EPC_STATE_DIR`; secrets go to the vault and are never returned to a browser. Bundled with esbuild to `dist/epaperclip.mjs`; unit tests in vitest. |
| **ePaperclip Console** | `apps/console` | React + TypeScript + Vite, TanStack Query for all server state, a custom design-token system (no component library), lucide icons, xterm/noVNC for terminals. `tsc --noEmit && vite build`. |
| **Proxmox sandbox provider** | `plugins/proxmox-sandbox` | A standalone Paperclip plugin against `@paperclipai/plugin-sdk@2026.1023.0` (outside the pnpm workspace, own lockfile). Clones an unprivileged LXC from the built template, starts it, waits for SSH, and runs agent commands over `ssh`. Template built by `template/build-template.sh` / `provision.sh` with pinned Node.js and agent CLI versions in `versions.sh`. |
| **Worker Fabric** | `packages/worker-fabric`, `packages/worker-daemon`, `services/epaperclip/src/fabric`, `plugins/remote-worker` | TypeScript WebSocket hub (leases, heartbeats, cancellation) plus a daemon package and a remote-worker plugin. |
| **Pin** | `services/epaperclip/src/pin.ts`, `apps/console/src/pages/pin*` | In-process assistant: a tool-calling loop with a fixed tool list (host state, vault read for admins, organizations, apps, approvals), SSE streaming, provider retries, and approval records. It is not a second orchestrator. |
| **Jev** | `packages/task-router`, `packages/model-eval`, `services/epaperclip/src/task-router-*.ts` | Pure TypeScript packages: deterministic classifier, routing table, TypeSafe client, rules fallback, and a model-evaluation harness. Host feature routes own per-organization consent and persistence. |
| **Papercliped website + MCP** | `/project/papercliped` @ `41bc270` | Separate repository (MCP server in `src/`, website in `web/`). The V2 “power of the Pin” site is already merged; this session used it as the product contract and did **not** change it. |
| **Papercliped Connect** | `/project/papercliped-connect` @ `5e1d012` | Separate Node monorepo (`apps/`, `packages/`, `node --test`). Identity-link routes and the OIDC issuer are implemented and merged (`9ede4fb`), not deployed. The device side is integrated here. |

---

## 5. Systems and tools used

| System | Use in this session |
| --- | --- |
| **OpenCode** | Lead implementation and integration. One lead plus four bounded subagent lanes (`general` agent), each in its own git worktree/branch; the lead implemented Agent Containers and merged the result. |
| **Claude Code** | Not consulted in this session. Architecture decisions were grounded in the pinned upstream contracts and real host evidence. Claude performs the independent refinement/qualification pass tomorrow; no review was impersonated. |
| **Jev / TypeSafe** | TypeSafe key is **not configured**; the deterministic rules fallback is the routing path. No fabricated Jev decisions, no outbound task text. |
| **Proxmox VE** | Real host `pve` inspected read-only: task logs, storage config, filesystem/mount, subuid/gid, cgroups, installed ePaperclip (`v1.0.0-rc32`). No guest, storage, network or service was changed. |
| **GitHub** | `OpenSourcx/papercliped-engine`, `papercliped`, `papercliped-connect`; merged lanes pushed to `main` and summarised as a PR. |
| **Toolchain** | Node 22.23, pnpm 10.28, TypeScript, vitest, esbuild, Vite/React, TanStack Query. |
| **TestSprite** | Installed on agent-dev but **not run** in this session; reserved for tomorrow’s functional/browser campaign. |

---

## 6. Verification performed (and what it does not prove)

| Check | Result |
| --- | --- |
| `pnpm -r typecheck` (12 workspace projects) | **passed** |
| `services/epaperclip` vitest | **1160 passed / 22 skipped** (73 files) |
| `apps/console` vitest | **576 passed** (57 files) |
| `packages/proxmox-client` | **114 passed** |
| `packages/task-router` / `packages/model-eval` | **18 + 11 passed** |
| `packages/worker-daemon` | **4 passed, three consecutive runs** (after the recovered de-flake) |
| `services/host-broker` | **21 passed** |
| other packages (automations, marketplace, os-library, engine-client, worker-fabric) | **16 + 6 + 9 + 14 + 17 passed** |
| Workspace total | **1966 passed / 22 skipped** |
| Host-service esbuild bundle | **builds** (`dist/epaperclip.mjs`) |
| Agent Containers host evidence | **real** (task logs and mount state above) |

What these checks do **not** prove: real Cloudflare/DNS operations, the deployed Connect identity/OIDC path, TypeSafe’s live
response shape, model authentication and a first-task run on real hardware, or browser/mobile behaviour. Those remain the
qualification work.

**Real-host result already observed (2026-11-09, miah1).** The candidate was deployed to `pve` (`pinned-b09af44`, which
contains PR #34) and Agent Containers scenario 1 passed: the amd64 template downloaded and unpacked correctly, the
unprivileged container started, provisioning completed, the container converted to a template, setup reached **Ready**,
and a re-run resumed idempotently. `keyctl=1` is only settable by `root@pam` on this host; setup now falls back to
`nesting=1` when needed. Organization creation, a resource group, the CEO agent and the first issue also worked; readiness
reported `credential_missing` / `agent_paused` honestly.

Not yet exercised on real hardware: model authentication, the first-task execution, Pin, Jev, Worker Fabric, Cloudflare,
non-admin permission checks, and TestSprite. Two later Agent Containers fixes (late template-flag poll, failure-streak
reset) were pushed after that host run and have not been re-exercised.

**Final candidate deployed (2026-11-10).** `main` at `6171c8a` was built and installed on **pve** and the disposable
**VM 9100** as `pinned-6171c8a`: services active, `GET /api/health` `{"ok":true}`, console serving. It includes the
setup-persistence fix (#40), the template-ACL fix (#39), the broker-skip decision (#38), the UI wayfinding fixes
(#35, #37), the Agent Containers fixes (#34) and the test-fixture fix (#36).

Agent Containers is **Ready** on both hosts: pve has template CT 104 and 2 environments; VM 9100 (a clean PVE 8.4
nested test host) built template CT 100, installed the provider, created its organization environment and enforced
sandbox-only. A second browser on VM 9100 skips onboarding, confirming the setup is device-wide. The broker remains
disabled and is a skipped step, not a failed organization. The Playwright harness and screenshots are in
`/home/agent/epc-ui`; environment details are in `/project/claude-handoff/TEST-ENVIRONMENTS.md`.

**Cloudflare:** `kpnsolute.com` is on Cloudflare and `local.kpnsolute.com` is free, but pve's stored token is invalid
(`Zone: Read` missing), so no publication was created. A valid token is the only blocker for the `local.kpnsolute.com`
test address.

---

## 7. Outstanding environmental blockers

1. **The final candidate is deployed; the remaining scenarios are not run.** Agent Containers is Ready on real hosts
   (pve and VM 9100); model auth/task, Pin, Jev, Worker Fabric, Cloudflare, non-admin checks and TestSprite remain. The
   broker is disabled; that is now `skipped`, not `failed`.
2. **Connect-side identity routes and the OIDC issuer exist and are merged, but are not deployed.** Device-side identity
   links and “Sign in with Papercliped” are implemented against them (`papercliped-connect` main `5e1d012`, identity-link
   commit `9ede4fb`; `identity-links.test.mjs`, `engine-contract.test.mjs`). The remaining gap is deployment and live
   qualification, not missing code.
3. **No console UI for identity links.** Host APIs and tests exist; the Access panel was not extended.
4. **Self-managed Cloudflare live attach** was not exercised (no live token/zone). Provisioning code and tests are in
   place.
5. **Jev TypeSafe key not configured.** Rules fallback is active; the real API’s response shape is unverified.
6. **Readiness conservatism.** Grok account sign-in without a visible credential can show `unknown`; viewers may see
   `unknown` because the engine’s auth-signal needs agent-create permission. This never produces a false “Ready”.
7. **Broker cleanup on resource-group deletion** is not implemented; the pool/mapping is removed, the broker group policy
   is not.
8. **Model test credential / quota** is the blocker for model authentication and the first real agent task. pve Claude
   and Codex are usage-limited until 2026-11-12; miah2's Claude account works.
9. **Cloudflare token is invalid.** pve's `publisher.cloudflare.apiToken` fails with `Zone: Read` missing, so
   `local.kpnsolute.com` was not created. A token with `Zone:Read`, `DNS:Edit`, `Cloudflare Tunnel:Edit` is required.

---

## 8. Deployment and tomorrow’s qualification handoff

### Deploy the candidate (owner authorization required; restarts the service)

```sh
# on pve, as root; the built HEAD must equal the SHA
SHA=6171c8ab5b3cb0b548805279aad9c5c8bfc46e4c
curl -fsSL https://raw.githubusercontent.com/OpenSourcx/papercliped-engine/main/deploy/from-source.sh | EPC_COMMIT=$SHA bash
systemctl status epaperclip --no-pager
```

The installer builds on the host with its pinned Node.js, builds both plugins, installs `/opt/epaperclip`, and restarts
the unit. It does not touch guests, storage or networking.

### Scenarios for Claude (physical host `pve`)

1. **Agent Containers / `drive2`.** Open Settings → Agent containers. Expect the host architecture (`amd64`), `drive2`
   reported as xfs/ok, the template built from `debian-13-…_amd64`, `nesting=1,keyctl=1`, and the job reaching `ready`.
   If it fails, use the shown `lxc-start -n <id> -F -l DEBUG` command and the expandable evidence. Re-run setup once to
   prove resume does not recreate the template.
2. **Organization lifecycle.** Create an organization; confirm a Proxmox pool `epc-<slug>`, a persisted resource group,
   an active sandbox environment, a CEO agent with `role: ceo`, and a real first issue. Confirm no organization without a
   group gets the shared pool.
3. **Model authentication.** Connect one subscription sign-in and one API key; confirm the credential lands in the vault
   / engine secret reference, the agent gets `adapterType`, and readiness flips only when all three checks pass. Test
   “Skip for now” and the honest blocked state.
4. **Proxmox permissions.** Use a non-admin organization owner and an admin; confirm only `Sys.Modify` can set up
   containers, that the token stays privilege-separated, and that `/access/permissions` agrees.
5. **Jev.** With no TypeSafe key: confirm rules-fallback decisions are persisted and no network call is made. With a key
   and explicit organization consent: confirm only goal/files/expected-size are sent and a high-risk task escalates
   without being sent.
6. **OAuth / identity.** Connect-side identity links and the OIDC issuer are merged (`5e1d012`, `9ede4fb`). Deploy them,
   then exercise pairing, authorization, link approval, “Sign in with Papercliped”, unlink/revocation, and local Proxmox
   login as recovery. Verify no implicit ACL and correct session termination.
7. **Cloudflare modes.** Local-only, self-managed Cloudflare (token popup, permissions, tunnel/DNS, resume, teardown),
   and Connect managed mode; confirm the modes stay exclusive and local admin survives a Connect outage.
8. **Pin.** Ask it to explain the host, propose a plan, inspect a failed container, and submit an approved operation;
   confirm approvals and cancellation.
9. **Cancellation.** Verify the integrated Worker Fabric lease-cancel fix (`6ea6c98`): no exec is admitted after a lease
   is reported stopped, and a late command returns `lease_inactive`.
10. **Installer recovery.** Upgrade on a host with existing organizations, restart the service, and confirm state,
    secrets, environments and agents survive.

---

## 9. Definition of implementation-complete — checklist

- [x] Agent Containers: architecture, storage capability, resume, settings, retry bound, isolation.
- [x] Organization → resource group → environment → CEO → model → first task, persisted through engine APIs.
- [x] Truthful per-agent readiness from live engine data.
- [x] Model connection UI and readiness surfaces; skip is honest.
- [x] Device-side identity links and Sign in with Papercliped, behind existing contracts.
- [x] Self-managed Cloudflare token UX and resume correctness.
- [x] Jev routing package and assignment path with deterministic fallback and consent gate.
- [x] Pin/Jev interoperability at the API level; no second orchestrator.
- [x] Typechecks and unit/integration suites on the integrated branch.
- [x] Recovered Worker Fabric cancellation fix and the worker-daemon de-flake integrated and tested.
- [x] Deployed to `pve` and VM 9100; Agent Containers reached **Ready** on real hardware (`pinned-6171c8a`, 2026-11-10). Setup persistence and the template ACL are verified.
- [ ] Remaining real-host scenarios: model auth + first task, Pin, Jev, Worker Fabric, Cloudflare, non-admin checks.
- [ ] Connect identity/OIDC **deployed** and exercised on real infrastructure — merged (`5e1d012`, `9ede4fb`), not deployed.
- [ ] TestSprite/browser/mobile campaign — **tomorrow (Claude)**.

**This is not a production-ready declaration.** It is a complete, integrated candidate for independent verification.
