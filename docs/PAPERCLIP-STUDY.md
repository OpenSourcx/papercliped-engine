# Paperclip, used as a person would use it

What Paperclip (`paperclipai 2026.1005.0`, the version we pin) does when someone sets up a company, adds an agent and connects a model. Everything below was observed by running it with its own interface (local trusted mode) and clicking through, plus reading the server code for the parts a screen doesn't show. Where something is inferred or unverified it says so.

## Starting a company (the first-run wizard, `/onboarding`)

Four screens, one question each, a sleeping mascot, a progress dot row.

1. **"What is the name of your organization?"** The company is created on the first Continue, not at the end. Quitting here leaves a company behind.
2. **"Create your first agent"**: only a name (placeholder "Chief of staff").
3. **"Connect a model"**: cards for Claude and OpenAI, each labelled Subscription, and a link "Use API key instead" that switches the cards to API. See below.
4. **First task**, with "Skip for now". The server code has "Failed to launch first task".

The wizard remembers where you were (reloading returns to the saved step and keeps the chosen mode).

What the flow produces is the same thing the server-side seed route builds (`POST /api/companies/{id}/onboarding-seed`, body `{ revision, mission?, agent?{name, role?}, firstTask?{title, details?} }`; applying the same revision twice is a no-op):

| Piece | What it is |
| --- | --- |
| Goal | The mission. First line is the title, the rest the description, level `company`. |
| First agent | `role: "ceo"` (the structural key), `title` is the free text ("Chief of staff"), adapter `claude_local` unless overridden, `status: idle`, `permissions: { canCreateAgents: true, canCreateSkills: true }`, `runtimeConfig: { heartbeat: { maxConcurrentRuns: 20 } }`. |
| Core skills | `adapterConfig.paperclipSkillSync.desiredSkills` = `paperclip`, `paperclip-board`, `paperclip-converting-plans-to-tasks`, `paperclip-create-agent`, `para-memory-files`. An agent only receives skills in its own list, so a CEO without them reports its toolkit as missing. |
| Project | "Onboarding", `in_progress`, linked to the goal. |
| First task | An issue in that project, `todo`, assigned to the CEO, in the goal. |

The CEO is then expected to build the team itself with the `paperclip-create-agent` skill (hire requests, with board approval when the company requires it). Assigning the first task wakes the agent at once.

## Connecting a model: three ways, one entity

Paperclip models this as an **AI connection**: provider (`anthropic`, `openai`, `openrouter`, `xai`) plus method (`subscription` or `api_key`), owned by a person (`personal`) or shared, bound to chosen agents or all of them. Routes: `/api/companies/{id}/ai-connections/local/attempts` and `/local/check`.

- **API key**: a key field; saving verifies it against the provider ("Could not verify the account" when it can't).
- **Subscription, local environment**: it shows a command to run in a terminal on the machine running Paperclip (`claude auth login`; for Codex a command with a per-connection `CODEX_HOME` and `codex login --device-auth`, "your existing terminal login stays separate") and then checks automatically.
- **Subscription, sandbox environment**: the server runs the login in the sandbox itself over a pseudo-terminal (the hooks our Proxmox provider implements) and the interface shows the sign-in address and code.
- **Gemini** has no account sign-in: "Use a Gemini API key, or an existing supported Gemini CLI login on the selected environment's host", an optional `GEMINI_API_KEY` field, or an organization secret.

The same Connect step appears when adding any Claude or Codex agent (`/agents/new`), with an Environment picker. New-agent flow: **Name → Adapter** (a grid: Claude Code, Codex, Cursor, Cursor Cloud, Gemini CLI, Grok Build, Hermes Gateway, Hermes, Kimi Code, OpenCode, Paperclip Runner, Pi) → **Connect** (Claude and Codex only) → **Configure** (model, key or secret, environment, a **Run test** button) → **Confirmation**.

**Connectors** in the sidebar is something else: a catalog of tool and MCP connectors per company (Airtable, Asana, Box, Cloudflare, ... and "Anthropic: use Anthropic APIs with a restricted key"), with Browse and Review. It does not hold model sign-ins.

## The product shape

- **Sidebar**: company switcher; New Task, Search, Dashboard, Inbox; Work (Tasks, Projects, Routines, Artifacts); Org (Agents, Skills, Connectors, Audit); the board user at the bottom. Light, plain, one accent.
- **Dashboard**: agent run strip, four counters (agents enabled, tasks in progress, month spend against budget, pending approvals), run activity, tasks by status, success rate, recent activity and tasks.
- **Agent page**: sub-navigation in four groups. Agent (Overview, Instructions, Skills), Runtime (Harness/Runtime, Secrets & variables, Tools), Governance (Permissions/Trust, API Keys, Revisions), Audit (Activity, Runs, Costs, Budgets). Actions: star, Assign Task, Run now, Run with provider trace, Clear error.
- **Task page**: a conversation with the assignee, a properties panel (status, assignee, project, labels, parent, blockers, reviewers, approvers, scheduled retry, monitor, watchdog), a composer with the assignee and a "Harness default" selector.
- **Failure handling** (seen for real: the seeded agent woke at once and its run failed because Claude wasn't signed in): the agent goes to `error`; the task gets a "Run failed" divider and a comment from the agent; a scheduled retry appears ("Agent resumes in 20s, Attempt 1", **Check now**); the Inbox gets a "failed" row with **Archive** and **Retry**; toasts appear at the bottom left; the agent page shows **Clear error**. Sending a message wakes the agent early.
- **Inbox** tabs: Mine, Recent, Unread, Blocked, All.

## What this means for ePaperclip

1. Our start-a-company path (a modal asking for a name and sizes) creates an empty company. Paperclip's path creates a mission, a CEO with the core skills and hire permission, an Onboarding project and a first task. We should call the same seed route, then add what is ours (the resource group and container environment).
2. Model connection belongs in company start and in new-agent, as a step, not on a separate settings page. Account sign-in in a sandbox is the provider hook we already built; the wizard step and the AI-connection records are what is missing.
3. Gemini stays API-key only.
4. Failure handling is a visible product feature: error state, retry, Inbox row, toast. Our console should show the engine's retry state rather than "Runner is writing".
5. Pin can already drive the same routes through the signed-in person: `onboarding-seed`, `agent-hires`, task comments, the board chat. It cannot today because we gave it read tools plus a few actions only.

## Not verified

- The fourth wizard screen (first task): the wizard cannot pass step 3 without a provider that verifies the key, which this machine cannot reach.
- Members, invites and the Board chat screens, and how the interface speaks to human members. The routes exist (`/company/settings/*`, board chat marked experimental and local-only) but I did not click through them.
- Sandbox-mode sign-in in the interface (needs a running sandbox provider).
- How shared (not personal) AI connections are granted.
