# Pin's runtime

Pin is the copilot built into ePaperclip. This page covers what runs on the host service so Pin is stable: the automation runner, notifications, Agent mode plans, the model and connector settings, update awareness, and a small read-only MCP endpoint. The chat itself (providers, streaming, read tools) is described in [ENGINE.md](ENGINE.md). Code lives in `services/epaperclip/src/features/pin-*.ts` (one registration line in `features/index.ts`), the page in `apps/console/src/pages/pin/runtime.tsx`.

Rules that hold everywhere below: every call needs the Proxmox sign-in (or a Bearer API token, [API.md](API.md)); changes need `X-EPC-Request: 1`; input is validated strictly and unknown fields are refused; secrets are write-only; Proxmox decides what anyone may do.

## Automations

An automation is plain data, validated before it is stored (`packages/automations`):

- **When something happens**: a machine's memory, CPU or disk use (or its status) compares to a value for some time, checked every 30 seconds to 7 days (default 1 minute), with a cooldown.
- **On a schedule**: every day at a time (the device's clock) or every 5 minutes to 7 days.
- **Scope**: containers, VMs or both; optionally a tag, a resource group or specific machine ids.
- **Action**: notify, shut down, stop, start, or take a snapshot. Never delete anything. Machines tagged `protected` only ever get a notification.

Everything is read back in plain words before saving (`POST /api/pin/automations/preview`, shown in the New automation dialog and by Pin).

### Who an automation acts as

Creating one makes a **Proxmox API token for its owner** (`<owner>!epcauto-<id>`), called as the owner. By default the token is privilege-separated and the owner grants it one role (`PVEAuditor` to notify, `PVEVMUser` for power and snapshots) on exactly the paths in its scope (`/vms/<id>`, `/pool/<pool>`, or `/vms`). It can never do more than that, and never more than its owner may. If the owner can't grant permissions (no `Permissions.Modify`), creation answers `needs_permissions`; the owner may then explicitly choose to let it act with all of their permissions (`allowOwnerPermissions`), still limited in code to its one action and scope. The page labels which of the two each automation has. The token's secret is sealed in the vault, never returned or logged. Deleting the automation deletes the token. If Proxmox stops accepting the token (owner disabled or removed) the automation pauses at once.

### The runner

Starts with the host service (`main.ts`), looks every 15 seconds for due automations.

| Rule | How |
| --- | --- |
| No overlap | One pass at a time; one run per automation at a time. A manual "Run now" during a run answers 409. |
| Bounded retries | A temporary Proxmox failure (5xx, network) is retried 3 times (1 s, 4 s waits). A refusal (403) is never retried. A Proxmox task that ends in error fails the run. |
| Backoff and pause | A failed run backs the automation off (1, 2, 4 ... up to 60 minutes). Three failed runs in a row pause it, with the reason. Resume clears the count. |
| Pin's mode | Assistant mode: an action becomes a one-step plan waiting for the owner's approval (and a second pass doesn't pile up another for the same machine). Agent mode: it runs now. |
| History | Every run that did something or failed is kept (last 300) with its steps, attempts and reasons. A pass that found nothing is not history. Runs left "running" by a restart are finished as failed. |
| Surfaced | Failures and pauses go to the owner's inbox as critical notices. |

Limits: cooldown timers and "for N minutes" counters are in memory, so a restart starts them fresh. A schedule missed while the host was down runs once when it is back, not once per missed day.

Routes: `GET|POST /api/pin/automations`, `GET|DELETE /api/pin/automations/:id`, `POST .../pause|resume|run`, `GET /api/pin/automations/runs[?automation=]`, `POST /api/pin/automations/preview`. People see their own; Proxmox administrators see all.

## Notifications

Kinds: task finished, backup failed, device events (a device goes offline or comes back), approvals (an organization is waiting for the person), automations, Pin's proposals, updates. Collected for a person, as that person, when their console (or a script) reads `GET /api/pin/notifications` (at most one pass every 20 seconds; `?refresh=1` forces it), so they only hear about what Proxmox lets them see: their own finished tasks, failed backups they can see, and so on. Automation and plan notices are added for the owner as they happen. A notice has a key, so collecting twice never doubles it.

**Quiet by default.** Everything lands in the inbox, but a notice may make the island expand ("peek") only when it is a warning or failure, its kind isn't marked quiet, and it isn't inside the person's quiet hours. Defaults: task finished, automations and updates are quiet. Per person (`PUT /api/pin/notification-prefs`): switch kinds off, mark kinds quiet, set quiet hours (they may cross midnight; the device's clock). `POST /api/pin/notifications/read` `{all: true}` or `{ids}`, `POST /api/pin/notifications/clear` removes what was read. 200 notices are kept per person.

Limits: while nobody is signed in nothing is collected for them; on their next sign-in the last 6 hours of tasks and the current device and approval state are picked up. The inbox is on the device's state file, not pushed to email or a phone.

## Agent mode: what Pin can do, and what it asks first

In Agent mode Pin does the work, not just a checklist. It has real action tools, and each person chooses how much runs on its own (Pin's page, Agent mode, "What Pin may do on its own"; saved per person as `permission`):

| Permission | What happens |
| --- | --- |
| **Ask** (the default) | Every action Pin wants to take is shown in the chat as a card. You approve or decline it there, and Pin carries on with the result. |
| **Accept edits** | Safe actions run at once: create, start, snapshot, clone, back up, grow a disk, change settings. Anything that interrupts a machine (shut down, stop, reboot) or can't be undone asks. |
| **Auto** | Everything runs at once except what can't be undone (delete a machine, delete a snapshot, roll back), which asks. |
| **Plan** | Pin only writes plans (`propose_plan`); nothing runs until you approve each step on the Plans tab, as before. |
| **Bypass permissions** | Everything runs with no questions, deletes included. Turning it on takes the typed word `bypass` (the host refuses without it) and is written to the audit trail. |

Every action runs as the signed-in person, so Proxmox's own permissions still decide, and each run, result and failure is audited (`pin.act.run`, `pin.act.done`, `pin.act.failed`). Bypass does not widen what the account may do. Nothing in a tool call can carry a password: a container Pin creates has none and is opened from its console as root, or with an SSH public key you give it.

**Actions**: `create_container` (a template by volume id, or an OS name like `debian-12`, found on the node or downloaded from Proxmox's catalog; storage and bridge default to sensible ones), `create_vm` (with an ISO attached if asked), `clone_machine`, `backup_machine`, `resize_disk`, `set_machine_config` (name, cores, memory, swap, start at boot, description, tags), `power_machine`, `snapshot_machine`, `delete_snapshot`, `rollback_snapshot`, `delete_machine` (stopped machines only), `download_template`, `create_task`. **Reads** it uses to choose well: `list_machines`, `machine_detail`, `storage_overview`, `list_container_templates`, `list_isos`, `list_bridges`, `list_snapshots`, `list_backups`, `task_status`, plus the existing host, task, organization and notes tools.

Behaviour worth knowing:

- Risk classes: *safe*, *disruptive* (power off or restart) and *destructive* (can't be undone). Only destructive actions need a typed phrase when approved (`destroy 101`, `rollback 101`, `delete 101`).
- An action that needs approval becomes a one-step plan, so it also shows on the Plans tab and goes through the same checks (only a signed-in browser session can approve, never an API token). The conversation waits up to 15 minutes; if nobody answers, the request is cancelled and Pin is told nothing was done.
- Pin takes up to 24 steps in a conversation and at most 30 changes, then stops.
- A task that outlasts the approval request (a long backup or clone) is reported as still running, with its task id; Pin can follow it with `task_status`.
- `GET /api/pin/settings` and `PUT /api/pin/settings` carry `permission`; going to `bypass` needs `confirmBypass: "bypass"` in the same request.

## Agent mode plans

In Agent mode Pin gets one more tool, `propose_plan`. It writes a plan down (1 to 8 steps) and cannot run one:

- Step kinds: power (start, shutdown, stop, reboot), snapshot, delete snapshot, roll back to a snapshot, create a task in an organization. Machines must be ones the person can see.
- The person reviews the plan on Pin's **Plans** tab and approves **one step at a time, in order**. Approving runs that step now, as them, so Proxmox's permissions apply. Skip moves on; Reject cancels the rest; a failed step ends the plan and skips the rest.
- **Destructive** steps (anything that interrupts a running machine or can't be undone: shutdown, stop, reboot, delete or roll back a snapshot) need the typed phrase (`shutdown 101`, `rollback 101`, `delete 101`). The server checks it, not just the page.
- Only the owner can decide on a plan, and only from a signed-in browser session: an API token can read plans (`GET /api/pin/plans`) but answers 403 `ticket_only` on any decision.
- Audit trail: proposing, approving, skipping, rejecting, each step's result and cancelling are written to the plan (who, when, result) and to the audit trail (`GET /api/access/audit`, administrators).
- Automations in Assistant mode use the same plans (a one-step plan each).

Routes: `GET /api/pin/plans`, `GET /api/pin/plans/:id`, `POST /api/pin/plans/:id/steps/:stepId/approve|skip|reject` `{confirm?}`, `POST /api/pin/plans/:id/cancel`.

## Model and connector settings

Reviewed end to end:

- **Keys are write-only.** A key is sealed in the vault when set; `GET /api/connectors` returns only whether a key exists, its last four characters, who set it and when, and the last test. Only Proxmox administrators set, replace, test or remove keys.
- **Test connection.** Connectors can be tested (a minimal authenticated call). Pin's settings add **Test connection** (`POST /api/pin/settings/test`): one real request of a few tokens with the saved key and the chosen model, so a wrong key, a model the key can't use, an exhausted quota, a provider outage or a timeout shows up now, in words. At most one test every 3 seconds per person.
- **Clear errors.** Provider failures become sentences with a code (`provider_auth`, `provider_rate_limited`, `provider_rejected`, `provider_overloaded`, `provider_timeout`, `provider_unreachable`) and say who can fix it.
- **No key in logs or responses.** Provider error text is redacted before it is shown or logged: the exact key, `sk-...`/`AIza...` shapes (including masked ones), bearer values and any long unbroken token become `[key]`. Tests assert that no response or log line from the connector, settings, model, test and chat routes contains the key. Gemini keys travel in a header, never the URL.

## More model services, fallbacks and usage

Besides the four built-in providers, an administrator can add hosted providers and local servers (Ollama, LM Studio, llama.cpp, vLLM, any OpenAI-compatible server) in Connectors; they appear in Pin's provider list as `x:<name>`. Pin streams from them the same way (tools included for the OpenAI-compatible ones). A chain of fallbacks lets Pin carry on when the chosen provider is rate-limited, out of quota, overloaded, unreachable or refuses the key, before any answer has been shown; the finished chat says which provider answered (`done.via`). Each turn's token counts, as the provider reports them, feed the Usage table in Connectors (no text is kept). Details in [CONNECTORS.md](CONNECTORS.md).

Agent mode plans can now also come from connected apps (`createdBy: "app"`, titled with the app's name): they wait on the Plans tab exactly like Pin's.

## Update awareness

`GET /api/pin/update` shows the installed version (`/opt/epaperclip/VERSION`) next to the latest release from the project's public release feed (GitHub's `releases/latest`), the release notes as plain text, and the release page link (only links inside this project's repository are kept).

- **No telemetry, no third-party loads.** The host service makes one plain HTTPS GET to the feed (headers: `Accept` and a fixed `User-Agent`, nothing about the device, the person or the version), at most every 6 hours, and only when a Proxmox administrator opens the page or presses Check now. Browsers never contact it, the CSP is unchanged. Administrators can switch checks off (`PUT /api/pin/update/settings`); then nothing is requested. Set `EPC_RELEASE_FEED` to read a mirror.
- **Guided update.** The host service is unprivileged and sandboxed and stays that way, so it cannot install anything. An administrator types `update <version>` and the host service writes a small request file (`/var/lib/epaperclip/update/request`, fixed `KEY=VALUE` shape). A root-owned path unit (`epaperclip-update.path`, from `deploy/`) starts `epaperclip-update.service`, which runs `/opt/epaperclip/update/run.sh`. That helper revalidates the request, downloads that exact release from the project's GitHub releases, checks its published SHA-256 and its VERSION, and runs the installer from it. The installer is unchanged in what it checks: it stages the new version beside the old one, test-starts it, swaps it in, and puts the previous version back (including the engine's database when the engine changed) if it doesn't come up healthy. Progress is in `/var/lib/epaperclip/update/status` and shown on the page; the page reconnects by itself while the service restarts.
- **Go back.** If a previous version is kept, typing `rollback` runs the installer's own `--rollback` through the same helper.
- **Without the helper** (installed before this feature, or the unit could not be enabled) the page says so and shows the shell command. Updating from the shell always works.
- What the helper trusts: the request file can only ask for an update to a published release of this project (checksum-verified) or a rollback; the release location comes from the unit's environment, never from the request. Someone who controls the host service process could therefore trigger an update to a real release, which is the same trust as owning the service.

## Read-only MCP endpoint

`POST /api/mcp` with `Authorization: Bearer epc_...` speaks MCP's streamable HTTP in its simplest form (one JSON-RPC message per POST, one JSON answer): `initialize`, `ping`, `tools/list`, `tools/call`. The tools are Pin's read tools (host status, machines, one machine, storage, tasks, organizations, one organization), run as the token's person with the token's own Proxmox permissions, so a privilege-separated token sees only what it was given. It offers no tool that changes anything and never accepts the console's cookie. For a token with the least reach, create one with **Separate privileges** and give it `PVEAuditor` on the paths to share. (A read-only token can't be used: it may only make GET requests, and MCP is a POST.) The full Papercliped bridge (OAuth at `/oauth/*`, `POST /mcp`, write tools through plans) is described in [CONNECTORS.md](CONNECTORS.md).

## Chats and memory

Pin's conversations are kept on the device, per person, sealed like Notes. In the console a chat is saved as you talk, and the browser then sends only the new message: the device already has what was said, what Pin did and what failed. API tokens and the stateless call (`POST /api/pin/chat` without `save` or `chatId`) keep nothing.

| Route | |
| --- | --- |
| `GET/POST /api/pin/chats`, `GET/PATCH/DELETE /api/pin/chats/:id` | list, start, open, rename, delete |
| `GET /api/pin/memory` | SOUL.md, MEMORY.md and their revision |
| `PUT /api/pin/memory/soul`, `/memory` | save; a stale `baseRev` is refused with 409 |
| `GET /api/pin/memory/history`, `POST /api/pin/memory/restore` | earlier versions, put one back |

SOUL.md and MEMORY.md are added to Pin's instructions, capped, and can never change its rules. Pin writes MEMORY.md itself only when your message asks it to ("remember this", "forget that"): the `remember` and `forget` tools are refused otherwise, whatever a page or document tells the model. Each save is a revision, so Pin's edits can be undone like yours. Revisions follow Paperclip's agent instruction files (versioned, with a conflict when the base is stale).

## The system vault

Host-wide variables, Pin only or shared with selected CEOs. Pin can list their names, never their values. See [VAULT.md](VAULT.md).

## Seeing what Pin is doing

Every chat leaves a trace in the journal and in `GET /api/activity` (which model, how long each answer took, retries, tool timings, how it ended), and `GET /api/status` sums up the last hour. See [ACTIVITY.md](ACTIVITY.md).

## State and limits

Everything is in `state.json` in the host service's state directory (written atomically): `pin.automations`, `pin.runs` (300), `pin.plans` (200), per person `pin.inbox:<user>` (200), `pin.prefs:<user>`, `pin.cursor:<user>`, `pin.nodeStates`, `pin.update.cache`, `pin.update.enabled`. Automation token secrets are in the vault as `pin.automation.<id>`.

## Testing

`services/epaperclip/test/pin-runtime.test.ts`, `pin-model.test.ts` with `fakes-pin.ts` (a Proxmox that checks privileges per token, flaky and refusing on demand; a controllable clock); `deploy/test/run.sh update_helper` for the root helper; `apps/console/test/pin-runtime.test.tsx` for the page. Screenshots: `services/epaperclip/scripts/pin-shots.mts`.
