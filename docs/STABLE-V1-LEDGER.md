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
| `docs/STABILITY-GRADEBOOK.md` | new-untracked | INTEGRATED (copied; reconciled row by row with papercliped-connect ACCEPTANCE.md, see the gradebook) |
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
- **Deploy test failures, root cause and fix:** `update_helper` and `fresh` asserted `stat -c %u == 0` on installed files. The suite's `chown` stand-in cannot change ownership, so they fail for any non-root runner and pass only as root (the release workflow uses `sudo`). `root_owned` (deploy/test/run.sh) is now: as root, the unchanged real uid check; otherwise the file must be inside this host's prefix, the stand-in must have recorded exactly `chown -R root:root <prefix>.new` (the staged tree the installer later moves into place), and no later recorded chown may give anything under the prefix to another owner. **Negative proof** (installer temporarily mutated, then restored with `git checkout`, `cmp` identical): with the chown omitted, `fresh` and `update_helper` both FAIL ("62 passed, 2 failed"); with the chown aimed at `$STAGE/engine` instead of the whole stage, both FAIL ("62 passed, 2 failed"). Targeted `fresh update_helper` unmutated: 64 passed, 0 failed. Full-suite results are in the validation section below, reported separately.
- **PR CI (ACTIVE):** Codex installed the workflow (`7a01a5a`, `53cba7e`): `.github/workflows/ci.yml` on every pull request and push to main. Run results are in the "CI" section below. Workflow activation is not merge protection (see there).
- **Gradebook reconciled row by row** with the ecosystem acceptance matrix, `papercliped-connect/docs/v1/ACCEPTANCE.md` (fetched from the remote). My earlier statement that no such document exists was wrong (search miss).
- **Access (merged destination).** Settings section "Access" (`pages/access/AccessHub.tsx`) has People and permissions (existing Access control) and Remote access (`RemoteAccess.tsx`): Local only, Self-managed Cloudflare (existing publishing flow in `CloudflareAccess.tsx`, copy says tunnel not Worker), Papercliped Connect (pairing UI over the existing `/api/papercliped/connect/*` API: link, approval page, confirm the shown account, tunnel state, unlink). Switching between remote modes goes through Local only. `?settings=advertising` redirects to `?settings=access&access=remote`; Connectors link updated. Tests: `apps/console/test/remote-access.test.tsx` (4). Console suite 508 passing, `check:design` 0 violations.
- **Provider forms (outstanding item 1, forms and manual client).** `setupFields.ts` + `SetupFields`: text, password, textarea, select, checkbox, datetime (ISO, no native date input per CORE), advanced fields collapsed, hidden fields' defaults submitted, required/maxLength/pattern validation before connect, provider-required prefix, credentials as strings only. When the engine reports `manualClientRequired`, a form takes the preregistered client ID/secret and re-calls connect with `resumeConnectionId` + `oauthClient` (same draft, no duplicate; secret cleared from UI state). Tests (2 new): every field type, defaults, validation, payload shape; the manual-client flow. Not verified against a real engine or provider; `resumeConnectionId` + `oauthClient` follows the 1023 request schema but a real round trip is untested. Provider marks on existing connection rows: still open (ToolConnection carries only `applicationId`).
- **Provider callback address (outstanding item 2).** Root cause of the loopback blocker: the engine's `PAPERCLIP_PUBLIC_URL` is fixed at install to `http://127.0.0.1:3100`, so OAuth redirects cannot return to another computer. New `install.sh --set-public-url https://name[:port]` / `--clear` (root): accepts only a plain https origin (no login, path, query; loopback names refused), rewrites `PAPERCLIP_PUBLIC_URL` and `PAPERCLIP_ALLOWED_HOSTNAMES` in `engine.env` and `EPC_ENGINE_PUBLIC_URL`/`EPC_PUBLIC_URL` atomically with the file's mode kept, restarts both services and prints the exact redirect address to register. Simulated-host scenario `public_url` (16 checks incl. 10 refused inputs that change nothing). Access, Remote access shows the callback address and, when it does not match the console origin, the exact command. Already in place from the snapshot: the public callback route accepts only `state/code/error/iss` (single-valued, size-capped) and redirects to a same-origin fragment page; completion needs a signed-in session + CSRF; chat webhooks relay exact signed bytes and the engine verifies signatures. Not done: running the command on a real host, a real provider round trip, Connect hostname as callback (follows `--set-public-url` once a managed hostname exists).
- **Aggregate organization quota in the allocation path (outstanding item 4).** `plugins/proxmox-sandbox`: new `quotaGuests/quotaCores/quotaMemoryMb`; before every create/clone, inside a per-pool lock, it reads the pool's real members (templates excluded) and refuses a container that would pass any limit, creating nothing. ePaperclip sets the three values from the organization's resource group on every environment sync, so resizing follows. Tests: machine limit refused with no clone issued, cores and memory added up, two simultaneous requests for the last slot (exactly one succeeds), guests outside the pool not counted (host machines and Pin are not charged), no limit when unconfigured, nonsense limits rejected; host test shows the limits reach the environment config. Plugin suite 60/60. Limits: single-process lock (documented shortcut); disk is not aggregated; the broker's own lease limits remain separate and unconnected to this path; contention against a real Proxmox untested.
- **Pin external-tool execution, Option A (implemented, verified live against a real engine).** Read the pinned engine's gateway/policy source first, then ran it: findings, design and evidence are in `docs/PIN-APP-EXECUTION.md`. Summary: tool-gateway sessions need a real `running` heartbeat run, so Pin cannot use them without consuming a worker; the engine's board-user route `POST /api/tool-connections/{id}/test-calls {agentId,...}` runs a tool under an agent's policy as the signed-in person with native approvals. Pin therefore borrows one paused "Pin (host)" agent per organization (no adapter run, no container; the container reconciler skips it, tested) governed by host-managed `allow`/`require_approval`/`block` policies, default deny. `call_app_tool` (Pin action tool, risk disruptive) plus read tools `list_app_tools`, `app_tool_status`; console card in Organization apps. Two engine findings: (1) approvals need `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`, which the installer did not set, so every ask-first action failed with 500: fixed in `install.sh` (new installs and upgrades, tested); (2) new engine agents get an unscoped `tools:use` grant that the engine treats as "allowed", so **an action set to Off in the generic Organization apps access editor still ran** for an ordinary agent (live: `allow_explicit_grant`); only `block` policies deny reliably. Option B (propose-only) is not implemented and is not counted as Pin integration. Not exposed to remote MCP clients.
- **Plugins: install, upgrade, revoke (implemented; verified live against a real engine with a local registry).** Server-enforced, administrator-only, in `src/features/connect-plugins.ts`; trust-key, catalog-signing and install rules are in `docs/PLUGIN-CATALOG.md` (key generation/pinning, `scripts/marketplace-entry.mjs`, `marketplace-publish.mjs`; installs stay fail-closed with no pinned key; no private key is committed; no first-party key or catalog exists, so no claim of signed releases). Permissions are publisher declarations, never described as a sandbox. The engine's real handlers were read and exercised (2026.1023.0): `POST /api/plugins/install {packageName, version, isLocalPath}` (instance admin) goes `ready`; `POST /api/plugins/{id}/upgrade {version}` (body optional, default latest; a capability increase goes `upgrade_pending`, an engine-side approval) **does accept a downgrade**, so the host's `not_newer` refusal is the only guard; `DELETE /api/plugins/{id}` uninstalls. The real plugin package (`plugins/proxmox-sandbox` repacked as 0.1.0 and 0.2.0) was served by a local npm registry; `test/live/plugins.live.test.ts` ran the unmodified route through: fail-closed with no key, consent required, hash mismatch refused with the engine untouched, install, upgrade to 0.2.0, refused rollback, revoke. Also fakes-backed: 8 host tests, 3 console tests. Not done: a public registry, a real catalog or signing key, a real third-party plugin, the engine's `upgrade_pending` capability approval flow in the console.
- **Identity linking contract** written: `docs/ACCESS-IDENTITY-LINK-CONTRACT.md` (proposal only; not implemented).
- **Brand kit:** `brand/BRAND-KIT.md` (rewritten to the papercliped reference).

## Validation evidence (tested head `14c701a`; later commits are documentation only)
Labels: **local** = unit/typecheck/build on this machine; **simulated** = simulated-host installer suite or stub engine; **live-service** = real engine 2026.1023.0 on disk (plus fake provider and fake Proxmox); **deployed** = nothing (no candidate was deployed).
* local: `pnpm install --frozen-lockfile` OK; `pnpm -r typecheck` 0 errors; `pnpm -r --workspace-concurrency=1 test` exit 0: console 518, host service 1001 passed (8 live tests skipped without `EPC_LIVE_ENGINE`), host-broker 20, engine-client 14, proxmox-client 84, automations 16, marketplace 6, os-library 9; plugin `proxmox-sandbox` 60; console `pnpm build` OK; `check:design` 0 violations; `check-pve-api` 613 calls matched; script tests 21/0; `pnpm audit --prod` no known vulnerabilities.
* simulated: full `deploy/test/run.sh`, all scenarios incl. `public_url` and the approval-secret upgrade check, no real-engine scenario: **as miah 182 passed, 0 failed; as root (sudo) 193 passed, 0 failed**. Earlier negative proof of the ownership assertion stands (omitted chown and wrong-tree chown both fail it).
* live-service (engine 2026.1023.0 from `/project/.work/engine-1023`, Node 24.21.0, local npm registry, fake MCP provider): `test/live/pin-apps.live.test.ts` 5/5 and `test/live/plugins.live.test.ts` 3/3 at `14c701a`; UI check 35/35 (`live-ui2-final.log`, run against a console build of this branch, one commit before `14c701a` added only scripts).
* CI (live GitHub Actions): see the CI section; the run on `53cba7e` succeeded.
* Nothing is deployed; no real provider, real model, real Proxmox host or real Connect was used.

## shadcn MCP
Re-checked 2026-11-07 (tool search for shadcn): no shadcn tool is visible in this session, so it is not connected here and was not used. No `shadcn init`, no token overwrite.

## Outstanding (current)
1. Real provider round trips (forms, manual OAuth client, callback) against GitHub/Notion/Slack/Discord on a real device; real model execution and native agent create/run-test.
2. Broker setup and its tie to the allocation path (the provider enforces aggregate limits itself); contention test on a real Proxmox; disk aggregation.
3. Pin: remote-MCP exposure of `call_app_tool`, real-provider check; the generic app-access editor's Off is not a deny for default-granted agents (decision needed, see Pin section).
4. Plugins: a real pinned catalog key and published catalog (none exist), a real third-party plugin, the engine's `upgrade_pending` approval flow in the console.
5. Identity linking: owned by the Connect-contract subagent's contract (PR #16); not coded here.
6. Self-managed Cloudflare: real cloudflared attachment; the UI still says the privileged publisher creates the tunnel in "the next installation step".
7. Auth/Connect brand follow-ups (palette, diamond mark, fonts): Connect repo.
8. Accessibility beyond keyboard/touch (screen reader), real-device candidate install/upgrade/rollback on an approved test host, and the acceptance-matrix real-device rows (EP-1, EP-10, CN-5, CN-6, MC-5).
9. Branch protection on `main` (owner action).

## Pin external-tool execution
Option A is implemented (see `docs/PIN-APP-EXECUTION.md`). Option B (propose-only) remains an unimplemented fallback and does not count toward the Pin integration. Remaining for Pin: exposure through the remote MCP surface, a person-facing approvals inbox link from Pin's reply, real-provider verification, and a decision on the generic app-access editor's Off (below).

**Open risk (engine behaviour, live-verified):** in the Organization apps access editor, Off does not stop an ordinary agent that kept the engine's default unscoped `tools:use` grant. Ask-first holds. Options: write a `block` policy for each Off action for that agent (as Pin's identity does), or show a warning. Not changed here; needs an owner decision because it alters the existing editor's semantics.

## Access / identity plan (Access UI done; identity linking not implemented)
- Rename user-facing Advertising to Access; audit existing Access Control nav first; keep old routes redirecting. Three modes: Local only, self-managed Cloudflare (device plugin; cloudflared Tunnel vs Worker described accurately; creds stay in device vault), Papercliped Connect (reuse `connectLink.ts`, `tunnelHelper.ts`, `paperclipedAccount.ts` from main).
- Identity linking: single-use, expiring, device/session-bound state; restricted return URLs; shows cloud account + local Proxmox principal/realm before confirm; no auto-admin from login/subscription; local access works with Connect offline; same permission checks for console and /mcp.
- **Shared contracts to agree with the Connect/identity agent before changing** (nothing changed unilaterally): the device-link request/confirm payloads, account-to-principal mapping record, unlink/revoke events, entitlement states shown in UI.

## CI (GitHub Actions) and merge protection
* **Run 42346584160** (`CI`, pull_request, head `53cba7e`): **success**. `checks` job: install, typecheck, `pnpm test`, `pnpm build`, `node scripts/check-pve-api.mjs`, `pnpm test:scripts`, Proxmox sandbox provider (typecheck/test/build): all steps success. `deploy-simulation` job: `sudo env PATH=$PATH bash deploy/test/run.sh`: success. Evidence: `gh run view` job and step conclusions; duration 5m13s. Label: live GitHub Actions service.
* **Run 42346578088** (`7a01a5a`, same workflow): both jobs `cancelled` after 10 s. Classification: **superseded by the workflow's own concurrency group** (`cancel-in-progress`), because `53cba7e` was pushed seconds later. Not infrastructure, not a test or packaging failure.
* **Run 42348650484** (head `c54b1ff`, includes the Access, plugins and touch-size work): `checks` success, `deploy-simulation` success. **Run 42350015557** (head `5704221`, includes Pin option A, live-test files, 44px targets): `checks` success, `deploy-simulation` success. Live-service tests are skipped in CI (they need a disposable engine), so CI does not cover them.
* **Merge protection (separate from workflow activation): NOT PRESENT.** `gh api repos/OpenSourcx/papercliped-engine/branches/main/protection` answers 404 "Branch not protected"; `GET /rulesets` returns `[]`; `branches/main` shows `protected: false`; `allow_auto_merge: false`. So nothing requires the `CI` checks (`checks`, `deploy-simulation`) or a review before merging to `main`. I did not change any setting. Missing: required status checks (`checks`, `deploy-simulation`), required pull request review, blocking force-push and deletion of `main`, up-to-date branch requirement.

## Blockers
- Branch protection on `main` does not exist (owner action); CI runs but is not a required gate.
- Identity-link contract proposed in `docs/ACCESS-IDENTITY-LINK-CONTRACT.md`. I could not reach the Connect agent: `ListAgents` is not in my toolset and SendMessage to `papercliped-connect` failed ("No agent named ... is reachable"). **Dependency:** Connect must implement/approve the `/api/v1/devices/{id}/identity-links*` routes and answer the 4 open questions in that doc. Coordinator: please relay.
- Real-service evidence needs approved test host and provider accounts.

## Running jobs
None. The disposable engine, local registry and fake provider used for the live checks were stopped when the pass ended (`/project/.work/engine-1023`, `/project/.work/plugin-live` remain on disk).

## Next action
Read PR #15 CI logs; then device-side identity link state (after contract agreement), provider form fields, public-address setup, broker enforcement.

## Mobile, keyboard and live-screen pass (2026-11-07)
Labels: **live-service** = the real ePaperclip host service in front of a real engine 2026.1023.0 on disk (`scripts/live-engine/host-live.ts`, `live-ui-setup.mjs`, `live-ui.mjs`), driven by Playwright (headless Chromium from `/project/.work/browsers`); **stubbed** = anything listed below.
* **Touch targets:** every button, switch, radio, tab, select and input is at least 44px on coarse pointers via one token (`--touch-target`, `src/index.css`); `apps/console/DESIGN.md` updated (it said 40px; CORE.md says 44). Audit at 390x844 with touch emulation, both palettes, on Organization apps (live), the agent-access dialog (live), Access people, Access remote access and Community plugins: **0 controls under 44px, 0 horizontal overflow** (20 checks, live-service for the engine-backed screens; the Access and plugin pages use the live host with stubbed engine data only where the engine has no data, see below).
* **Keyboard/focus (desktop, live-service):** the dialog opens from the keyboard, focus moves into it, Tab never leaves it over 40 presses, focused controls draw the 2px ring, Esc closes it, focus returns to the control that opened it.
* **Live-engine behaviour found and fixed:** a working connection reports `healthStatus: "ok"` (not only `healthy`), which the row showed as a warning; health words are now mapped from the engine's real enum (`healthView`, tested).
* **Live grants round-trip:** in the real engine the agent-access editor saved an agent plus read=allow, write=ask, and reopening showed the same values and the agent still selected (the retained-grants fix, now proven live rather than against a fake).
* **Live Pin:** enabling Pin created a paused `Pin (host)` agent and the default-deny, allow and require_approval policies in the engine.
* 35/35 checks in the final run (`/project/.work/stable-v1-logs/live-ui2-final.log`; screenshots `/project/.work/shots/live-*.png`, not committed).
* **Still stubbed/not covered:** the provider is a local fake MCP server (not GitHub/Notion/Slack/Discord); Proxmox is a fake (users sam/lee); no real model, OAuth sign-in, webhook or channel traffic; Connect/Cloudflare states on the Remote access page were stubbed API responses (earlier pass); no screen reader testing; desktop-only keyboard run (touch audit is size/overflow only).

## Brand kit
Latest owner decision (2026-11-07): authority is the established OpenSourcx/papercliped branding (README launch images and `web/public/brand/`). The earlier "warm/gold" decision is superseded. Details, palette, console changes and the Connect/Auth follow-ups (palette, diamond mark, fonts) are in `brand/BRAND-KIT.md`. Console: new default presets "Papercliped Clip" / "Clip Light" (`theme.tsx`), DESIGN.md updated, `check:design` 0 violations, console tests 508/508. Pin's orb unchanged and Pin's only.
Acceptance item: [ ] brand-consistency check (console vs Connect auth site vs website, 390 px and desktop, light and dark). Console side has no visual pass; Auth/Connect side blocked on the follow-ups.
