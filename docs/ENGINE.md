# The engine

ePaperclip is three things: **an interface** that replaces Proxmox's web UI, **an engine** (Paperclip) that runs organizations of agents, and a **Proxmox layer** that joins them (sign-in, resource groups, containers for agents, secrets, Pin). This page records what the engine is, how it is run, and why. Everything here was checked against Paperclip's source and by running it, not assumed.

## The engine is Paperclip, unmodified and pinned

[Paperclip](https://github.com/paperclipai/paperclip) is MIT licensed and is published to npm as `paperclipai` (Node >= 24.11). ePaperclip runs the published package at an exact version, installed from a lockfile with integrity hashes. There is no fork to carry for v1. Anything Proxmox-specific goes in through Paperclip's own extension points (plugins, environments, its HTTP API), so upgrading the engine is a version bump, not a merge.

Licence: Paperclip's MIT notice and copyright are kept with the installed package. See `docs/THIRD-PARTY.md`.

Measured with the real package (`paperclipai@2026.1005.0`, embedded Postgres, idle):

| | |
| --- | --- |
| Server process | about 0.5 GB resident |
| Embedded Postgres | about 0.4 GB across its backends |
| Disk, installed packages | about 1.4 GB (agent SDKs and CLIs are most of it) |
| Disk, an empty instance | about 75 MB |
| Install time | about 2 minutes on a good connection |

Plan for 2 GB of free RAM and 3 GB of disk for the engine. Agents do not run on the host: they run in containers (below).

## How people get in: managed accounts behind the Proxmox sign-in

The engine binds to loopback only. The only way in is ePaperclip's host service on port 443, which signs people in with their Proxmox account.

Paperclip has a trusted-header sign-in, but it is its "Paperclip Cloud" lane and it forbids creating organizations ("Company creation is managed by Paperclip Cloud") and puts everyone in one shared company, so it is not used. Instead the host service uses Paperclip's supported login:

1. At install, the host service creates an internal service account in the engine and claims the instance (`POST /api/bootstrap/claim`). It is the engine's only instance admin, and it is never exposed to a browser.
2. When a Proxmox user first signs in, the host service creates a **managed engine account** for them (`POST /api/auth/sign-up/email`) with a long random password that only the service knows, stored encrypted in the service's vault. The user never sees or types it.
3. On each sign-in the host service opens an engine session for that user and keeps its cookie server-side. The browser only ever holds the host service's own session cookie.
4. The browser talks to `/engine/api/*`. The host service checks the Proxmox session and the `X-EPC-Request` header, then forwards to the engine as that user. The live-events WebSocket is forwarded the same way.
5. Organizations (Paperclip "companies") can only be created by an engine instance admin. Proxmox decides who that is: on every sign-in, a person with `Sys.Modify` on `/` (an administrator of this node) is made an engine instance admin by the service account, and someone who lost that right in Proxmox loses it in the engine. Everyone else works in the organizations they are invited to (engine memberships and roles).

Verified end to end: sign-up, first-admin claim, two organizations created, and a second user who sees no organizations and cannot claim admin.

## Where agents run: containers, not the host

Paperclip runs an agent by leasing an environment, putting the workspace in it, running the agent CLI through a plain `execute` call, and releasing it. A sandbox provider is a Paperclip plugin implementing eight hooks (validate, probe, acquire, resume, release, destroy, realize workspace, execute). The closest existing model is the `exe-dev` provider: an HTTPS API creates the machine and `ssh` runs the commands.

ePaperclip's `proxmox` provider does the same with Proxmox LXC containers: clone a template into the organization's resource group, start it, wait for SSH, run commands over SSH, stop or destroy it. Container isolation (unprivileged, no host mounts) is what keeps agent code off the hypervisor. Open points before building it:

- One container per organization (shared, needs refcounting or an idle reaper) or per agent and workspace (natively supported by Paperclip's lease reuse). Per agent and workspace is simpler.
- Subscription sign-in for Claude and Codex goes through Paperclip's device-login flow, which needs the provider to implement its PTY hooks. API keys and OAuth tokens work without it.
- The template needs openssh-server, Node >= 24.11, and the agent CLIs.

## Secrets

Paperclip stores secrets with its own `local_encrypted` provider (a master key file next to the data) and injects them as `secret_ref` entries in adapter env. ePaperclip uses that for agent credentials and the engine's own secrets. The host service has a separate vault for the managed engine passwords. Keys are never sent to a browser.

## The interface

Our console stays the front end. Paperclip's own UI is about 490 components with a deep provider stack and no support for a path prefix, so it is not embedded. The console consumes the engine's HTTP API through a typed client generated from `/api/openapi.json` (728 paths), with `@paperclipai/shared` as the contract, pinned to the engine version. Where a Paperclip screen is better than ours, we copy the idea (MIT) rather than embed it.

## Pin

Paperclip ships an MCP server, an OAuth-scoped public MCP endpoint, and a "board" skill for operating a company over REST. Pin's tools build on those so it acts through the same API as the interface, as the signed-in person.

## Run order

1. Install the engine from the lockfile, as its own locked-down service on loopback.
2. Host service: vault, managed accounts, proxy for `/engine/api` and the events WebSocket.
3. Console: organizations, agents, tasks, goals, approvals, costs from the engine, replacing the demo data.
4. The `proxmox` sandbox provider, with an agent template.
5. Pin on the engine's MCP and API.
6. IAC: Proxmox users and permissions become engine memberships and roles.

## Contracts between the parts

These are fixed so the installer, host service, console, Pin and the sandbox provider can be built in parallel.

**Install layout**
- Private Node.js (pinned, verified): `/opt/epaperclip/node/bin/node`, used by both services.
- Host service and console: `/opt/epaperclip/epaperclip.mjs`, `/opt/epaperclip/console/`.
- Engine: `/opt/epaperclip/engine/` holds `package.json` and `package-lock.json` from this repo's `engine/` folder, installed with `npm ci` (integrity-checked). Entry point: `/opt/epaperclip/engine/node_modules/@paperclipai/server/dist/index.js`.
- Engine data: `/var/lib/epaperclip-engine` (`PAPERCLIP_HOME`), owned by system user `epaperclip-engine`.
- Engine settings: `/etc/epaperclip/engine.env`, mode 0600, generated once at install with fresh secrets (`BETTER_AUTH_SECRET`, `PAPERCLIP_AGENT_JWT_SECRET`) plus `PAPERCLIP_DEPLOYMENT_MODE=authenticated`, `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`, `HOST=127.0.0.1`, `PORT=3100`, `PAPERCLIP_PUBLIC_URL=http://127.0.0.1:3100`, `PAPERCLIP_ALLOWED_HOSTNAMES=127.0.0.1,localhost`, `PAPERCLIP_API_URL=http://127.0.0.1:3100`, `PAPERCLIP_MIGRATION_AUTO_APPLY=true`, `SERVE_UI=false`.
- Units: `epaperclip.service` (host service, port 443) and `epaperclip-engine.service` (engine, loopback 3100).
- Host service state: `/var/lib/epaperclip` (systemd `StateDirectory=epaperclip`, `EPC_STATE_DIR`), holding `vault.key` (0600, 32 random bytes) and `state.json` (settings, with every secret encrypted by the vault).
- The host service finds the engine at `EPC_ENGINE_URL` (default `http://127.0.0.1:3100`).

**Host service HTTP (browser-facing, all need the Proxmox session; writes need `X-EPC-Request: 1`)**
- `/engine/api/*` forwards to the engine's `/api/*` as the signed-in person's managed engine account. The WebSocket `/engine/api/companies/:id/events/ws` is forwarded the same way. Cookies from the browser are never forwarded; the engine session lives in the host service.
- `GET /api/engine/status`: `{ installed, reachable, ready, version, bootstrap: "pending" | "ready", error? }`.
- `GET /api/connectors`: providers and integrations with `{ id, kind, configured, last4?, testedAt?, ok? }`. Never returns a secret.
- `PUT /api/connectors/:id/credential` `{ apiKey }`, `POST /api/connectors/:id/test`, `DELETE /api/connectors/:id/credential`.
- `GET /api/pin/settings`, `PUT /api/pin/settings`: `{ provider, model, mode: "assistant" | "agent", connectors: string[] }`.
- `GET /api/pin/models?provider=`: models the configured key can use, read from the provider.
- `POST /api/pin/chat`: `{ messages, context: { page, device, org? } }`, answers as a server-sent event stream: `delta` (text), `tool` (a proposed or completed action), `done`, `error`.

**Console**
- Talks to the engine only through `@papercliped-engine/engine-client` (base `/engine`).
- Demo mode keeps its in-browser data; live mode uses the engine and Proxmox only, never demo data.
