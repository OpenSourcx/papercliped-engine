# epaperclip host service

Runs on the Proxmox VE host. It serves the console, signs people in with their Proxmox accounts, and calls the Proxmox API as the signed-in user, so Proxmox's own permissions decide what each person can see and do.

## Install

```sh
pnpm install && pnpm build    # from the repository root
sudo ./deploy/install.sh      # on the host
```

The installer puts the service in `/opt/epaperclip`, creates an `epaperclip` system user (in `www-data`, to read the node certificate the way `pveproxy` does), installs Node.js from Debian if needed, and starts `epaperclip.service` on port 443. Settings live in `/etc/default/epaperclip`:

| Variable | Default |
| --- | --- |
| `EPC_LISTEN` | `0.0.0.0:443` |
| `EPC_PVE_URL` | `https://127.0.0.1:8006` |
| `EPC_PVE_CA` | `/etc/pve/pve-root-ca.pem` |
| `EPC_PVE_NODE` | the hostname |
| `EPC_TLS_CERT` / `EPC_TLS_KEY` | `/etc/pve/local/pve-ssl.pem` / `.key` |
| `EPC_STATIC` | `/opt/epaperclip/console` |
| `EPC_MAX_UPLOAD_GB` | `64` |
| `EPC_DEV_HTTP` | unset; `1` serves plain HTTP for local development only |

If you replaced the node certificate (for example with ACME), point `EPC_TLS_CERT`/`EPC_TLS_KEY` at `/etc/pve/local/pveproxy-ssl.pem`/`.key`.

## API

All under `/api`. Changes need `Content-Type: application/json`, `X-EPC-Request: 1` and a same-site `Origin`.

| Route | Does |
| --- | --- |
| `GET /realms` | Sign-in realms |
| `POST /login`, `POST /login/tfa`, `POST /logout` | Sign in (with two-factor) and out |
| `GET /me` | The signed-in user |
| `GET /host` | Node status, guests and storage the user can see |
| `GET /stats/node`, `GET /stats/guests/:vmid` | Usage history (`timeframe`, `cf`) |
| `POST /guests/:vmid/power` | `start`, `shutdown`, `stop`, `reboot` |
| `GET /machines/options`, `POST /machines` | Templates, ISOs, storages and pools; create and start an unprivileged container |
| `POST /vms` | Create a VM booting an ISO, with Proxmox's wizard defaults for the OS type |
| `GET /storage/:id/content`, `POST /storage/:id/delete` | What a storage holds; delete one volume |
| `GET /templates/catalog`, `POST /templates/download` | Proxmox's template catalog and downloads from it |
| `POST /storage/:id/download-url` | Have Proxmox download an ISO or template from a URL, with an optional checksum |
| `POST /storage/:id/upload?content=&filename=` | Upload an ISO or template as `application/octet-stream`, streamed to Proxmox (capped by `EPC_MAX_UPLOAD_GB`) |
| `GET /tasks`, `GET /tasks/:upid` | The task log and one task's status and output |

## Develop

```sh
pnpm test && pnpm typecheck
EPC_DEV_HTTP=1 EPC_LISTEN=127.0.0.1:4190 EPC_STATIC=../../apps/console/dist EPC_PVE_URL=https://<host>:8006 EPC_PVE_CA=./pve-root-ca.pem node --experimental-strip-types src/main.ts
```
