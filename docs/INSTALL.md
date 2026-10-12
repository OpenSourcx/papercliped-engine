# Installing ePaperclip on Proxmox

ePaperclip runs on your Proxmox host and serves its console at `https://<host>/` (port 443). People sign in with their Proxmox accounts, and every action runs as that person, so Proxmox's own permissions still decide what they can do. Proxmox's own web interface keeps running on `:8006`; it is never changed, and it is your way back in if anything goes wrong.

You need: Proxmox VE 8 or newer, root access (the web shell works: Datacenter → your node → **Shell**), and internet access from the host.

## Install

Latest release (once releases are published):

```sh
curl -fsSL https://github.com/OpenSourcx/papercliped-engine/releases/latest/download/get.sh | bash
```

From a branch, building on the host (a few minutes):

```sh
curl -fsSL https://raw.githubusercontent.com/OpenSourcx/papercliped-engine/<branch>/deploy/from-source.sh | EPC_REF=<branch> bash
```

The installer first checks everything it needs and changes nothing if something is missing. It brings its own checksum-verified Node.js (your system's isn't touched), test-starts the new version on a spare port, then swaps it in. If the swapped-in service doesn't come up healthy, the previous version is put back automatically (on a first install, everything is removed).

When it finishes it prints the address. Open it, and sign in with your Proxmox username and password, with the realm you use for Proxmox itself.

## Afterwards

The installer comes with every download and clone of the repository (`deploy/install.sh`):

| Command | Does |
| --- | --- |
| `./deploy/install.sh` | install, or upgrade to this version |
| `./deploy/install.sh --status` | version, whether it's running, whether it answers |
| `./deploy/install.sh --rollback` | go back to the previous version |
| `./deploy/install.sh --uninstall` | remove it (settings stay; `--purge` removes those too) |

Settings are in `/etc/default/epaperclip` (port, certificate, upload size). Restart after changing them: `systemctl restart epaperclip`. Logs: `journalctl -u epaperclip`.

## If something's wrong

- **The page doesn't load.** If the Proxmox firewall is on, allow TCP 443 (Datacenter → Firewall → Add: direction in, ACCEPT, tcp, port 443). Use `:8006` meanwhile.
- **Port 443 is taken.** Set `EPC_LISTEN=0.0.0.0:8443` in `/etc/default/epaperclip`, then `systemctl restart epaperclip`.
- **Clusters.** Install on each node you want to reach it from; every node serves its own console and signs in against the same cluster accounts.
- **Remove everything.** `./deploy/install.sh --uninstall`. Proxmox is untouched either way.
