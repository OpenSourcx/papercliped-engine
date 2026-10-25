# PinView

PinView (`/<device>/view`, the speech-bubbles icon under Pin in the rail) is the one place for every conversation on a device, laid out like a desktop chat app. The console stays the Proxmox homelab console; PinView is where you work with Pin and with your organizations' agents.

## Layout

PinView is laid out like a desktop chat app:

```
sidebar | conversation  [cards] [plan] [terminal] [files] [⋯] [Share] | cards | tiles
        |                                                              |       | Plan
        |                                                              |       | Files (tree + tabs)
        |                                                              |       | Terminal ...
```

| Part | What it does |
| --- | --- |
| Sidebar | Hide it, back and forward through the conversations you opened, and the way back to the console. Places: **New chat**, **Search** (Go to), **Artifacts**, **Machine files**, **Pull requests**, **Automations**, **Customize** (Pin's settings). Then **Pinned**, one group per **organization** with its agent chats, and **Recents** with Pin's chats. Groups fold and end in "Show more"; each group's menu starts a chat with one of its agents, marks it read, and collapses or expands all. A row ends in its state (working, waiting for you, unread) and has a menu: Pin, Rename, Copy link, Mark as read, Delete. |
| Conversation | The chat in a centered column. The toolbar's icons show what is open and toggle it: **Cards**, **Plan**, **Terminal**, **Files**; **⋯** has Artifacts, Pull requests, Pin, New chat and Search; **Share** copies a link to the conversation. |
| Cards | **Environment** (the device, the machines this conversation touched with a shortcut to their files, the repositories followed), **Context** (an estimate of how full the conversation is), **Connectors** (each with Set up or Reconnect when it needs it), **Changes** (open, failing and merged pull requests), **Background tasks** (steps still running). The **Show** menu picks the cards. |
| Tiles | Panes stacked in a column, each with its own actions, **expand** and **close**, the line between two dragging to share the height: **Plan** (the conversation's tasks: a written plan's steps with their state, or the steps Pin took, ticked off as they finish), **Files** (a machine's tree beside tabs for files, Pin's steps and artifacts), **Terminal** (this device or any running machine), **Artifacts**, **Pull requests**. A file or command Pin touches opens in Files as a preview tab, and a written plan opens Plan, by themselves. |

Keyboard: **Ctrl/Cmd+P** Go to (conversations, open files, agents, every command), **Ctrl/Cmd+B** sidebar, **Ctrl/Cmd+.** cards, **Alt+N** new chat with Pin, **Alt+W** close the file tab. In the terminal only Go to is taken. The arrangement (sidebar width, which tiles, their sizes, the tile column's width) is kept per browser.

On a phone the sidebar is the first screen; a conversation opens over it, and the cards and tiles open as full sheets from the toolbar.

PinView sits above the console and below its dialogs (`--z-workspace`), so confirmations it opens show over it.

## Menus

All menus are the shared `Menu` component (`apps/console/src/ui/Menu.tsx`): arrow keys move, Enter runs, Escape closes and returns focus.

- **A conversation row** (the "⋯" on hover): Pin or Unpin, Rename, Copy link, Delete. Delete asks once more in the row ("Delete" or keep it). Rename and Delete exist only for Pin's chats; an agent chat is named after its agent and lives in its organization. A copied link opens PinView on that chat (`?chat=<id>` for Pin, `?c=agent:<company>:<agent>` for an agent).
- **A message** (the "⋯" on hover): Copy message (plain words), Copy message as Markdown, Quote in reply (puts the message in the composer as a quote).
- **A tile**: file and command tiles have Word wrap and Line numbers, and Copy contents / Copy path or Copy command / Copy output; a plan tile can be copied as a list.
- **Details → Show**: which cards appear (Pin: Model, Permissions, Connectors, Changes; an agent: Agent, Organization, Files, Changes) and Reset to defaults. The choice is kept in this browser.
- **Changes** (administrators, once GitHub is connected): Show all pull requests, Refresh, Change token or repositories, Disconnect GitHub.

## Tiles from tool calls

Tiles are derived from the open conversation's tool steps (`pages/pinview/tiles.ts`), so they appear and update as a step runs and finishes:

| Tool | Tile |
| --- | --- |
| `machine_read_file` | The file, with its path and machine; the content Pin read. |
| `machine_write_file` | The file with the proposed contents, marked "Waiting for you" until you approve it in the chat. |
| `machine_exec` | The command and its output. |
| `propose_plan` | The plan's steps (destructive ones marked) and a link to approve them on the Plans tab. |

A new tile opens the tiles column by itself on a wide screen; on a phone the Tiles button in the header shows a count instead, so the conversation stays in view. The newest three tiles show; "Show N earlier" reveals the rest. Expand gives one tile the whole column; closing a tile hides it for this conversation. Agent chats have no tool steps in the engine's chat yet, so they produce no tiles.

## Unread and the organization filter

A conversation is unread when it changed after you last opened it: a dot and bold title on the row, a count on its section, and a count on PinView's icon in the rail (agent chats; Pin's own chats are read as you write them). Opening a conversation reads it, and so does anything that arrives while it is open. Anything older than your first visit to PinView counts as read, so the list doesn't start full of dots. What you have read is kept in this browser.

The filter above the list shows everything, only unread conversations, only Pin, or one organization; "Mark all as read" is in the menu beside it.

## Machine files and editing

The **Files** tile shows a machine's whole file tree (toggle it with the tree icon): pick a machine and a starting folder, open folders in place, show hidden files from its menu, refresh. Clicking a file opens it in a tab:

- Text files up to 48 KB open; binary files and bigger ones say so instead.
- **Edit** turns the view into an editor: Tab indents (Escape then Tab moves on), the footer shows line and column, the title gets a dot while there are unsaved changes, **Save** (or Ctrl/Cmd+S) writes it back, **Revert** drops your changes.
- Saving sends the version you opened; if the file changed in the machine meanwhile, nothing is overwritten and the tile offers **Reload**.
- A file tile from one of Pin's steps has **Edit the live file**, which opens the file as it is now in the machine in an editor tile.

How it works (`services/epaperclip/src/features/machine-files.ts`): `GET /api/guests/:vmid/files?path=`, `GET /api/guests/:vmid/file?path=`, `PUT /api/guests/:vmid/file` (`{ path, content, etag }`). They run through the same in-machine path as Pin's machine tools (the guest agent for a VM; for a container its console, which must open into a shell), as the signed-in person, so Proxmox's permissions decide. File contents travel as base64 so nothing is changed on the way; a write goes to a temporary file and is copied over the original so owner and permissions stay, in pieces short enough for any terminal. Pin's `machine_write_file` now writes large files in pieces the same way.

## Pull-request tracking

An administrator connects GitHub once (Details → Changes, or Pull requests in the sidebar): a token with read access to pull requests and checks, and up to 12 repositories as `owner/name`. Then everyone signed in sees:

- in the **Changes** card: how many are open, how many have failing checks, and the five newest;
- in the **Pull requests** tile: the full list with state (open, merged, closed, draft), author, branch, age and checks (passed, failed, running), each linking to GitHub.

Pin can read the same list with the `list_pull_requests` tool ("how are my PRs doing?"); it can't change anything on GitHub.

How it works (`services/epaperclip/src/features/github.ts`):

- `GET /api/github`, `PUT /api/github` (`{ token?, repos? }`, administrators, a new token is checked against `GET /user` first), `DELETE /api/github`, `GET /api/github/prs`.
- The token is stored sealed, never returned (only its last four characters) and only sent to `api.github.com`.
- Answers are cached for a minute per token and repository list. Only `https://github.com/...` addresses become links. A repository GitHub can't see is reported on its own without hiding the others.

## Not built yet

Browsing an agent workspace's files (the engine has no routes for them), webhooks so pull requests update the moment they change (today: once a minute), unread state shared across browsers, and Collaborate rooms in the sidebar.

## The status line under the composer

On Pin's chat the line under the composer is interactive: click **Agent mode** or **Assistant mode** to switch; in Agent mode on a device, click the permission (Ask, Accept edits, Auto, Plan) to change what Pin may do on its own (Bypass is still set in Pin's settings, with its typed confirmation); the model on the right opens Pin's settings. On a phone the Plan, Terminal and Files icons move into the toolbar's More menu.
