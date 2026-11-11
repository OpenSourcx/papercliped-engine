/**
 * The composer's "#": a message that starts with "#" is a line for Pin's memory, not a chat message. It is saved straight
 * away through the person's own memory, and can be undone through the memory history that already exists.
 */

/** True when the draft is a memory line: "#" is its very first character. */
export function isMemoryLine(draft: string): boolean {
  return draft.startsWith("#");
}

/** The line to keep: everything after the "#", on one line. Null when nothing was typed after it. */
export function memoryLine(draft: string): string | null {
  if (!isMemoryLine(draft)) return null;
  const text = draft.slice(1).replace(/\s+/g, " ").trim();
  return text ? text : null;
}

/** The heading the store adds before the first remembered line, so a demo save reads like a real one. */
const REMEMBERED = "## Remembered";

/**
 * Adds one line to MEMORY.md text. Used by the demo, which keeps memory in the browser; the device does the same work
 * itself. Returns `added: false` when the line is already there, so a second save doesn't double it.
 */
export function appendMemoryLine(memory: string, text: string, today: string): { memory: string; line: string; added: boolean } {
  const line = `- ${today}: ${text}`;
  if (memory.toLowerCase().includes(text.toLowerCase())) return { memory, line, added: false };
  const body = memory.includes(REMEMBERED) ? `${memory.replace(/\s+$/, "")}\n${line}\n` : `${memory.replace(/\s+$/, "")}\n\n${REMEMBERED}\n${line}\n`;
  return { memory: body, line, added: true };
}

export interface RememberResult {
  ok: boolean;
  message: string;
  /** The line as it was saved (with its date), or null when it was already there. */
  line: string | null;
  /** The revision to restore to undo this save. */
  rev: number;
}
