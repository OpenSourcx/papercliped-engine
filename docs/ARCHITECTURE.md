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
| `apps/console` | The single UI. Starts from Paperclip's UI and adds host pages and the design framework. | Planned |
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

## Connector access

Each system-wide connector has an access list: `pin` and zero or more company IDs. Paperclip's existing connections model (applications, connections, profiles, bindings, policies, approvals) carries this; the new piece is the Pin principal and the per-company grant UI.

## Engines

- **Native:** Paperclip's existing local adapters, run by the engine service on the host.
- **Container session:** a lease from the broker in the company's resource group; the agent runs inside it over SSH, and the lease is destroyed afterwards or when it expires.
