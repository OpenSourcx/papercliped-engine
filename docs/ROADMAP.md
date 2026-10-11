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
- [ ] Connect the console to the host broker and ePaperclip (replace the demo data layer)
- [ ] IAC backend: create and update Proxmox users, roles and ACLs from ePaperclip users and policies
- [ ] Storage, network and backup pages
- [ ] Serve the console in place of the stock Proxmox UI, which stays reachable as an emergency console

## Phase 5: the system

- [ ] Installer ISO and apt repository on top of upstream Proxmox VE packages, with our own name and branding
- [ ] Vault root key, unlock and recovery
- [ ] Kill switch and emergency console documentation
