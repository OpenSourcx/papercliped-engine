import { describeRule, validateRule } from "@papercliped-engine/automations";
import type { useEngine } from "../data/store.tsx";
import type { PinToolEvent } from "./live.ts";

/**
 * Pin's proposals, turned into cards and into the console's own actions. Pin proposes; the person confirms; the
 * console runs the action through the same functions its buttons use, so Pin can never do more than the person could
 * from the page. The host service proposes power_machine, snapshot_machine and create_task; names are matched loosely.
 */

type Engine = ReturnType<typeof useEngine>;
const POWER = ["start", "shutdown", "stop", "reboot", "reset"] as const;
type Power = (typeof POWER)[number];

export interface ToolView {
  title: string;
  body: string;
  confirmLabel: string;
  danger: boolean;
  /** False when the console has no button for this; the card then says so instead of offering Confirm. */
  runnable: boolean;
  details: string[];
}

/** What a run needs besides the store: navigation, and creating a task in an organization (live engine). */
export interface ToolDeps {
  nav: (to: string) => void;
  createTask?: (companyId: string, title: string, description?: string) => Promise<unknown>;
}

const norm = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, "_");

export type ToolKind = "power" | "snapshot" | "task" | "rule" | "navigate" | "unknown";

export function kindOf(t: Pick<PinToolEvent, "name" | "args">): ToolKind {
  const n = norm(t.name);
  if (/snapshot/.test(n)) return "snapshot";
  if (/power|start|stop|shutdown|reboot/.test(n) && (t.args.vmid !== undefined || t.args.machine !== undefined)) return "power";
  if (/task|issue/.test(n) && typeof t.args.title === "string") return "task";
  if (/rule|automation/.test(n)) return "rule";
  if (/navigate|open|go_to/.test(n) && typeof t.args.to === "string") return "navigate";
  return "unknown";
}

const powerOf = (t: PinToolEvent): Power | null => {
  const a = String(t.args.action ?? t.args.power ?? "").toLowerCase();
  return (POWER as readonly string[]).includes(a) ? (a as Power) : null;
};

const vmidOf = (t: PinToolEvent) => Number(t.args.vmid ?? t.args.machine);
const VERB: Record<Power, string> = { start: "Start", shutdown: "Shut down", stop: "Stop", reboot: "Restart", reset: "Reset" };
const SNAP_NAME = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/;

export function describeTool(t: PinToolEvent, engine: Pick<Engine, "data">): ToolView {
  const details = Object.entries(t.args).slice(0, 6).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  const kind = kindOf(t);
  const machine = () => {
    const g = engine.data.guests.find((x) => x.vmid === vmidOf(t));
    return { g, name: g ? `${g.name} #${g.vmid}` : `machine #${vmidOf(t)}` };
  };
  if (kind === "power") {
    const action = powerOf(t);
    const { g, name } = machine();
    if (!action) return { title: t.title ?? `Change power for ${name}`, body: t.summary ?? "Pin asked for a power action the console doesn't know.", confirmLabel: "Confirm", danger: false, runnable: false, details };
    const lossy = action === "stop" || action === "reset";
    return {
      title: t.title ?? `${VERB[action]} ${name}`,
      body: t.summary ?? (!g ? "That machine isn't on this device." : lossy ? "This cuts power without a clean shutdown. Unsaved work on the machine is lost." : action === "start" ? "The machine boots with its current settings." : action === "reboot" ? "The machine's own system restarts cleanly." : "The machine's own system shuts down cleanly first."),
      confirmLabel: VERB[action],
      danger: lossy || action === "shutdown",
      runnable: !!g,
      details,
    };
  }
  if (kind === "snapshot") {
    const { g, name } = machine();
    const snap = String(t.args.name ?? "");
    const valid = SNAP_NAME.test(snap);
    return {
      title: t.title ?? `Snapshot ${name}`,
      body: t.summary ?? (!g ? "That machine isn't on this device." : !valid ? `"${snap}" isn't a valid snapshot name.` : `Saves the machine as it is now, named ${snap}. You can roll back to it later.`),
      confirmLabel: "Take snapshot",
      danger: false,
      runnable: !!g && valid,
      details,
    };
  }
  if (kind === "task") {
    const org = engine.data.orgs.find((o) => o.engine?.companyId === t.args.companyId || o.slug === t.args.companyId);
    return {
      title: t.title ?? `New task: ${String(t.args.title)}`,
      body: t.summary ?? (typeof t.args.description === "string" && t.args.description ? t.args.description : `In ${org?.name ?? "the organization"}.`),
      confirmLabel: "Create task",
      danger: false,
      runnable: typeof t.args.companyId === "string",
      details,
    };
  }
  if (kind === "rule") {
    const v = validateRule(t.args.rule ?? t.args);
    return v.ok
      ? { title: t.title ?? "Save this automation", body: describeRule(v.rule), confirmLabel: "Save automation", danger: false, runnable: true, details }
      : { title: t.title ?? "An automation Pin drafted", body: `The rule didn't pass the validator: ${v.errors.join(" ")}`, confirmLabel: "Save automation", danger: false, runnable: false, details };
  }
  if (kind === "navigate") return { title: t.title ?? "Open a page", body: t.summary ?? String(t.args.to), confirmLabel: "Open", danger: false, runnable: true, details: [] };
  return { title: t.title ?? t.name.replace(/_/g, " "), body: t.summary ?? "The console can't run this from here yet.", confirmLabel: "Confirm", danger: false, runnable: false, details };
}

/** Runs a confirmed proposal with the console's own actions. */
export async function runTool(t: PinToolEvent, engine: Engine, deps: ToolDeps): Promise<{ ok: true; note: string } | { ok: false; error: string }> {
  const kind = kindOf(t);
  if (kind === "power" || kind === "snapshot") {
    const vmid = vmidOf(t);
    if (!engine.data.guests.some((g) => g.vmid === vmid)) return { ok: false, error: "That machine isn't on this device." };
    if (kind === "snapshot") {
      const name = String(t.args.name ?? "");
      if (!SNAP_NAME.test(name)) return { ok: false, error: "That snapshot name isn't valid." };
      const r = engine.snapshot(vmid, name, String(t.args.description ?? ""));
      return r.ok ? { ok: true, note: "Snapshot started." } : { ok: false, error: r.error ?? "Proxmox refused." };
    }
    const action = powerOf(t);
    if (!action) return { ok: false, error: "The console doesn't know that power action." };
    const r = engine.guestPower(vmid, action);
    return r.ok ? { ok: true, note: `${VERB[action]} sent.` } : { ok: false, error: r.error ?? "Proxmox refused." };
  }
  if (kind === "task") {
    const companyId = String(t.args.companyId ?? "");
    const title = String(t.args.title ?? "").trim();
    if (!title) return { ok: false, error: "The task has no title." };
    if (deps.createTask) {
      try {
        await deps.createTask(companyId, title, typeof t.args.description === "string" ? t.args.description : undefined);
        return { ok: true, note: "Task created." };
      } catch (e) {
        return { ok: false, error: (e as Error).message || "The engine refused." };
      }
    }
    const org = engine.data.orgs.find((o) => o.slug === companyId || o.engine?.companyId === companyId);
    if (!org) return { ok: false, error: "That organization isn't here." };
    engine.addTask(org.slug, title, null);
    return { ok: true, note: "Task created." };
  }
  if (kind === "rule") {
    const v = validateRule(t.args.rule ?? t.args);
    if (!v.ok) return { ok: false, error: v.errors.join(" ") };
    engine.saveRule({ ...v.rule, createdBy: "pin" });
    return { ok: true, note: "Automation saved." };
  }
  if (kind === "navigate") {
    deps.nav(String(t.args.to));
    return { ok: true, note: "Opened." };
  }
  return { ok: false, error: "The console can't run this from here yet." };
}
