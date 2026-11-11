# epaperclip-worker

Adds a machine you own — a desktop, a Jetson, a spare server — as an AI worker for [ePaperclip](https://github.com/OpenSourcx/papercliped-engine) and Pin.

```sh
npx epaperclip-worker setup
```

It detects the machine (CPU, RAM, GPU/VRAM, disk, Ollama), recommends local models that actually fit, and prints the install plan. Nothing is downloaded without an explicit flag:

```sh
sudo npx epaperclip-worker setup --install-ollama      # Ollama's official installer
npx epaperclip-worker setup --pull --model llama3.1:8b # pull the chosen model
npx epaperclip-worker setup --adopt <code from Workers>
```

Other commands:

| Command | Does |
| --- | --- |
| `epaperclip-worker recommend` | device and model table; no changes |
| `epaperclip-worker status` | worker id, state, last heartbeat |
| `epaperclip-worker diagnose` | checks Node, pairing, endpoints, Ollama |
| `epaperclip-worker caps` | full detected capability JSON |
| `epaperclip-worker config key=value` | name, ollamaUrl, workspaceRoot, slots, maxContext |
| `epaperclip-worker run` | run the worker in the foreground |

The worker only connects **out** to the host's Fabric port; it opens no port. Pairing uses a single-use code and a pinned host key. It never holds Proxmox or user OAuth credentials. For a persistent systemd service, use the worker tarball installer: [Worker Fabric guide](https://github.com/OpenSourcx/papercliped-engine/blob/main/docs/WORKER-FABRIC-GUIDE.md).

Requires Linux and Node 22 or newer. MIT licensed.
