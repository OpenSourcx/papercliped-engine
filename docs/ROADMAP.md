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

- [ ] One UI: Paperclip's style plus host pages (guests, storage, network, backups, updates)
- [ ] Onboarding: organization name, Pin mode, first AI account, Pin's access, first company
- [ ] Design framework: themes as tokens and layouts the user can change
- [ ] Serve the console in place of the stock Proxmox UI, which stays reachable as an emergency console

## Phase 5: the system

- [ ] Installer ISO and apt repository on top of upstream Proxmox VE packages, with our own name and branding
- [ ] Vault root key, unlock and recovery
- [ ] Kill switch and emergency console documentation
