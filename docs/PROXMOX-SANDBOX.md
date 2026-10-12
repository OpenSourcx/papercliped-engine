# The Proxmox sandbox provider

`plugins/proxmox-sandbox` is a Paperclip plugin that runs Paperclip's agents inside Proxmox VE LXC containers instead of on the host. It is a standard sandbox provider (driver key `proxmox`), so the engine stays unmodified: it is installed like any other plugin and selected per environment.

Checked against `paperclipai@2026.1005.0` and `@paperclipai/plugin-sdk@2026.1005.0`, and installed into a running engine of that version (see [Verification](#verification)).

## What it does

For every agent run, Paperclip asks the provider for a lease. The provider:

1. picks the next free vmid (`GET /cluster/nextid`),
2. makes a **full clone** of the configured LXC template into the configured **pool** (or creates a container from a CT template volid), tags it `epaperclip;company-<companyId>;run-<runId>`, and sets cores, memory, disk and `net0` (`name=eth0,bridge=<bridge>,ip=dhcp`),
3. starts it, waits for it to run, and reads its IPv4 address (`GET /nodes/<node>/lxc/<vmid>/interfaces`, falling back to a static `ip=` in the config),
4. waits for SSH with backoff, records the container's SSH host key, detects the home directory and `bash`, and creates the workspace,
5. returns the lease `<node>/<vmid>` with `{ vmid, node, ip, remoteCwd, shellCommand, knownHosts, ... }`.

Every command Paperclip runs is then one `ssh` call into the container. When the run ends, the container is shut down and deleted (`purge=1&destroy-unreferenced-disks=1`). With `reuseLease` on, the container keeps running and Paperclip resumes it for the next run of the same agent and workspace; a resume starts it again if it was stopped, and reports it as expired if it is gone.

| Hook | Behaviour |
| --- | --- |
| validate | Shape checks, CA and SSH key sanity (public key pasted, PuTTY file, truncated PEM, passphrase), refuses privileged containers unless `allowPrivileged` |
| probe | `GET /version`, node status, template exists and is safe (unprivileged, no host bind mounts, no device passthrough, no raw `lxc.*`), pool exists, storage active. Creates nothing |
| acquire | Clone or create, configure, start, address, SSH, workspace. Anything that fails after the container exists deletes it again |
| resume | Running: reuse. Stopped: start. Gone, or the vmid now belongs to something else: `{ providerLeaseId: null, metadata: { expired: true } }` |
| realize workspace | `mkdir -p` over SSH, returns the cwd |
| execute | `ssh -T` with BatchMode, the container's recorded host key, a temporary 0600 key file that is removed afterwards, env and cwd in a quoted `sh -c` wrapper, stdin, timeout, output streamed to the run log |
| release | Shut down and delete, returns a `destroyed` receipt. Keeps the container when `reuseLease` is on. `resourceDisposition: "stop_and_retain"` stops and keeps it |
| stop | Shuts down and keeps the container and its files; throws if the stop cannot be confirmed, never deletes |
| destroy | Always deletes; a container that is already gone is success |

The driver declares `sandboxCapabilities.reusableLeases: true` (resume, release and destroy are all implemented as `SANDBOX_PROVIDER_CAPABILITIES.md` requires) and `defaultAcquireTimeoutMs: 300000`. It does not implement the native file-sync hooks, so Paperclip uses its base64-over-exec transfer.

Paperclip's **Test** button on a saved sandbox environment does a real acquire and release, so it creates and deletes one container. The probe of an unsaved draft only runs the provider's probe hook and creates nothing.

## Security model

The boundary Paperclip relies on is that agent code inside the sandbox cannot reach host files, host credentials or the provider's control plane (`SANDBOX-REQUIREMENTS.md`). On Proxmox that comes from:

- **Unprivileged containers.** Root in the container is an unprivileged uid on the host. Privileged containers are refused at validation, at probe and at acquire (the template is checked before cloning, since clones inherit it). `allowPrivileged` exists for operators who knowingly accept the risk; the API token below cannot create privileged containers anyway (that needs `Sys.Modify` on `/`).
- **No host mounts.** The provider never adds mount points, and refuses a template with a host bind mount (`mpN: /host/path,...`), a passed-through device (`devN`) or raw `lxc.*` settings.
- **A token that can only touch the pool.** The engine's API token is privilege-separated and has rights only on the agents' pool, on the template (clone and read only), on one storage and on one bridge. It cannot see or change any other guest, the host or the cluster configuration.
- **Ownership checks.** The provider only stops or deletes containers that carry its `epaperclip` tag and the run's `company-<id>` tag, and never deletes a template. A vmid that was reused by someone else after our container was deleted is reported as gone, not touched.
- **No secrets in the container.** The SSH private key stays on the engine host (written to a 0600 file for each connection and removed afterwards); only its public half is in the container. The API token never leaves the engine.
- **TLS.** The Proxmox certificate is verified against `caCert` (the cluster CA, `/etc/pve/pve-root-ca.pem`) or the system trust store. Verification is only skipped when `allowInsecureTls` is set explicitly and no `caCert` is given.

### SSH host keys: trust on first use

There is no Proxmox API to read a container's SSH host key, so the provider learns it on the first connection after it created the container (`StrictHostKeyChecking=accept-new` into an empty per-container known_hosts), stores it in the lease metadata, and from then on connects with `StrictHostKeyChecking=yes` under a `HostKeyAlias` tied to `<node>/<vmid>`. A changed key is refused, and an address change after a restart does not matter.

The trade-off: something that answers on the container's address in the seconds between DHCP and the first connection could present its own key. That requires an attacker already on the bridge network. The template builder makes every clone generate its own host keys on first boot, so one container's key never vouches for another. If that window is unacceptable, put the agents' bridge on a network that only the Proxmox host and the containers can reach.

### Internet access

The provider does not restrict the containers' network. Agents need to reach their model APIs and package registries; anything stricter (Proxmox firewall rules on the pool, a separate bridge or VLAN with egress filtering) is the operator's policy, as Paperclip's sandbox contract says.

## Setting up Proxmox

All commands run on the Proxmox host as root. Replace `pve` with your node name, `local-lvm` with the storage for container disks and `vmbr0` with the bridge.

### 1. Pool, user, roles and token

```sh
# The pool the agents' containers go into.
pveum pool add epaperclip-agents --comment "ePaperclip agent containers"

# A user for the engine. It never logs in; it only owns the token.
pveum user add epaperclip-engine@pve --comment "ePaperclip engine (sandbox provider)"

# Roles with only what the provider uses. Role names may not start with "PVE".
pveum role add EPaperclipSandbox --privs "VM.Allocate VM.Audit VM.Config.CPU VM.Config.Memory VM.Config.Disk VM.Config.Network VM.Config.Options VM.PowerMgmt Pool.Audit"
pveum role add EPaperclipTemplate --privs "VM.Clone VM.Audit"
pveum role add EPaperclipStorage --privs "Datastore.AllocateSpace Datastore.Audit"
pveum role add EPaperclipNetwork --privs "SDN.Use"
pveum role add EPaperclipNodeAudit --privs "Sys.Audit"

# The token, privilege-separated: it gets only the ACLs below, and never more than the user.
pveum user token add epaperclip-engine@pve sandbox --privsep 1 --comment "ePaperclip sandbox provider"
```

`pveum user token add` prints the secret once. Keep the full value `epaperclip-engine@pve!sandbox=<secret>`.

What each privilege is for:

| Privilege | Used for |
| --- | --- |
| `VM.Allocate` (pool) | Creating containers in the pool (clone target or create), deleting them |
| `VM.Config.CPU`, `VM.Config.Memory`, `VM.Config.Disk`, `VM.Config.Network`, `VM.Config.Options` (pool) | Cores, memory, root disk size, `net0`, tags and description |
| `VM.PowerMgmt` (pool) | Start, shutdown, stop |
| `VM.Audit` (pool, template) | Reading config, status and interfaces |
| `Pool.Audit` (pool) | The probe's pool check |
| `VM.Clone` (template) | Cloning the template |
| `Datastore.AllocateSpace`, `Datastore.Audit` (storage) | Container disks; reading the CT template volume when creating from a volid |
| `SDN.Use` (bridge) | Attaching `net0` to the bridge (Proxmox VE 8 and later) |
| `Sys.Audit` (node) | The probe's node status, and reading task status and logs if your Proxmox version does not treat the token as the owner of its own tasks |

### 2. ACLs

A privilege-separated token's rights are the intersection of the user's and the token's, so grant each path to both.

```sh
for who in "--users epaperclip-engine@pve" "--tokens epaperclip-engine@pve!sandbox"; do
  pveum acl modify /pool/epaperclip-agents --roles EPaperclipSandbox $who
  pveum acl modify /vms/9000 --roles EPaperclipTemplate $who
  pveum acl modify /storage/local-lvm --roles EPaperclipStorage $who
  pveum acl modify /sdn/zones/localnetwork/vmbr0 --roles EPaperclipNetwork $who
  pveum acl modify /nodes/pve --roles EPaperclipNodeAudit $who
done
# Only when creating from a CT template volid instead of cloning:
#   pveum acl modify /storage/local --roles EPaperclipStorage --users ... / --tokens ...
```

Keep the template **out of** `epaperclip-agents`: the token has `VM.Allocate` on the pool, so a template in the pool could be changed or deleted by it. The template gets only `VM.Clone` and `VM.Audit`.

### 3. SSH key and template

```sh
ssh-keygen -t ed25519 -N '' -C epaperclip-engine -f ./epaperclip_engine_key
./plugins/proxmox-sandbox/template/build-template.sh --vmid 9000 --storage local-lvm --bridge vmbr0 \
  --ssh-public-key ./epaperclip_engine_key.pub
```

`build-template.sh` (Debian 12 by default, `--debian 13` for trixie) downloads the Debian standard CT template with `pveam`, creates an unprivileged container with `nesting=1` (systemd in current Debian needs it), installs openssh-server, git, tar, curl, ca-certificates, Node.js 24.21.0 from nodejs.org (SHA-256 checked against the pinned value from `SHASUMS256.txt`) and the agent CLIs `@anthropic-ai/claude-code` and `@openai/codex` from npm, creates an `agent` user with a writable home, authorizes the key for `root` and `agent`, sets sshd to key-only logins with no forwarding, makes each clone generate its own SSH host keys and machine id on first boot, cleans up and converts the container to a template. Running it again leaves an existing template alone (`--rebuild` replaces it). Run it with `--help` for all options.

Cloned containers get SSH keys only from the template (Proxmox has no way to inject keys into a clone), so the template must trust the engine's public key. When `template` is a volid instead, the provider passes the public key derived from `sshPrivateKey` as `ssh-public-keys` at create time, but that container has no Node.js or agent CLIs unless the CT template already contains them.

## Installing the plugin into the engine

The plugin is a standalone package (like Paperclip's own sandbox providers it is not part of the root pnpm workspace, so it does not touch the lockfile). Build it on the engine host:

```sh
cd plugins/proxmox-sandbox
npm ci
npm run build          # writes dist/manifest.js and dist/worker.js
npm prune --omit=dev   # keep only @paperclipai/plugin-sdk for the worker
```

Install it as the engine's instance admin, either with the CLI:

```sh
npx paperclipai plugin install --local /opt/epaperclip/plugins/proxmox-sandbox --api-base http://127.0.0.1:3100
```

or through the API (`isLocalPath` paths must be readable by the engine's service user):

```http
POST /api/plugins/install
{ "packageName": "/opt/epaperclip/plugins/proxmox-sandbox", "isLocalPath": true }
```

The answer is the plugin record; `status` should be `ready` (`epaperclip.proxmox-sandbox-provider`). The engine runs the worker as a child process of its own service user, so that user needs the `ssh` client on its PATH.

## Creating the environment

```http
POST /api/companies/:companyId/environments
{
  "name": "Proxmox LXC",
  "driver": "sandbox",
  "config": {
    "provider": "proxmox",
    "apiUrl": "https://127.0.0.1:8006",
    "node": "pve",
    "apiTokenSecret": "epaperclip-engine@pve!sandbox=<secret>",
    "caCert": "<contents of /etc/pve/pve-root-ca.pem>",
    "template": "9000",
    "pool": "epaperclip-agents",
    "storage": "local-lvm",
    "sshPrivateKey": "<contents of epaperclip_engine_key>",
    "sshUser": "agent"
  }
}
```

Environment names are unique per instance. `apiTokenSecret` and `sshPrivateKey` are `secret-ref` fields: Paperclip stores pasted values as company secrets and keeps only their ids in the config.

**Paste the token as `user@realm!name=<secret>`.** Proxmox token secrets are UUIDs, and Paperclip reads a bare UUID in a `secret-ref` field as the id of an already saved secret (the request fails with "Secret referenced at apiTokenSecret was not found"). The full form is not a UUID, so it is stored as a new secret, and the provider splits it (`apiTokenId` may then be left out; if it is given it must match). A secret saved beforehand and picked in the UI works too.

| Field | Default | |
| --- | --- | --- |
| `apiUrl` | `https://127.0.0.1:8006` | Proxmox API (must be https) |
| `node` | | Node that runs the containers |
| `apiTokenId` | | `user@realm!name`; optional when `apiTokenSecret` has the full form |
| `apiTokenSecret` | | Secret, or `user@realm!name=<secret>` |
| `caCert` | | PEM CA; empty means the system trust store |
| `allowInsecureTls` | `false` | Skip certificate checks when no `caCert` (avoid) |
| `template` | | Template vmid to clone, or `storage:vztmpl/<file>` to create from |
| `pool` | | Pool for the containers (required) |
| `storage` | | Disk storage; required for a volid, optional for clones |
| `bridge` | `vmbr0` | Bridge for `net0` (DHCP) |
| `cores`, `memoryMb`, `diskGb` | 2, 2048, template size (16 for a volid) | Disk is grown on clones, never shrunk |
| `unprivileged` | `true` | Privileged needs `allowPrivileged: true` |
| `sshPrivateKey` | | Engine's key, no passphrase |
| `sshUser`, `sshPort` | `root`, 22 | `agent` runs the agents unprivileged inside the container |
| `namePrefix` | `epaperclip` | Hostnames are `<prefix>-<vmid>` |
| `reuseLease` | `false` | Keep a container per agent and workspace between runs |
| `timeoutMs` | 300000 | Budget for creating a container, and for commands that set none |

Test it with `POST /api/environments/:id/probe` (a real acquire and release) or `POST /api/companies/:companyId/environments/probe-config` with a draft config (checks only).

## Using it for agents

Set an agent's default environment when creating or updating it:

```http
PATCH /api/agents/:agentId
{ "defaultEnvironmentId": "<environment id>" }
```

or make it the instance default for everyone (`PATCH /api/instance/settings { "defaultEnvironmentId": "<environment id>" }`). `GET /api/companies/:companyId/environments/capabilities` lists which adapters support the `proxmox` provider (the local CLI adapters such as `claude_local`, `codex_local` and `gemini_local` do; `process` and `http` do not).

Agent credentials go in as adapter environment variables backed by Paperclip secrets (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or the CLIs' OAuth tokens), which Paperclip passes to each command over SSH.

## Limits and known gaps

- **No device login yet.** The provider does not implement Paperclip's login pseudo-terminal hooks, so subscription sign-in for Claude and Codex (the device-login flow) is not available in these containers. Use API keys or OAuth tokens stored as secrets.
- **File sync is the generic fallback.** Without native sync hooks, workspaces move in base64 chunks over `execute`, which is slow for large repositories.
- **No interactive setup or template capture.** Templates are built with `build-template.sh`, not from the Paperclip UI.
- **IPv4 over DHCP.** The bridge needs a DHCP server; static addressing only works through the template's own `net0` (`ip=`), which every clone would share.
- **Trust on first use** for SSH host keys (above).
- **No provider-side expiry.** Paperclip's `requestedExpiresAt` cannot be enforced by Proxmox, so the provider returns no expiry and Paperclip fails closed for callers that need one.
- **One node.** Containers are created on the configured node; there is no placement across a cluster.
- **Reused containers keep running** until Paperclip destroys them; they hold their memory while idle.
- The engine logs the body of rejected API requests, which can include pasted secrets; prefer saving secrets first and referencing them.

## Verification

- `npm test` in `plugins/proxmox-sandbox`: unit and lifecycle tests against a fake Proxmox API served over HTTPS with a self-signed certificate generated by openssl at test time (it refuses chunked bodies and wrong tokens like pveproxy), a local shell standing in for SSH, Paperclip's own environment test harness (`@paperclipai/plugin-sdk/testing`), and an end-to-end test over a real OpenSSH server on a spare port (skipped where `sshd` is missing).
- Installed into a throwaway `paperclipai@2026.1005.0` engine (run as an unprivileged user, own `PAPERCLIP_HOME`) with `paperclipai plugin install --local`: the plugin reached `ready`, validation refused a privileged config through the API, a draft probe reported a bad token, and the saved environment's probe ran a full acquire (clone, start, address, SSH as the engine's user against a real sshd, host key recorded, workspace) and release (shutdown, delete) against the fake Proxmox API.
- Not verified against a real Proxmox VE host: the API calls follow the published API schema (`pve-docs/api-viewer`), and `build-template.sh` passes `bash -n` and ShellCheck but has not been run.
