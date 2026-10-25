# The composer

Specification of how people put things in: `/` commands, `@` mentions, `#` Pin board and the interactive status line. Kept in step with the design system artifact (components Composer, SlashMenu, MentionPicker, MentionChip, PinBoard, StatusLine).

## The field

Typing is the fastest way to do anything, so the composer carries the same weight as the visuals. A roomy rounded field (`radius-2xl`, `surface-2`, `line-strong`); `+` on the left; voice and send on the right (send is `primary`, round, 32 — 44 on touch); a status line under it. Mentions are chips inside the field text and travel with the message as context. Three triggers: `/` commands, `@` mentions, `#` Pin board. Each opens a popover anchored to the caret (our Menu popover look, glass), filters as you type, shows recent and most likely items first and works with the keyboard alone and on a phone: Up/Down move, Enter runs or inserts, Tab completes, Escape closes and leaves the text. Reference: `composer.png`. Only one popover is open at a time; typing a space after a complete `/command` closes it; backspace over a chip removes the whole chip; the field grows to about eight lines then scrolls.

## / commands

Typing `/` at the start of a line opens the command list, filtered as you type, each with a one-line description in `ink-3` on the right. Groups: **Commands** (workspace and Pin: `/new`, `/plan` ask Pin for a written plan, `/terminal`, `/files`, `/mode agent`, `/permission ask`, `/model`, `/clear`, `/automation` describe a standing rule, `/remember`) then one group per organization with its own useful actions (`/task`, `/hire`). Recent first, then most likely; the best match is highlighted. Enter runs; Tab completes the name and keeps the cursor for arguments (`/mode ` offers agent and assistant). Escape closes. A command that needs an argument shows its choices as a second list. No match: one quiet line, "No command like that. Press Enter to send it as text.".

## @ mentions

Typing `@` opens the picker (reference `composer-mention-picker.png`): an icon, the name and a quiet detail line, the first match highlighted. Kinds, in this order when nothing is typed (recents first): **person** (a Proxmox user on this device), **agent** (any organization; the message reaches it), **organization**, **project**, **machine**, **file** (a machine's file through the Explorer, or an artifact). Typing filters across kinds; a kind word (`@machine`) narrows to one; Backspace on `@` closes. Enter or Tab inserts the mention as a chip and the picker closes; the message carries each mention as structured context (kind, id, display name) so Pin or the agent knows exactly what is meant. A file mention opens a small path browser when there is more than one match.

## Mention chips

A mention in the composer and in the sent message: 24px tall, `radius-md`, an accent wash with a hairline, a kind icon and the name. Arrow keys move over a chip as one unit; Backspace removes it whole; a click in a sent message opens what it points to (a file in the Files tile, a machine's card, an agent's chat). The chip's accessible name says its kind. Kinds: person, agent, organization, project, machine, file.

## # Pin board

A `#` at the very start of the field turns the line into a note for Pin: the hint popover reads "Pin board · Save to Pin's memory". Enter saves it at once, without a reply, through `pinLibrary.save("memory", …)` (a host route appends one line if the edit has to be atomic), clears the field and shows a small **Remembered** chip (`good`) under it for about 3 seconds, with Undo while it shows. A `#` elsewhere in a line is just text. Failure: the text stays in the field and an inline notice says why ("Pin's memory isn't reachable. Try again.").

## The status line

The line under the composer (reference `composer.png`): mode and permission on the left, the model on the right, all `xs` `ink-3`. Each is a button: click **Agent mode / Assistant mode** to switch (a Menu), **the permission** (Ask, Accept edits, Auto, Plan; Bypass stays in Pin's settings with its typed word) when in Agent mode on a device, and the model to open Pin's settings (or a model list). The open one is `surface-3`. 28px high (44 on touch). On an agent chat the line shows the agent's status and organization instead.

