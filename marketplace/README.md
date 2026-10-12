# The marketplace catalog

The Store's list of connectors, adapters and skills beyond what ships with ePaperclip. `catalog.json` is the source; `scripts/marketplace-publish.mjs` turns it into `dist/index.json` and `dist/index.json.sig`, signed with an Ed25519 key. Devices fetch both through their host service and show the catalog only if the signature matches a key pinned in `packages/marketplace/src/index.ts`.

It can live anywhere that serves two static files over https: a public GitHub repository (the default address is `raw.githubusercontent.com/OpenSourcx/papercliped-marketplace/main/index.json`), GitHub Pages or a release asset, or a public Supabase Storage bucket. Where it lives doesn't decide trust; the signature does.

## Entries

```json
{
  "id": "matrix", "kind": "connector", "connectorKind": "chat",
  "name": "Matrix", "vendor": "Matrix.org", "summary": "Talk to Pin and your agents from a Matrix room.",
  "version": "1.0.0", "minEngine": "0.1.0",
  "source": { "type": "npm", "name": "@scope/epc-matrix", "version": "1.0.0", "integrity": "sha512-…" },
  "permissions": ["net.matrix.org"],
  "icon": { "file": "icons/matrix.svg", "sha256": "…" }
}
```

- npm sources must be an exact version with the registry's `sha512-` integrity hash. Ranges are refused.
- `kind` is `connector`, `adapter` or `skill`. Connectors need a `connectorKind`.
- An entry whose `id` matches something that ships with ePaperclip is ignored; the catalog adds, it never replaces.
- Publishers can supply their own `icon` (an SVG in `icons/`, pinned by SHA-256).

## Publishing

1. `node scripts/marketplace-keygen.mjs` once. Keep the private key as the CI secret `MARKETPLACE_SIGNING_KEY`; pin the public key in `TRUSTED_KEYS`.
2. Change `catalog.json` in a reviewed pull request.
3. CI runs `node scripts/marketplace-publish.mjs` and publishes `dist/`. Republish at least every 60 days; an expired catalog is refused.

## Rotating the key

Add the new public key to `TRUSTED_KEYS` in a release, wait for devices to update, switch CI to the new private key, then drop the old key in a later release.

## What the device checks

Signature, expiry, a sequence number that never goes down (within a run of the service), strict field formats, and unique ids. Fetched and checked by the host service only; the browser never reads the catalog directly.
