# V1 clean install on a fresh Proxmox host

This is the clean-host path for the V1 candidate. It is intentionally short: install Proxmox, give the
sandbox an isolated network, install ePaperclip from a pinned commit, sign in with a Proxmox account.

**Status:** clean candidate, not a signed final release. A signed V1 still needs the beta branch merged
to `main`, a tag, the release signing key, and the worker/Pin gates in `errors/`. Do not label an
unsigned build “V1 final”.

## 1. Fresh Proxmox

Install Proxmox VE 9.x on the host. Do not configure the host's own web interface or network beyond
what the installer does. Root shell only.

## 2. Isolated sandbox network (once)

Agent Containers refuse the management bridge by default. Create the isolated bridge, DHCP and NAT:

```sh
SHA=40777ae3be31724abcdbd1b16afc463ad396e99f
curl -fsSL "https://raw.githubusercontent.com/OpenSourcx/papercliped-engine/$SHA/deploy/isolated-bridge.sh" | bash
```

It creates `vmbr1` with `10.77.0.1/24`, DHCP `10.77.0.100-250`, and NAT via the default route. It does
not touch `vmbr0` or Proxmox's own UI. Override the names/ranges with `EPC_SANDBOX_*` environment
variables if needed.

Verify:

```sh
ip -brief addr show vmbr1
systemctl is-active dnsmasq
```

## 3. Install ePaperclip from the pinned candidate

```sh
SHA=40777ae3be31724abcdbd1b16afc463ad396e99f
curl -fsSL "https://raw.githubusercontent.com/OpenSourcx/papercliped-engine/$SHA/deploy/from-source.sh" | EPC_COMMIT="$SHA" bash
```

This builds on the host with the installer's pinned Node.js, installs the host service and engine, and
rolls back if the services do not come up. It is a source install, not a signed release.

Verify:

```sh
epaperclip status
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1/
```

Open `https://<host>/`, sign in with a Proxmox account, create an organization.

## 4. Agent Containers

In the console, run the guided Agent Containers setup. It should detect:

- storage: the host's real storage (`local-lvm` if present; `dir` otherwise),
- bridge: `vmbr1` from step 2,
- template: built from the host's architecture.

On `dir` storage the first sandbox is a full clone; later leases reuse the stopped sandbox. On
thin/SSD storage Proxmox linked-clones the template.

## 5. Worker (optional, another machine)

On the AI box:

```sh
npm install -g epaperclip-worker
epaperclip-worker setup
```

Choose **Let Pin set it up** or **Guide me**. Pair with a code from Workers. Pin shows the real specs
and a fitting model. Until the privileged helper is installed, Pin shows the exact command to run.

## 6. What is still not final

- Signed V1 release and tag (the clean install above is pinned source, not a signed artifact).
- Privileged worker helper for Pin-managed Ollama/model install.
- ACP/native runner execution on the worker.
- A real worker run and cancellation observed on a non-pve machine.
- The V1 blocker list in `papercliped-docs/errors`.

Freeze RC churn: after this candidate, only V1 blockers get changes; no more “prerequisite” release
candidate updates.
