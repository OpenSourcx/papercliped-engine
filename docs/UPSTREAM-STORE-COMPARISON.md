# Upstream Paperclip store vs the ePaperclip Store

Studied: `paperclipai/paperclip` at commit `cbf811c` (shallow clone, MIT, Copyright (c) 2025 Paperclip AI) and the pinned engine 2026.1023.0.
Evidence label for everything below: read from source, not run against upstream's hosted service.

## How upstream does it

| Area | Upstream | Where |
|---|---|---|
| Brand marks | One manifest (`schemaVersion`, `providers[]` with `slug`, `provider`, `catalogVisible`, `localAsset`, optional `darkAsset`), assets vendored in the UI bundle. A strict path check and alias normalisation (`app-brand-assets.ts`) keep a manifest entry from pointing outside `/brands/`. The logo component tries the local file first (light or dark variant), and shows a letter tile only after the image fails at runtime. | `ui/public/brands/apps/manifest.json`, `ui/src/lib/app-brand-assets.ts`, `ui/src/pages/apps/AppLogo.tsx` |
| Mark provenance | Marks come from Lobe Icons (MIT) or the vendor's own page; each non-obvious one has a README with URL and retrieval date; licences sit beside the assets. | `doc/connections/CONNECTOR-ICONS.md`, `ui/public/brands/*/LICENSE`, `LOBE-LICENSE` |
| Adapters | Display metadata (label, icon, category, verified/built-in) lives in a UI registry, not in the server. External adapters are plugins with a manifest. | `ui/src/adapters/adapter-display-registry.ts`, `AdapterManager`, `adapter-plugin.md` |
| Plugin catalog | An image-owned catalog verified by digest at install time; plugins are npm packages or local paths. | `server/src/__tests__/distribution-plugin-catalog.test.ts` and the plugin routes |
| Plugin routes | list/examples, install, upgrade, enable, disable, delete, plus per-plugin config and health. | `server/src/routes/plugins.ts`, `ui/src/pages/PluginManager.tsx` |

## How ours does it

- **Catalog and trust.** `marketplace/catalog.json` is an Ed25519-signed index (`packages/marketplace`). The host verifies the signature against pinned keys (`EPC_MARKETPLACE_KEY`), checks each package's digest, shows a consent screen for the capabilities it asks for, and refuses a capability increase on upgrade. No key or no catalog fails closed (409 `no_catalog`).
- **Host routes.** `/api/connect/plugins` (install, upgrade, reinstall, enable, disable, revoke) and `/api/connect/adapters`.
- **Console.** `apps/console/src/pages/store/` (Store, catalog, useStore) with built-in entries in `data/storePlugins.ts` merged with signed marketplace entries (`fromMarket`).
- **Marks.** Before this change: simple-icons paths for some ids, a Slack image for one id, and a coloured letter tile for the rest (OpenAI, Linear's neighbours, every OS, VirtIO). Now: one resolver (`data/brandMarks.ts`) and one component (`ui/BrandMark.tsx`).

## Gaps and decisions

| Upstream idea | Decision | Why |
|---|---|---|
| Manifest of marks with provenance | Adopted in spirit: `data/brandIcons.ts` is generated and carries `source` and `license` per mark; `brand-marks/README.md` records vendored files. A test fails on a missing source or licence. | Same goal, but ours is code-generated so a mark can't be listed without its source. |
| Local-first, no hotlinking | Adopted (already ours). Test rejects external references in shipped SVGs. | |
| Letter tile on image failure | Not adopted. We resolve at build time and show a labelled generic glyph for unknown or custom entries. | The owner asked for no letter tiles; build-time resolution means no runtime failure path to cover. |
| Light and dark variants (`darkAsset`) | Not needed: marks are single-colour in `currentColor`, which follows the theme; Slack's colour artwork reads on both surfaces. | Smaller than a second asset per mark. |
| Lobe Icons / Paperclip SVGs | Reused for OpenAI, xAI/Grok, Pi and Hermes Agent, unmodified, with both MIT notices kept in `apps/console/brand-marks/` and `docs/THIRD-PARTY.md`. Slack's file was already reused. | simple-icons no longer carries these; upstream's files are MIT. |
| Model-provider / connector / adapter / skill grouping | Adopted: the Plugins section is split into Model providers, App connectors, Agent adapters, Skills (`PLUGIN_GROUPS`). Search, "See all" and installed/update chips already existed. | |
| Digest-verified image-owned catalog | Not adopted. Ours is a signed remote-or-file catalog with consent and capability checks, which is stronger for third-party plugins. | Keep the fail-closed model. |
| Display metadata (icon, category) carried in the catalog | Not adopted yet. A signed entry gets a mark only if its id matches a shipped mark; otherwise a generic glyph labelled "custom". | Letting a signed entry name an icon file would add a path-handling surface; adding a field to the signed schema is a catalog format change for the trust-key owner to decide. Needs: optional `mark` id (from our shipped set only), never a URL or file. |
| Per-plugin config and health pages | Open. Ours shows install state and consent; no per-plugin health. | Not part of this change. |
| Verified badge for built-in adapters | Open. Ours shows "Built in". | |

## Marks with no openly licensed source (generic glyph, labelled)

Windows 11 and Windows Server (Microsoft's terms were not obtained), OpenClaw Gateway (no open mark found), and our own Paperclip Runner, HTTP, Process and ePaperclip skills (brand authority is the Papercliped kit: no new marks). The VirtIO drivers card shows the Fedora mark, because the drivers are the Fedora Project's. Linear uses simple-icons' Linear mark, which is the same artwork upstream ships (a circle with diagonal bands); it is the real logo, not a placeholder.

## Safety

No trust check changed. Marks are static files bundled with the console; no catalog field can load one from elsewhere.
