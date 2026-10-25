# PinView

PinView (`/<device>/view`, the speech-bubbles icon under Pin in the rail) is the one place for every conversation on a device, laid out like a desktop chat app. The console stays the Proxmox homelab console; PinView is where you work with Pin and with your organizations' agents.

## Layout

| Area | What it holds |
| --- | --- |
| Sidebar (left) | **New chat**, **Files**, **Pull requests**, **Machine files**, "Chat with an agent…", a filter (All conversations, Unread, Pin only, or one organization) with "Mark all as read", a search box, then your **Pinned** chats, **Pin**'s chats and one folding section per organization with its agent chats. Your name and Settings at the bottom. |
| Conversation (middle) | The thread in a centered column; the composer; under it what the conversation runs on (Pin: permission and model; an agent: its status and organization). |
| Tiles (right) | Panes that open by themselves while the assistant works, plus Files and Pull requests when you open them. |
| Details (far right) | Folding cards, chosen with the **Show** menu. |

On a phone each area is its own pane: the list, then the conversation, and tiles or details as a full sheet with a close button.

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

**Machine files** in the sidebar opens a tile with a machine picker and that machine's whole file tree: a path bar you can click or type into, Up and Refresh, folders first, hidden files on request (the tile's menu), sizes. Clicking a file opens it in an editor tile:

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
