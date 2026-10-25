# Hand-off: refine PinView's UI

You are taking over the visual design of **PinView**, ePaperclip's workspace for working with its assistant (Pin) and the organizations' AI agents. The structure and features are built and tested; your job is to make it look and feel finished. Refine, don't rebuild: keep every feature and test passing.

## What ePaperclip is

ePaperclip turns a Proxmox host into a device you run from one web console, with Paperclip (a company-of-agents engine) built in. Pin is the device's assistant: it reads the host, acts on it (in Agent mode, gated by permission modes), and works inside machines. PinView (`/<device>/view`) is where people have long sessions with Pin and with agents, open the files and plans Pin touches, run a terminal and follow pull requests.

## The owner's design choices (follow these)

1. **The feel of a desktop chat app.** The reference is a modern desktop AI-chat client: a calm left sidebar (places, then Pinned, groups and Recents, rows that end in a state icon), a centered conversation, **interactive toolbar icons** at the top right that open panes beside it and look pressed while open, a **column of cards** (Environment, Context, Connectors, Changes, Background tasks) and **stacked tiles** (Plan with a task checklist, Files with a tree and tabs, Terminal), each tile with expand and close. Clean, quiet, dense but breathable.
2. **ePaperclip's own visual language**, not Paperclip's: our tokens, our themes (Paperclip Warm is the default dark theme), our components. Match Paperclip's flows and words where it has them, never its colours or mascot.
3. **Liquid glass** where it helps (bars, menus, popovers), with an amount the person controls in Appearance (Transparency effects on/off, a "Liquid glass" amount). Everything must still look right with transparency off.
4. **The accent is the person's choice** (Appearance offers a palette and a custom colour). Use `bg-accent` + `text-on-accent` together; never assume the accent is gold.
5. **Every UI element is one referenced component.** If you need a control, use the one in `apps/console/src/ui/` (Button, IconButton, Select, Menu, Slider, ColorPicker, Toggle, Segmented, Modal, ResizeHandle, Notice, Chip, Status...). If none fits, add it there once, document it in `DESIGN.md`, and use it everywhere.
6. **No dialog when a page or pane will do.** Updates is a page, not a modal; file edits happen in place; confirmations are short and only for losing work or destroying something.
7. **Responsive for real:** desktop, tablet and a 390px phone. On a phone each part is its own screen (sidebar first, conversation over it, cards and tiles as full sheets).
8. **Plain words.** Short, sentence case, say what happens; see `DESIGN.md` → Words.

## The goal is UX, not only looks

Give the **composer and how people put things in** the same weight as the visuals. PinView is where someone works on several organizations and projects at once with Pin and the agents; typing should be the fastest way to do anything.

### The composer: `/`, `@` and `#`

| Typed | Opens | What it does |
| --- | --- | --- |
| `/` | a command list | Workspace and Pin commands, filtered as you type, with descriptions: `/new`, `/plan` (ask Pin for a written plan), `/terminal`, `/files`, `/mode agent`, `/permission ask`, `/model`, `/clear`, `/automation` (describe a standing rule), `/remember`, plus each organization's useful actions (`/task`, `/hire`). Enter runs; Tab completes. |
| `@` | a mention picker (see `docs/design/reference/composer-mention-picker.png`) | Mention a **person** (a Proxmox user on this device), an **agent** (any organization; the message reaches it), an **organization** or **project**, a **machine**, or a **file** (a machine's file through the Explorer, or an artifact). The mention becomes a chip in the field and travels as context with the message, so Pin or the agent knows exactly what you mean. |
| `#` at the start | "Pin board" | Saves the line straight to Pin's memory, without a reply: `# we need to focus on work` is remembered at once and shown as a small "Remembered" chip. It uses Pin's memory file (`pinLibrary.save("memory", …)`, `apps/console/src/data/engine/pinLibraryApi.ts`); add a host route that appends one line if the edit has to be atomic. |

Rules for all three: open as a small popover anchored to the caret (our `Menu`/`Select` popover look, glass); arrow keys, Enter, Tab, Escape; type to filter; recent and most likely items first; works with the keyboard alone and on a phone. Mentions and commands are tested like the rest.

### Also in scope for UX

- **The thread:** group an assistant's steps the way `docs/design/reference/thread-grouped-tool-calls.png` does: one collapsed line ("Ran 5 commands", "Read 3 files") that opens into the steps, each folding again with its command and output.
- **Several organizations and projects at once:** switching never loses your place; tiles can hold things from different organizations; the sidebar shows what is working and what waits for you everywhere.
- **The composer's status line** (mode, permission, model) is interactive: click to change, as in `docs/design/reference/composer.png`.

## Dynamic tiling (the goal)

Tiles should behave like a tiling window manager (Hyprland is the reference): panes **size themselves automatically** to share the space as they open and close, split horizontally or vertically, can be **dragged to rearrange** or to split another pane, and be resized by dragging any edge between them. Keyboard: move focus between panes and move a pane with modifier + arrow keys; maximise and restore. The current tile column (`workspace/Tiles.tsx`, a single vertical stack with fixed heights) is the starting point; replace it with a real layout tree (splits and leaves) kept per browser.

## Consistent controls

Icon controls are **bare icons**: no box, no border, no fill until hovered or pressed (see `docs/design/reference/tile-header-icons.png` and `tile-expand-close.png`). The same size, spacing and hover everywhere: toolbar, tile headers, cards, sidebar. Fix the places where icons sit in bordered boxes. Study how the reference app looks in **dark mode**: low-contrast separators, surfaces that differ by one step, no heavy borders.

## Reference images

`docs/design/reference/` holds the owner's reference screenshots with a README saying what to take from each. Read it before you start.

## Read first

- `apps/console/DESIGN.md` — the design book: tokens (three tiers), status vocabulary, motion, layers, component inventory, **PinView workspace** rules, words, accessibility, enforcement.
- `docs/PINVIEW.md` — what every part of PinView does, with the keyboard shortcuts.
- `apps/console/src/index.css` — tokens and the few global classes (`.glass`, `.glass-bar`, `.transition-control`, motion).

## Where the code is

| Part | File |
| --- | --- |
| PinView (layout, state, toolbar, tiles wiring) | `apps/console/src/pages/pinview/PinView.tsx` |
| Sidebar | `pages/pinview/workspace/Sidebar.tsx` |
| Cards | `pages/pinview/workspace/Cards.tsx` |
| Tile column | `pages/pinview/workspace/Tiles.tsx` |
| Files tile: tabs, tree, editor | `workspace/EditorGroup.tsx`, `workspace/Explorer.tsx`, `pages/pinview/MachineFiles.tsx` |
| Step output / plan / file viewer | `pages/pinview/TileView.tsx` (`Pane`, `Code`), `pages/pinview/tiles.ts` |
| Pull requests | `pages/pinview/Changes.tsx` |
| Terminal tile | `workspace/MachineTerminal.tsx` (uses `src/terminal/`) |
| Go to palette | `workspace/Palette.tsx` |
| The conversation itself | `src/pin/PinThread.tsx`, `src/pin/PinCards.tsx`, `src/pin/ThreadContext.tsx` |
| Shared controls | `src/ui/` (`Menu.tsx`, `ResizeHandle.tsx`, `Select.tsx`, `primitives.tsx`...) |
| Theme runtime (accent, glass, transparency, mode) | `src/theme/theme.tsx`, Appearance page `src/pages/Appearance.tsx` |

## What we'd like refined

These are the known weak spots; fix them and anything else you see:

- **Typography and rhythm:** consistent sizes and weights between sidebar, card titles, tile headers and the conversation; tighten line heights in dense lists.
- **Sidebar polish:** row height, hover and active states, the group headers, the "Show more" row, spacing between places and groups, the footer.
- **Cards:** proportions, the meta on the right of a title (Context percent bar, counts), row alignment, action styling.
- **Tiles:** header consistency across Plan, Files, Terminal, Artifacts and Pull requests; the Terminal tile shows the terminal's own header inside the tile header (double chrome) — make it one; smooth open/close motion; a clear drop line on the resize handle.
- **Toolbar icons:** spacing, pressed state, the attention dot, the Share button.
- **Plan tile:** the task checklist should read like a real checklist (done struck through, current one highlighted, failed obvious).
- **Empty states** in every pane: one quiet, helpful line.
- **Glass and contrast:** check both dark and light themes (Appearance → mode), transparency on and off, several accents (a dark blue, a light yellow).
- **Phone:** sheets, back arrows, the sidebar list, touch targets of 44px.
- **Agent chats** use the same thread components; make sure they look identical to Pin's.
- **Icon controls** inside bordered boxes (the cards' header menu, some tile actions, the phone sheets' back buttons): make them bare icons like the references.

## Rules you must keep

- **Tokens only.** No raw colours, font sizes, durations, z-indexes or radii in components. `npm run check:design` (in `apps/console`) enforces colour, type, motion, layer, shape, spacing and control gates; it must stay at 0 violations. Don't add allowlist entries to get around it.
- **Strict CSP:** `script-src 'self'; style-src 'self'`, no inline scripts, no third-party loads, no web fonts from other hosts, no analytics.
- **Accessibility:** every control has a name, focus is visible, menus and trees follow the ARIA patterns already used, contrast 4.5:1 for text.
- **Don't change behaviour** without saying so: the tests in `apps/console/test/pinview.test.tsx`, `tiles-menu.test.tsx`, `machine-files-ui.test.tsx`, `appearance.test.tsx` describe it. Update a test only when you intentionally change what it checks, and say why.
- **Don't remove features.** Every menu item, card, tile, shortcut and state described in `docs/PINVIEW.md` stays.
- **Update `DESIGN.md`** for any component or rule you add or change, and `docs/PINVIEW.md` if what a part does changes.

## How to run it

```sh
pnpm install
cd apps/console
npx vite --port 5199
```

Open `http://localhost:5199/pve/view`. Without a Proxmox host it runs in demo mode; to skip the first-run setup, run this once in the browser console, then reload:

```js
localStorage.setItem("epc.setup", JSON.stringify({ ownerName: "Sam", deviceName: "pve", pinMode: "agent", aiProvider: null, pinAccess: { system: true, orgs: true, connectors: true, docs: true }, completedAt: new Date().toISOString() }))
```

In demo mode Pin answers from a scripted brain (try "How is my server?"); there are no saved chats, no machine files and no GitHub, so empty states show. The tests mock live data (tool steps, files, unread chats) if you want to see those states; Playwright and Chromium are available for screenshots.

## Checks before you finish

```sh
cd apps/console
npx tsc --noEmit -p .
npm run check:design
npx vitest run
```

All three must pass. Take screenshots at 1600×900, 1280×800 and 390×800, in dark and light, with the cards and three tiles open, and include them with your summary.

## Deliverable

Commit on a new branch from `main`, in small commits with plain descriptions (what changed and why, no tool or model names). Summarize what you changed, what you left and why, and anything you think the owner should decide.
