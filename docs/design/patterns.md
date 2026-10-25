# Patterns

## Empty, loading and error, per surface

| Surface | Empty | Loading | Error |
| --- | --- | --- | --- |
| Console page | `EmptyState`: icon badge, what this is for, one action | `Skeleton` rows that keep the layout | `Notice critical` at the top: what happened, what to do, retry |
| Pin's conversation | Orb and one sentence: "Ask Pin about this device, or tell it what to set up." | Three breathing dots; after 10s "Still waiting for the model" | A card with the failure in plain words; links the fix ("Add a model provider in Connectors") |
| Sidebar group | One `xs` line: "No chats yet." / "No agents yet." | Rows as skeletons | The group shows a `warning` line with Retry |
| Cards | One quiet line ("Nothing running.", "No connectors yet" + Set up) | Skeleton line | `warning` line with the fix link |
| Plan tile | "When Pin writes a plan or works through steps, its tasks show here and tick off as they finish." | n/a | A failed task shows red; the step opens |
| Files tile | "Open a file from the tree, or ask Pin to read one." | "Loading…" with a spinner in the tree | `warning` text in the tree; a Notice in the editor |
| Terminal tile | A prompt | "Opening console…" | The chip reads Reconnect; restart icon |
| Pull requests | The connect form (admins) or a Notice (others) | Skeleton rows | A Notice with the GitHub message |
| Composer | Placeholder "Ask Pin" | Send becomes Stop while Pin writes | Inline under the field; the text stays |

An empty state is one quiet line in `ink-3` inside panes and cards; a full `EmptyState` only on a page. No illustrations in panes.

## Keyboard shortcuts

| Keys | Does |
| --- | --- |
| Ctrl/Cmd + P | Go to: conversations, open files, agents and every command |
| Ctrl/Cmd + K | Open Pin (the island) |
| Ctrl/Cmd + B | Hide or show the sidebar |
| Ctrl/Cmd + . | Hide or show the cards |
| Alt + N | New chat with Pin |
| Alt + W | Close the active file tab |
| Ctrl/Cmd + S | Save the open file (in the editor) |
| Enter / Shift+Enter | Send / new line in the composer |
| Ctrl/Cmd + Enter | Submit a multi-line prompt in a modal |
| `/` `@` `#` | Commands, mentions, Pin board (composer) |
| Up / Down, Enter, Tab, Esc | Move, run or insert, complete, close (every popover) |
| Esc | Closes the top layer; focus returns to its opener |
| Alt + arrows (proposed) | Tiling: focus, move and resize panes (see Tiling) |
| In the terminal | Only Go to is taken |

## Toasts, notices, badges

See the Feedback card: inline first; a toast only for what happened elsewhere or later; unread is an accent dot and a semibold row; counts cap at 99+.

## Responsive

Desktop shows every column from `lg` (1024). Below it, cards and tiles are sheets. Tablet: the conversation plus a right sheet. Phone (390): each part is its own screen: the sidebar first, the conversation over it (back arrow), cards and tiles as full sheets with a back arrow. Every touch target is 44px; editable text is 16px.
