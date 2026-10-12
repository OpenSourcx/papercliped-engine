# ePaperclip design rules

**Status:** v1. The source of truth for how the console looks, moves and speaks. It governs structure first and brand second: brand values live only in the token layer and can change without touching a component.

Read this before changing anything under `apps/console/src`. If a change conflicts with this document, change the document first (with review) or change the code. The structure follows [Paperclip's DESIGN.md](https://github.com/paperclipai/paperclip/blob/master/DESIGN.md) (MIT): principles, a single token layer in tiers, a component inventory, a status vocabulary, words as part of the system, and enforcement that a machine checks. The values and the voice are our own.

## Product stance

The console is the front of a Proxmox host and the organizations of agents that run on it. The person using it is an operator: they glance to see what is happening, decide whether it needs them, and act. Every screen answers, in order: **what is happening, does it need me, what do I do about it.** Calm beats clever. Density comes from information, never from chrome.

Pin is the console's copilot. It lives in one place (the island at the top of every page), proposes rather than surprises, and never does more than the person could do from the page.

## Principles

1. **One component per job.** One Button, one Card, one Modal, one Toggle, one Status. Variants are props, not new components. Before writing a new component, check the inventory below and prove nothing covers the job.
2. **Tokens are the only source of visual values.** Colour, type size, radius, shadow, z-order, duration and easing come from `src/index.css` (and, for colour, the theme presets in `src/theme/theme.tsx`). No hex, no `text-[13px]`, no `z-[60]`, no `200ms` in components. If a value is missing, add a token; that is a feature, not a workaround.
3. **Hierarchy through structure, not decoration.** Position, size and weight first; borders, fills and dividers only when they earn their place. A screen should survive removing one visual layer.
4. **Status is systematic.** One vocabulary (below), used identically in rows, chips, dots, charts and Pin's cards. State never rides on colour alone: every status pairs a shape or icon with a word.
5. **Machine values look machine-made.** VMIDs, IP addresses, file names, snapshot names, model ids, rule expressions and log output use the mono font (`font-mono`) and `tabular-nums` where numbers line up.
6. **Words are part of the system.** One name per concept, buttons that name their action, errors that say what to do. See "Words".
7. **Motion with purpose.** Motion explains where something came from, confirms an action or shows that work is happening. It is short, interruptible, springs for shape changes, and disappears under reduced motion. See "Motion".
8. **Changeable by instruction.** A correct design change is "edit tokens, run checks", not "visit forty files". The gates in "Enforcement" keep it that way.

## Token tiers

All tokens live in one file, `src/index.css`. Runtime-tunable values (anything Appearance or a theme preset changes) live in `:root`, never in `@theme inline`, because inline values are baked in at build time. `@theme inline` only maps tokens to Tailwind utilities.

### 1. Foundation (scales with no meaning yet)

| Scale | Tokens | Utilities |
| --- | --- | --- |
| Type ladder | 11 `micro`, 12 `xs`, 13 `compact`, 14 `sm`, 15 `body`, 17 `lead`, 18 `lg`, 20 `xl`, 22 `title`, 26 `heading`, 30 `display`, 34 `hero`, 40 `hero-md`, 48 `hero-lg`; fluid `meter`, `meter-caption`, `unit` | `text-compact`, `text-heading` ... each step carries its own line height |
| Tracking | `--tracking-label` (0.08em, uppercase labels), `--tracking-code` (0.3em, one-time codes) | `tracking-label` |
| Spacing | Tailwind's 4px scale (`--spacing`) | `p-3`, `gap-4`, `h-10` |
| Radius | one anchor `--radius` (Appearance tunes it); `xs sm md lg xl 2xl 3xl` derived as 0.4/0.6/0.8/1/1.4/1.8/2.6 x anchor; `rail`, `rail-active`, `squircle` | `rounded-lg` |
| Elevation | `--elevation-1..3` built from `--shadow-color` | `shadow-raised`, `shadow-overlay`, `shadow-modal` |
| Z layers | `--z-raised 10`, `sidebar 20`, `rail 30`, `island 40`, `drawer 50`, `modal 60`, `fullscreen 65`, `popover 70`, `tooltip 80` | `z-(--z-modal)` |
| Motion | durations, easings, springs (see "Motion") | `duration-(--duration-fast)`, `ease-spring` |

Radius assignments: chips and tags `sm`; buttons, inputs and menu rows `md`/`lg`; cards and popovers `xl`; modals and the island `2xl`; avatars and pills `full`. A nested element steps down one tier from its container.

Control heights: 32px (`sm`), 40px (`md`, the default for buttons, inputs and selects), 44px (`lg`). Touch targets are at least 40px; icon-only buttons are 32px only inside dense chrome that also has a larger target nearby.

### 2. Semantic (roles, set per theme)

| Role | Tokens |
| --- | --- |
| Surfaces | `--bg` (page), `--surface` (cards), `--surface-2` (fills, inputs), `--surface-3` (selected, hover on fill), `--code` (log and code blocks), `--screen` (machine screens) |
| Ink | `--ink` (text), `--ink-2` (secondary), `--ink-3` (captions; at least 4.5:1 on `--surface`) |
| Lines | `--line` (hairlines), `--line-strong` (hover, emphasis) |
| Action | `--primary` / `--primary-ink` (the one commit action per view), `--accent` / `--accent-soft` (selection, focus, links) |
| Focus | `--ring` (defaults to the accent) |
| Overlay | `--scrim` (behind modals and drawers), `--shadow-color`, `--rim` (glass highlight) |
| Status | `--good`, `--live`, `--warning`, `--serious`, `--critical`, `--on-status` |

Every preset in `theme/theme.tsx` carries the full semantic set, so switching presets never leaves a value behind. Light presets darken the status hues (they must clear 3:1 against near-white) and soften shadows.

### 3. Domain (things only ePaperclip has)

| Domain | Tokens |
| --- | --- |
| Pin | `--pin-1..3` (orb gradient), `--pin-highlight`, `--island-rest-width`, `--island-height`, `--spring-island-*` |
| Identity | `--identity-bg`, `--identity-ink`, `--identity-grad-*`: lightness and chroma for name-hashed hues (organizations, people, tags, Store apps). Components set only `--hue`. |
| Glass | `--glass-blur`, `--glass-alpha` (Appearance tunes both) |
| Greeting | `--glow-1..3` |
| Charts | `--series-1`, `--series-2` (two-series charts; one series uses the accent) |

## Light and dark

Dark (Paperclip Warm) is the default. Graphite and Midnight are dark; Daylight is light. The theme runtime writes a preset's tokens onto `<html>` and sets `color-scheme`. Components never branch on the theme: if something needs a different value in light mode, it is a token with a different value in the light presets. Check every change in at least Warm and Daylight.

## Status vocabulary

| Kind | Means | Shape | Token |
| --- | --- | --- | --- |
| `good` | running, connected, done, saved | check circle, solid dot | `--good` |
| `working` | in progress, an agent working, a task running | spinner, solid dot | `--live` (liveness is always blue) |
| `idle` | nothing to do | dashed ring | `--ink-3` |
| `off` | stopped, switched off | dashed ring, hollow dot | `--ink-3` |
| `paused` | paused, waiting on someone | pause circle | `--warning` |
| `warning` | needs setup, needs attention soon | triangle | `--warning` |
| `critical` | failed, error, unreachable | cross circle | `--critical` |

Use `Status` (icon and label) in rows and headers, `StatusDot` in dense chrome (sidebars, rails), and `Chip tone=` for compact tags. Pin's proposal outcomes use the same words: Done (good), Cancelled (neutral), and the failure in plain words (critical).

## Motion

Values live in `:root`; components reference them, never literals.

| Token | Value | Use |
| --- | --- | --- |
| `--duration-instant` | 80ms | delays that let a shape lead its content |
| `--duration-fast` | 150ms | hover, press, exits, toggles |
| `--duration-base` | 220ms | enters, cross-fades, colour changes |
| `--duration-slow` | 320ms | page sections, settings modal, drawers |
| `--duration-deliberate` | 480ms | meters and bars filling |
| `--motion-ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` | most enters and responses |
| `--motion-ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | exits only |
| `--motion-ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | breathing loops (thinking dots, caret) |
| `--motion-ease-sheet` | `cubic-bezier(0.32, 0.72, 0, 1)` | modals and drawers (the iOS sheet curve) |
| `--motion-ease-spring` | `linear(...)` sampled from stiffness 400 / damping 30 | small CSS springs: toggles, chevrons, radio dots |
| `--spring-island-*` | stiffness 400, damping 34, mass 1 | Pin's island shape (JavaScript spring) |
| `--spring-gentle-*` | stiffness 260, damping 30, mass 1 | larger, slower shape changes |

Rules:

- **Shape changes spring; everything else eases.** Springs keep velocity when retargeted, so a shape that changes its mind never jumps. `ui/spring.ts` is the spring engine; it writes to `element.style` (CSSOM), which the strict CSP allows.
- **Interruptible by default.** Prefer CSS transitions over keyframes for anything a person can trigger repeatedly; transitions retarget mid-flight, keyframes restart.
- **Under 300ms for things people trigger often.** Hover and press responses use `--duration-fast`. Keyboard-driven switching (Ctrl/Cmd+K) is not slowed by decoration.
- **Animate transform and opacity.** Width and height animate only on the island, where the shape is the point, with content laid out at its final size so text never reflows mid-morph.
- **Content follows the shape.** When the island changes, the old content blurs out in `--duration-fast` while the new content fades and settles in after `--duration-instant`.
- **Exits are quicker than enters** and ease in.
- **Reduced motion is honoured at the token layer.** `prefers-reduced-motion: reduce` sets every duration to 0, stops loops (orb, shimmer, caret, dots, skeleton) and makes springs jump; the island keeps a plain cross-fade. Spinners keep spinning because they carry meaning.
- **No motion for its own sake.** No parallax, no bouncing attention-seekers, no looping decoration outside Pin's orb.

## Pin's island

One shape at the top centre of every page, above the page and below modals.

| View | When | Shape |
| --- | --- | --- |
| rest | default | 184 x 40 pill: orb, "Pin · mode", unread count |
| status | Pin is thinking or writing, or a task this console started is running | 300 x 40 pill: thinking orb, "Thinking", "Writing" or the task, breathing dots |
| peek | a new notice | up to 380 wide, content height; settles back after about 4 seconds |
| actions | pointer rests on the island (hover devices only) | up to 720 wide, content height: page context and up to three quick actions, More for the rest |
| open | click, tap, or Ctrl/Cmd+K | up to 480 x 640 panel: header, Chat or Notifications, composer |

Behaviour: Esc or a click outside closes it and focus returns to the pill; opening focuses the composer. The island steps back (fades, becomes inert) while any other modal is open. Pin's own confirmation dialog sits above it. On phones the open panel is the full width less 16px.

Pin's conversation: your words sit in a bubble on the right; Pin's sit on the page on the left. While Pin waits, three dots take turns; while it writes, a soft caret breathes at the end of its words. Proposals arrive as cards with one primary action (the verb: "Stop", "Take snapshot", "Create task") and Cancel. Errors stay inline, say what happened, and link the fix ("Add a model provider in Connectors").

## Component inventory

All in `src/ui/` unless noted. Each uses tokens only.

| Component | Job | Variants and states |
| --- | --- | --- |
| `Button` | every text action | `primary` (one per view), `secondary`, `ghost`, `danger`; `sm`/`md`/`lg`; hover, active (scale 98%), disabled, `loading` (spinner, `aria-busy`) |
| `IconButton` | an action shown only as an icon | label required (accessible name and tooltip); `ghost`/`secondary`; `sm` 32 / `md` 40 |
| `Card` | a bordered surface | `interactive` (hover border and fill); always `relative` so clipped content stays contained |
| `PageFrame` / `PageHeader` | a page's frame and title block | roomy as a main view, flush in a modal; eyebrow, subtitle, actions |
| `SectionTitle` | a label over a group | optional action on the right |
| `Field` | label, control, hint or error | error replaces hint and is announced |
| `Input` / `Select` / `Textarea` | text entry | one recipe (`controlClass`): 40px, `surface-2` fill, focus ring; `Input size="lg"` for sign-in and onboarding |
| `Toggle` | on/off | `role="switch"`, spring knob, disabled |
| `Segmented` | two to four exclusive options | `sm`/`md`; scrolls sideways on narrow screens |
| `Tabs` | a page's sections | underline, scrolls sideways on phones, optional counts |
| `Avatar` | a person, organization or app | identity hue from `--hue`, squircle |
| `Tag` (`ui/Tag.tsx`) | a Proxmox tag | identity hue from the name |
| `Status` / `StatusDot` | state with a word / state in dense chrome | the status vocabulary |
| `Chip` | a compact label | `neutral`, `accent`, `warning`, `good`, `critical`, `live` |
| `EmptyState` | nothing here yet | says what this is for and what to do first |
| `Notice` | a calm inline message | `info`, `warning`, `critical`, `good`; title, body, action |
| `Skeleton` / `Spinner` | loading | skeletons keep the layout; spinners have a label |
| `Kbd` | a key | mono |
| `Modal` (`ui/Modal.tsx`) | anything that isn't a main view | `sm`/`md`/`lg`; bottom-aligned on phones; focus moves in, Tab wraps, Esc closes the top one, focus returns to the opener |
| `SettingsModal` | the full-screen settings | categories left, section right; phone shows one at a time |
| `ArcMeter` / `BarMeter` (`ui/meters.tsx`) | one ratio against a limit | value in ink, never in the series colour; exact value in caption and tooltip |
| `TimeSeriesChart` / `UsageGraphs` | history | series tokens; tooltip on hover |
| `PinOrb` (`pin/PinOrb.tsx`) | Pin's mark | `thinking` |
| `PinIsland` (`pin/PinIsland.tsx`) | Pin's home | the five views above |
| `PinThread` / `PinInput` (`pin/PinThread.tsx`) | Pin's conversation and composer | shared by the island and Pin's page; Enter sends, Shift+Enter adds a line, Stop while writing |
| `CardShell` / `PinCardView` / `ToolCard` (`pin/PinCards.tsx`) | cards in Pin's conversation | proposed, done, cancelled, failed |
| `QuickActionBar` (`pin/QuickActionBar.tsx`) | Pin's quick actions for the page | row of three plus More; `compact`; `scroll` for one line |
| `PinSettingsPanel` (`pin/PinSettings.tsx`) | provider, model, mode, connectors | loading skeleton, load error with retry, no provider, save, saved, save error |

Deliberate exceptions: native `<select>` stays native (keyboard and screen-reader behaviour for free); the terminal and machine screens are third-party canvases styled through tokens read at runtime.

## Words

Our vocabulary, one name per concept:

| Say | Not |
| --- | --- |
| organization | company, org (in copy), workspace |
| task | issue, ticket, job |
| machine (a container or a virtual machine) | guest, VM (except where the kind matters: "Virtual machine") |
| device (this Proxmox host) | node, server (in copy) |
| Pin | the AI, the assistant, the bot |
| Assistant mode, Agent mode | autonomous, auto |
| connector | integration, plugin (for credentials) |
| model provider | AI vendor |
| automation | rule (in copy), trigger |
| resource group | pool (in copy) |

- Buttons name the action: "Create machine", "Save settings", "Take snapshot". Never "Submit" or "OK".
- Errors say what happened and what to do: "Pin needs a model provider. Add one in Connectors."
- Empty states say what to do first.
- Sentences, not shouting: sentence case everywhere, no exclamation marks, no "Oops".
- Numbers carry units and plurals agree ("1 machine running", "3 machines running").
- No model names in copy, code or docs; use the provider's name and the model id the provider returns.

## Accessibility

- **Focus:** one 2px ring in `--ring` with a 2px offset on every focusable element (`:focus-visible`). Fields show the ring through `focus:ring-2`. Never remove focus styles without replacing them.
- **Contrast:** body text at least 4.5:1, `--ink-3` captions at least 4.5:1 on `--surface`, status icons and focus rings at least 3:1, in every preset.
- **Keyboard:** everything reachable with Tab; Ctrl/Cmd+K opens Pin; Esc closes the top layer; Enter sends in Pin's composer, Shift+Enter adds a line; modals trap focus and return it.
- **Screen readers:** icon-only buttons have labels; status is a word, not a colour; Pin's conversation is a polite live region; dialogs are labelled.
- **Reduced motion:** see "Motion".
- **Touch:** targets at least 40px; editable text is 16px on coarse pointers so phones don't zoom; hover-only affordances (the island's quick actions) are also reachable by tapping into the panel.

## Changing the UI

1. **Change how something looks everywhere:** edit the token in `src/index.css` (or the presets), then check Warm and Daylight at 1440, 1024 and 390.
2. **Build or style a component:** tokens only; check the inventory first; add it to the inventory here.
3. **Run the checks:** `pnpm --filter @papercliped-engine/console check:design typecheck test build`.
4. **Mechanical rewrites** go through a committed script (`scripts/codemod-tokens.mjs`), never hand edits across many files.

## Enforcement

`scripts/check-design.mjs` (`pnpm check:design`, and the `design gates` test in the console's test suite) scans `src/**/*.{ts,tsx}` with comments stripped and fails on:

- **colour:** hex colours, `rgb()`/`hsl()`/`oklch()` literals and Tailwind palette classes (`bg-red-500`, `text-white`)
- **type:** arbitrary font sizes (`text-[13px]`) and `fontSize` strings
- **motion:** `cubic-bezier()`, `"200ms"` strings, `duration-150`/`delay-75`, `animate-[...]`
- **layer:** `z-[60]` and numeric `zIndex`
- **shape:** `rounded-[..]`, `tracking-[..]`, `leading-[..]`
- **spacing:** arbitrary padding, margin, gap and inset values

Exceptions are listed by path in the "DESIGN ALLOWLIST" block at the end of `src/index.css`, each with its gates and a reason. Today: the theme presets (the runtime half of the token layer), Appearance's accent swatches (colours the user picks), third-party brand marks, and the files the engine-data work owns this run (`src/data/`, `src/pages/org/`, `OrgDashboard.tsx`, `NewOrg.tsx`, `Connectors.tsx`), which convert with `scripts/codemod-tokens.mjs` once that work merges.

Not gated yet (do by hand): arbitrary layout sizes (`min-w-[640px]`, grid templates), which are content decisions rather than visual values.

## Prior art

What we read and what we took:

- **Paperclip's design system** (`DESIGN.md`, `doc/design/CHANGING-THE-UI.md`, `DECISION-SHEET.md`, `COMPONENT-INVENTORY.md`, `PRIOR-ART.md`, `ui/src/index.css`; MIT): the document's structure, the three token tiers, runtime tokens in `:root` rather than `@theme inline`, one anchor radius with a derived ladder, the status vocabulary and "liveness is always blue", "words are part of the system", the allowlist-with-reasons gate, and motion tokens honoured at the token layer for reduced motion.
- **Emil Kowalski, "Great animations"** (emilkowal.ski/ui/great-animations): animate transform and opacity, keep most UI motion under 300ms, prefer interruptible transitions, honour reduced motion with a fade, review motion with fresh eyes. **"Building a toast component"** (Sonner): CSS transitions over keyframes because they retarget mid-flight; data-attribute driven enter states (our `data-phase` layers). **Vaul**: the `cubic-bezier(0.32, 0.72, 0, 1)` sheet curve, kept for modals and drawers.
- **Motion (motion.dev)**, layout animations and transitions docs: springs that keep velocity when interrupted, `bounce`/`visualDuration` versus stiffness/damping, and correcting radius during shape changes. We measured it for the island: 34 to 49 kB gzipped in this bundle for the layout features, so `ui/spring.ts` implements the one spring we need in about 1 kB, with the same physics.
- **Cult UI's Dynamic Island** (github.com/nolly-studio/cult-ui, MIT): size presets per state, spring stiffness 400 / damping 30, and content that blurs and scales out while the next fades in. Our island uses the same spring family (damping 34, slightly calmer) and the same blur cross-fade, with content laid out at its final size.
- **Rauno Freiberg, "Invisible details of interaction design"** (rauno.me/craft/interaction-design): interruptibility as physics, spatial consistency (things grow from where they live, which is why Pin's panel grows out of the pill), and skipping animation for high-frequency, keyboard-driven actions.
- **Apple Human Interface Guidelines, Motion and Live Activities** (developer.apple.com/design/human-interface-guidelines): purposeful, brief, interruptible motion; Reduce Motion replaces movement with cross-fades; the Dynamic Island's compact, minimal and expanded presentations, where expanded content extends the compact content and expansion is reserved for what needs it. These pages render client-side, so we worked from their published guidance rather than a fetched copy.
