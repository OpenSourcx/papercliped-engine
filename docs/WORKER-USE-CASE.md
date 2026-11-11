# Worker use case — the AI box you bought joins your host

**Status:** product contract. Read this before changing the worker, the Fabric, the model setup or the Pin
worker screens. `WORKER-FABRIC.md` is the protocol; this file is why it exists.

## The person

A homelab owner already runs Proxmox and ePaperclip on their host. The host has the CPU, disks and
containers, but not the GPU they want for local AI. They buy an AI-capable machine — a Jetson, a
GPU desktop, a mini PC, a spare server — because it is cheaper and more scalable than replacing the
Proxmox host.

They do **not** want a second cloud account, a second orchestrator, or to become a Kubernetes
operator. They want the AI box to become part of the host they already own, in minutes, and they want
Pin to manage it.

## The job to be done

> “I bought this AI machine. Make it work with my Proxmox host, using my local login, and let Pin
> install a model that fits it and run my agents on it.”

## The flow (consumer, not operator)

1. **On the host, in ePaperclip/Pin:** Workers → Add worker. Choose Tailscale, local network or a
   custom address. The signed-in Proxmox administrator approves it and gets one single-use code and
   one install command. No cloud identity, no KpnIdentity, no KpnSolute.
2. **On the AI box:** install the worker (`npm install -g epaperclip-worker`, the apt/tarball
   equivalent, or the one-line command) and run `epaperclip --worker setup` (or
   `epaperclip-worker adopt <code>`).
3. **The worker connects out** to the host, proves its key, and reports what it actually is: CPU,
   RAM, GPU/VRAM, disk, OS/arch, Ollama and existing models. It never listens for the host and never
   receives Proxmox or user OAuth credentials.
4. **Pin shows the worker** with its real specs. It recommends only models that fit that device and
   offers **Install Ollama** and **Pull model** as explicit, approved actions with visible progress.
5. **Pin creates a worker environment** and assigns agents. The scheduler sends runs to the least
   busy matching worker; model requirements and free memory are respected. Pin can drain, disable,
   refresh or revoke the worker.
6. **Scale by buying another box.** Repeat the same flow. Pin manages placement and routing; the
   Proxmox host stays the control plane and never becomes the model server.

## Identity and trust — the local ID service

- The approver is a **signed-in Proxmox administrator** on the host (or a Papercliped-authenticated
  session where Connect is used). That is the local identity service. No separate worker account.
- The pairing code is an authorization artifact minted by the host after that approval: single use,
  15 minutes, host key pinned, worker key generated on the device.
- The worker stores an Ed25519 identity (`0600`) and the host's public key. Revocation is durable: a
  revoked key can never reconnect.
- A worker never holds Proxmox credentials, user OAuth tokens, or the host's fabric private key.
- Tailscale/LAN is transport, never identity.

## The “install Ollama for you” boundary

The worker service runs as an unprivileged service user. Installing a system package or a model must
not mean Pin gets arbitrary root on the AI box.

The consumer path is a **narrow privileged helper**, installed once by the worker installer with the
user's consent:

- allowlisted actions only: `ollama.install`, `ollama.pull <model>`, `inference.status`;
- no arbitrary command, no shell, no file read outside the model store;
- fixed, signed command lines; model ids validated against the catalogue;
- progress and output streamed back to Pin; explicit approval before a download;
- if the helper is not installed, Pin shows the exact CLI command instead of pretending it can install.

Pin never talks to root directly. It asks the worker; the worker asks the helper over a local socket.

## Why this wins

- **Easier:** one code, one command, one pane of glass.
- **Cheaper:** use the AI hardware you bought; the Proxmox host stays as it is.
- **Scalable:** add workers, not a bigger host; Pin places work by capability and load.
- **Local:** no cloud account or hosted control plane is required.
- **Safe:** the worker is an unprivileged agent with a pinned key; privileged installs are narrow and
  audited.

## Definition of done (consumer worker)

- [ ] A person with a fresh AI box can add it from Pin/Workers and see its real specs, without a cloud
  account or a second orchestrator.
- [ ] Pin recommends models that fit the detected CPU/GPU/RAM/disk and never suggests one that does not.
- [ ] Pin can install Ollama and pull the chosen model through the privileged helper, with approval,
  progress and no arbitrary root.
- [ ] An agent run lands on that worker, completes, and can be cancelled; Pin shows where it ran.
- [ ] A second worker can be added and the scheduler chooses between them by capability and load.
- [ ] Drain, disable, refresh and revoke are observable in Pin; revocation is durable.
- [ ] A worker never holds Proxmox or user OAuth credentials.

## Non-goals

- A cloud account or a second control plane.
- Treating Tailscale as identity.
- Putting Proxmox credentials on the worker.
- Giving Pin arbitrary root on the AI box.
- Making the Proxmox host the model server.
- A second worker system beside the existing Fabric.
