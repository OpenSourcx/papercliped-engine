# Organization screens

Every screen inside a live organization (`/<device>/<org>/…`), and the engine API each one uses. All calls go through `@papercliped-engine/engine-client` (base `/engine`, so `GET /api/companies` below is `GET /engine/api/companies` in the browser). Writes carry `X-EPC-Request: 1`. Demo mode keeps its in-browser data and is unaffected. Live mode never shows made-up data: a screen with nothing to show says what to do first.

Every path the client calls is listed in `ENGINE_PATHS` (`packages/engine-client/src/index.ts`), and a test checks each exists in the pinned engine's OpenAPI document (`spec/openapi.json`). Two routes the engine serves but does not document live in `ENGINE_PATHS_UNDOCUMENTED`; a test checks they are still absent so they can move across when a later engine documents them.

Pages keep fresh through the organization's live-events socket (`/engine/api/companies/:id/events/ws`): an event refreshes only the data it touches (see `keysForEvent` in `apps/console/src/data/engine/events.ts`). While the socket is down they poll every 15 seconds.

## Sidebar (in Paperclip's order)

Search, Dashboard, Inbox (count), Chat, Decisions (count) · Work: Tasks (open count), Projects, Routines, Artifacts, Goals, Workspaces · Machines · Agents · Organization: Org chart, Members, Skills, Costs, Activity, Settings.

- Inbox count: `GET /api/companies/:id/sidebar-badges` (`inbox`). Decisions count: items in `GET /api/companies/:id/attention` that are not dismissed.
- The same inbox count shows as a badge on the organization's button in the rail (`useInboxCounts`).
- Search opens the palette (below). `Connectors` stays hidden in live mode: connectors are device-wide and live in Settings.

## Search

Press `/` anywhere (not while typing), or use Search in the sidebar. Ctrl/Cmd+K stays with Pin. The palette searches the organization you are in: tasks and files through `GET /api/companies/:id/search?q=`, agents and projects from data already loaded, the organization's pages, and the device's machines from the console's machine list. Arrow keys and Enter move and open; Esc closes.

## Inbox

`/inbox`, two tabs.

- **Needs you**: the engine's ranked attention feed, `GET /api/companies/:id/attention`. Each item can be answered in place:
  - approval: `POST /api/approvals/:id/approve` or `/reject` with an optional `decisionNote`, or `POST /api/approvals/:id/request-revision`.
  - an agent's question: reads `GET /api/issues/:id/interactions` and sends `POST /api/issues/:id/interactions/:interactionId/respond` with the chosen options and any written answer.
  - a confirmation request: `POST …/accept` or `…/reject`.
  - anything else (failed runs, blockers, budget alerts): Open links to the task, agent or Costs.
  - Dismiss: `POST /api/companies/:id/inbox-dismissals` with the item's `dismissalKey`.
- **Assigned and mentioned**: `GET /api/companies/:id/issues?touchedByUserId=me`. Unread tasks show a dot (`isUnreadForMe`). Mark read: `POST /api/issues/:id/read`. Archive: `POST /api/issues/:id/inbox-archive`.

## Decisions

`/decisions`. Waiting is the same attention feed, filterable by kind. History lists decided approvals (`GET /api/companies/:id/approvals`) with the note.

## Chat

`/chat`. Agent chat is an experimental engine setting that is off by default (`enableAgentChat`). While it is off the page says so, and a Proxmox administrator (engine instance admin) can turn it on with `PATCH /api/instance/settings/experimental {enableAgentChat: true}`; nothing else in that setting is touched.

- Conversations: `GET /api/companies/:id/chats`. Opening one (on the first message): `POST /api/companies/:id/chats/:agentRef` (an undocumented route).
- A message is a comment on the conversation's task: `POST /api/issues/:id/comments` with `{body, clientRequestId}` (the engine requires a UUID per message so a retry cannot post twice). The thread is `GET /api/issues/:id/comments`; new messages arrive through the socket's issue events.
- Not built: the board "conference room" chat. Its engine route (`POST /api/board/chat/stream`) starts the operator's own command-line assistant on the host and is refused outside a single-operator local install, so it cannot be offered here.

## Routines

`/routines`, `/routines/:id`.

- List, enable/disable (`PATCH /api/routines/:id {status: "active" | "paused"}`), Run now (`POST /api/routines/:id/run`): `GET /api/companies/:id/routines`.
- Create (`POST /api/companies/:id/routines`, then `POST /api/routines/:id/triggers` for a chosen schedule) and edit (`PATCH /api/routines/:id`): name, instructions, agent, priority. Schedules are presets or any five-field cron expression plus a time zone.
- Triggers: schedule, webhook, API. Enable/disable and rename (`PATCH /api/routine-triggers/:id`), remove (`DELETE`), add. A webhook's address and secret are returned by the engine only when the trigger is created or its secret is rotated (`POST /api/routine-triggers/:id/rotate-secret`); the console shows them once in a dialog and never again.
- Run history: `GET /api/routines/:id/runs` with each run's status, source, failure reason and the task it created (that task is the run's output).
- Revisions: `GET /api/routines/:id/revisions` (view the snapshot), restore with `POST /api/routines/:id/revisions/:revisionId/restore`.

## Skills

`/skills`. Installed: `GET /api/companies/:id/skills`; a skill's detail and files: `GET …/skills/:skillId` and `…/files?path=` (shown as plain text). Per-agent switches use `POST /api/agents/:id/skills/sync {mode: "add"|"remove", desiredSkills: [key]}` (agents whose adapter can't take skills say so). Catalog: `GET /api/skills/catalog`, install with `POST /api/companies/:id/skills/install-catalog {catalogSkillId}`. Sources: `GET /api/companies/:id/skill-sources`, refresh `POST …/skill-sources/:id/refresh`. Adding a source stays in the engine.

## Artifacts and Workspaces

- `/artifacts`: `GET /api/companies/:id/artifacts` (the engine lists what agents produced: documents, files and work products), filter by kind and search. Opening one previews it, sandboxed: images in an `<img>`, text and JSON read as text and shown as text (first 200 KB), everything else (HTML included) is download only. Engine content is never rendered as markup in the console's origin, and the host service additionally serves it with a `sandbox` Content-Security-Policy and forces HTML and scripts to download. Only addresses under `/api/` the engine itself returned are fetched.
- `/workspaces`, `/workspaces/:id`: `GET /api/companies/:id/execution-workspaces` and `GET /api/execution-workspaces/:id` with status, branch, folder and running services. Starting and stopping services is not offered yet.

## Costs

`/costs`. Summary and by agent (`…/costs/summary`, `…/costs/by-agent`), by project, provider and model (`…/costs/by-project`, `…/costs/by-provider`). Budgets: `GET …/budgets/overview` lists policies and open incidents, with spend against limit bars and alerts. Set the organization budget with `PATCH …/budgets {budgetMonthlyCents}` and an agent's with `PATCH /api/agents/:id/budgets`; both create a monthly policy that warns at 80% and pauses at the limit. A limit incident can be kept paused or raised and resumed (`POST …/budget-incidents/:id/resolve`).

## Organization settings

`/settings`. Rename and description: `PATCH /api/companies/:id`. Approve new agents toggle: the same call (`requireBoardApprovalForNewAgents`). Budget links to Costs. Resource group is read from the host service. Members are shown (`GET …/members`); changing who is in an organization is done in Access (Proxmox permissions on its resource group), and the page links there. Archive: `POST /api/companies/:id/archive`, after typing the organization's name; an owner or administrator only. The task prefix is fixed by the engine at creation, and the engine has no logo or colour setting.

## Agents

`/agents/:id` has tabs.

- **Overview**: status, spend, recent runs; Pause, Resume, Wake up.
- **Runs**: `GET /api/companies/:id/heartbeat-runs?agentId=`. Opening a run reads its log (`GET /api/heartbeat-runs/:id/log`) and, while it runs, appends `heartbeat.run.log` events from the socket (deduplicated by sequence number). Stop run: `POST /api/heartbeat-runs/:id/cancel`.
- **Configuration**: `PATCH /api/agents/:id` (name, title, role, reports to, capabilities, adapter, model, command, environment). Environment variables point at secrets (`{type: "secret_ref", secretId, version: "latest"}`); the picker lists `GET /api/companies/:id/secrets` and Create a secret posts to the same route. Secret values are sent to the engine and never read back or shown. Plain-text variables are allowed with a warning. Permissions: `PATCH /api/agents/:id/permissions`.
- **Instructions**: `GET /api/agents/:id/instructions-bundle` (set up with `PATCH … {mode: "managed"}`), files with `…/file?path=`, saved with `PUT …/file {path, content, baseRevisionId}` (a save over a newer revision is refused by the engine), revisions with `…/history` and `…/restore`.
- **Skills**: `GET /api/agents/:id/skills` and sync.
- **Budget**: as in Costs.

## Tasks

`/tasks/:ref` adds, below the description: labels (`GET/POST /api/companies/:id/labels`, assigned with `PATCH /api/issues/:id {labelIds}`), sub-tasks (`GET …/issues?parentId=`, created with `parentId`), files (`GET /api/issues/:id/attachments`, upload `POST /api/companies/:id/issues/:id/attachments` as multipart, delete `DELETE /api/attachments/:id`), work products (`GET /api/issues/:id/work-products`), linked approvals (`GET /api/issues/:id/approvals`) and documents (`GET /api/issues/:id/documents`, shown as text). Uploads go through the host service's proxy, which has a size cap and answers 413 with the limit; the console checks the engine's 10 MiB limit first and says so before sending.
