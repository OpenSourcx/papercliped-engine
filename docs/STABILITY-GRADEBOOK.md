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

## Reconciliation with the ecosystem acceptance gates (2026-11-07)

This gradebook (local ePaperclip behaviour) and the ecosystem gates stay separate; neither replaces the other. No document literally titled "ecosystem acceptance matrix" exists under `/project/papercliped*`, `/project/.agents` or `docs`; the ecosystem gates were taken from `papercliped-connect/docs/ROADMAP.md` (phases and "Production release"), `papercliped-connect/docs/v1/LEDGER.md` (findings, blockers) and `papercliped-engine/docs/PAPERCLIPED-ACCOUNT.md`. If the owner has a separate matrix, give its path and the rows below should be re-mapped.

| Ecosystem gate (source) | Local gradebook area | Combined status |
|---|---|---|
| Pairing with local administrator approval and owner approval (ROADMAP phase 1, PAPERCLIPED-ACCOUNT) | Access (new in this pass) | Device client implemented and tested against fakes; Access UI added. Live Connect pairing not run. |
| Identity linking to a local Proxmox principal (ADR-001, proposed contract) | Access, permissions | Contract written (`docs/ACCESS-IDENTITY-LINK-CONTRACT.md`); not implemented; Connect side not agreed. |
| Real `<device>.connect.papercliped.co` TLS and dedicated tunnel on a real host (ROADMAP phase 2) | Installation and updates | Not run. Blocked on broker approval / Cloudflare access (Connect LEDGER B2). |
| Provision, reconnect, revoke, outage recovery (ROADMAP phase 2) | Access | Tunnel client and unpair/revoke tested with fakes only. |
| ePaperclip managed Connect UI separate from bring-your-own-Cloudflare (ROADMAP phase 3) | Access | Implemented in the console (Remote access: three modes); component tests only; no browser pass. |
| Cross-tenant E2E, real-device smoke tests, staging rollback, signed-off security review (Production release) | Stable release gate; resource isolation; installation | Not started. |
| Stripe test-mode billing and entitlements (ROADMAP phase 3, LEDGER B1) | none locally | Out of scope for the device; the device only reacts to `no_entitlement`. |
| Engine pin 2026.1005.0 -> 2026.1023.0 (LEDGER U1) | Reference and acceptance rule | Pin is 1023 on main. This gradebook's contracts were audited against 1005; agent-access reads were re-verified against 1023 types in this pass. Other rows still cite 1005 and need re-audit. |

Gradebook rows changed by this pass: "Organization tool apps" now also covers retained grants (existing grants are read back and saved unchanged; unrepresentable grants block saving; unit-tested with fakes). "Installation and updates": the simulated deploy suite now passes as a non-root user as well, and CI runs it.
