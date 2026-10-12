# Proxmox sandbox provider

A Paperclip plugin (`epaperclip.proxmox-sandbox-provider`, driver key `proxmox`) that runs Paperclip's agents in unprivileged Proxmox VE LXC containers: it clones a template into a pool for each run, starts it, and runs every command over SSH.

Setup, the minimal Proxmox token and roles, installation into the engine and the environment config are in [docs/PROXMOX-SANDBOX.md](../../docs/PROXMOX-SANDBOX.md).

## Development

A standalone npm package (not in the root pnpm workspace), pinned to `@paperclipai/plugin-sdk@2026.1005.0`. Node 24.11 or later.

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
