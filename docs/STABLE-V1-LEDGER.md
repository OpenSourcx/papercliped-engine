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
- **PR CI (written, NOT active, BLOCKED):** `docs/ci/ci.yml` (to be installed as `.github/workflows/ci.yml`) runs on every pull request and push to main: frozen install, typecheck, tests, console build, PVE API conformance, script tests, provider typecheck/test/build, and the deploy simulation as root (`sudo`). No existing workflow or test was changed or weakened. **Blocker:** pushing a workflow file was rejected by GitHub ("refusing to allow an OAuth App to create or update workflow ... without `workflow` scope"); the agent token lacks that scope, so the file sits in `docs/ci/` until someone with the scope (or the owner) moves it with `git mv docs/ci/ci.yml .github/workflows/ci.yml`. Until then PR #15 has no automated checks.
- **Gradebook reconciled row by row** with the ecosystem acceptance matrix, `papercliped-connect/docs/v1/ACCEPTANCE.md` (fetched from the remote). My earlier statement that no such document exists was wrong (search miss).
- **Access (merged destination).** Settings section "Access" (`pages/access/AccessHub.tsx`) has People and permissions (existing Access control) and Remote access (`RemoteAccess.tsx`): Local only, Self-managed Cloudflare (existing publishing flow in `CloudflareAccess.tsx`, copy says tunnel not Worker), Papercliped Connect (pairing UI over the existing `/api/papercliped/connect/*` API: link, approval page, confirm the shown account, tunnel state, unlink). Switching between remote modes goes through Local only. `?settings=advertising` redirects to `?settings=access&access=remote`; Connectors link updated. Tests: `apps/console/test/remote-access.test.tsx` (4). Console suite 508 passing, `check:design` 0 violations.
- **Provider forms (outstanding item 1, forms and manual client).** `setupFields.ts` + `SetupFields`: text, password, textarea, select, checkbox, datetime (ISO, no native date input per CORE), advanced fields collapsed, hidden fields' defaults submitted, required/maxLength/pattern validation before connect, provider-required prefix, credentials as strings only. When the engine reports `manualClientRequired`, a form takes the preregistered client ID/secret and re-calls connect with `resumeConnectionId` + `oauthClient` (same draft, no duplicate; secret cleared from UI state). Tests (2 new): every field type, defaults, validation, payload shape; the manual-client flow. Not verified against a real engine or provider; `resumeConnectionId` + `oauthClient` follows the 1023 request schema but a real round trip is untested. Provider marks on existing connection rows: still open (ToolConnection carries only `applicationId`).
- **Provider callback address (outstanding item 2).** Root cause of the loopback blocker: the engine's `PAPERCLIP_PUBLIC_URL` is fixed at install to `http://127.0.0.1:3100`, so OAuth redirects cannot return to another computer. New `install.sh --set-public-url https://name[:port]` / `--clear` (root): accepts only a plain https origin (no login, path, query; loopback names refused), rewrites `PAPERCLIP_PUBLIC_URL` and `PAPERCLIP_ALLOWED_HOSTNAMES` in `engine.env` and `EPC_ENGINE_PUBLIC_URL`/`EPC_PUBLIC_URL` atomically with the file's mode kept, restarts both services and prints the exact redirect address to register. Simulated-host scenario `public_url` (16 checks incl. 10 refused inputs that change nothing). Access, Remote access shows the callback address and, when it does not match the console origin, the exact command. Already in place from the snapshot: the public callback route accepts only `state/code/error/iss` (single-valued, size-capped) and redirects to a same-origin fragment page; completion needs a signed-in session + CSRF; chat webhooks relay exact signed bytes and the engine verifies signatures. Not done: running the command on a real host, a real provider round trip, Connect hostname as callback (follows `--set-public-url` once a managed hostname exists).
- **Aggregate organization quota in the allocation path (outstanding item 4).** `plugins/proxmox-sandbox`: new `quotaGuests/quotaCores/quotaMemoryMb`; before every create/clone, inside a per-pool lock, it reads the pool's real members (templates excluded) and refuses a container that would pass any limit, creating nothing. ePaperclip sets the three values from the organization's resource group on every environment sync, so resizing follows. Tests: machine limit refused with no clone issued, cores and memory added up, two simultaneous requests for the last slot (exactly one succeeds), guests outside the pool not counted (host machines and Pin are not charged), no limit when unconfigured, nonsense limits rejected; host test shows the limits reach the environment config. Plugin suite 60/60. Limits: single-process lock (documented shortcut); disk is not aggregated; the broker's own lease limits remain separate and unconnected to this path; contention against a real Proxmox untested.
- **Pin and external tools (outstanding item 5). Left unimplemented until the owner chooses (designs below).** New read tool `list_app_action_requests` (caller's own engine session, company scope enforced, inputs/credentials stripped, test asserts no approve/decline/decide tool exists). Governed execution of external app tools by Pin is NOT implemented, on purpose: the engine's tool gateway issues sessions for an agent and run (`POST /api/tool-gateway/sessions` takes `agentId`, `runId`), and Pin is neither; executing as the person needs an engine contract for a board-user caller that I could not verify. Needs a decision: either Pin gets a dedicated engine agent identity per organization with Ask-first policies, or Pin only proposes and the person runs the call.
- **Plugins: install, upgrade, revoke (implemented, fakes only).** `services/epaperclip/src/features/connect-plugins.ts` + marketplace entry kind `plugin`. All checks are server-side and administrator-only (`isNodeAdmin`), same-site, no API tokens:
  - Install only from a catalog that passed signature, expiry and rollback checks. With no pinned signing key (`TRUSTED_KEYS` is still empty, and I did not add one) the answer is 409 `no_catalog`; a bad signature offers nothing. No claim is made of signed releases or a first-party key.
  - The submitted `acceptedPermissions` must equal the catalog's declared list exactly or nothing happens (409 `consent_required`); an upgrade needs fresh consent only when it adds a permission, and the recorded grant follows the new list.
  - The npm registry must still serve the exact `sha512` integrity the catalog was signed for (409 `integrity_mismatch`, 502 if the registry cannot be checked); upgrades must be newer (409 `not_newer`).
  - Revoke removes the plugin through the engine's `DELETE /api/plugins/{id}` and forgets the grant; plugins the engine has that did not come from the catalog are marked unverified and can be switched off or revoked, never switched on. Every step is audited (`plugin.install/upgrade/revoke/...`).
  - Console: Settings, Community plugins (`CommunityPlugins.tsx`): trust status, per-plugin provenance and accepted permissions, a review dialog that lists permissions and enables Install only after an explicit accept, upgrade with a "new permissions" flag, switch off/on, revoke with confirmation. Plugin entries are kept out of the demo Store list.
  - Tests: 8 host tests (`connect-plugins.test.ts`: consent variants, hash mismatch, upgrade/permission growth/hash, revoke and unverified, bad signature and no key, odd ids) and 3 console tests. Limits: permissions are publisher declarations; this host does not sandbox them and says so in the UI and API; the engine's `/api/plugins/install` and `/{id}/upgrade` request shapes follow the OpenAPI document (upgrade has no documented body; I send `{version}`) and were never run against a real engine; no real catalog exists yet; custom (non-catalog) plugin install is intentionally not offered.
- **Identity linking contract** written: `docs/ACCESS-IDENTITY-LINK-CONTRACT.md` (proposal only; not implemented).
- **Brand kit:** `brand/BRAND-KIT.md` (rewritten to the papercliped reference).

## Validation evidence (head recorded in the final report; see git log)
Local runs on `feat/stable-v1-reconcile` as user miah, logs under `/project/.work/stable-v1-logs/`:
- `pnpm install --frozen-lockfile` OK; `pnpm -r typecheck` 0 errors; `pnpm -r --workspace-concurrency=1 test` exit 0: console 511, host service 988, host-broker 20, engine-client 14, proxmox-client 84, automations 16, marketplace 6, os-library 9; plugin proxmox-sandbox 60 (separate `npm test`); console `pnpm build` exit 0; `check:design` 0 violations; `node scripts/check-pve-api.mjs` 613 calls matched; `node --test scripts/*.test.mjs` 21 pass 0 fail; `pnpm audit --prod` no known vulnerabilities.
- Deploy simulation, FULL suite (`bash deploy/test/run.sh`, all scenarios incl. the new `public_url`), same head: as miah **180 passed, 0 failed**; as root via `sudo env PATH=$PATH` **191 passed, 0 failed** (root also runs the npm-installer scenario that needs uid 0). Both without `EPC_TEST_REAL_ENGINE` (real-engine install scenario skipped). Logs `deploy-full-miah2.log`, `deploy-full-root2.log`. Targeted `fresh update_helper` (64/0) is separate, above.
- Everything here is unit/fake/simulated-host evidence. Not verified with real services, real devices, real providers, a browser, or deployed.
- GitHub Actions: none ran for PR #15 (see CI).

## shadcn MCP
Re-checked 2026-11-07 (tool search for shadcn): no shadcn tool is visible in this session, so it is not connected here and was not used. No `shadcn init`, no token overwrite.

## Outstanding (current)
1. Real provider round trips (forms, manual OAuth client, callback) on a real device.
2. Native agent create/configure/run-test and real model execution.
3. Broker setup and its tie to the allocation path (the provider now enforces aggregate limits itself); contention test on a real Proxmox; disk aggregation.
4. Pin governed external-tool execution (needs an engine contract decision, see above) and a person-confirmed approve/decline path.
5. Plugins: real engine contract check, a pinned catalog key and a real catalog (none exist); custom non-catalog install not offered.
6. Identity linking implementation: owned by the Connect-contract subagent's contract; do not code until it lands.
7. Self-managed Cloudflare: real cloudflared attachment; the UI still says the privileged publisher creates the tunnel in "the next installation step".
8. Auth/Connect brand follow-ups (palette, diamond mark, fonts): Connect repo.
9. Broader browser review (only Access, Remote access and Community plugins were screenshotted, with stubbed API data; connector/organization-app screens need a live engine); candidate install/upgrade/rollback on an approved test host; real-device gates in the acceptance matrix (EP-1, EP-10, CN-5, CN-6, MC-5).
10. CI workflow install (BLOCKED on token scope).

## Pin external-tool execution: two designs (owner decision needed; neither implemented)
Context: the engine runs an organization app's tools only through its tool gateway (`POST /api/tool-gateway/sessions` takes `companyId`, `agentId`, `runId`; `POST /api/tool-gateway/tools/call` executes under that session). Pin is host-resident, is not an engine agent, and is not charged to any organization's resources.

**Option A: a dedicated per-organization engine agent identity for Pin ("Pin (host)") with ask-first policies.**
- Create one engine agent per organization (created on demand by an organization admin, flagged `metadata.epaperclip=pin`), with no adapter/container (nothing runs in the organization's pool, so no quota is consumed).
- Its access to each app is an ordinary engine grant: Off/Ask/Allow per action via the same editor as other agents; default Off. New actions arrive quarantined and Ask-first.
- Pin calls `tools/call` through a gateway session for that agent and a synthetic run id per Pin turn (`pin:<session>:<turn>`). The engine, not Pin, decides allow/ask/deny; a held call returns an action request which the person approves in the organization's approvals (Pin cannot approve).
- Host enforcement before any call: the signed-in person must be a member of the organization with permission to use apps, the organization must be in the connect grant's `orgs` scope, the tool must be in an allowlist of non-destructive classes Pin may attempt, and every call and result summary is written to the host audit log with the person's identity.
- Pros: reuses engine governance, approvals, audit and revocation; one revoke point. Cons: a standing non-human principal per organization (must be shown in the agents list and be removable); needs an engine contract check that a gateway session can be minted for an agent the caller does not run as (unverified); budget attribution must be explicit.

**Option B: propose-only.**
- Pin never calls app tools. A new Pin action `propose_app_call {companyId, connectionId, tool, parameters}` writes a plan card; the person reviews exact parameters and clicks run in the console, and the host executes it as that person (a board-user session through the engine, if the engine offers a board-user execution route; otherwise the console shows the call for the person to run in the app).
- Destructive or write-class tools require the person's typed confirmation (existing Pin pattern: a phrase the app sends is ignored).
- Pros: no new principal; nothing runs without a human click; simplest to reason about. Cons: not hands-free; needs a board-user execution route (not present in the OpenAPI spec I read) or falls back to a purely informational plan.

Recommendation: B first (smallest, safe, ships behind the existing plan/confirm UI), A later if hands-free operation is required and the engine confirms an operator-minted gateway session. Until chosen, Pin has only the read tools (`list_organization_apps`, `list_app_action_requests`).

## Access / identity plan (Access UI done; identity linking not implemented)
- Rename user-facing Advertising to Access; audit existing Access Control nav first; keep old routes redirecting. Three modes: Local only, self-managed Cloudflare (device plugin; cloudflared Tunnel vs Worker described accurately; creds stay in device vault), Papercliped Connect (reuse `connectLink.ts`, `tunnelHelper.ts`, `paperclipedAccount.ts` from main).
- Identity linking: single-use, expiring, device/session-bound state; restricted return URLs; shows cloud account + local Proxmox principal/realm before confirm; no auto-admin from login/subscription; local access works with Connect offline; same permission checks for console and /mcp.
- **Shared contracts to agree with the Connect/identity agent before changing** (nothing changed unilaterally): the device-link request/confirm payloads, account-to-principal mapping record, unlink/revoke events, entitlement states shown in UI.

## Blockers
- Token lacks `workflow` scope, so the PR CI workflow cannot be pushed by this agent (see Completed).
- Identity-link contract proposed in `docs/ACCESS-IDENTITY-LINK-CONTRACT.md`. I could not reach the Connect agent: `ListAgents` is not in my toolset and SendMessage to `papercliped-connect` failed ("No agent named ... is reachable"). **Dependency:** Connect must implement/approve the `/api/v1/devices/{id}/identity-links*` routes and answer the 4 open questions in that doc. Coordinator: please relay.
- Real-service evidence needs approved test host and provider accounts.

## Running jobs
None.

## Next action
Read PR #15 CI logs; then device-side identity link state (after contract agreement), provider form fields, public-address setup, broker enforcement.

## Mobile and browser pass (2026-11-07)
A headless browser was available after installing Playwright's `chromium-headless-shell` into `/project/.work/browsers` (disk; Playwright from `/project/aftercard`). The built console (`vite preview`) was loaded with the API stubbed (`page.route`; stub data in `/project/.work/stable-v1-logs/shots.mjs`), demo-mode setup state, at 1440x900 and 390x844, in Clip (dark) and Clip Light, for Settings, Access, Remote access (Papercliped Connect pairing state) and Community plugins. Screenshots: `/project/.work/shots/*.png` (not committed). Findings: no horizontal overflow at 390 (scrollWidth equals clientWidth in all 8 views; dialogs 0 overflow); the Local only card's text was vertically centred unlike its neighbours (fixed); action buttons were 32 px tall, so they now use the 40 px size on Remote access, Community plugins and connection rows (still under the 44 px touch target CORE.md names: not fully met); both palettes read correctly. NOT covered: any screen backed by a live engine (organization apps, connection health rows, provider setup dialogs), keyboard/screen-reader review, real data, real Connect.

## Brand kit
Latest owner decision (2026-11-07): authority is the established OpenSourcx/papercliped branding (README launch images and `web/public/brand/`). The earlier "warm/gold" decision is superseded. Details, palette, console changes and the Connect/Auth follow-ups (palette, diamond mark, fonts) are in `brand/BRAND-KIT.md`. Console: new default presets "Papercliped Clip" / "Clip Light" (`theme.tsx`), DESIGN.md updated, `check:design` 0 violations, console tests 508/508. Pin's orb unchanged and Pin's only.
Acceptance item: [ ] brand-consistency check (console vs Connect auth site vs website, 390 px and desktop, light and dark). Console side has no visual pass; Auth/Connect side blocked on the follow-ups.
