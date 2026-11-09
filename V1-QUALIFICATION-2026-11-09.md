# Papercliped V1 — Qualification Report, 2026-11-09

**Recommendation: NO-GO for a stable release today.** The two release-critical defects found (Agent Containers setup for non-`root@pam` admins; the Engine ↔ Connect identity contract) are fixed in open PRs and verified, but most of the qualification matrix was not run. See "Not done".

## 1. What is deployed on `pve` right now

| | |
|---|---|
| Host | `pve` 192.168.1.200, Proxmox VE 9.2.25, x86_64 (amd64) |
| Installed | `/opt/epaperclip/VERSION` = `pinned-b09af44` (source `b09af44bbd922ad76066768d4a4a1f96b1c4b342`, branch `fix/keyctl-root-only`) |
| Previous | `pinned-c7187d9` (= `main` after PR #33), before that `v1.0.0-rc32` |
| Engine | Paperclip `2026.1023.0` (unchanged → no engine DB migration) |
| Health | `epaperclip` and `epaperclip-engine` active; console HTTPS 200; engine `bootstrapStatus: ready` |
| Broker | `epaperclip-broker` disabled/inactive — same as rc32 |

**The host runs an unmerged branch**, not `main`. It was deployed to re-test fix #1 on real hardware. Roll back to `c7187d9` with `epaperclip rollback`, or deploy `main` after PR #34 merges.

Both deploys used the commit-pinned installer (`EPC_COMMIT`, PR #33): fetched the script from the same SHA; the script verifies built `HEAD` equals the SHA. Exit code 0 was not taken as success: version file, units, health endpoint, state files and guests were checked afterwards.

**Backups / rollback evidence:** `/root/epc-preupgrade-20261109-045451` and `-050312` (state.json, vault.key with SHA256SUMS, latest engine dump). `/opt/epaperclip.prev` retained by the installer. Hourly engine DB dumps continue. `vault.key` verified byte-identical after the first deploy; `state.json` keys unchanged. Rollback itself was **not exercised**.

## 2. Preflight facts (read-only, before any change)

Guests CT 100, CT 103, VM 9100 running; VM 102 stopped — none touched. `drive2`: xfs, `rw,relatime,inode64`, 1.8 TB free (confirms the handoff). `/opt/epaperclip.prev` = rc31. A cached `debian-13…13.6-1_arm64` template (the CT 104 failure) is still on `drive2`; the code now ignores it.

## 3. Agent Containers (scenario 1)

| Step | Result |
|---|---|
| Architecture selection | **PASS.** Host arch `amd64`; `debian-13-standard_13.6-1_amd64` downloaded; Proxmox task log: `Detected container architecture: amd64` |
| Storage preflight | **PASS.** `drive2` verdict `ok` (xfs) from the API |
| Unprivileged LXC start | **PASS.** `vzstart:104` `TASK OK` (the original CT 104 failure was the arm64 rootfs) |
| Provisioning (SSH, Node, agent tools) | **PASS** (ran ~10 min, no error) |
| Template conversion | **PASS**, with defect #2 below. `pct config 104`: `template: 1`, `unprivileged: 1`, `arch: amd64` |
| Reaches Ready | **PASS on resume.** `state: ready`, `job: done`, environment created for each org |
| Idempotent resume | **PASS.** Second run reused template 104, did not rebuild |
| `keyctl=1` accepted? | **NO** — see defect #1. `nesting=1` alone is accepted and the container boots |

Not verified: provider-installed binaries inside the template by direct inspection (the run completed without error; I did not open a shell in CT 104), the 3-failure force-retry path, a second host architecture.

### Defects found and fixed (PR OpenSourcx/papercliped-engine#34, branch `fix/keyctl-root-only`)

1. **`keyctl=1` is `root@pam`-only.** Setup by any other administrator failed at container creation: `changing feature flags (except nesting) is only allowed for root@pam`. Fix: retry once with `nesting=1`. Verified on `pve` (this is what produced the working template). *Caveat:* a root@pam run still asks for keyctl; that path was not run, and I did not confirm systemd 257 needs keyctl — the container booted without it.
2. **Template flag read too early.** After a successful conversion the first config read missed `template: 1` and failed the whole ~10-minute build ("Proxmox didn't mark the container as a template"). Fix: poll up to 10 s. *Cause is inferred, not proven*; the polling fix itself was **not** re-run on hardware (it was pushed after the last deploy).
3. **Failure counter not reset.** `templateAttempts` stayed at 2 in a Ready setup (one more failure from the forced-retry lock). Fix: reset when a usable template is found. Not re-run on hardware.

Note: sandbox probes clone the template by full `rsync` copy on dir storage — about 5 minutes per clone on `drive2`. Not a bug, but it dominates first-agent latency.

## 4. Organization → agent lifecycle (scenario 2, partial)

Run as a temporary `epcqual@pve` Administrator (created and deleted by me; confirmed gone).

| Check | Result |
|---|---|
| Create org `QUAL-20261109` via engine | PASS |
| Org without a resource group gets no shared environment | **PASS** (only KpnSolute had one) |
| Resource group (4 cores/8 GiB/32 GiB/2 guests) | PASS: pool `epc-qual-20261109`, ACL step done, own environment `b673f9ae…` created |
| Provisioning state of that group | **`failed`** — broker step: "The local resource broker isn't answering yet." The broker has a management token but is disabled (as on rc32). Truthful, but the group shows failed although the org works. Left as is; enabling the broker is a service change |
| `onboarding-seed` → CEO + first issue | PASS: agent `role: ceo`, issue created |
| Environment binding | PASS (asynchronous — a readiness call made immediately after seeding saw `no_environment`; a few seconds later it was bound to the **org's own** environment, not KpnSolute's) |
| Honest blocked state | PASS: `credential_missing`, `agent_paused`; `ready: false` |
| Sandbox runs in a real LXC | **Partial.** The engine cloned template 104 into CT 101 (description names this org, environment and run) via the sandbox token, then destroyed it. I did not observe an agent executing inside it |

**Not done:** model connection (no test credential supplied), first task execution, persisted result, allocation-limit enforcement, non-admin owner permissions.

## 5. Engine ↔ Connect identity contract

Reproduced with the **real** engine `IdentityLinks` against the **real** Connect control plane and Postgres 17 (disposable Docker container, since removed).

| | Before | After (Connect PR OpenSourcx/papercliped-connect#37) |
|---|---|---|
| Engine `start` | Connect refuses: `not_available` (engine signs `linkId`; Connect's `FIELDS.start` has none) | accepted |
| Row id | database-generated; engine would reject the mismatch | device-generated `linkId` stored |
| Code hash | Connect hashed code only; engine hashes `linkId` + code | both bind `linkId` |

The authoritative contract (`docs/ACCESS-IDENTITY-LINK-CONTRACT.md` lines 31–33) already specifies the device-generated id, so **Connect was the side that deviated**; the engine needed no change. Signature verification, skew window, rate limits, session binding, the 5-attempt lock, step-up and ownership checks are untouched.

Evidence: new `tests/engine-contract.test.mjs` fails on `main` and passes on the branch (start → wrong code 403 → approve → poll → other-session confirm refused → confirm → `active`). Connect full suite, serial: 130 pass / 0 fail on both baseline and branch.

**Not checked:** timestamps/expiry, cancel, reconcile, OIDC register/rotation against the engine; `tests/live/oidc-live.mjs` (edited, not run). Not deployed anywhere. **Local identity-link Console UI was not built** (the handoff's unfinished surface). Federation stays disabled; nothing public was changed.

## 6. Test suites

Engine `services/epaperclip` vitest: 1070 pass / 90 fail / 22 skipped — **identical on `main` and on `fix/keyctl-root-only`**. All 90 are in `test/app.test.ts`; one cause seen is the test writing a hardcoded `/tmp/secret.txt` that is root-owned on agent-dev. The handoff's "1160 passed" equals 1070+90, so these fail only because of this environment. Not investigated further. `tsc --noEmit` clean. Containers tests 56/56.

## 7. TestSprite

**No test cases were created or run.** Only discovery: `testsprite` 0.16.0 is installed and authenticated under root (`sudo -n testsprite`); it warns the project verification skill is not installed. Browser, 390 px mobile, accessibility and the rest of the functional matrix: **not done**.

## 8. Not done (no result — do not read as pass)

Scenarios 3 (model auth), 4 (non-admin Proxmox permissions), 5 (Jev), 7 (Cloudflare modes), 8 (Pin), 9 (Worker Fabric cancellation), 10 (upgrade/restart persistence beyond the two upgrades above, which kept state), and the TestSprite campaign. Also not built: local identity-link Console UI.

## 9. Left behind on `pve` (intentional, please review)

- Org `QUAL-20261109`, its CEO agent and issue, pool `epc-qual-20261109`.
- Template CT 104 (needed by KpnSolute's environment) and engine-managed sandbox CT 101 (stopped; the provider recreates/destroys these).
- `/root/epc-preupgrade-*` backups.
- Temporary user `epcqual@pve`, its ACL, helper scripts and password: **removed**.

## 10. Blockers / next

1. Merge PR #34 (engine) and #37 (Connect); redeploy `main` by pinned SHA; re-run first-time setup from a clean template to prove fixes #2/#3 and the root@pam path.
2. Supply a model test credential to complete model auth → first task → persisted result in a real LXC.
3. Decide whether a disabled broker should mark a resource group `failed`.
4. Run the TestSprite campaign and the remaining scenarios; build the identity-link UI.
