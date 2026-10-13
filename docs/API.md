# Automating ePaperclip

Everything the console does goes through the host service's HTTP API, as the signed-in person, so Proxmox's own permissions decide. For scripts, cron jobs and other services there is a long-lived credential: an **ePaperclip API token**.

## Create a token

Console: **Access control > API tokens > New API token**. Choose:

| Setting | Meaning |
| --- | --- |
| Name | What it is for. Shown in the list and the audit trail. |
| Expires | 1 to 366 days (default 90). Tokens always expire. |
| Read-only | The token can only make `GET` and `HEAD` requests. Everything else answers 403 `read_only_token`. |
| Separate privileges | The token starts with no Proxmox permissions; give it some on **Roles & permissions** (for the Proxmox token `user@realm!epc-<id>`). Off means it acts as you, with all of your permissions. |

The token (`epc_<id>_<secret>`) is shown **once**. Copy it then; a lost token can't be shown again, only revoked and replaced. Over the API:

```sh
# Sign in as a person (cookie session) and create a token. Only a browser-style session can create or revoke tokens.
curl -sS -c jar.txt -H 'Content-Type: application/json' -H 'X-EPC-Request: 1' \
  -d '{"username":"sam","password":"…","realm":"pve"}' https://pve.lan/api/login
curl -sS -b jar.txt -H 'Content-Type: application/json' -H 'X-EPC-Request: 1' \
  -d '{"name":"nightly report","expiresInDays":30,"readOnly":true}' https://pve.lan/api/access/epc-tokens
# => {"token":"epc_3fa9…_…","record":{…},"proxmoxTokenId":"sam@pve!epc-3fa9…","note":"…"}
```

## Call routes

Send the token as a Bearer credential. No cookie, no `X-EPC-Request` header and no `Origin` are needed (a token has no browser), and tokens are never accepted from cookies, query strings or WebSockets.

```sh
export EPC=epc_3fa9c1d2e4b5a678_…            # keep it in a secret store, not in a script
curl -sS -H "Authorization: Bearer $EPC" https://pve.lan/api/me
curl -sS -H "Authorization: Bearer $EPC" https://pve.lan/api/host
curl -sS -H "Authorization: Bearer $EPC" https://pve.lan/api/tasks?limit=10

# Start a machine (needs a token that isn't read-only)
curl -sS -X POST -H "Authorization: Bearer $EPC" https://pve.lan/api/guests/101/power -H 'Content-Type: application/json' -d '{"action":"start"}'

# The engine, as your managed engine account (organizations, tasks, agents)
curl -sS -H "Authorization: Bearer $EPC" https://pve.lan/engine/api/companies
```

Errors are JSON, `{"error": "…", "code": "…"}`:

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `invalid_token` | Malformed, unknown or wrong token (always the same answer) |
| 401 | `token_expired` | The token has expired |
| 401 | `token_invalid` | Proxmox no longer accepts the token behind it (user disabled or removed, Proxmox token deleted) |
| 403 | `read_only_token` | A change was attempted with a read-only token |
| 403 | `forbidden` | Proxmox refused; the message names the missing privilege |
| 403 | `ticket_only` | The route needs a signed-in browser session (see below) |
| 429 | `rate_limited`, `too_many_attempts` | More than 600 requests a minute with one token, or 10 invalid tokens in 5 minutes from one address |

### What a token can't do

Proxmox itself doesn't allow API tokens to change a password or two-factor settings, and consoles are WebSockets tied to a browser session. These answer 403 `ticket_only`: opening a console (`POST /api/guests/:vmid/vnc`, the console sockets), changing a password, adding or removing two-factor entries. Tokens also can't create or revoke ePaperclip API tokens. Everything else works, including uploads.

## How it works (and why it is safe)

1. Creating a token creates a **real Proxmox API token** for you (`<user>!epc-<id>`, with the same expiry and your privilege-separation choice) by calling Proxmox as you. The host never stores a Proxmox password.
2. The Proxmox token's secret is sealed in the host's vault (AES-256-GCM, bound to the token's name). Your ePaperclip token's secret is **not stored at all**: only a salted SHA-256 hash, the metadata and the last-used time are kept in `state.json`.
3. A request with `Authorization: Bearer epc_…` is looked up by its public id, compared in constant time (an unknown id costs the same hashing work), checked for expiry, rate-limited, and then acts on Proxmox with `PVEAPIToken=…`. The mapped Proxmox token is re-checked at most once a minute and at once after the person is disabled, deleted or has their access removed, so a token dies with its person.
4. Revoking deletes the record and the sealed secret first (the token stops working that instant), then the Proxmox token. A token whose Proxmox token was deleted elsewhere stops working within a minute.
5. Engine access (`/engine/api/*`) uses the person's managed engine account, exactly as it does for a browser session, and obeys read-only tokens.

Audit trail: `GET /api/access/audit` (Proxmox administrators only) lists, newest first, token creation and revocation, every failed use (rate-limited to one entry per address per minute), and access-control changes. Secrets never appear in it or in any log.

## Route list

Every route needs a session cookie (plus `X-EPC-Request: 1` for changes) or a Bearer token. `GET` routes are read-only. Bodies and answers are JSON. The Proxmox API behind each is in [ACCESS.md](ACCESS.md).

### Session and tokens

| Method and path | Purpose |
| --- | --- |
| `POST /api/login`, `POST /api/login/tfa`, `POST /api/logout`, `GET /api/me`, `GET /api/realms` | Sign in and out (cookie sessions) |
| `GET /api/access/epc-tokens[?all=1]` | Your ePaperclip API tokens (`all=1` for administrators) |
| `POST /api/access/epc-tokens` `{name, expiresInDays?, readOnly?, privsep?}` | Create; the answer carries the token once |
| `DELETE /api/access/epc-tokens/:id` | Revoke (owner or administrator) |
| `GET /api/access/audit` | Audit trail (administrators) |

### Access control

| Method and path | Purpose |
| --- | --- |
| `GET /api/iac` | People, organizations, realms, groups, device roles |
| `POST /api/iac/users`, `PUT/DELETE /api/iac/users/:userid`, `PUT /api/iac/users/:userid/password` | Users |
| `PUT/DELETE /api/iac/orgs/:companyId/members/:userid` | Organization roles |
| `GET /api/access/users/:userid` | One user in detail (groups, expiry, tokens, two-factor) |
| `GET/POST /api/access/groups`, `GET/PUT/DELETE /api/access/groups/:id`, `GET /api/access/groups/:id/permissions` | Groups |
| `GET/POST /api/access/roles`, `PUT/DELETE /api/access/roles/:id` | Roles (built-ins are read-only; deleting a role in use needs `{removeAcls:true}`) |
| `GET /api/access/acl`, `POST /api/access/acl` `{path, roles[], users[]\|groups[]\|tokens[], propagate?, remove?}` | Permissions |
| `GET /api/access/permissions?userid=&path=` | Effective permissions |
| `GET /api/access/paths` | Paths to pick from |
| `GET/POST /api/access/users/:userid/tokens`, `PUT/DELETE …/tokens/:tokenid`, `PUT /api/access/users/:userid/tfa-unlock` | Proxmox API tokens (the secret is returned once) |
| `GET /api/access/tfa`, `GET/POST /api/access/tfa/:userid`, `PUT/DELETE /api/access/tfa/:userid/:id` | Two-factor (browser session only for changes) |
| `GET/POST /api/access/realms`, `PUT/DELETE /api/access/realms/:realm`, `POST /api/access/realms/:realm/sync` | Realms; sync answers `{task}` and the log is at `GET /api/tasks/:upid` |
| `GET/POST /api/access/pools`, `PUT/DELETE /api/access/pools/:poolid` | Resource groups (Proxmox pools) |

### Machines, storage, tasks

`GET /api/host`, `GET /api/stats/node`, `GET /api/stats/guests/:vmid`, `GET /api/machines/options`, `POST /api/vms`, `POST /api/guests/:vmid/power`, `GET /api/tasks`, `GET /api/tasks/:upid`, and the guests, storage, network, firewall and backup routes the console uses. The console's network tab in a browser's developer tools shows the exact calls for any screen.

### Engine

`/engine/api/*` forwards to the engine as your managed engine account. The same rules apply: changes from a cookie session need `X-EPC-Request` and a same-site `Origin`; a Bearer token needs neither.
