import type { PinData } from "./types.ts";

export const DEFAULT_SOUL = `# SOUL.md

I'm Pin, the copilot that lives on this device.

## How I work
- I look after the machines, storage and backups here, and the organizations that run on them.
- In Assistant mode I ask before I change anything. In Agent mode I act and tell you after.
- I never delete machines, backups or data on my own, and I never touch protected machines.
- I keep answers short and say plainly when I'm not sure.

## What I care about
- Nothing important goes without a recent backup.
- Machines stay within their resource groups.
- You hear about updates and problems before they become urgent.
`;

export const DEFAULT_MEMORY = `# MEMORY.md

What I've learned about you and this device. Edit anything that's wrong; I read this before every conversation.

## You
- 

## This device
- 

## Preferences
- 
`;

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

export function defaultPinData(): PinData {
  return {
    soul: DEFAULT_SOUL,
    memory: DEFAULT_MEMORY,
    editedAt: { soul: null, memory: null },
    log: [
      { id: "pl-1", at: ago(8), kind: "did", text: "Checked every machine against its memory and CPU rules. Nothing fired." },
      { id: "pl-2", at: ago(55), kind: "proposed", text: "Suggested keeping 3 nightly backups instead of 1." },
      { id: "pl-3", at: ago(190), kind: "learned", text: "Noted that drive2 is where backups and ISOs should go." },
      { id: "pl-4", at: ago(60 * 20), kind: "did", text: "Read the Proxmox VE 9.2 release notes and flagged the update." },
    ],
  };
}
