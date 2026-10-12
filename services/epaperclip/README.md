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
| `EPC_STATE_DIR` | `/var/lib/epaperclip` (state and vault; must be writable, the service won't start without it) |
| `EPC_ENGINE_URL` | `http://127.0.0.1:3100` |
| `EPC_ENGINE_PUBLIC_URL` | `EPC_ENGINE_URL` (the engine's `PAPERCLIP_PUBLIC_URL`, sent as `Origin` so its mutation guard accepts the request) |
| `EPC_ENGINE_DIR` | `/opt/epaperclip/engine` (read for the engine's version) |

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
| `GET /tasks`, `GET /tasks/:upid` | The task log (`?vmid=` for one machine) and one task's status and output |
| `GET /guests/:vmid/config`, `POST /guests/:vmid/config` | A machine's hardware; change cores, sockets, memory, swap, name, tags, notes, start at boot |
| `POST /guests/:vmid/destroy`, `POST /guests/:vmid/template` | Delete or convert to template; the body must carry the machine's name as `confirm`, and running or protected machines are refused |
| `POST /guests/:vmid/resize`, `POST /guests/:vmid/nets`, `POST /guests/:vmid/nets/:key/delete` | Grow a disk; add, edit (keeping the MAC) or remove a network device |
| `GET/POST /guests/:vmid/snapshots`, `POST .../snapshots/:name/rollback`, `.../delete` | Snapshots |
| `POST /guests/:vmid/clone` | Full clone (linked only from templates) |
| `POST /guests/:vmid/vnc`, WebSocket `/api/vnc/:id` | A VM's screen: one-time, session-bound VNC relay |
| WebSocket `/api/console/guests/:vmid`, `/api/console/node` | Text consoles and the host shell |
| `GET/POST /firewall/:scope/{options,rules,aliases,ipsets,groups,macros,log,refs}` | Firewall at `datacenter`, `host`, `guest-<vmid>`, or `group-<name>` (rules only); `409 lockout` when a change would block this console |
| `GET/POST /network/dns`, `GET/POST /network/hosts` | DNS servers and search domain; the hosts file, checked against its digest |
| `GET /sdn`, `POST /sdn/{zones,vnets,apply}` and `/sdn/vnets/:id/subnets` | SDN zones, VNets and subnets, staged until applied |
| `GET /network`, `POST /network`, `POST /network/:iface`, `.../delete`, `POST /network/apply`, `POST /network/revert` | Host interfaces, staged changes and their diff |

### Engine, connectors and Pin

| Route | Does |
| --- | --- |
| `GET /engine/status` (that is, `/api/engine/status`) | `{ installed, reachable, ready, version, bootstrap: "pending" \| "ready", serviceAccount: "ours" \| "other" \| "pending" \| "error", error? }` |
| `/engine/api/*` (at the root, not under `/api`) | The engine's `/api/*`, as the signed-in person's managed engine account. Changes need `X-EPC-Request` and a same-site `Origin`. Bodies stream both ways (capped by `EPC_MAX_UPLOAD_GB`). Only `content-type`, `accept`, `accept-language`, `range`, `if-none-match`, `user-agent`, `x-paperclip-tab-visible` and `x-paperclip-route` go to the engine; browser cookies, `Authorization` and `x-paperclip-cloud-*` never do, and `Set-Cookie` never comes back. `/engine/api/auth/*`, `/engine/api/bootstrap/*` and `/engine/api/cli-auth/*` (except `GET cli-auth/me`) are refused. `503 engine_unavailable` when the engine doesn't answer |
| WebSocket `/engine/api/companies/:id/events/ws` | An organization's live events, relayed as the person (the query string is dropped) |
| `GET /resource-groups`, `PUT /resource-groups/:companyId`, `DELETE /resource-groups/:companyId` | An organization's Proxmox pool (`epc-<slug>`, created as the signed-in user) and limits `{ name, cores, memoryMb, diskGb, maxGuests }`. Changes need an owner or admin of the organization; delete removes the pool only if it is empty |
| `GET /connectors` | `{ connectors: [{ id, kind, label, configured, last4?, updatedAt?, updatedBy?, testedAt?, ok?, error? }], canManage }`. Never a key |
| `PUT /connectors/:id/credential` `{ apiKey }`, `DELETE /connectors/:id/credential`, `POST /connectors/:id/test` | Model provider keys (`anthropic`, `openai`, `gemini`, `openrouter`), for Proxmox users with `Sys.Modify` on `/` |
| `GET /pin/settings`, `PUT /pin/settings` | `{ provider, model, mode: "assistant" \| "agent", connectors }`, per person |
| `GET /pin/models?provider=` | `{ provider, models: [{ id, label }] }`, read from the provider with the stored key |
| `POST /pin/chat` `{ messages, context: { page, device, org? } }` | A server-sent event stream: `delta` `{ text }`, `tool` `{ id, name, args, status: "done" \| "error" \| "proposed" }`, `done`, `error` `{ code, message }`. Read-only tools run as the person; changes come back as `proposed` for the console to carry out after confirmation |

### Engine accounts and state

The engine (Paperclip) listens on loopback. On first start the service creates `system@epaperclip.invalid` and claims the engine's first-admin slot; if someone else already claimed it, `/api/engine/status` says so. Each Proxmox user gets a managed engine account, created at their first sign-in: the email is the user id lower-cased with `@` as `.`, anything outside `[a-z0-9._-]` as `-`, cut to 40 characters, then `-` and the first 8 hex digits of the SHA-256 of the exact user id, at `epaperclip.invalid` (`sam@pve` becomes `sam.pve-<8 hex>@epaperclip.invalid`). Passwords are random and live only in the vault.

`EPC_STATE_DIR` holds `vault.key` (0600, 32 random bytes) and `state.json` (0600, written atomically). Every secret in `state.json` (engine passwords, connector keys) is sealed with AES-256-GCM under its own IV, with its name bound in and the key id recorded for a later rotation.

## Develop

```sh
pnpm test && pnpm typecheck
EPC_DEV_HTTP=1 EPC_LISTEN=127.0.0.1:4190 EPC_STATIC=../../apps/console/dist EPC_PVE_URL=https://<host>:8006 EPC_PVE_CA=./pve-root-ca.pem node --experimental-strip-types src/main.ts
```
