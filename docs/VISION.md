# Vision

papercliped-engine turns a Proxmox server into a machine you talk to. One interface replaces the stock Proxmox UI: it manages the host, runs your AI agents, hosts your companies, and gives you a personal copilot, **Pin**, that lives in the system and looks after it for you.

Think of the phone you carry. The hardware is yours, the system manages itself, and an assistant you can talk to does things for you. papercliped-engine is that, for your server.

## The three parts

| Part | What it is |
| --- | --- |
| **Proxmox engine** | The upstream Proxmox VE hypervisor (KVM, LXC, storage, networking, backups) running unchanged underneath. |
| **ePaperclip** | Paperclip, redesigned to run natively on Proxmox. Nothing Paperclip does today is removed: companies, agents, tasks, goals, approvals, budgets, connectors, adapters. It gains the host. |
| **Pin** | Your personal copilot. Not a company, not a CEO agent: yours. It manages your system, your companies and your connectors. |

## One interface

- A single clean UI replaces the Proxmox web UI. It manages the server (guests, storage, network, backups, updates) and everything Paperclip manages (companies, agents, tasks).
- It keeps Paperclip's visual style as the default.
- It ships a **design framework**: themes are tokens and layouts the user can change, so the interface can be redesigned without forking the code.
- The stock Proxmox UI stays installed but hidden, as an emergency console that works when everything above it is down.

## Pin

Pin is to this machine what Siri is to an iPhone, Copilot to Windows and Gemini to Android, with more control.

**Two modes**, chosen during onboarding and switchable any time:

| Mode | What Pin does |
| --- | --- |
| **Assistant** | Monitors, answers, does light tasks, and proposes anything bigger for you to approve. |
| **Agent** | Works autonomously: executes tasks, follows the schedule you give it, and acts on triggers. |

**Triggers and automations.** You say "if a container uses more than 50% of its memory, shut it down" and Pin creates the automation. Pin writes the rule; a deterministic engine runs it. In Assistant mode a firing rule asks you first; in Agent mode it acts.

**Memory.** Pin keeps a `SOUL.md` (who it is, how it behaves, what you want from it) and a `MEMORY.md` (what it has learned about you and your system), similar to OpenClaw.

**System skills.** Pin knows how to operate the machine: guests, storage, network, backups, companies, connectors.

**Always current.** Pin tracks Proxmox and Paperclip releases, tells you when an update is available through its notification system, and can apply it when you approve.

**Scope.** Pin can manage your system, create and manage companies, and use system-wide connectors you grant it.

## Companies and resource groups

- Companies (orgs) work as in Paperclip: agents, tasks, goals, budgets, approvals.
- Every company gets a **resource group**: the machines and resources assigned to it (CPU, memory, disk, guest count). Its agents cannot touch anything outside it.
- When you create a company, you choose how much of the system it may use. If you don't know, Pin decides for you.
- Company agents keep their own memory in Postgres. Creating a company manually shows the memory options.
- Pin can create companies for you.

## Engines

An agent runs either:

- **Natively**, on the engine host process, for trusted, light work, or
- **In a container session**, an isolated LXC created for the run and destroyed after it.

## Connectors and access

System-wide connectors (GitHub, model API keys, mail and others) are configured once. For each connector you choose who may use it: **Pin**, and/or **one or more companies**. A company's agents only see connectors granted to that company.

## Onboarding

1. Name your organization.
2. Choose Pin's mode (Assistant or Agent).
3. Connect your first AI account.
4. Grant Pin access to your system and connectors.
5. Optionally create your first company, or let Pin propose one.

## Principles

1. **You own the machine.** Your hardware, your secrets, your rules.
2. **Language in, deterministic action out.** Pin and agents decide what should happen; small, auditable components carry it out within hard limits.
3. **Nothing is lost from Paperclip.** Redesign, don't remove.
4. **Always recoverable.** The emergency console, snapshots before risky changes, and a kill switch.
