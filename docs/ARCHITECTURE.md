# Architecture

Status: draft. This describes the target system and marks which parts exist in this repository today.

## Layers

```
                         Browser, phone, MCP apps
                                   |
                     Console (one UI, design framework)
                                   |
        +--------------------------+---------------------------+
        |                          |                           |
       Pin                     ePaperclip                 Notifications
  (copilot, modes,      (companies, agents, tasks,      (updates, approvals,
   SOUL.md, MEMORY.md)   budgets, connectors, adapters)  automation results)
        |                          |
        +------------+-------------+
                     |
          Automations engine (deterministic rules)       Vault (secrets)
                     |
               Host broker  (the only holder of the Proxmox token)
                     |
         Proxmox VE engine: pveproxy API, KVM, LXC, storage, network
                     |
                 Debian host
```

## Components

| Component | Responsibility | In this repo |
| --- | --- | --- |
| `packages/proxmox-client` | Typed, minimal Proxmox VE API client. TLS always verified. | Yes |
| `services/host-broker` | Holds the Proxmox token. Exposes a small allowlisted API with two kinds of caller: Pin (system scope) and companies (resource-group scope). Enforces hard limits and protected guests. Audit log. | Yes (core logic) |
| `packages/automations` | Deterministic trigger engine. Evaluates rules against host metrics and decides actions. Mode-aware: Assistant proposes, Agent acts. | Yes |
| `services/epaperclip` | The host service: serves the console, signs users in through Proxmox's own login, and calls Proxmox as the signed-in user. | Yes |
| `apps/console` | The single UI: Paperclip's style as a system manager, Pin's island, onboarding, IAC screens, design framework. Routes are `/<device>/home` and `/<device>/<org>`. | Yes (live host data; org data still demo) |
| ePaperclip (`upstream/paperclip` fork) | Paperclip, redesigned and extended. | Planned |
| Pin | Copilot runtime: modes, skills, `SOUL.md`/`MEMORY.md`, turns language into rules and tasks. | Planned |
| Installer | ISO and apt repository on top of upstream Proxmox VE packages. | Planned |

## Fork strategy

- **Proxmox:** keep upstream packages unchanged (hypervisor, API daemons, storage, cluster). Replace what the user sees: the web UI entry point, branding, installer. This is how other Proxmox derivatives stay maintainable. The name cannot contain "Proxmox" (registered trademark). Shipping Proxmox packages means meeting their AGPL-3.0 obligations for those packages.
- **Paperclip:** fork `paperclipai/paperclip` (MIT) into ePaperclip, keeping its history so upstream changes can be merged. Keep every existing feature; add host awareness, resource groups, Pin and the design framework.

## Trust model

1. **Only the broker holds the Proxmox token.** Pin, ePaperclip and agents call the broker; none of them can reach the hypervisor API directly.
2. **Two scopes.**
   - **Company scope** = one resource group = one Proxmox pool, a vmid range and a tag. A company can create, read and destroy its own containers within its limits and nothing else.
   - **System scope** = Pin. Pin can read the whole host and power-manage guests, except guests on the protected list, which no caller can touch.
3. **Language never executes directly.** Pin turns "shut down any container over 50% memory" into a rule. The rule is validated against a schema and executed by the automations engine through the broker. A malformed or out-of-scope rule is rejected before it runs.
4. **Mode is enforced in code, not in prompts.** In Assistant mode the automations engine downgrades every action to a proposal that needs your approval.
5. **Secrets live in the Vault** and are delivered per run; agents never receive system-wide tokens.
6. **Audit everything.** Broker calls and automation decisions are logged.

## Resource groups

| Field | Meaning |
| --- | --- |
| `pool` | The Proxmox pool that holds the company's guests. |
| `vmidRange` | IDs this group may allocate. Never overlaps another group. |
| `tag` | Proxmox tag every guest in the group carries. |
| `limits` | Max guests, total cores, total memory, total disk, lease lifetime. |
| `profiles` | Which container profiles the group may launch. |

A guest belongs to a group only if it is in the pool, in the range and carries the tag. All three must hold.

## Automations

A rule has a trigger, a scope, an action and a mode policy:

```json
{
  "id": "mem-guard",
  "name": "Shut down containers over 50% memory",
  "when": { "metric": "memory_percent", "op": ">", "value": 50, "forSeconds": 60 },
  "scope": { "guestType": "lxc" },
  "then": { "action": "shutdown" },
  "cooldownSeconds": 600
}
```

Metrics come from the Proxmox cluster resource list (`mem`/`maxmem`, `cpu`, `disk`/`maxdisk`, `status`). Actions are `notify`, `shutdown`, `stop`, `start` and `snapshot`. Destructive actions such as destroy are not available to automations.

## Papercliped, native

The Papercliped bridge moves onto the device as an ePaperclip service instead of a separate hosted service. It serves MCP at `https://<device>/mcp` with OAuth sign-in against ePaperclip users. Sessions, the two access levels (Read only, Full control), the API only / Full / Agent only switch, per-agent overrides, tool and agent limits, and the activity log keep the behavior they have in Papercliped today (`src/access/policy.ts` and `src/access/guard.ts` in the Papercliped repository). What changes:

- **Identity:** a session is approved by an IAC user and is capped by that user's organizations, tools and policies, so console, Proxmox and AI-app access come from one place.
- **Scope:** sessions can be limited to organizations as well as agents.
- **Host tools:** with Full control and a user whose policies allow it, a session can reach Pin's system tools (through the broker, never directly), so an AI app can check host status or power-manage a guest the same way Pin does.
- **No hosted dependency:** the device is the authorization server. Apps on the web reach it through the user's own remote access (Tailscale or a tunnel).

## Usage history

The broker serves Proxmox's round-robin statistics read-only: `GET /v1/stats/node` (Pin only) and `GET /v1/stats/guests/:vmid` (Pin for any guest, a company only for guests in its resource group), each with `timeframe` (hour, day, week, month, year) and `cf` (AVERAGE, MAX). It calls `/nodes/{node}/rrddata` and `/nodes/{node}/{lxc|qemu}/{vmid}/rrddata`, which need only `Sys.Audit` and `VM.Audit`.

## Consoles and shells

Machine consoles and the host shell use Proxmox's own terminal proxy, relayed by the `epaperclip` service:

1. The browser opens a WebSocket to `/api/console/guests/<vmid>` (or `/api/console/node` for the host shell). The service refuses the upgrade unless the session cookie is valid and the `Origin` is this host, since WebSockets get no CORS protection.
2. As the signed-in user, the service calls `termproxy` for the container, the VM's serial port or the node. Proxmox checks `VM.Console` or `Sys.Console`, so a user only gets the consoles their Proxmox permissions allow. Agents and connected apps never get the host shell.
3. The service connects to `vncwebsocket` with the user's ticket, sends Proxmox's `user:ticket` handshake, waits for `OK`, then relays frames both ways. Neither ticket reaches the browser.
4. The browser's xterm.js terminal speaks Proxmox's framing (`0:<bytes>:<data>` for input, `1:<cols>:<rows>:` to resize, `2` to keep alive).

A VM's screen uses Proxmox's VNC proxy the same way. `POST /api/guests/<vmid>/vnc` asks Proxmox for a VNC proxy as the signed-in user, with a generated one-time VNC password. The service keeps the port and ticket under a random id that only that session can use, once, within 30 seconds, and returns the id and password. The browser's noVNC viewer connects to `/api/vnc/<id>`, which the service relays as raw binary to `vncwebsocket`. The password is useless without the relay, and the relay never hands out the ticket.

The console's terminal is written against a transport interface, so the demo shell and the live relay are interchangeable.

## Runs on the host

ePaperclip is not a guest on the machine it manages. It runs on the Proxmox host itself, next to `pveproxy`, as systemd services:

| Service | Listens | Does |
| --- | --- | --- |
| `epaperclip` | `:443` | Serves the console and its API with the node's own certificate (`/etc/pve/local/pve-ssl.pem`). Talks to Proxmox on `https://127.0.0.1:8006`, verified against the cluster CA. Runs as its own user with only `CAP_NET_BIND_SERVICE`. |
| `epaperclip-broker` (planned on the host) | loopback | Holds the Proxmox token for Pin, automations and company leases. |
| stock Proxmox UI | `:8006` | Unchanged, kept as the emergency console. |

`deploy/install.sh` installs the first; the others follow as they move onto the host.

## Integrated Access Control (IAC)

**Sign-in is Proxmox's own.** The console's login page sends the username, password and realm to the `epaperclip` service, which calls Proxmox's `/access/ticket`, including the two-factor step (`tfa-challenge` with `totp:` or `recovery:` codes). From then on the service calls Proxmox with that user's ticket, so Proxmox's permissions decide what each person sees and can change: a user without `Sys.Audit` gets no node graphs, one without `VM.PowerMgmt` can't power a guest, one without `VM.Allocate` can't create a machine. The browser never sees the Proxmox ticket; it holds a random session id in an `HttpOnly`, `SameSite=Strict`, `Secure` cookie. Every change also needs an `X-EPC-Request` header and a same-site `Origin`. Failed sign-ins are rate limited per address and per user. Sessions renew the Proxmox ticket while in use and end after two hours idle or twelve hours in total. Served without the service (in development), the console runs on demo data.

Every ePaperclip user is also a real Proxmox user (for example `sam@pve`). ePaperclip is the source of truth: creating, changing or removing a user, their organization roles and their policies updates the matching Proxmox user, roles and ACLs, so access is the same in the console and in the stock Proxmox UI. Policies are allow or deny rules over actions and resources; each is mirrored as a Proxmox role. Organization access maps to the organization's pool. The console screens exist; the sync backend is planned and will run through the broker with its own narrowly scoped permission (`User.Modify` and `Permissions.Modify` on the relevant paths).

## Firewall and network safety

Both act as the signed-in user, so Proxmox's permissions decide who may change them. Two guards sit on top:

- **Console lock-out.** Proxmox keeps its own interface (:8006) and SSH reachable when its firewall drops everything else, but not ePaperclip's port. Before turning the firewall on, switching an inbound policy away from accept, or removing or disabling a rule, the host service reads the datacenter and host rules and checks that an enabled inbound rule lets the console's port in. If not, it answers `409 lockout`, and the console offers to add one host rule that keeps the console reachable (or to continue anyway).
- **Staged network changes.** Interface and SDN changes are written to Proxmox's pending configuration and shown as a diff. Nothing changes on the host until they are applied, and they can be reverted. Deleting the interface that carries the gateway needs its name typed, in the UI and in the service.

Rules, options, aliases, IP sets, DNS and SDN fields are checked against narrow patterns before they reach Proxmox, and unknown option keys are refused.

## Connector access

Each system-wide connector has an access list: `pin` and zero or more company IDs. Paperclip's existing connections model (applications, connections, profiles, bindings, policies, approvals) carries this; the new piece is the Pin principal and the per-company grant UI.

## Engines

- **Native:** Paperclip's existing local adapters, run by the engine service on the host.
- **Container session:** a lease from the broker in the company's resource group; the agent runs inside it over SSH, and the lease is destroyed afterwards or when it expires.
