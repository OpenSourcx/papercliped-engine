# Worker Fabric guide

Adopt a Linux machine you own as a persistent ePaperclip worker. Contract and architecture: [WORKER-FABRIC.md](WORKER-FABRIC.md).

## Install on the worker
1. Get `epaperclip-worker-<version>.tar.gz` and its SHA-256 (build: `bash scripts/package-worker.sh`). There is no curl-pipe-shell installer.
2. Root install: `sudo ./install.sh --tarball FILE --sha256 HEX` (system user `epaperclip-worker`, systemd unit, `/workspaces`).
3. No root (what Orion uses): `./install.sh --user --fetch-node --tarball FILE --sha256 HEX --ollama-url http://<node>:11434 --max-context 4096 --slots 1`.
   Files go under `~/.local`, a user systemd unit is created, workspaces are `~/epaperclip-workspaces`. For start at boot a root user must run once: `sudo loginctl enable-linger <user>`.
4. Upgrade: run the installer again with the new tarball (`--rollback` returns to the previous one). Remove: `--uninstall [--purge]`.

## Adopt
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

## Set up a clean machine as an AI server
One command turns a clean Linux machine (a Jetson Orin Nano Super like Orion, any ARM64 board, or an x86 box with or without an NVIDIA GPU) into a managed ePaperclip AI server: `bootstrap.sh`, shipped inside the worker release next to `install.sh`. Run it as root from the unpacked release.

```
tar xzf epaperclip-worker-<version>.tar.gz && cd epaperclip-worker-<version>
sha256sum ../epaperclip-worker-<version>.tar.gz          # compare with the value on the release page
sudo ./bootstrap.sh --check                              # reads the hardware, prints the plan, changes nothing
sudo ./bootstrap.sh                                      # does it; asks before downloading models
sudo ./bootstrap.sh --yes --models auto --name orion     # no questions
```
**What it does, in order.** (1) Detects the hardware class (Jetson with its L4T release, generic ARM64, x86) and memory tier. (2) Installs missing prerequisites with apt (curl, ca-certificates, zstd, tar, xz-utils, sudo; on other distributions it tells you what to install). (3) Tailscale: installs it from the official apt repository if absent and joins the tailnet when `TS_AUTHKEY` is in the environment; otherwise it tells you to run `sudo tailscale up`. (4) Ollama from the official GitHub release, SHA-256 checked against the release's `sha256sum.txt` (a mismatch stops everything), as a system service under the `ollama` user. It listens on the Tailscale address when there is one, otherwise on loopback, never on all interfaces, with `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_KEEP_ALIVE=10m` and a context length from RAM (2048 below 6 GB, 4096 below 12 GB, 8192 below 24 GB, 16384 above). (5) The worker as a system service (`epaperclip-worker.service`, its own unprivileged user, starts at boot, no linger needed) through `install.sh`, fetching the pinned Node.js if the machine has none. (6) A small root-owned helper `/usr/local/lib/epaperclip-worker/epw-admin` and a sudo rule that lets the worker user run exactly three verbs: restart the worker, restart Ollama, install a signed update. (7) Models: one recommended coder model for the tier, only if it fits (weights x1.5 within 85% of RAM, twice the weights plus 2 GB of disk free) and only after you say yes.

| Memory | Tier | Recommended model | Context |
|---|---|---|---|
| under 3.5 GB | tiny | qwen2.5-coder:0.5b | 2048 |
| 3.5 to 6 GB | tiny | qwen2.5-coder:1.5b | 2048 |
| 6 to 12 GB (Orion: 7.5 GB) | small | qwen2.5-coder:3b | 4096 |
| 12 to 24 GB | medium | qwen2.5-coder:7b | 8192 |
| 24 GB and up | large | qwen2.5-coder:14b | 16384 |

**GPU.** On a Jetson it uses the system's L4T/CUDA runtime as it is and never installs or changes NVIDIA drivers (Ollama's JetPack 5 and 6 bundles are added for L4T R35 and R36; newer L4T uses the regular ARM64 bundle). On x86 with an NVIDIA card it checks `nvidia-smi`; if the driver is missing it says so and stops short: install the vendor driver yourself (Ubuntu: `sudo ubuntu-drivers install`, reboot) and run the script again. Without a working driver Ollama runs on the CPU.

**Adopt.** The pairing code comes from the console (Workers, Add worker; valid 15 minutes). Either pass it (`--host-code CODE`) or run `sudo epaperclip-worker adopt CODE` afterwards, then `sudo ./bootstrap.sh --pin-host-key` once: that copies the host key adoption pinned into `/etc/epaperclip-worker/host.pub`, a file only root can change, which signed updates are verified against. Without a code you can use `--host-url ws://host:7843/fabric/v1/connect --host-key KEY` and approve the request in the console.

**Firewall.** Nothing is opened and nothing needs opening: the worker only connects out and Ollama is bound to the tailnet or loopback. Do not open port 11434 to a LAN.

**Re-run, upgrade, undo.** Running it again changes nothing that is already right. `--upgrade` moves Ollama to the newest release and the worker to the bundle you are running. Every change is appended to `/var/lib/epaperclip-worker/bootstrap.log`; what it created is listed in `bootstrap.manifest`. `sudo ./bootstrap.sh --uninstall [--purge] [--purge-models]` removes exactly those things (Tailscale is left joined; models are kept unless `--purge-models`). Revoke the worker in the console as well.

### Health and statistics
Every 15 seconds the worker sends CPU percent, load, memory and swap, disk, temperatures, GPU load and temperature, uptime, the state of the worker, Ollama and Tailscale services, the models installed and loaded, and Ollama's running and queued requests (`epaperclip-worker stats` prints one sample locally). Nothing needs root: it reads `/proc`, `/sys/class/thermal`, `systemctl is-active`, `nvidia-smi` and the Ollama API; on a Jetson GPU load comes from the world-readable `/sys/devices/platform/bus@0/17000000.gpu/load` because `nvidia-smi` reports N/A on Orin. The host keeps the last hour at full resolution and 24 hours at one point per five minutes (saved with its state). The Workers list shows each worker as Online, Stale (connected but no sample for a minute) or Offline, with CPU, memory, temperature, GPU, disk free and service states; the worker page has a Health tab with the same plus charts, and a Manage tab.

### Manage a device from the console
Manage tab actions: restart the worker, restart Ollama, download or remove a model, show logs of the worker, Ollama or Tailscale, update the worker from a release tarball (https address plus SHA-256), and the existing drain, disable and revoke. Each request is signed by the host key, bound to one worker, valid for two minutes and single-use; the worker verifies it against the key it pinned at adoption and runs only the fixed action with validated parameters. There is no remote shell here; running commands is still only the authenticated execute path agents use. Every action is audited with who asked. An update is downloaded by the worker, checked against the signed SHA-256, and installed by the root helper only after it verifies the host signature again against the root-owned key; the previous version stays for `install.sh --rollback`. Restart and update need the helper, which only `bootstrap.sh` installs; a worker installed by hand supports models and logs.

### The worker is not a standalone server
The worker opens no port for anyone else: it dials out to its adopted host over the authenticated channel, and its inference gate listens on 127.0.0.1 only. Without an adoption it idles.

### Troubleshooting
`sudo ./bootstrap.sh --check` explains what it sees. `epaperclip-worker diagnose`, `journalctl -u epaperclip-worker -u ollama`, `systemctl status tailscaled`. Ollama will not start after install: with Tailscale not yet joined it binds loopback; once joined, re-run the script so it rebinds to the tailnet address. "Stale" means the connection is up but samples stopped: restart the worker. Clock more than two minutes off makes signed actions fail with a clear message. A model that does not fit is skipped with a reason; pull one by name from the Manage tab.

### What is verified, and what still needs a real device
See the PR description and [V2-ACCEPTANCE-MATRIX.md](V2-ACCEPTANCE-MATRIX.md). In short: parsing and collection are tested against recorded Orion output; the whole flow including systemd, users, sudo rules, signed management, update and uninstall is tested on a clean Debian 12 container with a stand-in Ollama binary. Not yet exercised on hardware: a real Ollama download and GPU use, `tailscale up` on a real tailnet, L4T/JetPack on a freshly flashed Jetson, an NVIDIA x86 driver machine. Prerequisites for that run: root on the device, internet access to github.com, pkgs.tailscale.com and nodejs.org, a Tailscale auth key or a person at the console, 10 GB of free disk for an 8 GB-class device, and a pairing code from the console.
