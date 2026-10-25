# Plan: match Paperclip's experience, then add Proxmox

Status: phase 1 built (see below); the rest is proposed and waits for approval.

## The rule

ePaperclip is Paperclip plus Proxmox. We keep every Paperclip feature and its way of working (the same screens, the same words, the same flows), and we add what only a Proxmox host can give: agents that run in containers on this device, resource groups, a vault, storage and networking, and Pin working inside machines. Where our console does something differently from Paperclip today, the default is to move to Paperclip's way and keep our additions on top.

Facts below come from using the pinned engine (`paperclipai 2026.1005.0`) in a browser, see [PAPERCLIP-STUDY.md](PAPERCLIP-STUDY.md). "Ours" columns were read from the code, not compared screen by screen; those cells say so.

## Where we are against Paperclip

| Paperclip screen | What it does there | Ours | Gap |
| --- | --- | --- | --- |
| Start wizard (`/onboarding`, 4 steps) | name → first agent → connect a model → first task, then the dashboard | A "New organization" modal: name, description, size. Creates an empty company and its resource group | **Missing.** No mission, no first agent, no model step, no first task |
| Seeded company | goal, CEO with core skills and hire permission, Onboarding project, first task | Nothing is seeded | **Missing** |
| New agent (modal then page) | Name → Adapter grid → Connect → Configure (model, key, environment, **Run test**) → Confirmation | `LiveAgents` has a create form with an adapter field | **Different, probably shallower.** No grid, no connect step, no Run test |
| Connect a model | subscription or API key per provider, an AI connection record, local or sandbox sign-in | A separate Settings → Agent sign-in page (rc19) and the Vault | **Wrong place.** It belongs inside company start and new agent |
| Agent page | sub-navigation: Agent (Overview, Instructions, Skills) · Runtime (Harness/Runtime, Secrets & variables, Tools) · Governance (Permissions/Trust, API Keys, Revisions) · Audit (Activity, Runs, Costs, Budgets) · actions Assign Task, Run now, Run with provider trace, Clear error | `LiveAgentTabs` with its own tabs | **Unverified depth.** Compare tab by tab |
| Task page | conversation with the assignee, properties panel, scheduled-retry card with Check now, composer with a harness selector | `LiveTasks`, `LiveTaskExtras`, `LiveChat` | **Unverified depth.** Failure handling in particular |
| Failure handling | error state, Run failed note, retry schedule, Inbox row with Retry/Archive, toasts, Clear error | Chat showed "Runner is writing" until a fix; inbox exists | **Partly.** Retry card, Inbox Retry and toasts need checking |
| Inbox | Mine, Recent, Unread, Blocked, All | `LiveInbox` | Unverified tab set |
| Dashboard | agent run strip, 4 counters, run activity, tasks by status, success rate, recent activity | `LiveDashboard` plus our device cards | Unverified; keep ours as an addition |
| Org chart | view of Agents | `OrgChart` | Probably present |
| Skills | Discover, Sources, Author | `LiveSkills` | Unverified |
| Connectors (tools) | catalog of MCP/tool connectors per company: Browse, Review, Advanced setup (Profiles, Gateway) | Our "Connectors" is mostly model keys | **Different thing under the same name.** Tool connectors per company are missing |
| Company settings | logo, **require board approval for new hires**, members, secrets, environments, access and invites | `LiveSettings`, members, vault | Unverified; the hiring-approval switch is the important one |
| Company import / export | GitHub URL or files into a new or existing company; export with package files | Not seen | **Probably missing** |
| Approvals / Decisions | pending approvals, decisions list | Decisions page | Present; check approvals |
| Costs, Budgets, Activity | audit, spend against limits, incidents | `LiveCosts`, `activity` | Present; check budgets |
| Routines, Projects, Goals, Artifacts, Workspaces | as named | all have a route | Present; depth unverified |

## Phases

### 1. Start a company the Paperclip way (built)

A wizard with the same four steps and words as Paperclip's, one question per screen, calling the engine's own routes (create the company, then `POST /api/companies/{id}/onboarding-seed` for the goal, first agent, project and task). Our additions, as extra steps: the organization's size (the resource group) and a check that agent containers are ready, with a one-click fix when they are not.

- Replaces the "New organization" modal for creating a company; the modal's size choices move into the wizard.
- Decision made: the company is created at the end of step 1, as Paperclip does, because signing in needs its container environment. The wizard saves where it was (`epc.start.draft`) and resumes; a saved draft is dropped when its company no longer exists.
- Our twist: step 2 offers **Create it myself** or **Let Pin create it**. Pin drafts a name, a role and a one-line summary from the organization's name and mission (`POST /api/pin/draft-ceo`, one model call with no tools); the person reviews and edits it. Nothing is created until they press Next.
- Built in `apps/console/src/pages/start/`; opened by `?modal=new-org` on a live device (the demo keeps the old modal).
- Done when: a new organization opens on a dashboard with its mission, a CEO that has the five core skills and can hire, an Onboarding project and a first task, and its agent runs in a container.

### 2. Connect a model inside the flow

The "Connect a model" step of the wizard and of new agent: cards per provider with Subscription and API key. In a container, a subscription uses the sign-in terminal our provider already implements (`58e6264`); API keys go to the Vault and are shared with the agents (`63feff8`). The AI-connection records Paperclip keeps (`/ai-connections`) become the source of truth instead of our separate page; Settings → Agent sign-in becomes a read-only overview that links into the flow.

- Gemini stays API key only.
- Done when: adding Claude to a new agent signs in or takes a key without leaving the flow, and the status shows on the agent.

### 3. The agent experience

- New agent: Name → Adapter grid (all twelve adapters Paperclip lists, with ours first: the ones installed in the template) → Connect → Configure with **Run test** → Confirmation.
- Agent page: the same four groups of sub-navigation and the same actions; fill in the tabs we lack.
- Failure handling: show the engine's retry state, **Check now**, Inbox **Retry**, toasts, **Clear error**.
- Done when: a screen-by-screen comparison against the running engine finds no feature missing on the agent and task pages.

### 4. Company screens

Company settings with the hiring-approval switch, secrets, environments and access; import and export; approvals; tool connectors (Browse, Review, Advanced) using the engine's own app routes. Rename our model-keys page so "Connectors" means what it means in Paperclip.

### 5. Pin as the company's operator

Give Pin tools for the same routes, gated by the permission modes already in place and by Paperclip's own approval switch:

- start a company (the seed route), hire an agent (`agent-hires`; lands as an approval when the company requires one), connect a model (prompts the person to sign in, never handles the credential), assign and comment on tasks, read run logs and failures, retry and clear an error;
- speak to the board and members through task comments and agent chats (routes exist; verify the board-chat route and what it allows before relying on it);
- keep working inside machines (`machine_exec` and friends, `5bf49ee`) for setup the agents need.

### 6. Look and feel (decided)

Visuals are ePaperclip's own interface: our tokens, our components from `src/ui/`, our themes. We match Paperclip's flows, labels and the order of its steps, not its colours, type or mascot. No Paperclip-style light preset and no Paperclip artwork.

## Cross-check against the product spec (docs/VISION.md and the roadmap's v2 goals)

The repo has no document called a v2 spec; the closest to a Claude-style Pin and agents interface is the 1.0.0 plan for PinView, which lived outside the repo until now. What it has: [VISION.md](VISION.md) (the product spec) and the "v2 goals" list in [ROADMAP.md](ROADMAP.md) (SEV/TDX, OCI pull, OVA/ESXi import, single-file restore, SPICE/Open vSwitch, ZFS/Ceph, GlusterFS; all machine and storage items, none about companies). Against VISION.md the company flow stands like this:

| VISION.md says | Today |
| --- | --- |
| "When you create a company, you choose how much of the system it may use. If you don't know, Pin decides." | Done in the wizard's first screen |
| "Creating a company manually shows the memory options" (Postgres, or Postgres plus memory files) | The old modal showed them in the demo only; the wizard shows none, and the live engine has no such switch that we use. **Open** |
| "Pin can create companies for you." | Pin drafts the CEO today; creating the company is phase 5 |
| Device onboarding: name, Pin's mode, connect your first AI account, grant Pin access, "optionally create your first company, **or let Pin propose one**" | The device onboarding stops before that step. The wizard could be its last step, with Pin proposing the name and mission. **Open** |
| A Claude-style workspace for Pin and agents | **Planned, not built**: PinView in [PLAN-1.0-PINVIEW-COLLABORATE.md](PLAN-1.0-PINVIEW-COLLABORATE.md) (it was only in the session's plan folder until now) |
| "Nothing is lost from Paperclip. Redesign, don't remove." | The rule this plan follows |
| An agent runs natively on the engine host for trusted, light work, or in a container session | Containers only: the engine is held to managed sandboxes. The native option is not built and is off by design (docs/ENGINE.md) |

## How each phase is checked

- A scripted run in a real browser against the real engine (the harness in `docs/E2E.md`) for each flow, plus the console tests.
- For parity, a written screen-by-screen comparison kept next to this plan, using the engine in `/opt/pcdemo`-style local mode, so "missing" always means "I looked".
- The Proxmox-only parts (containers, sign-in terminals, in-machine commands) are unproven until run on a real host; each phase says so in its notes.

## Not verified yet

Our depth on every row marked unverified; the wizard's fourth screen; Paperclip's board chat and members flows; sandbox-mode sign-in in the interface; shared (not personal) AI connections.
