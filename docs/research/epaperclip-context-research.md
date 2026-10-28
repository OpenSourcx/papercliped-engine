# Shared context in ePaperclip: what Claude does, what Paperclip has, what's missing

Research for the next piece of ePaperclip. The goal is the owner's: **an organization works like a Claude project.** It has standing context that every member shares, whether a person, Pin or an agent: instructions, knowledge files, memory, connectors, an environment, and a place where outputs land. Files are referenced from that shared context.

Sources are listed at the end. Claims about Claude come from Anthropic's documentation, read on 2026-10-28. Claims about Paperclip come from the pinned engine (`paperclipai 2026.1005.0`): its OpenAPI spec in `packages/engine-client/spec/openapi.json` and its source in `engine/node_modules/paperclipai` after `npm ci` in `engine/`.

---

## 1. How Claude organizes shared context

### 1.1 Projects in claude.ai chat (the current version)

- A project is a self-contained workspace with its own chats, a **knowledge base** (documents, text, code, files) and **custom instructions**. Every chat in the project draws on both.
- **Retrieval.** When project knowledge nears the context limit, retrieval turns on automatically (paid plans). Claude then uses a *project knowledge search* tool instead of loading everything, which raises capacity up to about 10x.
- **Sharing** (Team and Enterprise). By person, list or whole organization, with two roles:
  - **Can view**: see knowledge and instructions, and chat.
  - **Can edit**: change instructions and knowledge, and manage members.

### 1.2 Projects in Claude Code (the new version, in beta)

The closest match to what ePaperclip is: a stream of work, many workers, one shared context.

| Part | What it is |
| --- | --- |
| **Project conversation** | One long-running coordinator. It takes requests, answers quick ones in place, and starts a **thread** for each piece of work, or passes work to a thread already working in that area. It sees what threads report, not every step. |
| **Threads** | Workers, each a separate session with its own context window. They run in parallel, report back, work on their own branch and open PRs. |
| **Overview** | Threads by state: Ready for review, Waiting on you, Working, Landing, Idle, Resolved. Tabs for **Library**, **Pull requests**, **Scheduled tasks**. |
| **Library** | Files and folders you added, plus **files threads produced**. Outputs land here. |

**What every thread starts with** (the shared context):

| Context | What it carries | Limits and behaviour |
| --- | --- | --- |
| **Project instructions** | The brief every new thread and the coordinator receive | Up to 16,000 characters. Changes reach new threads, not running ones |
| **Project memory** | Requirements, decisions and pitfalls Claude keeps as files | Every thread reads the index `MEMORY.md` at start and opens other files when needed. Claude writes to it when told to remember, and saves the person's working preferences there on its own |
| **Repositories** | Cloned into every thread | Each repository's root `CLAUDE.md` is loaded. A thread can add a repository for itself only |
| **Files and folders** | Readable by every thread under `/mnt/project-files` | Up to 100 files and 2 GB per pick, 480 MB per file. Folders are copied (first 100 files, 200 MB). At most 10 folders. Uploads are copies |
| **Connectors** (MCP) | The account's connectors, connected once and available to every thread | A thread can turn one off. The coordinator itself has no connectors; work that needs one goes to a thread |
| **Environment** | Network level, environment variables, network secrets, setup script | Shared across sessions; detailed in 1.3 |

**Context management.** People don't manage context windows. Threads compact automatically. The coordinator works from recent messages, recent threads and project memory, not its full history. Anything that must never be dropped goes in memory.

**Settings sections:** General (name, icon, goal, coordinator and thread model and effort), Memory (instructions and memory files), Environment (repositories and environment), Plugins, Usage (tokens by thread and model).

**Lifecycle:** Pause stops everything, Archive hides it, Delete removes threads, memory and files.

### 1.3 Cloud environments: the runtime half of context

An environment is a saved configuration that sessions run in:

- **Network access:** None, Trusted (package registries, GitHub, cloud SDKs), Full, or Custom (your allowlist).
- **Environment variables.**
- **Network secrets.** API keys added to outgoing requests by a proxy *after* they leave the sandbox, so the session never sees the key.
- **Setup script.** Runs as root before the agent starts. The filesystem is snapshotted when setup finishes within about five minutes, and the snapshot expires after about seven days.

GitHub and MCP connectors reach the session through their own proxies whatever the network level.

### 1.4 The session side panel (the owner's screenshot)

Claude's workspace shows each session's shared state in one rail:

| Card | What it shows |
| --- | --- |
| **Environment** | The environment, plus the repositories and branch attached |
| **Context** | Context window use, broken down: messages, tool definitions, system prompt, skills, memory files, free space, auto-compact buffer |
| **Connectors** | Which are connected, and which need sign-in or reconnecting |
| **Outputs** | Files the session produced, openable |

---

## 2. What Paperclip (our engine) already has

| Claude concept | Paperclip today | Notes |
| --- | --- | --- |
| Project container | **Company**: name, description, budget, approval policy | No company-wide instructions, no knowledge library, no shared memory |
| Sub-project | **Project**: name, description, goals, lead agent, `env`, **workspaces** (`local_path`, `git_repo`, `remote_managed`), repositories | A project's workspaces are where agents' files live |
| Threads | **Issues** (tasks) assigned to agents. Each wake is a **heartbeat run** | `GET /api/issues/:id/heartbeat-context` assembles a run's context: issue, project, goal, ancestors, comments, attachments, a continuation summary document, the execution workspace |
| Instructions | **Per agent** instruction bundles, with files, revisions and restore | Nothing at company or project level |
| Memory | **Per agent**: the `para-memory-files` skill writes PARA folders, daily notes and `MEMORY.md` under `$AGENT_HOME` | Private to each agent; nothing shared across agents |
| Knowledge and files | **Issue documents** (keyed, with revisions, annotations and locks), **attachments**, **file-resources** (list and read files in an issue's workspace; text up to 512 KB, media up to 10 MB) | Everything is scoped to one issue or workspace; nothing company-wide |
| Outputs | **Artifacts** (company-wide list), **work products** per issue | Already a Library-like feed |
| Connectors | **Tool profiles** plus an **MCP gateway** per company (`/api/companies/:id/tools/profiles`, `/tools/mcp/import-json`, `/mcp/gateways/:id`), with the profile bound to agents | The way to give *every agent* a tool |
| Environment | **Environments** (`local`, `ssh`, `sandbox`, `plugin`) with `envVars` that can be secret references, probes, custom images, leases | Our Proxmox sandbox provider is the `plugin` driver. It refuses host bind mounts on purpose |
| Secrets | Company secrets, user secrets, secret providers, rotation, access events | |
| Skills | Company skills, catalog, sources, per-agent sync | |

## 3. What ePaperclip has on its own side

- **Pin:**
  - Personal `SOUL.md` and `MEMORY.md` (with revisions, plus the new `#` line from the composer).
  - Personal chats.
  - Tools that run as the signed-in person.
- **Notes:** personal notes, sorted by Pin, which can be shared read-only with one organization.
- **Vault:** sealed secrets, some shared to chosen CEOs.
- **Connectors:**
  - Model connections, with fallback and usage.
  - The **Router**: one endpoint for agents.
  - The Papercliped bridge: MCP for outside AI apps.
- **Machine files:** read and edit files inside a machine.
- **PinView:**
  - cards: Environment, Context, Connectors, Changes, Background tasks
  - tiles: Plan, Files, Terminal, Artifacts, Pull requests

  Today these are mostly **views**: the Context card shows page context, not a shared context store.

## 4. The gap

Paperclip shares context **per issue** and **per agent**. Claude shares it **per project**. ePaperclip has no layer where an organization (or one of its projects) holds context that Pin, every agent and every person can read and reference. The composer's `@` has no files to offer because there is no shared file store to point at.

Missing, by piece:

1. **Organization context**:
   - instructions every agent run and every Pin chat about that organization receives
   - a shared memory (`MEMORY.md` index plus files) with revisions
2. **Library**: knowledge files and folders, uploaded or pulled from a machine or repository, that anyone in the organization can reference with `@file`, and that Pin and agents can search and read.
3. **Outputs into the Library**: artifacts and work products from agents, and files Pin produces, appear in the same Library, marked as produced, with who made them and in which task.
4. **Delivery to agents.** Agents must actually *receive* this context, not just see it in the console:
   - instructions and the memory index prepended to every run
   - files readable on demand
   - memory writable through a controlled tool
5. **A context card that is real.** What the open conversation is carrying, and what share of the model's context it uses.
6. **Environment and connectors per organization, made visible.**
   - Which engine environment and which Proxmox container it runs in.
   - Which connectors (MCP tools, model connections through the Router) its agents get.
   - Which secrets are referenced.

## 5. Design constraints already in force

- **Keep the stock engine.** Paperclip is pinned and unmodified. Add on the host side, and use the engine's own extension points: the tool gateway and MCP import, instruction bundles, issue documents, environments, artifacts.
- **No host bind mounts into agent containers.** The sandbox provider refuses them by design. Files reach agents over a tool (MCP) or are copied by the engine's workspace setup, never by sharing a host folder.
- **Every read and write runs as someone.** A person reads the Library through their organization membership, checked on each request, as Notes sharing already does. Agents read through a token scoped to their organization. Pin acts as the signed-in person.
- **Knowledge is data, not instructions.** File contents reach a model labelled as data. They can never change Pin's rules or permissions (the Notes prompt-injection rules). Only *instructions* are instructions, and only people with edit rights can change them.
- **Secrets never enter context.** Scan uploads and memory writes with the Notes secret scanner. Show what was found, and offer to vault it.
- **Storage.**
  - Library files are files on the host under `/var/lib/epaperclip`, with metadata and revisions.
  - Large files have caps.
  - `state.json` is a single JSON file that is rewritten whole on every save, so large text can't go there. Use per-organization files, as Notes uses sealed documents.

## Sources

- Anthropic, *What are projects?*: https://support.claude.com/en/articles/9517075-what-are-projects
- Claude Code docs, *Let Claude coordinate ongoing work with Projects*: https://code.claude.com/docs/en/claude-projects
- Claude Code docs, *Use Claude Code in the cloud*: https://code.claude.com/docs/en/claude-code-on-the-web
- Claude Code docs, *Configure cloud environments*: https://code.claude.com/docs/en/cloud-environments
- Paperclip 2026.1005.0: `packages/engine-client/spec/openapi.json` (routes listed in section 2), `server/dist/routes/issues.js` (`heartbeat-context`), `server/dist/services/workspace-file-resources.js`, `server/skills/para-memory-files/SKILL.md`
- ePaperclip: `docs/PAPERCLIP-STUDY.md`, `docs/ORGS.md`, `docs/NOTES.md`, `docs/PIN.md`, `docs/CONNECTORS.md`, `docs/ROUTER.md`, `plugins/proxmox-sandbox/src/plugin.ts`
