# Proxmox sandbox provider

A Paperclip plugin (`epaperclip.proxmox-sandbox-provider`, driver key `proxmox`) that runs Paperclip's agents in unprivileged Proxmox VE LXC containers: it clones a template into a pool for each run, starts it, and runs every command over SSH.

Setup, the minimal Proxmox token and roles, installation into the engine and the environment config are in [docs/PROXMOX-SANDBOX.md](../../docs/PROXMOX-SANDBOX.md).

## Development

A standalone npm package (not in the root pnpm workspace), pinned to `@paperclipai/plugin-sdk@2026.1023.0`. Node 24.11 or later.

```sh
npm ci
npm run typecheck
npm test          # the real-sshd test runs when sshd, ssh and ssh-keygen are installed
npm run build     # dist/manifest.js, dist/worker.js
```

## Layout

| Path | What |
| --- | --- |
| `src/manifest.ts` | Driver declaration and config schema |
| `src/plugin.ts` | The environment hooks (validate, probe, acquire, resume, release, stop, destroy, realize, execute) |
| `src/proxmox-api.ts` | Proxmox API client over an injectable HTTPS transport |
| `src/ssh.ts` | ssh runner, timeouts and the quoted command wrapper |
| `src/ssh-keys.ts` | Public key derivation from the private key |
| `src/config.ts` | Config parsing and validation |
| `template/build-template.sh` | Builds the agent LXC template on a Proxmox host |
| `test/` | Fake Proxmox API, lifecycle tests, SDK harness conformance, real-sshd test |

## Protection against retry loops (ERR-CTR-001)

- **Failure breaker.** After `breakerThreshold` (default 3) failed acquires inside `breakerWindowMs` (15 min) for one organization and environment, acquire refuses at once, before any Proxmox call, until a cooldown passes (`breakerCooldownMs` 2 min, doubled on each failed trial, capped at `breakerMaxCooldownMs` 30 min). One success resets it. State is kept in the plugin state API (capabilities `plugin.state.read` and `plugin.state.write`), so a worker restart keeps it; without them it is memory only. `breakerThreshold: 0` turns it off.
- **Single flight.** Simultaneous acquires for one environment wait for one attempt; if it fails they share its error and clone nothing.
- **Reuse.** With `reuseLease`, an acquire reuses this organization's running or stopped container for the same environment instead of cloning.
- **Orphan cleanup.** Every acquire first removes this organization's containers that a failed create left tagged `provisioning` for more than 10 minutes. Templates, finished leases, spares and containers without our tag are never touched.
- **`spareContainers` (0 or 1, default 0).** Keeps one stopped pre-cloned container per environment, used by the next acquire. It costs one idle full clone of disk.
