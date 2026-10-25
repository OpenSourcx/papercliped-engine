import type { ThreadMessage } from "../../pin/useThread.ts";

/**
 * Tiles: panes that open beside a conversation because of what the assistant is doing. Reading or writing a file in a
 * machine opens that file, running a command opens its output, writing a plan opens the plan. They are derived from the
 * thread's tool steps, so they update as a step runs and finishes, and the same thread always gives the same tiles.
 */

export type TileStatus = "running" | "done" | "failed" | "waiting";

export type Tile =
  | { id: string; kind: "file"; title: string; path: string; vmid: number | null; text: string; write: boolean; status: TileStatus }
  | { id: string; kind: "command"; title: string; command: string; vmid: number | null; text: string; status: TileStatus }
  | { id: string; kind: "plan"; title: string; summary: string; steps: { label: string; destructive?: boolean }[]; status: TileStatus };

const statusOf = (s: string): TileStatus => (s === "done" ? "done" : s === "failed" || s === "error" ? "failed" : s === "running" ? "running" : "waiting");
/** Machine tools answer "<what happened> In <name> (<vmid>).\n<output>": the output is everything after the first line. */
const outputOf = (result: string | undefined) => {
  if (!result) return "";
  const i = result.indexOf("\n");
  return i < 0 ? "" : result.slice(i + 1).replace(/^\(no output\)$/, "");
};
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);
const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

export function tileFor(m: ThreadMessage): Tile | null {
  const t = m.tool;
  if (!t) return null;
  const status = statusOf(t.status);
  const a = t.args ?? {};
  if (t.name === "machine_read_file" || t.name === "machine_write_file") {
    const path = str(a.path);
    const write = t.name === "machine_write_file";
    return { id: t.id, kind: "file", title: base(path) || "File", path, vmid: num(a.vmid) ?? t.vmid ?? null, write, text: write ? str(a.content) : t.error ?? outputOf(t.result), status };
  }
  if (t.name === "machine_exec") {
    const command = str(a.command);
    return { id: t.id, kind: "command", title: command.split("\n")[0]!.slice(0, 60) || "Command", command, vmid: num(a.vmid) ?? t.vmid ?? null, text: t.error ?? outputOf(t.result), status };
  }
  if (t.name === "propose_plan" || (Array.isArray(a.steps) && typeof a.planId === "string")) {
    const steps = (Array.isArray(a.steps) ? a.steps : []).flatMap((s) => (s && typeof s === "object" && typeof (s as { label?: unknown }).label === "string" ? [{ label: (s as { label: string }).label, destructive: !!(s as { destructive?: unknown }).destructive }] : []));
    return { id: t.id, kind: "plan", title: str(a.title) || "Plan", summary: str(a.summary), steps, status };
  }
  return null;
}

/** Every tile the thread has produced, newest last, without the ones the person closed. */
export function tilesOf(messages: ThreadMessage[], closed: ReadonlySet<string>): Tile[] {
  return messages.flatMap((m) => {
    const t = tileFor(m);
    return t && !closed.has(t.id) ? [t] : [];
  });
}
