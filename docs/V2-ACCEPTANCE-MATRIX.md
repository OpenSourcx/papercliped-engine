# V2 acceptance matrix (ePaperclip engine side)

Created 2026-11-08 by the release-engineering agent (miah). Companion to the Connect V1 matrix
(`OpenSourcx/papercliped-connect` `docs/v1/ACCEPTANCE.md`, 71 items, its own status words), [STABLE-V1-LEDGER.md](STABLE-V1-LEDGER.md) and
[STABILITY-GRADEBOOK.md](STABILITY-GRADEBOOK.md). Rule carried over: no evidence means not verified. **This is not a sign-off.**

**Caveat on the 20 customer tests.** The V2 brief's own text was not available to this agent (not in either repo, `/project/inbox` or `.agents`).
C1-C20 are derived from the owner journey in the ledger, the gradebook's EP/CN/MC rows and the coordinator's list of known gaps.
Map each to the brief's numbering before sign-off; a missing test belongs here as a new row, not as an assumption.

## Statuses (exactly these)

`Missing` / `Partial` / `Implemented-unverified` / `Verified-mocks-or-simulation-only` / `Verified-real-integration-environment` /
`Verified-on-intended-real-device-or-provider` / `Verified-in-production` / `Blocked-by-named-prerequisite`.

"Tested build" is the commit or PR head the evidence was produced on. The integrated engine head is in the last section.
Rollback: for code merged into the reconcile branch, revert the merge commit; nothing from this branch is deployed.
Columns not repeated per row: requirement id = the ID; "deployment status" = "not deployed" unless the row says otherwise.

## A. The 20 customer acceptance tests

| ID | Customer test | Owner (repo / component) | PR / commit | Tested build | Verification procedure | Result and evidence | Limitation / blocker | Status | Deployment | Rollback |
|---|---|---|---|---|---|---|---|---|---|---|
| C1 | Install on a real Proxmox VE 8 host with one command (`get.sh`), signed and verified | engine / `deploy/install.sh`, `get.sh` | rc31; #15 | rc31 (real artifacts); integrated head (trial build) | Run `get.sh` on a Proxmox host; `epaperclip status` healthy | rc31 signature, checksum and pinned key verified (2026-11-08). Real `get.sh` + `install.sh` ran on Debian 12 + systemd with Proxmox stand-ins (RELEASE-PLAN.md section 10). Never run on real Proxmox | Approved disposable Proxmox VE 8 host with root | Blocked-by-named-prerequisite (disposable Proxmox VE 8 host) | rc31 pre-release on GitHub | `epaperclip uninstall` |
| C2 | First run: Proxmox sign-in, 4-step setup, home, mobile 390px | engine / host service + console | #15 | `8857fd1` and earlier | Playwright journey `scripts/live-engine/journey.mjs` against the live host service + real engine 1023, Proxmox faked | 10 journey steps pass; a11y audit 0 findings in 10 views (ledger "Complete owner journey") | Proxmox is a fake | Verified-real-integration-environment | no | revert merge |
| C3 | Console shows an update; one click installs the next release candidate; device restarts | engine / `epaperclip-update.sh` | #15 | integrated trial build | Install rc(n), request update to rc(n+1) through the helper | Live feed `updates.papercliped.co/feed.json` verifies with the pinned key. Real helper upgraded rc32 to rc33 in a Debian 12 + systemd container with Proxmox stand-ins (2026-11-08): `phase=done`; downgrade request refused; RELEASE-PLAN.md section 10 | Not run on a real Proxmox device; Pin/console button not driven (request file written as the host-service user) | Verified-real-integration-environment | feed live (rc channel) | `epaperclip rollback` |
| C4 | Roll back to the previous version after a bad update | engine / `install.sh --rollback` | #13, #15 | integrated trial build | `--rollback` after an upgrade; engine DB restored | Simulation scenarios `rollback`, `broken`, `service_fails`, `drain` pass; rollback through the real helper restored rc32 with its data (RELEASE-PLAN.md section 10) | Engine-pin change on rollback (DB restore) not exercised in the container (same engine pin); large-database migration time not measured | Verified-real-integration-environment | no | n/a |
| C5 | Link the device to a Papercliped account (pairing) | engine `connectLink.ts` + Connect | engine #7-#9, #11 | main | Pair from Access against production Connect | Fakes only; a production action not run | Owner approval for one pairing with a throwaway account | Verified-mocks-or-simulation-only | Connect side live | unpair removes device |
| C6 | "Sign in with Papercliped" (OIDC) on the device console | Connect auth + engine client | Connect OIDC issuer; engine #16 (contract only) | Connect main | Register device client, run code flow | Issuer deployed and live-verified by the Connect agent (coordinator report). Engine client not implemented | Connect review of contract; engine client coding | Partial | issuer live; device side no | n/a |
| C7 | Reach console and MCP from outside through Connect | Connect tunnel + engine client | engine #9 (CN-5/6, MC-5) | fakes | Real tunnel attach, open hostname from another network | Fake Connect, helper and cloudflared only | Real device with cloudflared, entitled throwaway account, outside network | Blocked-by-named-prerequisite (real device + entitled account + outside network) | no | disable remote mode |
| C8 | Self-managed Cloudflare: device creates tunnel and DNS record | engine / provisioning | #20 `f20408e` | integrated head | Provision against a test zone with a scoped token | Fake Cloudflare API only (`cloudflare-provision.test.ts`, `fakes-cloudflare.ts`; `docs/CLOUDFLARE-PROVISIONING-DESIGN.md`) | Scoped token via `tool-request` (broker), test zone, real `cloudflared` | Verified-mocks-or-simulation-only | no | revert merge; delete tunnel |
| C9 | Create an organization with a CEO agent | engine / wizard | #15 | `8bbce77` to head | Journey step 3 against a real engine | Passes; broker step skipped when not configured | Resource groups need the broker | Verified-real-integration-environment | no | delete company |
| C10 | Organization limits enforced on a real host | engine broker + provider | #15 | tests | Contention test on real Proxmox | Provider and broker limits tested with fakes | Real Proxmox host | Blocked-by-named-prerequisite (Proxmox host) | no | n/a |
| C11 | Agent containers: an agent starts in its own LXC | provider `proxmox-sandbox` | #21 `45be134` | integrated head | Create an agent on a Proxmox host; container runs a task | Diagnosis and grant-gap fixes unit-tested (`containers-diagnosis.test.ts`) | Real Proxmox host, template, broker token | Verified-mocks-or-simulation-only | no | revert merge |
| C12 | An agent completes a real task with a real model | engine 1023 | #15 | n/a | Assign a task with real model credentials | Only a stand-in `claude` program ran | Model credentials (owner) and C11 | Blocked-by-named-prerequisite (model credentials + C11) | no | n/a |
| C13 | Connect GitHub/Notion/Slack/Discord through real OAuth; Off/Ask/Allow enforced | engine native apps, `tools:use` | #15, #17 (merged) | `8bbce77` | Real sign-in, then allowed, denied, held action | Enforcement proven on the real engine with a fake provider (ledger "Resume checkpoint") | Real provider OAuth apps | Blocked-by-named-prerequisite (provider OAuth apps) | no | revoke connection |
| C14 | Real GitHub proof: an agent opens a real pull request through an approved action | engine + agent | none | none | Agent PR on a scratch repo after approval | Not attempted | C12 + C13, scratch repo | Missing | no | n/a |
| C15 | Pin chat, plan, held action approved or denied | engine / Pin | #15 | head | Chat with a model; held-action card | Card, enablement, held action: live-engine tests; chat without model shows instruction | Model provider | Partial (held action Verified-real-integration-environment; chat with model blocked) | no | disable Pin |
| C16 | Discord/Slack: inbound message becomes a task and gets a reply | engine channels | #15 | head | Real bot, signed inbound, reply | Dialog and engine refusal live; inbound and outbound not run | Active agent, bot credentials, reachable address | Blocked-by-named-prerequisite (bot credentials + active agent) | no | revoke endpoint |
| C17 | Adopt a remote worker (Orion) and run an agent on it | Worker Fabric | #18 `3ded131`/`7bce3cd`, #19 `9b441e4` | #18/#19 heads | Single-use pairing code, assigned run | Orion adopted over Tailscale (`wrk_d142b0970803`), runs, Ollama inference and queueing measured (`docs/evidence/`, ledger "Worker Fabric"). Agent CLI was a stand-in; UI not run against a live host | Reboot persistence unproven | Verified-on-intended-real-device-or-provider (adoption, runs); UI Partial | no | revoke worker; revert merge |
| C18 | A second Linux worker joins the hub | Worker Fabric | #18 | tests | Second machine adopts and runs | Local processes in tests only | A second Linux machine | Blocked-by-named-prerequisite (second Linux host) | no | n/a |
| C19 | Install, upgrade, revoke a signed community plugin | engine plugins | #15 | head | Against a catalog signed by a first-party key | Proven with a dev-key catalog on the real engine | No first-party key or catalog | Verified-real-integration-environment (dev key) | no | revoke plugin |
| C20 | Subscription gates remote access (billing test mode) | Connect billing + engine states | Connect | n/a | Stripe test-mode checkout, then tunnel allowed or blocked | Device handles `no_entitlement`, `not_ready`, `subscription_needed` (tests); Connect payments simulated in its live E2E | Stripe test mode, C7 prerequisites | Blocked-by-named-prerequisite (Stripe test mode + C7) | Connect billing live | n/a |

## B. Outstanding stable-V1 items carried over

| ID | Item | Owner | PR / commit | Verification | Result and evidence | Blocker | Status | Deployment | Rollback |
|---|---|---|---|---|---|---|---|---|---|
| S1 | EP-1 install on a real Proxmox host | engine | #15 | see C1 | simulated suite passes (root and non-root) | real host | Blocked-by-named-prerequisite (Proxmox VE host) | no | uninstall |
| S2 | EP-10 real-host validation gate | engine | none | gradebook gate | not started | real host | Blocked-by-named-prerequisite (Proxmox VE host) | no | n/a |
| S3 | CN-5 tunnel client attaches a real tunnel | engine + Connect | #9 | see C7 | fakes | device + entitlement | Verified-mocks-or-simulation-only | no | disable remote |
| S4 | CN-6 / MC-5 remote console and MCP via managed hostname | engine + Connect | none | see C7 | not started | device + entitlement | Missing | no | n/a |
| S5 | Real provider round trips (forms, manual OAuth client, callback) | engine | #15 | see C13 | not run | provider apps | Blocked-by-named-prerequisite (provider OAuth apps) | no | n/a |
| S6 | Broker tied to allocation path; disk aggregation | engine | #15 | see C10 | fakes | real Proxmox | Blocked-by-named-prerequisite (Proxmox host) | no | n/a |
| S7 | First-party plugin catalog key and catalog | owner | none | generate key, publish | none exists | owner decision | Blocked-by-named-prerequisite (owner key generation) | no | n/a |
| S8 | Identity linking implementation | engine + Connect | #16 (contract) | per contract | proposed; open questions unanswered | Connect review | Partial | no | n/a |
| S9 | Self-managed Cloudflare provisioning | engine | #20 | see C8 | fake API only | broker request + zone | Verified-mocks-or-simulation-only | no | revert |
| S10 | Accessibility beyond keyboard/touch | engine console | #15 | screen-reader pass | automated audit clean; no screen reader | tester | Partial | no | n/a |
| S11 | Branch protection on `main` | owner | none | commands in RELEASE-PLAN.md | `branches/main/protection` answers 404 (2026-11-08) | owner/admin | Blocked-by-named-prerequisite (owner action) | no | delete rule |
| S12 | Release signing and update feed | owner + CI | rc31 | verify published rc31 and feed with the pinned key | Both verify against `deploy/release-signing.pub` (2026-11-08). Key only in CI secret; no offline backup or rotation drill evidenced | owner: backup, tag rules, environment reviewers | Verified-in-production (rc channel); stable channel Missing | rc31 + feed live | withdraw via `deploy/withdrawn-releases.txt` |
| S13 | Stable APT repository | CI | main `339470d` | tag a final release; fetch `InRelease` | `updates.papercliped.co/apt/dists/stable/InRelease` and `apt.papercliped.co/...` answer 404 (no final release) | first final tag | Missing | no | n/a |
| S14 | Worker reboot persistence (Orion) | Worker Fabric | #18 | reboot node | not proven (linger off) | owner approval to reboot Orion | Blocked-by-named-prerequisite (owner approval) | no | n/a |
| S15 | Pin tool execution with a real provider | engine | #15 | real provider | Option A verified with a fake provider on a real engine | provider apps | Verified-real-integration-environment | no | n/a |
| S16 | Fabric test `adopts a worker with a single-use code` is timing-flaky | Worker Fabric | #19 CI runs 42437519525, 42437990252 | rerun | failed twice on #19 CI, passed on #18 and locally with identical service code | author fix: wait for `w.files.config().workerId` | Partial (CI reported green by coordinator on later heads) | no | n/a |
| S17 | `worker-daemon` `gate.test.ts` "runs one generation at a time" failed once under heavy machine load (integrated-head suite, other agents building), then passed 3 of 3 alone and in the full run | Worker Fabric | #18 | rerun on an idle runner | timing-sensitive, not reproduced | author: widen timing margins | Partial | no | n/a |

## C. Cross-repo items (not engine-owned, from the coordinator)

| ID | Item | Status | Basis |
|---|---|---|---|
| X1 | Website V2 (papercliped PR #48) | Verified-in-production | merged, observed live by Codex (coordinator report) |
| X2 | Connect auth fix (PR #35) and OIDC issuer | Verified-in-production | deployed, live-verified by the Connect agent with throwaway accounts (coordinator report; not re-checked here) |

## D. Integrated head

See the last section of [RELEASE-PLAN.md](RELEASE-PLAN.md) and the PR #15 description for the integrated head SHA and CI run.
