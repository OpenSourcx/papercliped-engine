import { describeRule, validateRule } from "@papercliped-engine/automations";
import type { useEngine } from "../data/store.tsx";
import type { PinToolEvent } from "./live.ts";

/**
 * Pin's proposals, turned into cards and into the console's own actions. Pin proposes; the person confirms; the
 * console runs the action through the same store functions its buttons use, so Pin can never do more than the person
 * could from the page. Names are matched loosely (machine.power, guest_power, power ...).
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

const norm = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, ".");

function kindOf(t: PinToolEvent): "power" | "rule" | "navigate" | "unknown" {
  const n = norm(t.name);
  if (/power|start|stop|shutdown|reboot/.test(n) && (t.args.vmid !== undefined || t.args.machine !== undefined)) return "power";
  if (/rule|automation/.test(n)) return "rule";
  if (/navigate|open|go/.test(n) && typeof t.args.to === "string") return "navigate";
  return "unknown";
}

const powerOf = (t: PinToolEvent): Power | null => {
  const a = String(t.args.action ?? t.args.power ?? norm(t.name).split(".").pop() ?? "").toLowerCase();
  return (POWER as readonly string[]).includes(a) ? (a as Power) : null;
};

const vmidOf = (t: PinToolEvent) => Number(t.args.vmid ?? t.args.machine);

const VERB: Record<Power, string> = { start: "Start", shutdown: "Shut down", stop: "Stop", reboot: "Restart", reset: "Reset" };

export function describeTool(t: PinToolEvent, engine: Pick<Engine, "data">): ToolView {
  const details = Object.entries(t.args).slice(0, 6).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  const kind = kindOf(t);
  if (kind === "power") {
    const action = powerOf(t);
    const g = engine.data.guests.find((x) => x.vmid === vmidOf(t));
    const name = g ? `${g.name} #${g.vmid}` : `machine #${vmidOf(t)}`;
    if (!action) return { title: t.title ?? `Change power for ${name}`, body: t.summary ?? "Pin asked for a power action the console doesn't know.", confirmLabel: "Confirm", danger: false, runnable: false, details };
    const lossy = action === "stop" || action === "reset";
    return {
      title: t.title ?? `${VERB[action]} ${name}`,
      body: t.summary ?? (lossy ? "This cuts power without a clean shutdown. Unsaved work on the machine is lost." : action === "start" ? "The machine boots with its current settings." : "The machine's own system shuts down cleanly first."),
      confirmLabel: VERB[action],
      danger: lossy || action === "shutdown",
      runnable: !!g,
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
  return { title: t.title ?? t.name, body: t.summary ?? "The console can't run this from here yet.", confirmLabel: "Confirm", danger: false, runnable: false, details };
}

/** Runs a confirmed proposal with the console's own actions. */
export function runTool(t: PinToolEvent, engine: Engine, nav: (to: string) => void): { ok: true; note: string } | { ok: false; error: string } {
  const kind = kindOf(t);
  if (kind === "power") {
    const action = powerOf(t);
    const vmid = vmidOf(t);
    if (!action || !engine.data.guests.some((g) => g.vmid === vmid)) return { ok: false, error: "That machine isn't on this device." };
    const r = engine.guestPower(vmid, action);
    return r.ok ? { ok: true, note: `${VERB[action]} sent.` } : { ok: false, error: r.error ?? "Proxmox refused." };
  }
  if (kind === "rule") {
    const v = validateRule(t.args.rule ?? t.args);
    if (!v.ok) return { ok: false, error: v.errors.join(" ") };
    engine.saveRule({ ...v.rule, createdBy: "pin" });
    return { ok: true, note: "Automation saved." };
  }
  if (kind === "navigate") {
    nav(String(t.args.to));
    return { ok: true, note: "Opened." };
  }
  return { ok: false, error: "The console can't run this from here yet." };
}
