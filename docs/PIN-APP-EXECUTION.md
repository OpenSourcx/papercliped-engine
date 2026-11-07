# How Pin uses organization apps (execution identity)

Status: implemented and verified against a real local engine (2026.1023.0) with a fake MCP provider. Not verified against a real provider (GitHub, Notion, ...) or on a real device. Pin's own permission modes (plan, ask, accept, auto, bypass) still apply on top.

## Engine contract, as read and then exercised (2026.1023.0)

Read from `@paperclipai/server` dist (`routes/tool-gateway.js`, `routes/tool-access.js`, `services/tool-gateway.js`, `services/tool-access-policy.js`) and confirmed by calling a real engine:

1. **Tool-gateway sessions cannot be used by Pin.** `POST /api/tool-gateway/sessions` takes `companyId, agentId, runId`. `createSession` requires the agent to be in the company and the run to exist, belong to that agent and be `running` (`ACTIVE_GATEWAY_RUN_STATUSES = {"running"}`). Pin has no run; a run means an agent actually executing (an adapter process or container). So a synthetic run id (the first design) would be refused with `run_company_mismatch`, and a real run would consume a worker. Rejected.
2. **The board-user execution route.** `POST /api/tool-connections/{id}/test-calls {agentId, toolName, parameters}` executes a connection's tool "as" an agent through the same policy engine, as the signed-in person, with no run. It requires: a board caller; `tools:use` or `tools:manage_connections` in the connection's organization; `tasks:assign` over the agent; and the agent must be in that organization and assignable (`paused` is assignable; `terminated` and `pending_approval` are not). `GET .../test-calls/{actionRequestId}` reports `waiting` / `done`.
3. **Decisions** (`policyService.decide`, in order): any matching `block` policy denies; `allow` policies allow; `require_approval` creates a signed action request (the call is NOT executed); then an explicit `tools:use` principal grant allows; then profile entries; default deny. A person approves with `POST /api/tool-gateway/action-requests/{id}/approve {companyId}` (board only) and the engine then executes the held call itself.
4. **Approvals need a secret.** Without `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET` in the engine's environment, any ask-first call fails with 500 `signing_secret_unconfigured`. The installer did not set it. Fixed: new installs generate it, upgrades add it if missing (`deploy/install.sh`, tested in `deploy/test/run.sh`).
5. **Default agents are over-granted.** A newly hired agent receives the default grant list including an **unscoped `tools:use`** (`NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS`, `services/agent-hiring.js`). The engine treats that as "allowed", so in the live engine an action left Off in the app-access editor (profile with default deny) still ran (`reasonCode: allow_explicit_grant`). Ask-first policies written by the editor do hold. **Consequence for the existing Organization apps editor: Off is not a deny for agents that kept their default grants.** This is the engine's behaviour; it is recorded in the ledger as a risk to resolve (a `block` policy is the only reliable deny).
6. **Cross-organization.** Another organization's connection is invisible to a non-member (404 "Tool connection not found"); an agent from another organization is refused (403 "This agent is not available for testing"); approving a request needs membership of its organization (403).
7. **A paused agent is never started.** A manual wake-up of a paused agent returns 202 and records a `queued` run, but the run is never started (observed 2.5 s later: still queued, agent still paused).

## Design (Option A)

* Pin stays host-resident. It does not provision a worker, container or sandbox environment and consumes none of an organization's allocation.
* **Identity:** one engine agent per organization, named "Pin (host)", created only when an organization administrator enables Pin for that organization (`POST /api/pin/apps/{companyId}`). Role general, adapter `http` to a closed loopback port, heartbeat disabled, left `paused`. The host records its id (`pin.appIdentities`) and verifies on every use that the engine still shows that agent in that organization and not terminated. The container reconciler skips it (tested), so it is never given the organization's container environment.
* **Authorization, enforced by the engine as the signed-in person.** The host adds no authority: every change and call is made with the person's own engine session. The host additionally checks that the connection belongs to the named organization, validates ids and sizes, and refuses everything until Pin is enabled.
* **Policy owned by the host** (because of finding 5): a `block` policy for the identity (priority 1000), plus, per action an administrator chooses, an `allow` policy (Allow) or a `require_approval` policy (Ask), selectors `{agentId, connectionId, catalogEntryId}`, priority 100. Off is the absence of a policy. Downgrades remove the old policy before adding the new one, so an action is never briefly allowed. Revoke removes all but the default deny.
* **Calling:** Pin tool `call_app_tool` (an action tool: risk "disruptive", so plan/ask/accept modes ask the person first; auto and bypass run it, still under the engine policy). Read tools `list_app_tools` (actions and Pin's mode for each) and `app_tool_status`. An approval-required result tells Pin to stop and report; Pin has no approve or decline tool (tested).
* **Console:** Organization apps, "Pin" card (enable, per-action Off/Ask/Allow, revoke).
* Not exposed to remote MCP clients yet (only the console's Pin runs `call_app_tool`).

## Verified

| Case | Evidence |
|---|---|
| allowed (executes at provider) | live, real engine + fake MCP provider: provider saw the call |
| denied (default deny, Off, unknown tool) | live: engine `deny_policy_block`, provider never called |
| approval-required (waits, then executes only after a person approves) | live: provider not called until the native approve, then `phase: done` |
| revoked action / revoke all | live: next call denied |
| cross-organization (other org's connection, other org's agent, outsider user, no inherited identity) | live (host check + raw engine 403/404) |
| identity never runs | live: paused, `http` adapter, wake-up stays queued; simulated: reconciler skips it |
| host-layer rules (validation, identity checks, no approve route, Pin action risk and modes) | simulated (stub engine), `test/pin-apps.test.ts` |

## Running the live check

```
# disposable engine on disk (not a service), Node >= 24.11
mkdir -p /project/.work/engine-1023/tree && cp engine/package*.json /project/.work/engine-1023/tree/
(cd /project/.work/engine-1023/tree && npm ci --omit=dev --ignore-scripts)
node deploy/engine-links.mjs /project/.work/engine-1023/tree
# start with the installer's settings plus PAPERCLIP_TOOL_ACTION_SIGNING_SECRET, on 127.0.0.1:3199 (see scripts/live-engine/run-engine.sh)
# sign up and claim bootstrap as admin@test.invalid, then:
EPC_LIVE_ENGINE=http://127.0.0.1:3199 pnpm --filter @papercliped-engine/epaperclip exec vitest run test/live
```
