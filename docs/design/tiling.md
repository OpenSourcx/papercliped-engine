# Tiling

The tile column becomes a **tiling window manager** in the manner of Hyprland. Today it is a single vertical stack with fixed heights (`workspace/Tiles.tsx`); that is the starting point. This page is the specification, so it can be built and tested.

## Layout model

A layout is a tree kept per browser (`localStorage`, one tree per workspace):

- **Leaf**: one tile (Plan, Files, Terminal, Artifacts, Pull requests, and later Chat) or a **tab group** of tiles.
- **Split**: a direction (`h` side by side, `v` stacked) and two or more children with ratios that sum to 1.

Rules:

1. **Panes size themselves.** Opening a tile splits the *focused* leaf along its longer side (dwindle), 50/50, and focuses the new tile. Closing a tile gives its space to its sibling. Nothing is ever left empty.
2. **Minimum sizes.** A pane is at least 240 wide and 160 high (a terminal: 320 x 160). If a split would break a minimum, the new tile opens as a tab in the focused leaf instead.
3. **Split either way.** Any pane can be split horizontally or vertically from its header menu ("Split right", "Split down") and by dragging.
4. **Resize from any shared edge.** Every edge between two panes is a `ResizeHandle`. Dragging moves only the two panes it touches; Shift-drag moves the whole line. Ratios snap to 25, 33, 50, 66 and 75% within 8px; double-click resets to 50/50. Arrow keys on a focused handle resize by 12px (48 with Shift).
5. **Gaps.** Panes touch; the line between them is the 1px `line` hairline. No gaps, no shadows between panes.
6. **Expand** (the header icon) fills the whole layout with one pane and the others wait; restore returns the tree untouched.
7. **Persistence.** The tree, ratios, which tab is active and which pane is focused are kept per browser. A tree that no longer fits the window is re-flowed, not discarded.

## Drag to rearrange

Drag a pane by its header (a 6px dead zone starts it). The target pane shows five zones: **left, right, top, bottom** (each the outer 30% of that side) and **centre**. Hovering a zone shows the **drop preview**: an `accent-soft` fill with a 2px dashed accent border over the exact area the dragged pane would take; the source pane dims to 60%. Dropping on an edge splits the target on that side; dropping on the centre swaps the two panes (with Alt held, adds the dragged tile as a tab). Escape cancels. Dropping outside any pane does nothing. A dragged tile follows the pointer as a small ghost of its header.

## Keyboard

The modifier is **Alt** (Option on a Mac). Proposed bindings, to confirm with the owner:

| Keys | Does |
| --- | --- |
| Alt + arrows | Move focus to the neighbouring pane |
| Alt + Shift + arrows | Move the focused pane (swap with, or enter, its neighbour) |
| Alt + Ctrl + arrows | Resize the focused pane by one step |
| Alt + M | Maximise or restore the focused pane |
| Alt + \ and Alt + - | Split right, split down (asks which tile to open) |
| Ctrl/Cmd+P → "Close pane" | Close the focused pane |

Focus is shown by a 2px accent line under the focused pane's header and a ring on its title. Inside the terminal only Go to is taken; to leave it press Escape twice, then use the keys above.

## Tablet and phone

- **Tablet (md to lg, 768 to 1023):** the conversation keeps the width; tiles open as a sheet over its right side, at most two panes side by side, no drag.
- **Phone (390):** no tiling. Cards and tiles are full sheets with a back arrow; several open tiles show a tile switcher (Segmented) at the top of the sheet, one tile at a time. The toolbar's More menu opens Plan, Terminal and Files.

## Several organizations and projects at once

PinView is where someone works on several organizations and projects with Pin and the agents together.

- **Switching never loses your place.** Tiles belong to the workspace, not to a conversation: changing the open chat keeps the tree, the open tabs, scroll positions and unsaved edits.
- **Tiles can hold things from different organizations.** Each tile's header shows a small context chip (organization · project, or machine) when its content is not the open conversation's.
- **Chat is a tile.** A conversation can open in a pane beside another, each with its organization chip; the composer belongs to the focused chat pane, and its `@` picker defaults to that chat's organization.
- **The sidebar shows the whole picture.** Every organization's group shows what is working (spinner) and what waits for you (clock, unread dot) regardless of which pane is focused; group labels carry the unread count.
- **Saved arrangements.** A layout can be saved under a name per browser ("Acme operations") and recalled from Go to.
