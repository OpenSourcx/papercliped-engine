# Roadmap

Each phase ends with something that runs on a real Proxmox host.

## Phase 1: the host core (in progress)

- [x] Proxmox API client
- [x] Host broker: resource groups, Pin system scope, protected guests, lease expiry, audit log, HTTP API
- [x] Automations engine: rule schema, validation, plain-language read-back, Assistant and Agent modes
- [ ] Run the broker against a real host with a scoped token and one resource group
- [ ] Automation runner: polls the broker's guest list, evaluates rules, executes or queues proposals, writes results to notifications
- [ ] Notifications store and API (proposals awaiting approval, automation results, update notices)

## Phase 2: ePaperclip

- [ ] Fork `paperclipai/paperclip` into this repository with history, so upstream changes can be merged
- [ ] Container-session engine: a Paperclip sandbox provider that leases containers from the broker in the company's resource group
- [ ] Resource groups in the company model: creating a company creates its pool, range, tag and limits through the broker; "let Pin decide" sizing
- [ ] Connector access per connector: Pin and/or chosen companies
- [ ] Company memory options when creating a company manually

## Papercliped, native (v1)

- [x] Connected apps page on demo data: device MCP address and per-app setup steps, the API only / Full / Agent only switch, sessions with Read only or Full control, organization and agent limits capped by the owning user, activity
- [ ] Move the Papercliped bridge into this repository as a device service (MCP at `/mcp`, OAuth against IAC users)
- [ ] Session limits by organization, and host tools for Full control sessions whose user allows them
- [ ] Remote access setup for web apps (Tailscale or tunnel connector)

## Phase 3: Pin

- [ ] Pin principal and runtime: Assistant and Agent modes, schedule, triggers
- [ ] `SOUL.md` and `MEMORY.md`
- [ ] System skills: guests, storage, network, backups, companies, connectors
- [ ] Natural language to automation rules, confirmed with the plain-language read-back before saving
- [ ] Creating companies on request
- [ ] Update awareness: track Proxmox and Paperclip releases, notify, apply on approval

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
- [ ] Live consoles: broker relay of Proxmox's terminal proxy, behind the same transport
- [ ] Paperclip pages still to come from the fork: chat, artifacts, workspaces, skills
- [x] Host service (`services/epaperclip`): Proxmox sign-in with two-factor, sessions, acting as the user, console serving with a strict CSP
- [x] Console on live data: host metrics, machines, power, usage graphs, every storage and the root file system, creating containers
- [x] Pin's island shows every suggestion for the page you're on: up to three in the row (actions first), the rest grouped under More
- [x] Installer and systemd unit for a Proxmox VE host (`deploy/`)
- [ ] Connect the console to the host broker and ePaperclip for organizations, agents and tasks (still demo data)
- [ ] IAC backend: create and update Proxmox users, roles and ACLs from ePaperclip users and policies
- [x] Storage content: browse ISO images, CT templates, backups and disks per storage; delete with confirmation
- [x] Proxmox's template catalog (system and TurnKey) with one-click download; ISO and template upload with progress; download from URL with checksum
- [x] Task log with each task's output; Pin notifies when downloads, uploads and creates finish
- [x] Virtual machines from an ISO, with Proxmox's wizard defaults per OS type (Windows 11 gets UEFI, Secure Boot keys and TPM 2.0)
- [ ] Backups: run now, schedules, restore
- [ ] Network: bridges, VLANs, apply configuration
- [ ] Machine hardware editing (disks, NICs, CPU, memory), snapshots and clones on live machines
- [ ] Firewall, users and permissions (the IAC sync backend), certificates, disks and ZFS, HA and replication
- [x] Serve the console on the host (port 443), with the stock Proxmox UI kept on 8006 as the emergency console

## Phase 5: the system

- [ ] Installer ISO and apt repository on top of upstream Proxmox VE packages, with our own name and branding
- [ ] Vault root key, unlock and recovery
- [ ] Kill switch and emergency console documentation
