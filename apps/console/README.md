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

## Pin's quick actions

There is no toolbar on the page. Hover Pin's island and it expands into the actions for where you are, like Proxmox's toolbar (Start, Shutdown, Console, More):

- On a machine: Start, Shut down, Console, Snapshot; under More: Reboot, Stop (confirmed first), Hardware, Task log, Ask Pin.
- In an organization: New task, Decisions, Agents, Machines; under More: Tasks, Org chart, Costs, Activity, Settings.
- On the device: Host shell, Resources, Summary, New organization; under More: Machines, Storage, Backups, Updates.

On touch screens the same actions sit at the top of Pin's panel when you tap the island. Pages register their actions with `usePinActions` (`src/pin/PinContext.tsx`); the most specific page wins over the app's defaults (`src/pin/RouteActions.tsx`), and a click always runs the newest version of the action.

## Graphs, Summary and Resources

- **Graphs** (`src/ui/TimeSeriesChart.tsx`, `src/ui/UsageGraphs.tsx`): every machine shows CPU, memory, network and disk IO; the node shows CPU and IO delay, memory, network and server load. Timeframes are Proxmox's (hour, day, week, month, year) with Average or Maximum. Each chart has a hover crosshair and tooltip, a legend when it has two series, and a table view. Colors are validated categorical slots per theme.
- **Summary** (`/<device>/summary`): the node's status and graphs.
- **Resources** (`/<device>/resources`): every node, machine, storage and zone in one sortable, searchable table with tags, like Proxmox's Search view. Rows open their page.

The demo history (`src/data/rrd.ts`) has the exact shape of Proxmox's `rrddata`, so switching to the broker's `/v1/stats` endpoints changes the data source, not the charts.

## Org chart

`/<device>/<org>/org` is a canvas: drag the background to pan, scroll or use the buttons to zoom, fit to screen, collapse branches, and search to highlight agents. Drag an agent onto another to change who it reports to; moves that would create a reporting loop are refused. Clicking an agent opens its details, including a "Reports to" picker as the keyboard-friendly way to move it.

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
