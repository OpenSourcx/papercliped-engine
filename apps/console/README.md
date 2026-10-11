# Console (ePaperclip web UI)

The one interface for the machine: it replaces the stock Proxmox UI and carries Paperclip's look, reorganized as a system manager. Pin lives in a floating island at the top of every page.

**Status: demo data.** The console runs entirely in the browser against built-in demo data (the "Demo data" chip in the sidebar says so). The data layer in `src/data/store.tsx` has the shape the host broker and ePaperclip will serve; connecting them replaces that file's internals, not the pages.

```sh
pnpm --filter @papercliped-engine/console dev       # http://127.0.0.1:5173
pnpm --filter @papercliped-engine/console build
pnpm --filter @papercliped-engine/console test
```

## Routes

| Path | Page |
| --- | --- |
| `/setup` | Onboarding: organization name, your name, Pin's mode, AI account, Pin's access and the device name |
| `/<device>/home` | Home: greeting, the Ask Pin bar, host CPU/memory/storage, and a card per organization (agents working, CPU, memory; "Idle" when nothing is working) |
| `/<device>/<org>` | An organization: resource group usage against its limits, agents, tasks, members, connectors, container sessions |
| `/<device>/orgs/new` | New organization: "let Pin decide" sizing or manual sliders, and agent memory options |
| `/<device>/guests` | Every VM and container, with start and shut down; protected guests are locked |
| `/<device>/automations` | Pin's rules, with plain-language read-back |
| `/<device>/updates` | Proxmox and ePaperclip versions and pending updates |
| `/<device>/access` | Integrated Access Control: users mirrored as Proxmox users, sync state, per-user organizations, tools, connectors and policies |
| `/<device>/apps` | Connected apps (Papercliped, built in): the device's MCP address, the API only / Full / Agent only switch, each session's level, organizations and agents, and activity |
| `/<device>/connectors` | Who may use each system-wide connector: Pin and/or each organization |
| `/<device>/appearance` | The design framework: theme presets, accent, corners, glass and text size |
| `/<device>/settings` | Device, Pin's mode, `SOUL.md`/`MEMORY.md`, demo reset |

Organization slugs can never be one of the system page names (`home`, `access`, and so on), so `/<device>/<org>` never collides. A wrong device name redirects to the right one.

## Pin

- **Island** (`src/pin/PinIsland.tsx`): a liquid-glass pill at rest; a new notification expands it briefly like a live activity; click or Ctrl/Cmd+K opens Pin's panel with chat, notifications and the Assistant/Agent switch.
- **Ask Pin bar** (`src/pin/PinComposer.tsx`): the home page's large prompt with suggestions, mode picker and voice input where the browser supports it.
- **Brain** (`src/pin/brain.ts`): with no AI account it understands status checks, org creation, updates and automations by pattern. Automations go through the real validator and read-back in `@papercliped-engine/automations`, the same path the model-backed Pin will use.

## Design framework

All styling reads CSS variables (`src/index.css`). A theme is a preset plus user overrides (`src/theme/theme.tsx`), applied to `<html>` and saved per browser. Presets: Paperclip Warm (default), Graphite, Midnight and Daylight. Status colors are fixed and always paired with an icon and a label.
