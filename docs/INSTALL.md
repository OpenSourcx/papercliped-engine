# Installing ePaperclip on Proxmox

ePaperclip runs on your Proxmox host and serves its console at `https://<host>/` (port 443). People sign in with their Proxmox accounts, and every action runs as that person, so Proxmox's own permissions still decide what they can do. Behind the console runs the engine, [Paperclip](https://github.com/paperclipai/paperclip), as a second service that only listens on the host itself. Proxmox's own web interface keeps running on `:8006`. It is never changed, and it is your way back in if anything goes wrong.

## What you need

- Proxmox VE 8 or newer, and root access. The web shell works: Datacenter → your node → **Shell**.
- Memory: 4 GB or more recommended. The installer refuses hosts with less than 2 GB. At idle the engine uses about 1 GB (0.5 GB for the server, 0.4 GB for its database).
- Disk: about 3 GB free where `/opt` and `/var/lib` live (1.4 GB for the engine's packages, room for its data).
- Internet access during the install, to nodejs.org and registry.npmjs.org (and to the package source you use).

## Install

Three ways, one installer. Whichever you pick, the same `deploy/install.sh` does the work and makes the same promises (below).

### With apt (recommended)

Add ePaperclip's signed package repository once, then install:

```sh
curl -fsSL https://updates.papercliped.co/apt/epaperclip-archive-keyring.gpg \
  -o /usr/share/keyrings/epaperclip-archive-keyring.gpg
gpg --show-keys /usr/share/keyrings/epaperclip-archive-keyring.gpg   # check the fingerprint below
echo "deb [signed-by=/usr/share/keyrings/epaperclip-archive-keyring.gpg] https://updates.papercliped.co/apt stable main" \
  > /etc/apt/sources.list.d/epaperclip.list
apt update
apt install epaperclip
```

The key's fingerprint is `B8A0 77BE 1EB3 B107 D11A  15DF 3A07 D686 6306 BE32` (ePaperclip Releases &lt;releases@papercliped.co&gt;). It is also in this repository at [`deploy/apt/epaperclip-archive-keyring.asc`](../deploy/apt/epaperclip-archive-keyring.asc). apt only accepts packages signed with it, and only from this repository: `signed-by=` keeps the key from vouching for anything else.

Updates come with the rest of the system: `apt update && apt upgrade`. The package also adds an `epaperclip` command: `epaperclip status`, `epaperclip rollback`, `epaperclip uninstall`.

Every install method leaves the `epaperclip` command on the host (`get.sh` and `npx` link it as `/usr/local/bin/epaperclip`; the package ships its own): `epaperclip status | version | update [--tag v1.0.0-rc4] | rollback | uninstall [--purge]`. `epaperclip update` finds the newest release in the public release feed, checks its signature and installs it, exactly as `get.sh` does. While you run a release candidate it follows release candidates too; from a final version it takes only final releases unless you add `--pre`. `epaperclip update --tag v1.0.0-rc5` installs that exact release. It says `already on vX` when there is nothing newer, and it never goes back to an older release.

### With npm

If the host has Node.js 18 or newer:

```sh
npx epaperclip install
```

or `npm install -g epaperclip`, then `epaperclip install`. Host Node.js only starts this command. The services run on the installer's own pinned Node.js. Upgrade with `npx epaperclip@latest install`.

### With one command

```sh
curl -fsSL https://github.com/OpenSourcx/papercliped-engine/releases/latest/download/get.sh | bash
```

This downloads the latest release, checks its Ed25519 signature (against the project's public key, which is written into that `get.sh`) and its checksum and version, and only then unpacks it and runs the installer inside it. If anything doesn't check out it installs nothing and says why. It needs `openssl`, which Proxmox hosts have. Run it again to upgrade. It refuses a release older than the installed one unless you set `EPC_ALLOW_DOWNGRADE=1`. How the signing works and how to check a download by hand: [SECURITY.md](SECURITY.md#release-signing).

### Release candidates

A tag with a hyphen (`v1.0.0-rc1`) is published as a GitHub pre-release, so "latest" (and the one-line command above) never picks it up, and it is on the npm tag `next`, not `latest`. The APT repository only ever carries stable releases. To try a release candidate on a test host:

```sh
B=https://github.com/OpenSourcx/papercliped-engine/releases/download/v1.0.0-rc1
curl -fsSL $B/get.sh | EPC_RELEASE_BASE=$B bash
# or: npx epaperclip@next install
```

It is verified exactly like a stable release. The console's Update button only offers stable releases. Going from a release candidate to the final `1.0.0` counts as an upgrade.

From a branch, building on the host (a few minutes):

```sh
curl -fsSL https://raw.githubusercontent.com/OpenSourcx/papercliped-engine/<branch>/deploy/from-source.sh | EPC_REF=<branch> bash
```

### What the installer promises

- It checks everything it needs first, and changes nothing if something is missing. It checks Proxmox VE 8+, memory, disk, that ports 443 and 3100 are free, pveproxy, and the node certificate.
- It brings its own Node.js: a pinned version, checked against a pinned SHA-256, in `/opt/epaperclip/node`. Your system's Node.js isn't used or changed.
- It installs the engine with `npm ci` from the lockfile in this repository (`engine/package-lock.json`). That pins Paperclip at an exact version, checks every package against its integrity hash, and runs no package's install scripts.
- It builds the new version beside the old one and test-starts it on a spare local port. A new engine is test-started as its own user, against a throwaway data directory. Only then is the new version swapped in.
- If the swapped-in services don't come up healthy, it puts the previous version back by itself: programs, both systemd units and, if the engine version changed, the engine's database. On a first install, everything is removed.

When it finishes it prints the address. Open it and sign in with your Proxmox username and password, using the realm you use for Proxmox itself. The engine's first start sets up its database (a few hundred migrations), which takes up to a few minutes. The installer waits for it and shows progress.

## After installing: set up agent containers

Agents never run on the host. Until this is done the engine refuses to run any agent (a run fails with "managed sandbox only"), and the console says so. Sign in as a Proxmox administrator (a user with `Sys.Modify` on `/`, such as `root@pam`), open **Settings, Agent containers**, check the storage and bridge it suggests, and press **Set up agent containers**. It takes several minutes (it builds a Debian template container with Node.js and the agent tools) and carries on if you close the page. Every Proxmox step is made through the Proxmox API as you, so Proxmox's own permissions decide.

It needs: the `ssh` client on the host (Proxmox hosts have it), internet access from the host and from the bridge's DHCP network (to download the Debian template, Node.js and the agent tools), a bridge with DHCP, and a storage for container disks and one for templates. What it creates, and how to remove it, is in [docs/ENGINE.md](ENGINE.md#agent-containers); doing the same by hand is in [docs/PROXMOX-SANDBOX.md](PROXMOX-SANDBOX.md).

## What goes where

| Path | What |
| --- | --- |
| `/run/epaperclip-exec/` | root-owned private execution socket (`root:epaperclip`, 0660) and root-only per-container lock files; recreated at boot |
| `/etc/systemd/system/epaperclip-exec.socket`, `epaperclip-exec@.service` | socket-activated root helper; installer enables the socket, rollback restores matching units, uninstall removes them |
| `/opt/epaperclip/` | `exec/epaperclip-exec.mjs` (root-owned private container execution helper), and the programs: `node/` (private Node.js), `epaperclip.mjs` (host service), `console/`, `engine/` (Paperclip and its packages, about 1.4 GB), `plugins/proxmox-sandbox/` (the agent container provider: built code, the template scripts and its production packages, about 45 MB, installed from its own lockfile like the engine's and readable by the engine's user), `VERSION` |
| `/opt/epaperclip.prev/` | the previous version, kept for `--rollback` |
| `/etc/systemd/system/epaperclip.service` | the host service: port 443, user `epaperclip` |
| `/etc/systemd/system/epaperclip-engine.service` | the engine: `127.0.0.1:3100` only, user `epaperclip-engine` |
| `/etc/default/epaperclip` | host service settings (port, certificate, upload size) |
| `/etc/epaperclip/engine.env` | engine settings and secrets, mode 0600. Written once at install with fresh random secrets, never overwritten (an upgrade only adds a setting that is missing) |
| `/var/lib/epaperclip/` | the host service's vault key and its settings, every secret in them encrypted by the vault |
| `/var/lib/epaperclip-engine/` | the engine's data: its PostgreSQL database, its secrets key, its hourly backups |
| `/usr/share/epaperclip/` | with apt only: the package's copy of the release, which the installer runs from |

Both services are locked down by systemd: their own users, no access to home directories, a read-only system, and only their own data directory writable. The engine gets no capabilities at all and is capped at 3 GB of memory. Nothing in Proxmox's own configuration is changed.

## Afterwards

| Command | apt or npm | Does |
| --- | --- | --- |
| `./deploy/install.sh` | `epaperclip install` | install, or upgrade to this version |
| `./deploy/install.sh --status` | `epaperclip status` | versions, whether both services run and answer, where the data and latest backup are |
| `./deploy/install.sh --rollback` | `epaperclip rollback` | go back to the previous version |
| `./deploy/install.sh --uninstall` | `epaperclip uninstall` | remove it, keeping data and settings |
| `./deploy/install.sh --purge` | `epaperclip uninstall --purge` | remove it with its data, settings and users |

With apt, `apt remove epaperclip` is `--uninstall` and `apt purge epaperclip` also deletes the data. The installer comes with every download (`deploy/install.sh`). With apt it is at `/usr/share/epaperclip/deploy/install.sh`.

Logs: `journalctl -u epaperclip` and `journalctl -u epaperclip-engine`. Restart after changing settings: `systemctl restart epaperclip` (or `epaperclip-engine`).

### Upgrade

Upgrade the way you installed: `apt upgrade`, `npx epaperclip@latest install`, or the `get.sh` command again. The installer reuses the installed engine when its lockfile hasn't changed. A new engine version is installed fresh and test-started first. It then migrates the database forward on its first start, so the installer first keeps a copy of the database in `/var/lib/epaperclip-engine/pre-upgrade/`. Only the latest copy is kept.

If an apt upgrade fails, the installer has already put the previous version back and apt reports the error. Run `apt upgrade` again once the cause is fixed.

### Rollback

`--rollback` (or `epaperclip rollback`) swaps the previous version and its units back in. If the engine version changes with it, the database copy from before the upgrade is put back. The newer database is kept beside it, as `instances/default/db.from-<version>-<date>`, not deleted. There is one step of history: after a rollback there is no "previous" until the next upgrade.

### Uninstall

`--uninstall` stops and removes both services and everything in `/opt`. It keeps `/var/lib/epaperclip-engine`, `/var/lib/epaperclip`, `/etc/epaperclip` and `/etc/default/epaperclip`, and says where they are. Installing again picks them up as they were. `--purge` removes those too, with the two service users.

## Backups

- **The engine backs itself up every hour** into `/var/lib/epaperclip-engine/instances/default/data/backups/` (compressed SQL, kept for 7 days). `--status` shows the latest one.
- Back up, off the host:
  - `/var/lib/epaperclip-engine` (the engine's data and its backups)
  - `/etc/epaperclip` (the engine's secrets: without them, sessions and agent keys from the old install won't work)
  - `/var/lib/epaperclip` (the host service's vault: without it, the stored engine sign-ins and connector keys can't be read)

  Keep the three together. Stop both services for a consistent copy of the engine's live database (`systemctl stop epaperclip epaperclip-engine`), or rely on its hourly SQL backups.
- Proxmox's own backup jobs cover guests, not the host's files, so include these paths in whatever backs up the host itself.

## If something's wrong

- **The page doesn't load.** If the Proxmox firewall is on, allow TCP 443 (Datacenter → Firewall → Add: direction in, ACCEPT, tcp, port 443). Use `:8006` meanwhile.
- **Port 443 is taken.** Set `EPC_LISTEN=0.0.0.0:8443` in `/etc/default/epaperclip`, then `systemctl restart epaperclip`.
- **The engine doesn't start.** `journalctl -u epaperclip-engine -n 100`. The console keeps working for the host itself while the engine is down.
- **Clusters.** Install on each node you want to reach it from. Every node serves its own console and engine, and signs in against the same cluster accounts.
- **Remove everything.** `./deploy/install.sh --purge`. Proxmox is untouched either way.

## For maintainers: releases and signing

A tag like `v0.1.0` runs `.github/workflows/release.yml`. It builds and tests (including `deploy/test/run.sh`, the installer's tests on simulated hosts, and a real engine install from the lockfile), then publishes:

- the GitHub release: `epaperclip.tar.gz`, its checksum, the signed manifest and signature (`epaperclip.manifest.json`, `epaperclip.manifest.sig`), `get.sh` and `epaperclip_<version>_all.deb`. A tag with a hyphen is marked as a pre-release; the build fails for any tag if the `RELEASE_SIGNING_KEY` secret is missing. See [RELEASING.md](RELEASING.md).
- the APT repository: `scripts/publish-apt.sh` signs it and uploads it to the Cloudflare R2 bucket `epaperclip-updates` under `apt/`, served at `https://updates.papercliped.co/apt` (the bucket's custom domain). It needs the secrets `R2_ENDPOINT`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` (an R2 token limited to that bucket, Object Read & Write) and `APT_SIGNING_KEY` (and `APT_SIGNING_PASSPHRASE` if the key has one). It signs only with the key whose public half is in `deploy/apt/epaperclip-archive-keyring.asc`, and skips with a notice when the secret isn't set.
- the npm package `epaperclip` (`npm/epaperclip`), over npm Trusted Publishing (OIDC, with provenance; no token is stored). A failure there never fails the release, because the GitHub release is the artifact.

To replace the signing key (it expires 2029-10-11; see `deploy/apt/README.md`), on a trusted machine:

```sh
gpg --quick-gen-key "ePaperclip Releases <releases@papercliped.co>" ed25519 sign 3y
gpg --armor --export <FINGERPRINT> > deploy/apt/epaperclip-archive-keyring.asc     # commit this, update the fingerprint here
gpg --armor --export-secret-keys <FINGERPRINT>                                        # paste into the APT_SIGNING_KEY secret, never commit it
```

Users then need the new keyring file. Announce it before the old key expires.

To change the engine version, edit `engine/package.json`, then regenerate the lockfile with the installer's Node.js version: `node scripts/engine-lock.mjs --fresh`. It also checks that `npm ci` accepts the result.
