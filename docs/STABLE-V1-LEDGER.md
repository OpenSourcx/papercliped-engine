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

## Completed since the checkpoint (commits on PR #15)
- **Agent access editing (outstanding item 1).** `engine.apps.profiles/policies` (read-only client methods, types exported, host allowlist entries) and `appAccess.ts` read the gallery-managed profile `app:<connectionId>` and its `app_gallery_finish` ask-first policies against engine 2026.1023.0 types. Reopening starts from existing grants; a company binding is kept as `all_agents`; any other selector, exclusion, condition, non-default profile action or non-agent/company binding disables Save with an explanation; a failed read disables Save (never looks like "no access"). Tests: reopen+save preserves grants, all-agents preserved, unsafe/unreadable blocks saving (`apps/console/test/organization-apps.test.tsx`, 7 tests). Note: the host allowlist is path-only (existing design), so POST to these two paths is also reachable; the engine authorizes it.
- **Console production build:** `pnpm --filter ./apps/console build` exit 0 (only the usual >500 kB chunk warning); log `/project/.work/stable-v1-logs/build.log`.
- **Deploy test failures, root cause:** `update_helper` and `fresh` asserted `stat -c %u == 0` on installed files. The suite's stand-ins cannot chown, so these fail for any non-root runner and pass only as root (CI uses `sudo`). Fix: `root_owned` helper in `deploy/test/run.sh`: real uid check as root, otherwise require the installer's recorded `chown -R root:root` call. The root-mode assertion is unchanged. Non-root: 64/64 for `fresh update_helper`. Not yet run as real root here.
- **PR CI:** new `.github/workflows/ci.yml` on every pull request and push to main: frozen install, typecheck, tests, console build, PVE API conformance, script tests, provider typecheck/test/build, and the deploy simulation as root (`sudo`). No existing workflow or test was changed or weakened.
- **Gradebook reconciled** with ecosystem gates (section appended to `docs/STABILITY-GRADEBOOK.md`; no file named "ecosystem acceptance matrix" exists, see there).
- **Access (merged destination).** Settings section "Access" (`pages/access/AccessHub.tsx`) has People and permissions (existing Access control) and Remote access (`RemoteAccess.tsx`): Local only, Self-managed Cloudflare (existing publishing flow in `CloudflareAccess.tsx`, copy says tunnel not Worker), Papercliped Connect (pairing UI over the existing `/api/papercliped/connect/*` API: link, approval page, confirm the shown account, tunnel state, unlink). Switching between remote modes goes through Local only. `?settings=advertising` redirects to `?settings=access&access=remote`; Connectors link updated. Tests: `apps/console/test/remote-access.test.tsx` (4). Console suite 508 passing, `check:design` 0 violations.
- **Identity linking contract** written: `docs/ACCESS-IDENTITY-LINK-CONTRACT.md` (proposal only; not implemented).
- **Brand kit index:** `brand/BRAND-KIT.md`.

## Validation evidence (latest head)
- Frozen install OK; `pnpm -r typecheck` OK; console 508/508, engine-client 14, host service 987+ (allowlist sync test passes), host-broker 20, others unchanged; scripts tests 21/0; `check:design` clean; console build OK.
- Everything is unit/fake-backed. Not verified with real services, real devices, real providers, a browser, or deployed.
- GitHub Actions: see PR #15 checks after the new `ci.yml` run (recorded below when read).

## shadcn MCP
Not available in this session: no shadcn tools appear in my tool list and a tool search found none. It is registered in `~/.claude.json` per the owner but was not connected here (possibly needs a session restart). Not used; no `shadcn init` or token change was made.

## Outstanding (current)
1. Provider form fields (checkbox/textarea/datetime/extension), manual OAuth client UI, provider marks on existing connection rows.
2. Device public-address setup for provider callbacks; live round trip.
3. Native agent create/configure/run-test and real model execution.
4. Broker setup and aggregate org quota in the real sandbox allocation path; Pin not charged to org.
5. Pin governed external tool execution.
6. Plugin install/upgrade/revoke qualification.
7. Identity linking implementation (device side) after Connect agrees the contract; Connect-side routes.
8. Self-managed Cloudflare: tunnel/DNS creation by the privileged publisher is still "next installation step" in the UI; real cloudflared attachment unverified.
9. Align auth-site palette/mark with official assets (Connect repo); brand visual check.
10. Browser desktop/mobile review; candidate install/upgrade/rollback on an approved test host; real-root run of deploy simulation.

## Access / identity plan (Access UI done; identity linking not implemented)
- Rename user-facing Advertising to Access; audit existing Access Control nav first; keep old routes redirecting. Three modes: Local only, self-managed Cloudflare (device plugin; cloudflared Tunnel vs Worker described accurately; creds stay in device vault), Papercliped Connect (reuse `connectLink.ts`, `tunnelHelper.ts`, `paperclipedAccount.ts` from main).
- Identity linking: single-use, expiring, device/session-bound state; restricted return URLs; shows cloud account + local Proxmox principal/realm before confirm; no auto-admin from login/subscription; local access works with Connect offline; same permission checks for console and /mcp.
- **Shared contracts to agree with the Connect/identity agent before changing** (nothing changed unilaterally): the device-link request/confirm payloads, account-to-principal mapping record, unlink/revoke events, entitlement states shown in UI.

## Blockers
- Identity-link contract proposed in `docs/ACCESS-IDENTITY-LINK-CONTRACT.md`. I could not reach the Connect agent: `ListAgents` is not in my toolset and SendMessage to `papercliped-connect` failed ("No agent named ... is reachable"). **Dependency:** Connect must implement/approve the `/api/v1/devices/{id}/identity-links*` routes and answer the 4 open questions in that doc. Coordinator: please relay.
- Real-service evidence needs approved test host and provider accounts.

## Running jobs
None.

## Next action
Read PR #15 CI logs; then device-side identity link state (after contract agreement), provider form fields, public-address setup, broker enforcement.

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
