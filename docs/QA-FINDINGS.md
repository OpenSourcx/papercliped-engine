# QA findings

A drive-through of every console screen that exists today, in demo mode and in live mode against a fake Proxmox (HTTPS on :8006, the real host service on :4443 with the built console, signed in as `root@pam`). Headless Chromium, desktop (1440x900) and phone (390x900) widths, with page errors, failed requests and raw error text collected on every route. Screenshots are in `/tmp/qa-shots` (they live in the QA machine's temp folder; re-run the walk to regenerate).

Status lines were added when the machine page work landed (see docs/MACHINE.md); the findings themselves are the original walk. Each finding names the screen, what happens, the evidence, and the workstream that should own it (see `docs/PARITY.md`). Missing Proxmox features are not repeated here; they are the rows in the parity matrix. Severity: High = a person can get stuck or misled; Medium = confusing or wrong, with a way around; Low = polish.

**Totals: 21 findings (2 High, 10 Medium, 9 Low).** What was exercised: sign-in (good, wrong and expired session), onboarding, Overview, Summary, Machines and all 7 tabs of a running container, a running VM and a protected container, the machine action menu (snapshot, clone, back up, template, delete, new machine, hardware, task log), Hardware dialogs (add network device, grow disk, options), Resources, Storage and a storage's content, Store, Tasks, Pin (page and chat), Network (bridge create and staged changes), Firewall (rule dialog), Backups, Host shell, VM console, every settings dialog, and in demo mode both organizations and all of their pages.

## Findings

### High

**QA-01. A machine's power actions are invisible until you hover Pin's island.** Screen: Machine page (every machine, live and demo). The header says only "Actions are in Pin: hover the island"; there is no Start, Shut down, Reboot or Console button on the page. A first-time user, and anyone on touch, has nothing to click (touch is meant to use Pin's panel). Proxmox puts Start/Shutdown/Console in the header, and the parity target is "never open Proxmox's UI". Evidence: `live-m101-overview.png`, `live-hover107.png` (the bar that appears), `live-more-107.png`. Owner: W-MACHINE.

*Status: Fixed. Start or Shut down, and Console, are buttons in the machine header.*

**QA-02. A machine that does not exist waits forever.** Screen: `/pve/machines/999` (and any bad VMID). It shows "Waiting for machine #999 - A new machine shows up as soon as Proxmox lists it" with no end state, so a mistyped or deleted machine looks like a slow one. Also true after deleting a machine you are viewing. Evidence: `live-w1440-machines_999.png`. Owner: W-MACHINE.

*Status: Fixed. An unknown number shows "There is no machine #N" after a short look-up (a machine just created can take a few seconds to be listed); a deleted machine is reported as gone at once.*

### Medium

**QA-03. A mistyped address says "The engine isn't installed".** Screen: any unknown `/pve/<word>` (for example `/pve/nope`, `/pve/containers`). The word is treated as an organization, so the page tells you to install the Paperclip engine, and the sentence ends with a duplicate "(The engine isn't installed.)". It should say the page was not found. Evidence: `live-w1440-nope.png`. Owner: W-ENGINE.

*Status: Fixed. A single unknown word says the page was not found (and mentions the engine only as a possible reason); the duplicated sentence is gone. A page inside an organization still says the engine is missing.*

**QA-04. Empty pill in every machine header.** Screen: Machine page header, next to the "Container" / "Virtual machine" badge. A blank rounded chip is rendered, including for machine 101, which has the tag "web" (the tag is not shown anywhere in the header). Evidence: `live-m101-overview.png`, `live-m102-hardware.png`. Owner: W-MACHINE.

*Status: Fixed. No chip without text; the machine's tags show in its header.*

**QA-05. Machines list has no way to create a machine, search or sort.** Screen: Machines. The only controls are the All/Running/Stopped filter and per-card Manage/Console; creating a machine needs the Pin island menu or the rail "+". Names and memory truncate ("858 MiB / 2.00..."). Evidence: `live-w1440-machines.png`. Owner: W-MACHINE.

*Status: Fixed. New machine button (opens the wizard), search by name, number, tag or OS, and sort.*

**QA-06. Agent containers dialog shows raw Proxmox API errors, repeated.** Screen: Settings > Agent containers. Every setup step repeats "Couldn't check Proxmox: Proxmox GET /access/roles failed (404)", exposing an API path and no way forward. Evidence: `live-set-agent-containers.png`. Owner: W-ENGINE.

*Status: Fixed. Proxmox failures are explained in words, once, without the API path; each step says "Not checked".*

**QA-07. The Store warns "Couldn't read drive2" with no cause or retry.** Screen: Store. A Proxmox 404 on a storage listing becomes a 502 from the host service (`GET /api/storage/drive2/content?content=vztmpl` returns 502) and the page shows an amber line that never clears and offers no Retry. Missing-content and unreachable-storage cases should be told apart. Evidence: `live-w1440-store.png`, response log. Owner: W-DISK.

*Status: Partly fixed. The Store line has a Try again button. Telling a missing storage content list from an unreachable storage is still open (it needs a host-service change in the storage route).*

**QA-08. A storage opens on an empty tab while other tabs hold content.** Screen: Storage > drive2. It opens on "ISO images (0)" with "No iso images on drive2" while Backups (1) and VM disks (1) are not empty. Open the first non-empty tab, or All. Evidence: `live-w1440-storage_drive2.png`. Owner: W-DISK.

*Status: Fixed. A storage opens on its first tab that holds something.*

**QA-09. Memory can only be set from a fixed list.** Screen: Machine > Hardware. A drop-down offers 512 MiB to 64 GiB in preset steps, so 3 GiB, 6 GiB, 100 GiB or any exact MiB value cannot be set (and a value outside the list has no option to show). Proxmox accepts any value. Evidence: `live-m102-hardware.png`. Owner: W-MACHINE.

*Status: Fixed. Memory (and swap, minimum memory) take any whole number of MiB, in MiB or GiB.*

**QA-10. Settings > General describes organizations as demo data in live mode.** Screen: Settings > General, "DEMO" block: "Organizations, agents, tasks and rules are still demo data in this browser until ePaperclip's backend lands" with a "Start over" button, while organizations are now backed by the engine in live mode. The copy is stale and "Start over" reads as destructive. Evidence: `live-set-general.png`. Owner: W-ENGINE.

*Status: Fixed. Live, General explains what this browser keeps; the reset is a plain button, not a red "Start over".*

**QA-11. Connected apps is not backed by anything in live mode.** Screen: Settings > Connected apps. It shows a device address (`https://127.0.0.1/mcp`, taken from the browser's host, not the console's port or the device's real name), sessions and the API only/Full/Agent only switch, none of which are served by the host service today (roadmap: not built). A switch that changes nothing is worse than no switch. Evidence: `live-set-apps.png`. Owner: W-ENGINE.

*Status: Fixed. Live, Connected apps says it is not available on this device yet, with no address, sessions or switch. The demo is unchanged.*

**QA-12. Firewall rule tables are clipped on a phone, with the actions off-screen.** Screen: Firewall (and the machine Firewall tab) at 390 px. The table scrolls sideways inside its card with no visible cue; the Actions column is out of view, so rules cannot be edited or deleted without finding the hidden scroll. Machine tab strips clip the same way ("Snapshots" is cut off, Backups to Tasks are hidden). Evidence: `live-w390-firewall.png`, `live-w390-machines_102_tab_hardware.png`. Owner: W-MACHINE (tabs), W-NODE (firewall).

*Status: Fixed. Rules are cards on a phone with their actions in reach; machine and Firewall tab strips wrap instead of clipping.*

### Low

**QA-13. Machines list duplicates tab stops.** Screen: Machines. Each card exposes "Manage" twice and "Console" twice to the keyboard and screen readers (card link plus button). Evidence: button list in the walk log; `live-w1440-machines.png`. Owner: W-MACHINE.

*Status: Fixed. One button per action on each card.*

**QA-14. Storage page is narrower than every other page.** Screen: Storage. The content column is about 850 px wide with large empty margins at 1440 px, while Machines and Network fill the width. Evidence: `live-w1440-storage.png` against `live-w1440-machines.png`. Owner: W-DISK.

*Status: Open. Storage page width belongs with the storage work.*

**QA-15. Pin gives two different instructions when no model is set.** Screen: Pin page says "Choose one in Settings"; the chat error says "An administrator can add an API key in Connectors". The Ask Pin bar accepts the question and answers with the error rather than saying up front it cannot answer. Evidence: `live-pin-chat2.png`. Owner: W-ENGINE.

*Status: Open. Pin's two different instructions when no model is set.*

**QA-16. Machine overview shows "Address -" and "Owner Device" with no way to fill them.** Screen: Machine > Overview. A running container with DHCP never shows its IP (the guest agent and container interfaces calls are not used). Evidence: `live-m101-overview.png`. Owner: W-MACHINE.

*Status: Fixed. Overview shows the hostname and addresses (guest agent, container interfaces, or the configuration while stopped), with the reason when there are none.*

**QA-17. The sign-in page logs a console error before sign-in.** Screen: every first load. `GET /api/me` returns 401 and Chrome logs a red console error, which drowns real errors in the console. Evidence: walk log. Owner: W-ENGINE.

*Status: Open. The browser logs the 401 before sign-in; avoiding it needs /api/me to answer 200 when signed out, which changes the API.*

**QA-18. Demo mode organization navigation has four dead entries.** Screen: demo organization sidebar. Chat, Artifacts, Workspaces and Skills open a placeholder: "This page comes from Paperclip itself and lands when the ePaperclip fork is merged into the console." Evidence: `demo-w1440-northwind_labs_chat.png`. Owner: W-ENGINE.

*Status: Open. Demo organization placeholders.*

**QA-19. Demo agents in the sidebar all link to the agent list.** Screen: demo organization sidebar > Agents. Each agent row goes to `/<org>/agents`, not to that agent (live mode goes to the agent). Evidence: `demo-w1440-qa.png`; `ContextSidebar.tsx` DemoOrgSidebar. Owner: W-ENGINE.

*Status: Open. Demo agents link to the list on purpose (the demo has no agent pages).*

**QA-20. `/pve/<org>/members` silently redirects in demo mode.** Screen: demo. The Members page exists only in live mode, so the address lands on the dashboard with no message. Owner: W-ENGINE.

*Status: Fixed. The demo explains that members are managed on a device.*

**QA-21. A one-to-three pixel horizontal overflow on an organization dashboard.** Screen: demo `/pve/qa` at 1440 px (document scroll width exceeds the viewport). Evidence: `demo-w1440-qa.png`. Owner: W-ENGINE.

*Status: Open. One-to-three pixel overflow on the demo organization dashboard.*

## What works well (checked and fine)

Sign-in: wrong password gives "Wrong username or password", an expired session returns to sign-in on the same address. Delete: refuses a protected machine with a clear message and keeps the button disabled until the name is typed. Snapshots: name rules shown, button disabled for a bad name. Network: a new bridge is staged, with Apply, Revert and Show changes. Console: the container terminal, VM screen and host shell connect (VM screen shows Ctrl+Alt+Del, Fit, Reconnect). Mobile: no page-level horizontal overflow on any route at 390 px.

## Could not verify

- **Task history** stayed empty ("No tasks yet") after starting, snapshotting and creating machines, and a poll of a new task's status returned `400 Unknown task`. The fake Proxmox does not record tasks for power actions and gives create tasks an odd id, so this may be the fake rather than the console; check against a real host.
- **Interactive graphs and numbers**: the fake returns the same sine wave for every machine, so graph correctness was not judged.
- **Upload, template download, restore, clone, resize and the two-factor sign-in** were not run end to end (they need real Proxmox behaviour); only their dialogs and validation were looked at.
- **Engine-backed organization screens in live mode** (agents, tasks, decisions) need a running engine; the engine was not installed here, so they were walked in demo mode only.
- **Other builders' work in progress** (disks, storage settings) was not present in this checkout and is not covered.
