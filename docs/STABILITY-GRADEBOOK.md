# ePaperclip stability gradebook

Updated: 2026-11-04. Stable release is **not yet qualified**. Paperclip Connect and marketing follow qualification.

## Reference and acceptance rule

The behavioral reference is the exact bundled `paperclipai` / `@paperclipai/server` / `@paperclipai/shared` version **2026.1005.0**, plus the native Paperclip source audit. The published server package was inspected directly for tool-access, chat-channel, provider callback and authorization contracts. The engine client's checked-in OpenAPI document guards route compatibility.

Use native Paperclip to check what users can accomplish. Keep ePaperclip's own components, spacing, tokens and navigation. A catalog entry, stored credential, successful typecheck, simulated provider response, or green test suite does not prove a live integration works.

## Current evidence

| Area | Implemented / checked | Remaining release evidence |
| --- | --- | --- |
| Organization onboarding | Native seed API; model sign-in step; resume; Back reuses the company and updates the same agent; first-task text survives navigation; failed resource provisioning stays visible | Fresh-device walkthrough with real model sign-in, first task and successful agent execution |
| Agent hierarchy and feedback | Live `reportsTo` tree; cyclic/orphaned structures remain visible; loop-producing moves disabled; latest-run badges refresh on heartbeat events; a completed run is not labelled a completed task | Browser walkthrough with concurrent live agents and actual task completion |
| Connector separation | Organization hub retains Agent models separately from Organization apps; device-wide hosting plugins stay distinct | Full navigation and mobile visual pass |
| Organization tool apps | UI now calls native engine gallery/connect/health/catalog/finish/revoke APIs; selected agents and Off/Ask/Allow actions reach engine governance | Real GitHub, Notion and Vercel authorization, read/write execution, approval and revoke proof |
| Chat channels | Native endpoint creation, bot credentials, health/test, channel resource selection, pause/resume/revoke; signed webhook bytes relayed without user credentials; human identity confirmation uses native permission checks | Real Discord/Slack setup, human identity linking, inbound task and outbound reply; provider callbacks need a browser-reachable address |
| Provider OAuth | Host return page, signed-in completion with CSRF checks, native state validation and public client metadata relay; UI blocks a known mismatched callback origin | Device public-address configuration and live provider callback round trip; broker-specific callback/enrollment flows require separate qualification |
| Pin | Host-native; can inspect org reporting structure and native app/channel health through the caller's permissions, without credential values or refs | Governed external tool execution for Pin is not established by these read tools |
| Resource control | Provisioning stages recorded independently; repair retries ACL synchronization; broker registry validates isolation and persists before activating policy | Broker configuration/setup on device, and proof that the execution path enforces aggregate org limits rather than only per-container sizes |
| Plugins | Existing marketplace / Proxmox provider code retained | Community plugin install, declared capabilities, runtime integration, upgrade and revoke require an end-to-end qualification pass |
| Installation and updates | Simulated install/upgrade/rollback/uninstall suite passed; exact real engine installed and answered health in an isolated fixture; native Proxmox provider test suite passed | Candidate package installed on test device, authenticated console walkthrough and rollback verification |

## Tests added or extended in this pass

- `apps/console/test/start-company.test.tsx`: company reuse, CEO update, preserved task drafts, resource-provisioning warning.
- `apps/console/test/org-and-graphs.test.ts`: disconnected cycles and unsafe manager changes.
- `apps/console/test/organization-apps.test.tsx`: native provider handoff, callback-origin mismatch, explicit grants/action policies, Discord setup.
- `services/epaperclip/test/native-apps.test.ts`: callback parameters, same-origin landing, session-bound completion, CSRF, rejected-state handling and response minimization.
- `services/epaperclip/test/channel-ingress.test.ts`: exact signed bytes, header stripping, public-route boundary and payload limit.
- `services/epaperclip/test/pin-apps.test.ts`: permission-preserving reads and credential-reference exclusion.
- `services/host-broker/test/broker.test.ts`: failed persistence cannot activate new resource authority.

## Device observation

Read-only SSH inspection found the test Proxmox device on **v1.0.0-rc30**, with `epaperclip` and `epaperclip-engine` active and `epaperclip-broker` inactive. Its engine public URL still points to loopback. These observations are not evidence that the working-tree changes have been deployed; they have not.

## Stable release gate

Do not tag stable from local tests alone. Record a candidate revision and package, verify installation and rollback, complete the fresh-device path, perform real provider authorization and permitted/denied agent calls, verify chat identity and replies, exercise resource isolation and quota contention, and review the console at desktop/mobile sizes. Keep failures and missing external-account prerequisites visible here until resolved.

## Reconciliation with the ecosystem acceptance matrix (2026-11-07)

The matrix is `OpenSourcx/papercliped-connect` `docs/v1/ACCEPTANCE.md` (71 items, refreshed 2026-11-06 late; fetched from the remote into `/project/.work/scratch`). An earlier version of this section wrongly said no such document exists; that was a search miss on my side. This gradebook (local ePaperclip behaviour) and the matrix stay separate; neither replaces the other. The matrix's own caveat applies: it is not a V1 sign-off. Statuses below use the matrix vocabulary (verified-live, verified-test, built-unverified, blocked, not-started) plus this branch's effect. Matrix rows owned only by Connect, billing, gateway or the owner (ID-1..10, CN-1..4, CN-7, CN-9..13, BL-*, MC-1..3, SR-1, SR-3..10, SR-12, SR-13, RL-2..6, UI-1, UI-2) are not touched by this branch and keep the matrix's status.

| Matrix row | Matrix status | This gradebook / branch | Reconciled status |
|---|---|---|---|
| EP-1 installs on a real Proxmox host | built-unverified | Simulated install suite now passes for non-root runners as well as root (`deploy/test/run.sh`, see ledger); never run on a real host | built-unverified (unchanged) |
| EP-2 stable 1.0.0 via APT/latest/npm | blocked | Not touched; no stable tag | blocked (unchanged) |
| EP-3 local login with Proxmox accounts | built-unverified | Gradebook area "Pin/permissions"; fake Proxmox only | built-unverified |
| EP-4 agent containers run agents | built-unverified | Gradebook "Resource control": broker registry persistence tested; actual allocation-path enforcement not shown | built-unverified; gradebook gap stays open |
| EP-5 organizations, agents, tasks on live engine data | not-started | **Stale in the matrix.** Main already has live engine data (`Live*` pages); this branch adds live org apps, hierarchy, onboarding. Evidence: unit tests and a pinned-engine install fixture only, no real onboarding walkthrough | built-unverified (matrix row should be updated; not verified live) |
| EP-6 machine management | built-unverified | Not touched | built-unverified |
| EP-7 modes exclusive | verified-test | Console now exposes them (EP-11); same backend tests | verified-test |
| EP-8 updates, rollback, uninstall | built-unverified | Simulated suite only | built-unverified |
| EP-9 engine pin 1023 | verified-test | Pin is 1023 on main; this branch's agent-access reads are typed against 1023. Gradebook rows citing 1005 (tool-access, chat endpoints, provider OAuth) still need re-audit against 1023 | verified-test for the upgrade; gradebook contracts partly unaudited on 1023 |
| EP-10 real-host validation | not-started | Same gate as the gradebook "Stable release gate" | not-started |
| EP-11 Connect panel in Settings, Remote access | not-started | **Implemented on this branch** (Access, Remote access, Papercliped Connect pairing UI over `/api/papercliped/connect/*`); 4 component tests, console suite 508 pass; no browser pass, no live Connect | built-unverified once merged |
| UI-3 Remote access, Connect panel | not-started | Same as EP-11 | built-unverified once merged |
| UI-4 design review vs CORE.md and accessibility | not-started | `check:design` 0 violations; clip palette contrast computed (all text pairs above 4.5:1); no human or browser accessibility review | not-started (partial automated evidence) |
| CN-5 device tunnel client attaches a real tunnel | built-unverified | Fakes only (fake Connect, helper, cloudflared) | built-unverified |
| CN-6 / MC-5 remote MCP through a managed hostname | not-started | Gradebook "remote console and MCP" required evidence | not-started |
| CN-8 device-initiated unpair | verified-live (Connect side) | Engine side unpair calls it, tested with a fake; real engine-to-Connect path unproven | as matrix |
| MC-4 local MCP with consent, Proxmox-bounded | built-unverified | Gradebook "Pin": host-native, read tools; governed execution not established | built-unverified |
| SR-2 engine vulnerable dependencies | not-started | **Stale in the matrix.** Main has `ws` 8.22 (#14); `pnpm audit --prod` on this branch: "No known vulnerabilities found" (2026-11-07) | verified-test (audit run); matrix row should be updated |
| SR-11 local control when Connect pauses/fails | verified-test | Console Access page keeps local usable; copy states it; unit tests only | verified-test |
| ID-1..ID-10 identity | mixed | Identity linking to a Proxmox principal is not an ID row yet; a proposed contract is owned by the Connect-contract subagent | add a row (owner: engine + connect-backend) |

Gradebook rows changed by this pass: "Organization tool apps" covers retained grants (existing grants read back and saved unchanged; unrepresentable grants block saving; unit-tested with fakes). "Installation and updates": the simulated deploy suite passes as non-root too, with a target-specific ownership assertion. Matrix rows I recommend the Connect side update: EP-5, EP-11, UI-3, SR-2.
