# Upgrading the engine (Paperclip) and rolling back

ePaperclip runs the published npm package `paperclipai` at one exact version (`engine/package.json`, `engine/package-lock.json`). An engine upgrade is a version bump plus the checks below. Releases of ePaperclip itself are in [UPDATES.md](UPDATES.md) and [RELEASING.md](RELEASING.md).

## Supported versions

| ePaperclip engine pin | Status |
| --- | --- |
| **2026.1023.0** (MIT, Node >= 24.11) | Current. Installed and run for real; see the verification list below. |
| 2026.1005.0 | Previous pin. An ePaperclip release with this pin still upgrades to 1023 and rolls back to it (tested with real data, below). |

Only exact stable versions are supported. Nightly, canary and beta builds are not. The bridge (`papercliped` gateway) has its own list of Paperclip versions it works with: `docs/PAPERCLIP-COMPATIBILITY.md` in that repository.

## What changed upstream between 1005 and 1023 that matters here

- **Workspace restore locks changed protocol (2026.1006+).** Locks are OS-level SQLite file locks under `<instance>/locks/directory-merge/`. An older engine process does not take them, so an old and a new engine must never run against the same data together, on upgrade or on rollback. Old `<hash>.lock/` folders block the new engine and must be moved away; `*.lock.sqlite` files must never be moved or deleted. The installer now enforces this (below).
- **New agents go through a lifecycle.** A hired agent is `paused` / `preparing`, then `verifying` (the host runs the adapter's test), and only `ready` agents run. Existing agents were moved to `ready` by the migration (checked). Code that creates an agent and wakes it at once must wait for `lifecycleState = ready`.
- **Claude, Codex, Gemini and Kimi run over ACP by default** (a bridge package inside the engine). `adapterConfig.engine = "cli"` selects the old CLI lane; local filesystem/network confinement only works on the CLI lane. The host service already sets `cli` for sandbox agents ([PROXMOX-SANDBOX.md](PROXMOX-SANDBOX.md#engine-lane)).
- **Operator role: 14 grants instead of 1; tool grants are enforced strictly; budget policies block unpriced usage by default; cost columns are numeric.** Not exercised by ePaperclip's own code paths; watch for new 403s and blocked runs after an upgrade.
- **Bigger install:** 2.3 GB of packages (1.4 GB before), including native agent programs. The installer checks for 2.6 GB free for the new tree.
- 87 new API paths, none removed (815 vs 728). 40 database migrations to apply on top of 1005; the release notes warn that two (0313, 0314) are slow on large databases, so the installer's engine wait is 15 minutes (`EPC_ENGINE_WAIT`).

## How the installer protects an upgrade

`deploy/install.sh` (also what the console's Update button runs, through `epaperclip-update`):

1. **Preflight, nothing changed yet:** disk, memory, registry reachable, the new engine tree is installed with `npm ci` from the lockfile (integrity hashes, no install scripts) into a staging folder, and test-started on a spare port with a throwaway data folder.
2. **Stop everything.** All units stop. Then `drain_engine` checks that no process of the engine's user is left (agent and plugin workers included), ends stragglers, and **refuses the upgrade (the old version is started again) if one cannot be ended.** It then moves old-protocol lock folders to `<engine data>/legacy-locks-<time>/` (kept, never deleted).
3. **Backup before migration.** When the engine version changes, the engine's database folder is copied to `<engine data>/pre-upgrade/` (cold copy of a stopped database, with the engine version beside it). Only the latest copy is kept. The engine also makes its own hourly backups.
4. **Swap and start.** The previous version stays in `/opt/epaperclip.prev`. The new engine migrates its database on first start.
5. **If it does not become healthy**, the installer stops everything, drains again, puts the database copy back and restarts the previous version.

## Rolling back

From a shell: `sudo epaperclip rollback` (or `sudo ./deploy/install.sh --rollback`). It stops everything, **refuses if an engine process survives**, puts the previous version back, and, if the engine version differs, restores `pre-upgrade/db` and keeps the newer database beside it as `db.from-<version>-<time>` (nothing is deleted). If no copy from before the upgrade exists it says so; restore an hourly engine backup then.

Data created after the upgrade is not in the restored database. Take the decision before people work in the new version, or export what matters.

## Doing an engine bump (maintainers)

1. Edit `engine/package.json`, then with the pinned Node 24 run `node scripts/engine-lock.mjs` (regenerates the lockfile and proves `npm ci` accepts it).
2. Set `@paperclipai/shared` in `packages/engine-client/package.json` and `@paperclipai/plugin-sdk` in `plugins/proxmox-sandbox/package.json` to the same version; refresh `pnpm-lock.yaml` and the plugin's lockfile.
3. Install the engine in a scratch folder, run it on loopback, and `node scripts/refresh-engine-spec.mjs <install dir> <engine url>`.
4. `pnpm -r typecheck && pnpm -r test`, `npm test` in the plugin, `bash deploy/test/run.sh`, `node scripts/gen-notices.mjs`. `spec-drift.test.ts` fails if the pin, the shared types, the SDK, the lockfile and the spec snapshot disagree, or if the client calls a route or method the engine does not document.
5. Run the real checks: install the plugin into the running engine, create a company, an agent and a task, wake the agent; upgrade a data folder from the previous pin and roll it back.
6. Update the table above and the gateway's compatibility page.

## What was verified for 2026.1023.0

Real (on this repository's CI-less dev box, Node 24.21.0 from a checksum-verified tarball in a scratch folder, no root, nothing installed globally):

- `npm ci --omit=dev --ignore-scripts` of the committed lockfile, then `engine-links.mjs`, then the engine started with the installer's settings; migrations applied (332 on an empty database, 12 s); `/api/health` ok; `/api/openapi.json` captured.
- Managed-account flow from [ENGINE.md](ENGINE.md): sign-up, `bootstrap/claim`, `cli-auth/me` with `isInstanceAdmin`.
- Agent lifecycle: company created, Claude agent created (`preparing`, `verifying`, `ready` once the adapter test passed), task assigned, run `succeeded` through the assignment path, and `POST /agents/:id/wakeup` and `/heartbeat/invoke` both queue a run. The model is a stand-in `claude` program that answers in stream-json (no real model or login was used, and the ACP lane was not run).
- Plugins: the Proxmox sandbox provider and the Papercliped plugin both installed through `POST /api/plugins/install` and reached `ready` (the provider never ran against a Proxmox host).
- Upgrade and rollback of data: a 1005 data folder with a company, an agent, a task and runs was stopped, copied, started on 1023 (40 migrations, healthy in 14 s, data and runs intact, the agent now `ready`), then rolled back by restoring the copy and starting 1005 again (healthy, data intact). The database was small, so the slow-migration timing on a large database is **not** measured.

Against fakes only: the installer scenarios in `deploy/test/run.sh` (simulated host, stand-in engine), including the new `drain` scenario (a straggler process, old lock folders, a straggler that cannot be ended refuses the upgrade and the rollback); the root-only real-engine scenario (`EPC_TEST_REAL_ENGINE=1`) was not run because it needs root. Not run: the full browser E2E ([E2E.md](E2E.md)) against 1023, a real Proxmox host, the ACP lane, Codex/Gemini/Cursor adapters, an upgrade of a large database.

## Licence note for the agent SDKs

Our downloads contain only `engine/package.json` and the lockfile; the installer fetches the packages from the npm registry. That includes components that are not open source: `@anthropic-ai/claude-agent-sdk` (with a native `claude` program), `@cursor/sdk`, `@github/copilot` (each "SEE LICENSE IN ..." under its owner's terms), and `opencode-<platform>` programs that declare no licence at all. They are the engine's dependencies and run on the customer's host under their own terms. A product image that bundles `node_modules` would make us their distributor and needs a legal read first. Details: `NOTICE`, `THIRD_PARTY_LICENSES.md`, [THIRD-PARTY.md](THIRD-PARTY.md).
