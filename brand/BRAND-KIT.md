# Papercliped brand kit (shared rules)

One kit across ePaperclip (device console), Papercliped Auth, Connect and the website. This file records **which source is authoritative for what**; it does not redefine values.

**Owner decision (latest, 2026-11-07):** the established OpenSourcx/papercliped branding is the authority: the README's launch images (`web/public/brand/community/papercliped-launch-light.png`, `papercliped-launch-dark.png`) and `web/public/brand/` (mascot, wordmark, icon pack). This supersedes the earlier "keep warm/gold" instruction. Invent no new mark. Pin's orb belongs to Pin only.

## The reference (read from the remote `OpenSourcx/papercliped` main, not a local checkout)
The launch images use the site's "clip" palette (`web/scripts/community-cards.mjs`, `web/src/theme/palettes.ts`):

| Role | Dark | Light |
|---|---|---|
| bg | `#16150f` | `#fffddc` |
| surface | `#201f17` | `#fffff0` |
| ink | `#f4f1d6` | `#0b0a07` |
| muted | `#bdb99f` | `#57564a` |
| line | `#35332a` | `#e7e3bb` |
| accent (also the pill and code chip) | `#e9e4b0` | `#47463c` |
| accent ink | `#16150f` | `#fffddc` |
| mascot cheeks | `#e98a7a` | `#e98a7a` |

Type: Inter (UI), Bricolage Grotesque (display), JetBrains Mono (machine text and the connector address). Mascot: a paperclip with a face; use `web/public/brand/mascot-*.svg`, `wordmark-*.png` and the icon pack as-is (light default, dark on dark; do not recolor, stretch or redraw).

## Authority by topic
| Topic | Authoritative source |
|---|---|
| Brand look, marks, palette | the reference above (OpenSourcx/papercliped README + `web/public/brand/`) |
| Design principles, product vs brand register | `/project/design/CORE.md` (project DESIGN doc > CORE > `frontend-design`) |
| Console structure: tokens, components, status vocabulary, gates | `apps/console/DESIGN.md`, `src/index.css`, `src/theme/theme.tsx` (`pnpm check:design`) |
| Pin's mark (the orb) | `brand/README.md`, `brand/tokens.json`. Pin only; not a logo for ePaperclip, Proxmox, Papercliped or Connect |
| Names | "ePaperclip" (lower-case e), "Pin", "Papercliped" (account and ecosystem), "Papercliped Connect", user-facing "Access" (not "Advertising"). "Paperclip" alone is the upstream project, used only factually |
| Auth look (`auth.papercliped.co`) | follows the reference; see follow-ups below |

## What the console does now
Default preset "Papercliped Clip" (dark) and "Papercliped Clip Light" use the table above (`src/theme/theme.tsx`). Console structure, spacing, radius and components are unchanged. Other presets (Warm, Graphite, Midnight, Daylight) remain selectable. Not done here: the console does not show the mascot or wordmark anywhere new, and `:root` first-paint values are still Warm (`brand/tokens.json` and the Pin app icon depend on them; a test keeps them in step). Contrast checked for ink-2/ink-3/accent on bg and surfaces (all above 4.5:1, accent above 9:1).

## Follow-ups for the Connect/Auth side (papercliped-connect, not changed here)
1. `apps/auth/auth-assets.mjs` palette: cool dark (`--bg #0b0b10`, `--surface #15151c`, `--accent #9f94ff`, `--blue #8ac0fa`, radial violet/blue backgrounds, primary button gradient `#a69bff -> #88aafa`). Replace with the clip palette above (dark and light via `prefers-color-scheme`).
2. The rotated-diamond `.mark` (two squares) is not an official asset. Replace with `mascot-*.svg` / wordmark from the icon pack.
3. Font stack is plain Inter; add Bricolage Grotesque display and JetBrains Mono for machine text per the site.
4. The Console and landing Workers (`console.`, `connect.`) should be checked for the same.
5. `AUTH-SITE.md` should name the reference as its brand source.

## Consistency check (acceptance)
Console vs auth site vs website at 390 px and desktop, light and dark: same names, official marks only, AA contrast, status with icon or shape, sentence case, verbs on buttons. Console side: `check:design` and unit tests only; no visual pass yet. Auth/Connect side: blocked on the follow-ups.
