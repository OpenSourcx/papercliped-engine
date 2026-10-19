# Pin's brand kit

Pin is the copilot inside ePaperclip, and its mark is a small turning ball of color: **the orb**. This folder is the one place the mark is defined. Everything here is generated from [`tokens.json`](tokens.json) by `node brand/build.mjs`; the console's CSS and these files are held in step by a test, so they can't quietly drift apart.

## Files

| File | Use |
| --- | --- |
| [`pin-orb.svg`](pin-orb.svg) | The mark on its own, transparent background. Use this by default; it works on dark and light. |
| [`app-icon.svg`](app-icon.svg) | The mark in a rounded square on the console's dark surface. App icon, home-screen icon, social avatar. |
| [`pin-orb-black.svg`](pin-orb-black.svg), [`pin-orb-white.svg`](pin-orb-white.svg) | One-colour versions for print, stamps, embossing, and anywhere a single ink is all there is. |
| [`png/`](png) | `pin-orb-{16…1024}.png` (transparent) and `app-icon-{180,192,512}.png`. |
| `apps/console/public/` | What the console ships: `favicon.svg` (a simplified mark for tiny sizes), `favicon.ico` (16/32/48), `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `site.webmanifest`. |

Rebuild with `node brand/build.mjs` (SVGs always; PNGs and `favicon.ico` when Chromium is installed, or set `CHROMIUM=/path`). `node brand/build.mjs --check` fails if the committed SVGs don't match the tokens.

## Color

| Role | Value | Where it comes from |
| --- | --- | --- |
| Orb stop 1, warm gold | `#f2c16b` | `--pin-1` |
| Orb stop 2, coral | `#e9776a` | `--pin-2` |
| Orb stop 3, violet | `#8e7cf0` | `--pin-3` |
| Highlight | white at 70% | `--pin-highlight` |
| Dark surface | `#171612` | `--bg` |
| Ink | `#f4ecdc` | `--ink` |
| Accent (interface highlights) | `#e8b25c` | `--accent` |

The three stops run around the circle as one gradient: gold at the top, coral toward the right, violet toward the lower left, back to gold. Don't reorder them, recolor them, or add a fourth.

## Construction

- A circle. A soft darker core sits inside it (a circle at 56% of the width, the surface color at 25%), and a small round highlight sits up and to the left (18% of the width, centered 35% across and 29% down).
- At 24 px and below, drop the core and enlarge the highlight slightly; the core turns to mud at that size. `favicon.svg` is that version.
- The app icon puts the orb at about 70% of the square, so it survives round and "squircle" masks without cropping.

## Size and space

- **Clear space:** keep at least a quarter of the orb's diameter free on every side. Nothing else inside that margin.
- **Smallest size:** 16 px for the favicon version, 24 px for the full orb.
- Beside text, center the orb on the text's x-height line and set it at 1.25–1.5 times the text's cap height.

## Motion

In the product the orb turns slowly (one revolution in 8 seconds) and speeds up (1.4 seconds) and shrinks to 92% while Pin is thinking. Both stop when the person has asked for reduced motion. Stills (these files) are the resting state; never animate the SVGs with anything flashier than that turn.

## Names and wording

- The product is **ePaperclip**: lower-case *e*, capital *P*, one word. The copilot is **Pin**.
- Pin's orb stands for Pin only. It isn't a logo for the whole product, for Proxmox, or for Paperclip.
- ePaperclip is built to work with Proxmox VE and Paperclip, and is independent of both. Don't use either project's name, logo or artwork as part of ours, and don't imply an endorsement. Their names appear only where they are the factual subject ("works with Proxmox VE") and in licence notices.

## Don't

- Don't stretch, skew, rotate the highlight, or put a shadow or outline on the orb.
- Don't place the full-color orb on a busy photo; use the app icon or a one-color version.
- Don't recolor it to match another brand, and don't swap the gradient for a flat color (use the one-color files if you need flat).
- Don't redraw it by hand. If it needs to change, change `tokens.json` and rebuild.

## Licence

The mark and these files are © OpenSourcx and may be used to refer to Pin and ePaperclip (links, articles, integrations, screenshots). The software is licensed separately; see the repository's `LICENSE`.
