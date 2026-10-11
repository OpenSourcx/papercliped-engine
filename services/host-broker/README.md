# Host broker

The only component that holds the Proxmox API token. Pin, ePaperclip and company agents call this service; none of them can reach Proxmox directly.

- **Company scope:** create, read and destroy containers inside the company's resource group (one pool, one vmid range, one tag), within its lease, core and memory limits. Leases expire and are reaped, even after a broker restart.
- **System scope (Pin):** read the host and every guest with its metrics, and start, stop, shut down, reboot or snapshot any guest. Protected guests and templates are refused. Nothing can destroy a guest outside a resource group.
- **Audit:** every call is appended to a JSONL log.

## 1. Create a scoped Proxmox user and token

Run on the Proxmox host as root. Adjust storage names (`local`, `drive2`), the bridge zone and pool names to your machine, and check each command against `pveum help` for your version.

```sh
# A dedicated user, never root or an Administrator.
pveum user add engine-broker@pve --comment "papercliped-engine host broker"

# What companies' containers need, granted only on their pools.
pveum role add EngineLeases --privs "VM.Allocate VM.Audit VM.Clone VM.Config.CPU VM.Config.Disk VM.Config.Memory VM.Config.Network VM.Config.Options VM.PowerMgmt VM.Snapshot"

# What Pin needs host-wide: read everything, power and snapshot guests. No VM.Allocate, so it cannot create or destroy outside pools.
pveum role add EngineSystem --privs "VM.Audit VM.PowerMgmt VM.Snapshot Sys.Audit"

# One pool per company resource group.
pveum pool add co-acme --comment "Company: Acme"
pveum acl modify /pool/co-acme --users engine-broker@pve --roles EngineLeases
pveum acl modify / --users engine-broker@pve --roles EngineSystem

# Storage for container disks and templates, and use of the bridge.
pveum acl modify /storage/local --users engine-broker@pve --roles PVEDatastoreUser
pveum acl modify /storage/drive2 --users engine-broker@pve --roles PVEDatastoreUser
pveum acl modify /sdn/zones/localnetwork --users engine-broker@pve --roles PVESDNUser

# The token inherits only this user's rights. Give it an expiry and rotate it.
pveum user token add engine-broker@pve engine --privsep 0 --expire $(date -d '+90 days' +%s)
```

Keep the token secret out of chat and out of the config file. The broker reads it from `PROXMOX_TOKEN_SECRET`.

If you have a backup job for "all guests", exclude the company pools, or every short-lived container will be backed up.

## 2. Configure

Copy `broker.example.json` to `/etc/papercliped/broker.json` and edit it. Callers are listed by the SHA-256 of their token:

```sh
openssl rand -base64 32 | tr -d '\n=' | tee pin.token | sha256sum
```

Give the token to the caller and put only the hash in the config.

## 3. Run

```sh
PROXMOX_TOKEN_SECRET=... node --experimental-strip-types src/main.ts /etc/papercliped/broker.json
```

It listens on `127.0.0.1:8787` by default. Keep it on loopback or a management network; container guests must not be able to reach it.

## API

| Method and path | Caller |
| --- | --- |
| `GET /v1/health` | anyone |
| `GET /v1/host` | Pin |
| `GET /v1/guests` | Pin |
| `POST /v1/guests/:vmid/actions` `{ "action": "shutdown" }` | Pin |
| `GET /v1/groups/:group/leases` | Pin, or that group |
| `POST /v1/groups/:group/leases` `{ "profile", "sshPublicKey", "runId", "requestedExpiresAt" }` | Pin, or that group |
| `GET /v1/groups/:group/leases/:id` | Pin, or that group |
| `DELETE /v1/groups/:group/leases/:id` | Pin, or that group |
