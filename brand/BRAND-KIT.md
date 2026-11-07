# Papercliped brand kit (shared rules)

One kit across ePaperclip (device console), Papercliped Auth, Connect and the website. This file records **which source is authoritative for what**; it does not redefine values. Owner decision 2026-11-07: keep ePaperclip's warm/gold direction for this reconciliation; invent no new mark; Pin's orb belongs to Pin only.

## Authority by topic
| Topic | Authoritative source | Rule |
|---|---|---|
| Design principles, product vs brand register | `/project/design/CORE.md` | project DESIGN doc > CORE > `frontend-design` plugin |
| Console colors, type, radius, motion, components, status vocabulary | `apps/console/DESIGN.md` and `src/index.css` token tiers (gate: `pnpm check:design`) | tokens only; no hex, arbitrary sizes or native controls |
| Console palette | `--bg #171612`, `--ink #f4ecdc`, `--accent #e8b25c` (`brand/tokens.json`, Warm preset default; Daylight light) | warm/gold is the ePaperclip direction |
| Pin mark (the orb) | `brand/README.md`, `brand/tokens.json`, `node brand/build.mjs --check` | Pin only. Not a logo for ePaperclip, Proxmox, Papercliped or Connect |
| Papercliped marks (mascot, wordmark, avatars, icons) | `/project/papercliped/web/public/brand/` (icon pack, `papercliped-icons.zip`, `docs/LAUNCH-KIT.md`) | the only official Papercliped assets; reuse as-is, do not redraw or recolor; not copied into this repo |
| Product and feature names | this file | "ePaperclip" (lower-case e), "Pin", "Papercliped" (the account and ecosystem), "Papercliped Connect", user-facing "Access" (not "Advertising") |
| Central auth look (`auth.papercliped.co`) | `papercliped-connect/docs/AUTH-SITE.md`, `apps/auth/auth-assets.mjs` | brand register; currently violet/cool-dark, see conflict 1 |
| Public site structure | `papercliped/docs/SITEMAP.md` | |

## Conflicts and how they are resolved
1. **Palette.** Console is warm dark with gold accent; the Connect auth site is cool dark (`#0b0b10`) with violet accent (`#9f94ff`) and a custom diamond mark. Resolution: ePaperclip surfaces (Access, onboarding, Connect handoff screens inside the console) use console tokens. Aligning the auth site's accent/background and mark to the official Papercliped assets is a **follow-up in papercliped-connect** (not done here; it is another agent's repo). Recorded as acceptance item in the ledger.
2. **Marks.** The auth site's diamond mark is not an official asset in the icon pack. Use the official wordmark/mascot there; the Pin orb stays out. Follow-up for the Connect agent.
3. **papercliped has no DESIGN doc** (CORE.md). This file is the interim brand index; a real DESIGN.md for papercliped/Connect is still needed (CORE.md recommended order, step 1).
4. **Access vs Advertising.** Resolved in code: one Access destination (People and permissions, Remote access). Legacy `?settings=advertising` redirects.
5. **Casing.** "ePaperclip" per `brand/README.md`; "Paperclip" alone refers to the upstream project and is only used factually.

## Consistency check (acceptance)
Console vs auth site vs website at 390px and desktop, light and dark: same product names, official marks only, AA contrast, status shown with icon or shape, sentence case, verbs on buttons. Status: console side verified by `check:design` and unit tests only; no visual pass yet.
