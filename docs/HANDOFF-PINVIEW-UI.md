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
