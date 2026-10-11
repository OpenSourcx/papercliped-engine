# Console (ePaperclip web UI)

The one interface for the machine: it replaces the stock Proxmox UI and carries Paperclip's look, reorganized as a system manager. Pin lives in a floating island at the top of every page.

**Status: demo data.** The console runs entirely in the browser against built-in demo data (the "Demo data" chip in the sidebar says so). The data layer in `src/data/store.tsx` has the shape the host broker and ePaperclip will serve; connecting them replaces that file's internals, not the pages.

```sh
pnpm --filter @papercliped-engine/console dev       # http://127.0.0.1:5173
pnpm --filter @papercliped-engine/console build
pnpm --filter @papercliped-engine/console test
```

## Layout: a rail and modals

The console follows Discord's flow. A slim **rail** on the left holds the main views: the device's Home, Guests, Automations, then one avatar per organization (a green badge when agents are working), a "+" to create one, and at the bottom Connected apps, Settings and you. Items are round and square off on hover; a pill on the left edge marks where you are; tooltips show the name and status.

Everything else opens as a **modal** over the page you're on:

- **Settings** is a full-screen modal with categories on the left (General, Updates, Access control, Connected apps, Connectors, Appearance) and closes with Esc.
- **Details** (a user's access, an app session) and **Create an organization** open as centered modals.
- Modals stack, and Esc closes only the top one. They scale and fade in and out.

## Routes

| Path | What |
| --- | --- |
| `/setup` | Onboarding: organization name, your name, Pin's mode, AI account, Pin's access and the device name |
| `/<device>/home` | Home: greeting, the Ask Pin bar, host meters and a card per organization ("Idle" when nothing is working) |
| `/<device>/guests` | Every VM and container, with start and shut down; protected guests are locked |
| `/<device>/automations` | Pin's rules with plain-language read-back |
| `/<device>/<org>` | An organization: resource group usage, agents, tasks, members, connectors, container sessions |
| `?settings=<section>` | Opens the settings modal over the current page: `general`, `updates`, `access`, `apps`, `connectors`, `appearance` |
| `?modal=new-org` | Opens "Create an organization" |

Older addresses such as `/<device>/access` or `/<device>/orgs/new` open the matching modal over Home. Organization slugs can never be a system name, so `/<device>/<org>` never collides, and a wrong device name redirects to the right one.

## Pin

- **Island** (`src/pin/PinIsland.tsx`): a liquid-glass pill at rest; a new notification expands it briefly like a live activity; click or Ctrl/Cmd+K opens Pin's panel with chat, notifications and the Assistant/Agent switch.
- **Ask Pin bar** (`src/pin/PinComposer.tsx`): the home page's large prompt with suggestions, mode picker and voice input where the browser supports it.
- **Brain** (`src/pin/brain.ts`): with no AI account it understands status checks, org creation, updates and automations by pattern. Automations go through the real validator and read-back in `@papercliped-engine/automations`, the same path the model-backed Pin will use.

## Design framework

All styling reads CSS variables (`src/index.css`). A theme is a preset plus user overrides (`src/theme/theme.tsx`), applied to `<html>` and saved per browser. Presets: Paperclip Warm (default), Graphite, Midnight and Daylight. Status colors are fixed and always paired with an icon and a label.
