# Roadmap

Each phase ends with something that runs on a real Proxmox host.

## Road to 1.0 (planned 2026-10-31)

`v1.0.0-rc23` runs on the first host. 1.0.0 is the first release every device on the default channel is offered, so it waits
until each milestone below has shipped as release candidates and soaked. Dates are targets, not promises.

| When | Milestone | What ships | Release |
| --- | --- | --- | --- |
| Nov 2–8 | Distribution on our domain | Update feed and APT repository on Cloudflare R2 at `updates.papercliped.co` instead of GitHub Pages; an expiry in the signed feed, so a device rejects an old copy that would hide a withdrawal; console fixes (whole characters to the browser, a prompt stop that doesn't wait 90 s on open consoles) | rc24 |
| Nov 9–22 | Console and context, part 1 | Multi-shell console: tabs, splits, working window controls. Context phase 0 (the Projects rename) and phase 1 (the context store), `docs/CONTEXT.md` | rc25–26 |
| Nov 23 – Dec 6 | Agents share context | Context phase 2 (agent bridge, managed instructions block, TLS listener) and phases 3–4 (outputs, Pin). Private interactive shells per container | rc27–28 |
| Dec 7–13 | Prove the installer | Clean Proxmox 8 and 9 hosts: single node, cluster, ZFS and LVM. QA pass; no screen left on demo data | rc29 |
| Dec 14–31 | Freeze and soak | 1.0 release candidate, fixes only, on two hosts for two weeks | rc30+ |
| Dec 7 – Jan 4 | Site | An ePaperclip page on `papercliped.co` (what it is, the install line, screenshots, signing and security, docs), ready but unpublished | — |
| Week of Jan 4, 2027 | **1.0.0** | Tag `v1.0.0`: APT repository, npm `latest`, offered to every device; the site page goes live the same day | 1.0.0 |

## Phase 1: the host core (in progress)

- [x] Proxmox API client
- [x] Host broker: resource groups, Pin system scope, protected guests, lease expiry, audit log, HTTP API
- [x] Automations engine: rule schema, validation, plain-language read-back, Assistant and Agent modes
- [ ] Run the broker against a real host with a scoped token and one resource group
- [x] Automation runner: runs on the host service, acts through each automation's own Proxmox token, executes or queues proposals by Pin's mode, keeps run history, bounded retries, pauses itself after repeated failure (`docs/PIN.md`)
- [x] Notifications store and API (task finished, backup failed, device events, approvals, automation results, proposals, update notices) with a quiet inbox and per-person preferences

## Phase 2: ePaperclip

- [x] Engine decision: run the published, pinned `paperclipai` package unmodified (no fork to carry), behind the host service with managed per-user accounts; see `docs/ENGINE.md`
- [x] Install the engine as a locked-down loopback service (private Node, lockfile, secrets generated at install): `epaperclip-engine.service`, `npm ci --ignore-scripts` from `engine/package-lock.json`, test-started as its own user, database copied before an engine upgrade
- [ ] Host service: vault, managed engine accounts, `/engine/api` and events WebSocket proxy
- [ ] Container-session engine: a Paperclip sandbox provider that leases containers from the broker in the company's resource group
- [ ] Resource groups in the company model: creating a company creates its pool, range, tag and limits through the broker; "let Pin decide" sizing
- [x] Connector access per connector: Pin and/or chosen organizations; keys handed to the engine per organization; subscription sign-in inside agent containers (`docs/CONNECTORS.md`; the engine-facing parts are unchecked against a real engine)
- [ ] Company memory options when creating a company manually

## Papercliped, native (v1)

- [x] Connected apps page on demo data: device MCP address and per-app setup steps, the API only / Full / Agent only switch, sessions with Read only or Full control, organization and agent limits capped by the owning user, activity
- [x] Read-only MCP endpoint on the host service (`POST /api/mcp`, Bearer ePaperclip API tokens, Pin's read tools, Proxmox decides what each token sees): the part of the bridge that is small and safe to ship now
- [x] Papercliped bridge on the device: MCP at `/mcp`, OAuth 2.1 authorization code with PKCE and dynamic client registration, consent and revoke screens, Read only and Full control, host changes as plans by default, audit trail and rate limits (`docs/CONNECTORS.md`). The plan below is what was built; direct power tools exist behind a per-app opt-in.
- [x] Papercliped bridge, the exact plan (built):
  1. OAuth 2.1 authorization server on the host service for MCP clients (authorization code with PKCE, dynamic client registration, consent screen in the console), issuing the same kind of credential as an ePaperclip API token: a real Proxmox API token of the signed-in person, so Proxmox keeps deciding. Scopes are exactly two: Read only (`paperclip:read`) and Full control (`paperclip:control`).
  2. Serve MCP at `/mcp` (today `/api/mcp`, kept as an alias) with the Papercliped tool set; Read only gets the tools `/api/mcp` has now, Full control adds the engine tools through `/engine/api` as the person's managed engine account.
  3. Host-changing tools (power, snapshot) are never run by the bridge directly: they create an Agent mode plan, so a person still approves each step in the console (`docs/PIN.md`). Full control sessions whose user allows it may be given direct power tools later, behind the session limits below.
  4. Revoke from Connected apps (the Proxmox token is deleted), audit every call in the existing audit trail, rate-limit per credential.
- [ ] Session limits by organization, and host tools for Full control sessions whose user allows them
- [ ] Remote access setup for web apps (Tailscale or tunnel connector): claude.ai and ChatGPT need an https address they can reach
- [ ] Wire this device's MCP endpoint in as a tool source for agents through the engine's tool connections

## Phase 3: Pin

- [x] Pin runtime: Assistant and Agent modes, schedules and condition triggers, Agent mode plans approved step by step with typed confirmation and an audit trail (`docs/PIN.md`)
- [x] `SOUL.md` and `MEMORY.md`, editable on Pin's page (stored in the browser until the runtime lands)
- [ ] System skills: guests, storage, network, backups, companies, connectors
- [ ] Natural language to automation rules, confirmed with the plain-language read-back before saving
- [ ] Creating companies on request
- [x] Update awareness: installed vs latest ePaperclip from the public release feed (no telemetry, read by the host only), notify, guided update and rollback through the installer's staged install
- [ ] Update awareness for Proxmox packages and the pinned Paperclip engine version (the engine moves with ePaperclip releases today; Proxmox packages have their own Updates screen)

## Phase 4: the console

- [x] One UI on demo data: Paperclip's style reorganized as a system manager, with home, org dashboards, guests, automations, updates
- [x] Onboarding: organization name, your name, Pin mode, first AI account, Pin's access, device name
- [x] Pin's floating island and the Ask Pin bar
- [x] Integrated Access Control screens: users mirrored as Proxmox users, per-user orgs, tools, connectors, policies
- [x] Design framework: theme presets and user overrides as tokens
- [x] Rail plus context sidebar: device navigation (machines, host tools) and Paperclip's organization navigation
- [x] Machine pages with power, snapshots, hardware and task log; interactive console and host shell on a demo transport
- [x] Organization pages: inbox, decisions, tasks, projects, goals, routines, agents, org chart, costs, activity, connectors, settings
- [x] Pin's quick actions: context-aware actions on hover (touch: in Pin's panel), replacing on-page toolbars
- [x] Usage graphs for machines and the node over Proxmox's timeframes; Summary and Resources pages
- [x] Interactive org chart: pan, zoom, collapse, drag to change reporting lines with loop protection
- [x] Broker usage-history endpoints (`/v1/stats`) and Proxmox client `rrddata` calls
- [x] Live consoles: the host service relays Proxmox's terminal proxy (containers, VM serial consoles, host shell) over a WebSocket, as the signed-in user, behind the same transport
- [x] Pin's own page: mode, what Pin may do, SOUL.md and MEMORY.md, automations, activity log, skills, full chat
- [ ] Paperclip pages still to come from the fork: chat, artifacts, workspaces, skills
- [x] Host service (`services/epaperclip`): Proxmox sign-in with two-factor, sessions, acting as the user, console serving with a strict CSP
- [x] Console on live data: host metrics, machines, power, usage graphs, every storage and the root file system, creating containers
- [x] Pin's island shows every suggestion for the page you're on: up to three in the row (actions first), the rest grouped under More
- [x] Installer and systemd unit for a Proxmox VE host (`deploy/`)
- [ ] Connect the console to the host broker and ePaperclip for organizations, agents and tasks (still demo data)
- [ ] IAC backend: create and update Proxmox users, roles and ACLs from ePaperclip users and policies
- [x] Store: one place for operating systems (newest installers resolved from each vendor's own checksum list and downloaded verified), ready-made container apps, driver disks and plugins; installed/update status, install to a chosen storage, "Create machine" from an installed item. Plugin installs (connectors, agent adapters, Pin skills) are saved on this device; their runtime arrives with the ePaperclip fork
- [x] Store plugins mirror Paperclip's built-in adapter types (enable/disable) with bundled, licensed logos and monogram fallbacks
- [x] Store: signed marketplace index (Ed25519, expiry, no rollback, strict entry formats, npm entries pinned by integrity hash), fetched only by the host service; publish and key scripts in `scripts/`, rotation documented in `marketplace/README.md`
- [x] Installer hardening: preflight checks, pinned and verified private Node.js, staged install with automatic rollback, `--status`/`--rollback`/`--uninstall`, release packaging and workflow, `get.sh` and `from-source.sh`
- [x] Installer tests on simulated hosts in CI (`deploy/test/run.sh`): install, upgrade, rollback, broken versions, services that won't start, preflight refusals, uninstall and purge, the .deb and the npm command, and a real engine install
- [x] Packages: `.deb` with a signed APT repository on Cloudflare R2 (`updates.papercliped.co`), the `epaperclip` npm package, all running the same installer
- [ ] Installer: test on clean Proxmox 8 and 9 hosts (single node, cluster, ZFS and LVM), publish the first release
- [ ] Marketplace: generate and pin the first-party signing key, create the public catalog repository, CI publish job; install npm entries through Paperclip's adapter and plugin APIs once the runtime exists
- [ ] Store: remove an installed ISO or template from the Store, and update plugins from a published index
- [x] Storage content: browse ISO images, CT templates, backups and disks per storage; delete with confirmation
- [x] Proxmox's template catalog (system and TurnKey) with one-click download; ISO and template upload with progress; download from URL with checksum
- [x] Task log with each task's output; Pin notifies when downloads, uploads and creates finish
- [x] Virtual machines from an ISO, with Proxmox's wizard defaults per OS type (Windows 11 gets UEFI, Secure Boot keys and TPM 2.0)
- [x] Backups: schedules (create, edit, enable, delete), back up now, restore as a new machine or over the original, a Backups tab on every machine
- [x] Network: bridges, VLANs and bonds, staged with a diff, applied or reverted, with a guard on the interface carrying the gateway
- [x] Graphical VM consoles in the browser (noVNC through a one-time, session-bound relay), with Ctrl+Alt+Del, fit and full screen
- [x] Machine hardware editing: cores, sockets, memory, swap, growing disks, adding and editing network devices (MAC kept), name, tags, notes, start at boot
- [x] Snapshots (take, with memory for VMs, roll back, delete) and full clones on live machines
- [x] Firewall at every level (device, host, machine): rules with order and switches, security groups, aliases, IP sets, options and the log, with a guard that keeps this console's port reachable
- [x] DNS and the hosts file (digest-checked), and SDN virtual networks (zones, VNets, subnets with DHCP and SNAT), staged until applied
- [x] Machine actions: delete (name typed; refused while running or protected; purged from backup schedules), convert to template (linked clones from templates), reset, protection switch
- [x] Machine options: start order and delays, boot order, QEMU guest agent, OS type; Proxmox's real task history per machine
- [ ] Disk management (add, detach, move, change the CD), container DNS and features, Cloud-Init, replication, per-machine permissions
- [ ] Users and permissions (the IAC sync backend), certificates, disks and ZFS, HA and replication
- [x] Serve the console on the host (port 443), with the stock Proxmox UI kept on 8006 as the emergency console

## Phase 5: the system

- [ ] Installer ISO on top of upstream Proxmox VE packages, with our own name and branding (the APT repository for ePaperclip itself exists)
- [ ] Vault root key, unlock and recovery
- [ ] Kill switch and emergency console documentation

## v2 goals (deferred on purpose; v1 is the main engine working and the UI correct)

- Machine page: AMD SEV and Intel TDX options; OCI image pull; whole-OVA or ESXi import.
- Single-file restore from a backup (needs a binary-capable download in the shared Proxmox client).
- SPICE viewer handoff polish and Open vSwitch interfaces.
- ZFS maintenance (scrub, trim, replace) and Ceph install through the API where Proxmox gains one; until then guided commands.
- GlusterFS storage, if it returns to Proxmox's API.
- Per-machine "backup jobs covering this machine" card; a screen for experimental volume copy; browser file picker for import upload; WireGuard SDN fabrics.
