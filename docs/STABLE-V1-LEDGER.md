# ePaperclip stable-V1 reconciliation ledger

Status: **IN PROGRESS. Stable V1 is NOT qualified.** Updated 2026-11-07 by the miah reconciliation agent.

## Objective
Reconcile the uncommitted WSL snapshot (`/project/inbox/epaperclip-stable-v1-20261106`, base `d9e90f1`, 39 modified + 21 new paths) onto current `origin/main` without losing the engine 2026.1023.0 upgrade, Connect link/pairing/tunnel, unpair/revoke, ws security bump or user guide, then finish local stable-V1 scope.

## Branch / worktree
- Base: `origin/main` a708864 (8 commits after snapshot base; `d9e90f1` is an ancestor of main).
- Branch `feat/stable-v1-reconcile`, worktree `/project/papercliped-engine-worktrees/stable-v1-reconcile`. Deps: pnpm store `/project/.work/pnpm-store` (disk).
- Snapshot integrity: `sha256sum -c SHA256SUMS` re-run 2026-11-07: 104 OK, 0 failed.

## Method
`git apply --check` fails on 2 files (`deploy/install.sh`, `services/epaperclip/src/app.ts`); `git apply --3way` applied the other 37 cleanly and left 2 conflicts, resolved by hand keeping both sides. The 21 new files were reviewed and copied individually.

## Decision: duplicate organization-app ownership
The snapshot has two models: an early host-side "app record" API (`/api/organization-apps`, own secret store) and native engine connections (`native-apps.ts` + engine client + `LiveOrganizationApps`). The console already uses the native one. The host record API is **removed** (not ported); `state.ts` change existed only for it.

## 60-path inventory
| path | kind | disposition |
|---|---|---|
| `apps/console/src/App.tsx` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/src/data/brandIcons.ts` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/src/data/engine/connectApi.ts` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/src/data/engine/events.ts` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/src/data/engine/host.ts` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/src/data/engine/keys.ts` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/src/data/engine/labels.tsx` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/src/data/engine/queries.ts` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/src/data/orgTree.ts` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/src/pages/org/OrgPages.tsx` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/src/pages/org/live/LiveAgents.tsx` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/src/pages/org/live/LiveDashboard.tsx` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/src/pages/org/live/LiveSettings.tsx` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/src/pages/start/StartCompany.tsx` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/test/org-and-graphs.test.ts` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/test/start-company.test.tsx` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `deploy/epaperclip.service` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `deploy/install.sh` | tracked-change | integrated, 3-way conflict resolved (kept main uninstall of cloudflared.env, added broker unit) |
| `deploy/test/run.sh` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `docs/PLAN-PAPERCLIP-PARITY.md` | tracked-change | INTEGRATED (patch applied cleanly) |
| `packages/engine-client/src/index.ts` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `pnpm-lock.yaml` | tracked-change | INTEGRATED (applied cleanly over main lock; frozen install passes) |
| `scripts/gen-brand-icons.mjs` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `scripts/package-release.mjs` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `services/epaperclip/src/app.ts` | tracked-change | integrated, 3-way conflict resolved (kept clientIp/ConnectLink, added broker admin; dropped registerOrganizationApps) |
| `services/epaperclip/src/engine-allow.ts` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `services/epaperclip/src/engine.ts` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `services/epaperclip/src/features/connect-tools.ts` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `services/epaperclip/src/features/index.ts` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `services/epaperclip/src/main.ts` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `services/epaperclip/src/pin.ts` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `services/epaperclip/src/state.ts` | tracked-change | REPLACED (not ported): change existed only to support the dropped app-record API (setSettingWithSecrets) |
| `services/host-broker/README.md` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `services/host-broker/package.json` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `services/host-broker/src/broker.ts` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `services/host-broker/src/config.ts` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `services/host-broker/src/main.ts` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `services/host-broker/src/server.ts` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `services/host-broker/test/broker.test.ts` | tracked-change | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/public/brands/slack.svg` | new-untracked | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/src/pages/connect/ChannelIdentity.tsx` | new-untracked | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/src/pages/connect/ProviderCallback.tsx` | new-untracked | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/src/pages/org/live/LiveOrgChart.tsx` | new-untracked | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/src/pages/org/live/LiveOrganizationApps.tsx` | new-untracked | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/src/pages/org/live/OrganizationAppSetup.tsx` | new-untracked | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/src/ui/ProviderMark.tsx` | new-untracked | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `apps/console/test/organization-apps.test.tsx` | new-untracked | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `deploy/epaperclip-broker.service` | new-untracked | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `docs/HANDOFF-2026-11-05.md` | new-untracked | INTEGRATED (copied verbatim as historical record; this ledger is current) |
| `docs/STABILITY-GRADEBOOK.md` | new-untracked | INTEGRATED (copied; still needs reconciliation with ecosystem acceptance matrix) |
| `services/epaperclip/src/broker-client.ts` | new-untracked | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `services/epaperclip/src/channel-ingress.ts` | new-untracked | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `services/epaperclip/src/features/apps-contract.ts` | new-untracked | REPLACED: duplicate host app-record ownership model; native engine connections (native-apps.ts + engine client) are the single authority. Snapshot copy stays in inbox. |
| `services/epaperclip/src/features/native-apps.ts` | new-untracked | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `services/epaperclip/src/features/organization-apps.ts` | new-untracked | REPLACED: duplicate host app-record ownership model; native engine connections (native-apps.ts + engine client) are the single authority. Snapshot copy stays in inbox. |
| `services/epaperclip/test/channel-ingress.test.ts` | new-untracked | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `services/epaperclip/test/native-apps.test.ts` | new-untracked | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `services/epaperclip/test/organization-apps.test.ts` | new-untracked | REPLACED: duplicate host app-record ownership model; native engine connections (native-apps.ts + engine client) are the single authority. Snapshot copy stays in inbox. |
| `services/epaperclip/test/pin-apps.test.ts` | new-untracked | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |
| `services/host-broker/src/registry.ts` | new-untracked | INTEGRATED (applied/copied; typecheck + tests pass at this commit) |

## Validation evidence (at the PR head commit, this worktree)
- `pnpm install --frozen-lockfile`: OK.
- `pnpm -r typecheck`: 8 projects OK.
- `pnpm -r --workspace-concurrency=1 test`: all green. console 501, host service 987, host-broker 20, engine-client 14, proxmox-client 84, automations 16, marketplace 6, os-library 9. (Snapshot's 2 machine.test.tsx failures did not reproduce serially; cause of the earlier parallel flake still unproven.)
- Limits: all of the above are unit/fake-backed tests. Nothing here was run against real providers, a real device or real model execution. Nothing is deployed.
- CI: not yet inspected for this branch (see Next action).

## Outstanding (from HANDOFF-2026-11-05, unchanged unless noted)
1. Existing agent-access editing: reopening starts empty and Save replaces grants; needs typed read of tool profiles/policies, all_agents semantics, block advanced selectors. Re-verify against pinned engine 2026.1023.0 (snapshot was written against 1005).
2. Device public-address setup for OAuth callbacks; real provider round trip.
3. Native agent create/configure/run-test; real model execution.
4. Broker setup and aggregate org quota enforcement in the real sandbox allocation path; Pin not charged to org.
5. Pin governed external tool execution.
6. Plugin install/upgrade/revoke qualification.
7. Provider form fields (checkbox/textarea/etc.), manual OAuth client, marks on existing connection rows.
8. Browser desktop/mobile review; candidate install/upgrade/rollback on an approved test host.
9. Advertising -> Access rename and identity linking (below): not started.

## Access / identity plan (not implemented)
- Rename user-facing Advertising to Access; audit existing Access Control nav first; keep old routes redirecting. Three modes: Local only, self-managed Cloudflare (device plugin; cloudflared Tunnel vs Worker described accurately; creds stay in device vault), Papercliped Connect (reuse `connectLink.ts`, `tunnelHelper.ts`, `paperclipedAccount.ts` from main).
- Identity linking: single-use, expiring, device/session-bound state; restricted return URLs; shows cloud account + local Proxmox principal/realm before confirm; no auto-admin from login/subscription; local access works with Connect offline; same permission checks for console and /mcp.
- **Shared contracts to agree with the Connect/identity agent before changing** (nothing changed unilaterally): the device-link request/confirm payloads, account-to-principal mapping record, unlink/revoke events, entitlement states shown in UI.

## Blockers
- Needs product/contract confirmation from Connect agent for identity-link API shape.
- Real-service evidence needs approved test host and provider accounts.

## Running jobs
None after this commit (deploy lifecycle test was run locally; see PR).

## Next action
Push branch, open PR, inspect GitHub Actions logs, then implement outstanding item 1 and the Access rename.

## Brand kit (owner directive 2026-11-07)
Order of authority followed: `/project/design/CORE.md` (project DESIGN doc > CORE > frontend-design plugin), `apps/console/DESIGN.md`, `brand/README.md`, papercliped `LAUNCH-KIT.md`/`SITEMAP.md`, Connect `docs/AUTH-SITE.md`. Rules adopted for all Access, onboarding and Connect-handoff work: console product register, tokens only (`src/index.css`), no new colors or marks, user-facing names "Access" and "Papercliped Connect", product is "ePaperclip", copilot is "Pin", sentence case, verbs on buttons, no native controls.

### Conflicts found (not resolved; owner decision needed)
1. **Palette.** Console tokens: warm dark `--bg #171612`, `--accent #e8b25c` (gold), Inter, Pin orb gold/coral/violet. Connect auth site (`apps/auth/auth-assets.mjs`): cool dark `--bg #0b0b10`, `--accent #9f94ff` (violet), `--radius 17px`, Inter, a custom rotated-diamond mark. Different accent and background; the Connect handoff screens will look like a different product.
2. **Marks.** `brand/README.md` says the Pin orb stands for Pin only and is not a logo for the product. The Connect auth site uses a diamond mark; the papercliped site uses mascot + wordmark (`papercliped/web/public/brand`, `papercliped-icons.zip`). No single ePaperclip/Papercliped logo is defined for the Access/Connect handoff.
3. **Docs disagree on whether papercliped has a design doc.** CORE.md section 1 says "none found" for papercliped; LAUNCH-KIT.md and the icon pack exist, and AUTH-SITE.md calls its UI "branded" without naming tokens. CORE.md also lists a shared `--bg --surface --ink --muted --line --accent` vocabulary, which the auth site follows but with different values.
4. **Naming.** Console already has a settings route `access` plus `pages/Advertising.tsx`; renaming Advertising to Access creates a second Access destination unless merged with Access Control. Needs an IA decision (merge as sections of one Access page is the proposal).
5. **Casing/names.** brand README: "ePaperclip" (lower e); Connect/site copy uses "Paperclip"/"Papercliped". Not yet audited for stray "Paperclip" user-facing strings.

Until answered: Access UI inside the console uses console tokens only; Connect handoff copy uses plain console components and no new mark.

### Acceptance list item added
- [ ] **Brand consistency check:** console vs Connect auth site vs website at 390px and desktop, light and dark: same accent/background tokens (or an owner-approved mapping), same mark usage, same product names ("ePaperclip", "Pin", "Access", "Papercliped Connect"), AA contrast, status vocabulary with icon/shape. Blocked on conflicts 1-4.
