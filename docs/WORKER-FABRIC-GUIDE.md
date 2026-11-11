# Worker Fabric guide

Adopt a Linux machine you own as a persistent ePaperclip worker. **Why this exists:** [WORKER-USE-CASE.md](WORKER-USE-CASE.md). Protocol: [WORKER-FABRIC.md](WORKER-FABRIC.md).

## Install on the worker
1. Get `epaperclip-worker-<version>.tar.gz` and its SHA-256 (build: `bash scripts/package-worker.sh`). There is no curl-pipe-shell installer.
2. Root install: `sudo ./install.sh --tarball FILE --sha256 HEX` (system user `epaperclip-worker`, systemd unit, `/workspaces`).
3. No root (what Orion uses): `./install.sh --user --fetch-node --tarball FILE --sha256 HEX --ollama-url http://<node>:11434 --max-context 4096 --slots 1`.
   Files go under `~/.local`, a user systemd unit is created, workspaces are `~/epaperclip-workspaces`. For start at boot a root user must run once: `sudo loginctl enable-linger <user>`.
4. Upgrade: run the installer again with the new tarball (`--rollback` returns to the previous one). Remove: `--uninstall [--purge]`.

## Consumer setup: `epaperclip --worker`

On a worker machine, `epaperclip --worker` is the same CLI as `epaperclip-worker`. The first-run path is:

```sh
epaperclip --worker setup
```

It detects the machine (CPU, RAM, GPU/VRAM, disk, Ollama), recommends models that actually fit, and prints the install
plan. Nothing is installed without an explicit flag:

```sh
sudo epaperclip --worker setup --install-ollama      # run Ollama's official installer
epaperclip --worker setup --pull --model llama3.1:8b # pull the chosen model
epaperclip --worker setup --adopt <code>             # pair with ePaperclip/Pin
```

`epaperclip --worker recommend` shows the device and the model table without changing anything. The recommender uses
conservative memory floors and never suggests a model that does not fit the free disk. GPU recommendations need a
detected NVIDIA/Jetson GPU; otherwise the model is offered as CPU inference and labelled slower.

The same command is available after the worker tarball install (`epaperclip-worker setup`). On a Proxmox host the
`epaperclip` package provides the host commands and delegates `worker` to the worker CLI when it is installed.
In the console open Workers, choose Add worker, pick the network (Tailscale recommended, Local network, Custom), copy the single-use code (15 minutes), and run `epaperclip-worker adopt <code>` on the worker. Without a code a worker may ask to join: approve it in the console after comparing the verification string. `epaperclip-worker status` and `diagnose` show progress.

## Networking
The worker only connects out to the host's Fabric port (`EPC_FABRIC_LISTEN`, default 7843). The channel is Ed25519 authenticated, X25519 key-exchanged and ChaCha20-Poly1305 encrypted by itself, so any network works. Tailscale: install on both machines and join one tailnet. LAN: same subnet. Custom: set `EPC_FABRIC_PUBLIC_URL`.

## Scheduling and models
Environment requirements (arch, tools, gpu, localModel, minFreeMemMb) and optional pinning to one worker pick the worker; shell slots and inference slots are separate. The worker's inference gate (loopback, `OLLAMA_HOST` is set for commands) lets one generation run at a time and queues the rest. Model choice is the agent's setting and is independent of where it runs.

## Security
Per-worker Ed25519 identity (`identity.json`, 0600); host key pinned at pairing; revocation is durable and a revoked key can never reconnect; the worker never holds Papercliped, user OAuth or Proxmox credentials; the shell is not sandboxed (it is the service user on your own machine), workspaces separate files, not privileges. Run untrusted agents on a separate worker or user.

## Troubleshooting
`epaperclip-worker diagnose`; `journalctl --user -u epaperclip-worker`; `deploy/worker/orion-probe.sh` for the reference node; offline workers show in the console and new runs get a clear `offline` error.

## Orion runbook (reference node kpnai, 100.93.29.26)
Followed on 2026-11-08 as user `miah` (no root, no Node, no /workspaces): install with the `--user --fetch-node` command above, then `epaperclip-worker adopt <code>`. Not changed: Ollama, Tailscale, the machine's boot configuration.
