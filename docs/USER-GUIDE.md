# ePaperclip user guide

A short, ordered path through the documentation that already exists. It links to the detailed pages instead of repeating them. Status honesty first: the repository README's status table is the source of truth for what is built. At the time of writing ePaperclip is **ready to try but not yet run on a real Proxmox host**, and organizations, agents and tasks in the console are partly still demo data (see [README](../README.md) and [ROADMAP](ROADMAP.md)). Anything below that depends on those is marked.

## 1. Install

You need Proxmox VE 8 or newer, root on the host, about 4 GB of memory (2 GB minimum) and 3 GB of free disk. Pick one of three ways: signed APT repository (recommended), `npx epaperclip install`, or the `get.sh` one-liner. All three run the same installer, which checks first, changes nothing if something is missing, brings its own Node.js, and rolls itself back if the new services do not come up.

**Current availability (checked 2026-11-06):** only release candidates are published (latest `v1.0.0-rc30`; the update feed lists no stable release). Because the APT repository and the `releases/latest` one-liner carry stable releases only, they answer 404 today. Until a stable `1.0.0` is cut, install a release candidate as shown in [INSTALL.md#release-candidates](INSTALL.md#release-candidates) (the `EPC_RELEASE_BASE=.../releases/download/v1.0.0-rcN` form, or `npx epaperclip@next install`). Do not use plain `npx epaperclip install` for now: the npm `latest` tag still points at the old `1.0.0-rc2`, while `next` is `1.0.0-rc30`.

Full steps, the signing key fingerprint and what the installer promises: [INSTALL.md](INSTALL.md). What it puts where: [INSTALL.md#what-goes-where](INSTALL.md#what-goes-where). Release candidates: [INSTALL.md#release-candidates](INSTALL.md#release-candidates).

## 2. First run and local login

Open `https://<host>/` (port 443). Sign in with a **Proxmox account** (pam, pve, LDAP, with two-factor if you use it). What each person can see and do is exactly what their Proxmox permissions allow; every action runs as that person. The stock Proxmox interface stays at `https://<host>:8006/` and is your way back in if anything goes wrong.

The first start sets up the engine's database (a few hundred migrations) and can take a few minutes; the installer waits and shows progress. If the page does not load: [INSTALL.md#if-somethings-wrong](INSTALL.md#if-somethings-wrong). How sign-in maps to the engine's accounts: [ENGINE.md](ENGINE.md#how-people-get-in-managed-accounts-behind-the-proxmox-sign-in). Roles, groups, API tokens and two-factor: [ACCESS.md](ACCESS.md).

There is no separate ePaperclip password and no cloud account. A Papercliped account is only needed if you choose Connect (section 6).

## 3. Agents

Agents never run on the host. Until a Proxmox administrator sets up **Settings, Agent containers** the engine refuses to run any agent. Setup builds a Debian template container and a sandbox provider and takes several minutes. Details, what it creates, how to remove it: [ENGINE.md#agent-containers](ENGINE.md#agent-containers); by hand: [PROXMOX-SANDBOX.md](PROXMOX-SANDBOX.md). Organizations, budgets and approvals: [ORGS.md](ORGS.md). The Pin copilot: [PIN.md](PIN.md). Models and the router: [ROUTER.md](ROUTER.md). Secrets handling: [VAULT.md](VAULT.md).

**Slow to start?** How quickly an agent container appears depends on the storage it is made on: about two minutes on ordinary directory storage, a few seconds on ZFS. See [Fast storage for agent containers](FAST-STORAGE.md), written for people who have never used ZFS.

(On a device, organizations, agents, tasks, chat, artifacts and skills are live; the demo shows placeholders. The parity matrix in `PARITY.md` lists what is still open.)

## 4. Machine management

Virtual machines and containers are managed from the console as the signed-in person, with Proxmox deciding permissions: the machine page ([MACHINE.md](MACHINE.md)), disks ([DISKS.md](DISKS.md)), backups ([BACKUP.md](BACKUP.md)), software-defined networking ([SDN.md](SDN.md)), clustering ([CLUSTER.md](CLUSTER.md)), the node ([NODE.md](NODE.md)). Not everything has been verified against a real Proxmox host; each page lists what is not.

## 5. Backups of ePaperclip itself

The engine backs itself up hourly (kept 7 days). Copy `/var/lib/epaperclip-engine`, `/etc/epaperclip` and `/var/lib/epaperclip` off the host: [INSTALL.md#backups](INSTALL.md#backups).

## 6. Remote access modes

Exactly one mode is active, shown in Settings, Remote access:

| Mode | What it is | More |
|---|---|---|
| `local` (default) | The console and MCP stay on your network; nothing is published | nothing to set up |
| `cloudflare-self` | **Self-managed Cloudflare**: you provide a Cloudflare account, domain and API token; ePaperclip publishes through a `cloudflared` service on your host | `epaperclip device publish status` ([INSTALL.md](INSTALL.md#device-cli)) |
| `connect` | **Papercliped Connect**: a managed tunnel and address `<name>.connect.papercliped.co` per device, billed per device | [PAPERCLIPED-ACCOUNT.md](PAPERCLIPED-ACCOUNT.md), customer guides (overview, pairing, billing, troubleshooting) ship with the Papercliped Connect documentation, which is not public yet |

Switching between the two remote modes goes through `local`; while `connect` is active the Cloudflare self-management controls answer 409, so they cannot share the tunnel service, token file or public URL. Connect pairing is administrator-only and needs the account owner's approval plus the local administrator's confirmation of the exact account ([PAPERCLIPED-ACCOUNT.md](PAPERCLIPED-ACCOUNT.md#pairing-and-remote-access-mode-device-side)). The device-side tunnel client and its single-owner helper are built ([PAPERCLIPED-ACCOUNT.md](PAPERCLIPED-ACCOUNT.md#the-managed-tunnel-device-side)) but verified only against fakes, not a real tunnel or host. Unpairing also asks Connect to remove the device (it is retried if Connect is unreachable; check the Connect Console if the device is still listed). Connect billing is not enabled. Switching modes never changes local access or Proxmox permissions.

## 7. Updates and rollback

Check, schedule and install updates from Settings, Updates, or on the host with `epaperclip update`. Releases are signed and checked before anything is installed; an older release is refused. Details, channels, maintenance windows, history and withdrawn releases: [UPDATES.md](UPDATES.md). Proxmox's own packages are updated separately by the administrator and have no undo.

Rollback: `epaperclip rollback` (or the console's "Go back to the previous version") swaps the previous version back, including the engine's database copy taken before the upgrade. One step of history: [INSTALL.md#rollback](INSTALL.md#rollback), [INSTALL.md#upgrade](INSTALL.md#upgrade).

## 8. Uninstall

`epaperclip uninstall` removes the services and programs and keeps your data and settings; `epaperclip uninstall --purge` removes those and the service users too. Proxmox itself is untouched either way: [INSTALL.md#uninstall](INSTALL.md#uninstall) and the command table in [INSTALL.md#afterwards](INSTALL.md#afterwards). If you used Connect, remove the device in the Connect Console first; a purge on the host does not cancel a subscription.

## Security and licences

[SECURITY.md](SECURITY.md) has the threat model, what is enforced where and how to report a vulnerability. Third-party licences: [../THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md) and [../NOTICE](../NOTICE).
