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
