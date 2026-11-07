# Community plugins: the signed catalog, trust key and install rules

Machine-wide plugins run code inside the engine. They are installed only from a **signed catalog**, only by a Proxmox administrator, and only on a device that has been given a catalog signing key. Until a key is pinned, installing is refused (fail closed). Nothing here claims that signed releases exist: there is no first-party signing key yet (`TRUSTED_KEYS` is empty) and no published catalog.

**A plugin's permissions are the publisher's declarations, shown to the administrator before install and recorded when accepted. They are not an enforced sandbox.** What a plugin can actually reach is decided by the engine's plugin runtime and its own capability approval (an upgrade that adds capabilities goes to `upgrade_pending` in the engine and needs the engine's approval too).

## Setting up trust (once per publisher)

1. Generate a key pair on a trusted machine: `node scripts/marketplace-keygen.mjs`. Keep the **private** key only as the CI secret `MARKETPLACE_SIGNING_KEY` (or in the publisher's vault). Never commit it, paste it in a chat, or put it in a repository file.
2. Pin the **public** key on devices that should trust the catalog, either
   * in a release: add it to `TRUSTED_KEYS` in `packages/marketplace/src/index.ts` (`trustedKey(pem)`), or
   * per device, without a release: set `EPC_MARKETPLACE_KEY` (the public PEM, `\n` for newlines) in `/etc/default/epaperclip` and restart `epaperclip`. Optionally `EPC_MARKETPLACE_URL` for the catalog address.
3. Rotation: add the new public key, wait for devices to update, switch CI to the new private key, then drop the old key in a later release.

## Publishing an entry

1. Pick an exact published version of the plugin package. Get its entry with its registry integrity hash filled in:
   `node scripts/marketplace-entry.mjs @scope/plugin 1.2.3 my-plugin "My plugin" "Vendor" "What it does." net.example.test secrets.read`
2. Review it and add it to `marketplace/catalog.json` in a reviewed pull request (`kind` is `plugin`).
3. CI signs it: `MARKETPLACE_SIGNING_KEY="$(cat private.pem)" node scripts/marketplace-publish.mjs`. The script verifies the result the way a device will before writing `marketplace/dist/index.json` and `index.json.sig`. Republish at least every 60 days; an expired catalog is refused, and a lower sequence number than one already seen is refused (rollback protection).

## What the device enforces (server side, `src/features/connect-plugins.ts`)

* No pinned key or no verified catalog: 409 `no_catalog` on install. A catalog with a bad signature offers nothing.
* The administrator must submit exactly the declared permission list (409 `consent_required` otherwise). An upgrade asks again only when it adds a permission.
* The npm registry must still serve the exact `sha512` integrity the catalog was signed for (409 `integrity_mismatch`).
* An upgrade must be a newer version than the one installed (409 `not_newer`). The engine itself accepts a downgrade through its upgrade route (verified), so this check is the host's.
* Revoke removes the plugin through the engine and forgets the grant. Plugins the engine has from elsewhere are shown as unverified and can only be switched off or revoked.
* Everything is audited (`plugin.install`, `plugin.upgrade`, `plugin.revoke`, `plugin.disable`).

## Engine behaviour verified against 2026.1023.0 (live)

`POST /api/plugins/install {packageName, version, isLocalPath:false}` (instance admin) installs and goes `ready` when no new capability approval is needed; `POST /api/plugins/{id}/upgrade {version}` upgrades (body `{version}` optional, default latest); `DELETE /api/plugins/{id}` uninstalls. These were run for real with a plugin package at two versions served by a local npm registry; see the test below.

## Capability increases (verified live; differs from the engine's own comments)
The engine's lifecycle code mentions an `upgrade_pending` state for upgrades that add capabilities, but in 2026.1023.0 the plugin **loader** throws first: `POST /api/plugins/{id}/upgrade` answers 400 "introduces new capabilities that require approval: ..." and there is no approval call. The plugin stays `ready` at its old version (the failed attempt does stop its runtime first; it reports healthy afterwards). The host therefore never reaches `upgrade_pending`:
* `POST /api/connect/plugins/{id}/upgrade` turns that refusal into 409 `capability_increase` naming the capabilities, and changes nothing.
* The only way to adopt such a version is `POST /api/connect/plugins/{id}/reinstall {acceptedPermissions, confirm: true}`: it needs the exact new permission list and an explicit confirmation, re-checks the registry hash, removes the plugin from the engine (data is kept by the engine's default) and installs the new version. If the install fails the previous version (same version and hash) is installed again and the response says whether that worked.
* The console shows this as "The engine won't upgrade this in place" with a "Revoke and install" button, next to the wording that permissions are declarations, not an enforced sandbox.
Tested live (`test/live/plugins.live.test.ts`, 4 tests) with the plugin repacked at 0.3.0 declaring one more capability.

## Live check

```
# engine as in docs/PIN-APP-EXECUTION.md ("Running the live check"), started with npm_config_registry=http://127.0.0.1:4873
# a local registry serving @epc-live/plugin-proxmox-sandbox at 0.1.0 and 0.2.0 (the real plugin, repacked): /project/.work/plugin-live/registry.mjs
EPC_LIVE_ENGINE=http://127.0.0.1:3199 EPC_LIVE_REGISTRY=http://127.0.0.1:4873 pnpm --filter @papercliped-engine/epaperclip exec vitest run test/live/plugins.live.test.ts
```
The test runs the host route unmodified (request plumbing stubbed), signs and verifies the catalog with the real marketplace code, and asserts the engine's own plugin list after each step. It does not use a public registry, a real catalog or a real signing key.
