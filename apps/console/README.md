# Console (ePaperclip web UI)

The one interface for the machine: it replaces the stock Proxmox UI and carries Paperclip's look, reorganized as a system manager. Pin lives in a floating island at the top of every page.

**Status: demo data.** The console runs entirely in the browser against built-in demo data (the "Demo data" chip in the sidebar says so). The data layer in `src/data/store.tsx` has the shape the host broker and ePaperclip will serve; connecting them replaces that file's internals, not the pages.

```sh
pnpm --filter @papercliped-engine/console dev       # http://127.0.0.1:5173
pnpm --filter @papercliped-engine/console build
pnpm --filter @papercliped-engine/console test
```

## Layout: rail, context sidebar, modals

The console follows Discord's flow.

- **Rail** (far left): your device, then one avatar per organization (a green badge when agents are working), "+" to create one, and at the bottom Connected apps, Settings and you. Round buttons square off on hover; a pill marks where you are; tooltips show name and status on hover or keyboard focus (not on touch).
- **Context sidebar** (second column), like a channel list:
  - On the device: Overview, Automations, **Machines** (every VM and container, live), and **Host**: Host shell, Storage, Network, Backups.
  - Inside an organization: Paperclip's navigation (Dashboard, Inbox, Chat, Decisions; Work: Tasks, Projects, Goals, Routines, Artifacts, Workspaces; Agents; Organization: Org chart, Skills, Connectors, Costs, Activity, Settings) plus the organization's **Machines**.
- **Modals** for everything else: the full-screen settings modal, and centered modals for details, confirmations and creation. They stack, close with Esc from the top down, and animate in and out.

On phones the rail and context sidebar open together as a drawer.

## Machines and consoles

Every machine has a page with **Overview**, **Console**, **Snapshots**, **Hardware** and **Tasks**, plus power controls (start, shut down, reboot, and stop behind a confirmation). Protected machines are locked. Inside an organization, machine pages only open machines in its resource group.

The **Console** and the **Host shell** are xterm.js terminals behind a `TerminalTransport` (`src/terminal/transport.ts`). The terminal only sends keystrokes and writes what comes back, like a real TTY:

- **Live** (planned): the broker opens Proxmox's terminal proxy for the guest and relays the websocket; the browser never holds a Proxmox credential, and access follows the user's `guests.console` tool. The host shell is owner-only and never offered to agents or connected apps.
- **Demo** (today): a local line discipline (editing, history, Tab completion, Ctrl+C, Ctrl+L) in front of a simulated shell that answers from the machine's demo data. The terminal header says "Demo shell".

## Routes

| Path | What |
| --- | --- |
| `/setup` | Onboarding |
| `/<device>/home` | Home: greeting, the Ask Pin bar, host meters, organization cards |
| `/<device>/machines`, `/<device>/machines/<vmid>` | All machines, and one machine (`?tab=console` and so on) |
| `/<device>/shell`, `/storage`, `/network`, `/backups` | Host tools |
| `/<device>/automations` | Pin's rules |
| `/<device>/<org>` | The organization's dashboard |
| `/<device>/<org>/<section>` | `inbox`, `decisions`, `tasks`, `projects`, `goals`, `routines`, `agents`, `org`, `costs`, `activity`, `connectors`, `settings`, and Paperclip pages still to come (`chat`, `artifacts`, `workspaces`, `skills`) |
| `/<device>/<org>/machines/<vmid>` | One of the organization's machines |
| `?settings=<section>` | The settings modal over the current page: `general`, `updates`, `access`, `apps`, `connectors`, `appearance` |
| `?modal=new-org` | Create an organization |

Older addresses (`/<device>/guests`, `/<device>/access`, `/<device>/orgs/new` and so on) redirect to their new home. Organization slugs can never be a system name.

## Pin

- **Island** (`src/pin/PinIsland.tsx`): a liquid-glass pill at rest; a new notification expands it briefly like a live activity; click or Ctrl/Cmd+K opens Pin's panel with chat, notifications and the Assistant/Agent switch.
- **Ask Pin bar** (`src/pin/PinComposer.tsx`): the home page's large prompt with suggestions, mode picker and voice input where the browser supports it.
- **Brain** (`src/pin/brain.ts`): with no AI account it understands status checks, org creation, updates and automations by pattern. Automations go through the real validator and read-back in `@papercliped-engine/automations`, the same path the model-backed Pin will use.

## Design framework

All styling reads CSS variables (`src/index.css`). A theme is a preset plus user overrides (`src/theme/theme.tsx`), applied to `<html>` and saved per browser. Presets: Paperclip Warm (default), Graphite, Midnight and Daylight. Status colors are fixed and always paired with an icon and a label.
