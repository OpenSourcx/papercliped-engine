/**
 * Skills written by the ePaperclip project. They are plain text (a SKILL.md each), shipped inside the console, and an
 * organization adds the ones it wants: adding one creates it in that organization only, so nothing is shared between
 * organizations. They describe how to work well here (isolated containers, Pin, the Proxmox host), never anything secret.
 */
export interface EpaperclipSkill { slug: string; name: string; tagline: string; description: string; categories: string[]; markdown: string }

export const EPAPERCLIP_SKILLS: EpaperclipSkill[] = [
  {
    slug: "epaperclip-sandbox-etiquette",
    name: "Working in an ePaperclip container",
    tagline: "How to work well inside your isolated container.",
    description: "Use when running inside an ePaperclip agent container: where files live, what the network allows, and how to report results.",
    categories: ["ePaperclip", "containers"],
    markdown: `---
name: epaperclip-sandbox-etiquette
description: How to work inside an ePaperclip agent container.
---
# Working in an ePaperclip container

You run in an isolated Proxmox container made for this organization, not on the owner's machine.

- Your working directory is yours. Put every file you make there, and say its path when you report back.
- The internet works over HTTPS. The owner's LAN, the Proxmox host and its web interface are not reachable on purpose. Do not try to get around that.
- Nothing you install survives a new run unless it is in the workspace. Say what you installed.
- Never print secrets. If a task needs a credential, ask for it to be added as a secret instead of pasting it.
- When a run finishes, say what you did, what you checked, and anything you could not do.
`,
  },
  {
    slug: "epaperclip-pin-collaboration",
    name: "Working with Pin",
    tagline: "When to hand work to Pin, and how.",
    description: "Use when a task touches the Proxmox host, its machines, storage, network or backups: Pin does that, with the owner's approval.",
    categories: ["ePaperclip", "pin"],
    markdown: `---
name: epaperclip-pin-collaboration
description: Hand host and machine work to Pin, and ask before anything risky.
---
# Working with Pin

Pin is the owner's assistant for the Proxmox host. It acts through the host under its own name, one allowed action at a time, and everything it does is recorded.

- Ask Pin, in the task thread, for anything about the host: machines, storage, network, firewall, backups, updates.
- You cannot reach the host directly, and should not try. Describe what you need and why.
- Expect Pin to ask the owner before changing or deleting anything. Wait for the answer; do not repeat the request.
- Give Pin the machine number or name, not guesses. If you are not sure, ask for a list first.
`,
  },
  {
    slug: "epaperclip-worker-setup",
    name: "Connecting a worker machine",
    tagline: "Walk someone through connecting a Linux or Mac worker.",
    description: "Use when a person wants to run work on another computer: the worker connects out to ePaperclip and Pin guides the rest.",
    categories: ["ePaperclip", "workers"],
    markdown: `---
name: epaperclip-worker-setup
description: Guide a person through connecting a worker machine.
---
# Connecting a worker machine

A worker is another computer (Linux or macOS) that runs work for this organization. It only connects out; it opens no port.

1. In the console, open Workers and choose Add worker. Copy the code.
2. On the other computer run: npm install -g epaperclip-worker, then epaperclip-worker connect.
3. Choose who sets the machine up: Pin with approval each time, or the person running the commands Pin shows.
4. Paste the code, then approve the worker in the console when it asks.

Explain each step in plain words, one at a time. Never ask for a password or a key.
`,
  },
  {
    slug: "epaperclip-cost-care",
    name: "Spending carefully",
    tagline: "Keep runs short, and stop when stuck.",
    description: "Use on every task: keep turns and tokens low, and stop and ask instead of looping.",
    categories: ["ePaperclip", "costs"],
    markdown: `---
name: epaperclip-cost-care
description: Keep runs short and stop when stuck.
---
# Spending carefully

- Read the task fully before acting. Plan in two or three lines, then do it.
- If the same step fails twice, stop and say what failed instead of trying a third time.
- Prefer small files and focused commands over reading everything.
- If a task is bigger than it looked, say so and propose smaller steps.
`,
  },
];
