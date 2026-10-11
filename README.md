# papercliped-engine

A Proxmox-native system with **ePaperclip** and **Pin** built in. One clean interface replaces the stock Proxmox UI and manages your server, your companies and your AI agents. Pin, your personal copilot, lives in the system and looks after it for you.

- **Proxmox engine:** upstream Proxmox VE underneath (KVM, LXC, storage, network, backups), unchanged.
- **ePaperclip:** Paperclip redesigned to run natively on Proxmox. Companies, agents, tasks, budgets, approvals, connectors and adapters all stay; each company gets its own resource group on the machine.
- **Pin:** your copilot, in Assistant or Agent mode. It manages the system, your companies and your connectors, turns "if a container uses more than 50% of its memory, shut it down" into an automation, keeps a `SOUL.md` and `MEMORY.md`, and tells you when updates are available.

Read [docs/VISION.md](docs/VISION.md) for the product, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together, and [docs/ROADMAP.md](docs/ROADMAP.md) for what is built.

## What is in this repository today

| Path | What | Status |
| --- | --- | --- |
| `packages/proxmox-client` | Minimal Proxmox VE API client (API tokens, verified TLS, task waiting) | Working, tested |
| `packages/automations` | Pin's deterministic trigger engine: rule validation, plain-language read-back, mode-aware decisions | Working, tested |
| `services/host-broker` | The only holder of the Proxmox token: resource groups for companies, system scope for Pin, protected guests, lease expiry, audit log, HTTP API | Working, tested against a fake Proxmox; not yet run against a real host |

Not built yet: the console UI, the ePaperclip fork, the Pin runtime, the installer. See the roadmap.

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test
```

Requires Node 22 or later and pnpm.

## Run the broker

See [services/host-broker/README.md](services/host-broker/README.md) for the Proxmox permissions it needs and an example configuration.

## License

MIT. Proxmox VE is AGPL-3.0 and a trademark of Proxmox Server Solutions GmbH; this project is not affiliated with it and does not use its name for the product. Paperclip is MIT, copyright Paperclip AI.
