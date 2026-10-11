# papercliped-engine

A Proxmox-native system with **ePaperclip** and **Pin** built in. One clean interface replaces the stock Proxmox UI and manages your server, your companies and your AI agents. Pin, your personal copilot, lives in the system and looks after it for you.

- **Proxmox engine:** upstream Proxmox VE underneath (KVM, LXC, storage, network, backups), unchanged.
- **ePaperclip:** Paperclip redesigned to run natively on Proxmox. Companies, agents, tasks, budgets, approvals, connectors and adapters all stay; each company gets its own resource group on the machine.
- **Papercliped, built in:** Claude, ChatGPT, Codex and any MCP app connect straight to the device, each with Read only or Full control and never more than the user who approved it.
- **Pin:** your copilot, in Assistant or Agent mode. It manages the system, your companies and your connectors, turns "if a container uses more than 50% of its memory, shut it down" into an automation, keeps a `SOUL.md` and `MEMORY.md`, and tells you when updates are available.

Read [docs/VISION.md](docs/VISION.md) for the product, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together, and [docs/ROADMAP.md](docs/ROADMAP.md) for what is built.

## What is in this repository today

| Path | What | Status |
| --- | --- | --- |
| `packages/proxmox-client` | Minimal Proxmox VE API client (API tokens, verified TLS, task waiting) | Working, tested |
| `packages/automations` | Pin's deterministic trigger engine: rule validation, plain-language read-back, mode-aware decisions | Working, tested |
| `services/host-broker` | The only holder of the Proxmox token: resource groups for companies, system scope for Pin, protected guests, lease expiry, audit log, HTTP API | Working, tested against a fake Proxmox; not yet run against a real host |
| `services/epaperclip` | The host service: serves the console on port 443 with the node's own certificate, signs people in with their Proxmox accounts (Integrated Access Control) and acts on Proxmox as them | Working, tested against a fake Proxmox |
| `apps/console` | The ePaperclip web UI: onboarding, home with the Ask Pin bar, Pin's floating island and page-aware quick actions, org dashboards, machines, drives, automations, Integrated Access Control, connectors, appearance | Live host, machines, drives and graphs through the host service; organizations and agents still on demo data |
| `deploy/` | systemd unit and installer for a Proxmox VE host | Ready to try |

Not built yet: the ePaperclip fork (organizations, agents and tasks on the console are demo data until then), the model-backed Pin runtime, live consoles, the installer ISO. See the roadmap.

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test
```

Requires Node 22 or later and pnpm.

## Install on a Proxmox host

```sh
pnpm install && pnpm build        # from this repository
sudo ./deploy/install.sh          # on the Proxmox VE host, from the same checkout
```

Then open `https://<host>/` and sign in with any Proxmox account (pam, pve, LDAP, with two-factor if you use it). What each person can see and do is exactly what their Proxmox permissions allow. The stock Proxmox UI stays at `https://<host>:8006/` as the emergency console. Details in [services/epaperclip/README.md](services/epaperclip/README.md).

## Try the console without a host

`pnpm --filter @papercliped-engine/console dev` runs the console on its own, on demo data.

## Run the broker

See [services/host-broker/README.md](services/host-broker/README.md) for the Proxmox permissions it needs and an example configuration.

## License

MIT. Proxmox VE is AGPL-3.0 and a trademark of Proxmox Server Solutions GmbH; this project is not affiliated with it and does not use its name for the product. Paperclip is MIT, copyright Paperclip AI.
