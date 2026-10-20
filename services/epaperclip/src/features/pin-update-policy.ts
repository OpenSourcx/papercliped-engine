import type { PinRuntime } from "./pin-core.ts";

/**
 * How updates are handled on this device, the way a person would set it in Windows Update: whether to be reminded or to
 * install by itself in a maintenance window, whether updates are paused, and a record of what was installed and how it
 * went. Plain settings in the state file; nothing here touches the system. The update runner (pin-update.ts) reads them.
 */

export type Mode = "remind" | "window";
export interface Window {
  /** "daily", or a day of the week as Date.getDay() numbers it (0 is Sunday). */
  day: "daily" | 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** Local time of day on this device, "HH:MM". */
  at: string;
  /** How long the window stays open, in hours. */
  hours: number;
}
export interface Policy {
  mode: Mode;
  window: Window;
  /** Updates aren't installed by the schedule, and reminders stop, until this time. */
  pausedUntil: number | null;
  /** Reminders stop until this time. */
  snoozedUntil: number | null;
}

export const MAX_PAUSE_DAYS = 35;
export const DEFAULT_POLICY: Policy = { mode: "remind", window: { day: "daily", at: "03:00", hours: 2 }, pausedUntil: null, snoozedUntil: null };

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const AT = /^([01]\d|2[0-3]):([0-5]\d)$/;

const KEY = "pin.update.policy";

const day = (v: unknown): Window["day"] | null => (v === "daily" ? "daily" : Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 6 ? ((v as number) as Window["day"]) : null);

/** What is saved, repaired field by field so a damaged value can't switch on an automatic install by accident. */
export function readPolicy(rt: PinRuntime): Policy {
  const raw: Partial<Omit<Policy, "window">> & { window?: Partial<Window> } = rt.state.getSetting<Partial<Omit<Policy, "window">> & { window?: Partial<Window> }>(KEY) ?? {};
  const w: Partial<Window> = raw.window ?? {};
  return {
    mode: raw.mode === "window" ? "window" : "remind",
    window: {
      day: day(w.day) ?? DEFAULT_POLICY.window.day,
      at: typeof w.at === "string" && AT.test(w.at) ? w.at : DEFAULT_POLICY.window.at,
      hours: Number.isInteger(w.hours) && (w.hours as number) >= 1 && (w.hours as number) <= 6 ? (w.hours as number) : DEFAULT_POLICY.window.hours,
    },
    pausedUntil: typeof raw.pausedUntil === "number" ? raw.pausedUntil : null,
    snoozedUntil: typeof raw.snoozedUntil === "number" ? raw.snoozedUntil : null,
  };
}

/** What a request may change. Throws an Error whose message is for the person. */
export function applyPolicy(rt: PinRuntime, b: Record<string, unknown>): Policy {
  const cur = readPolicy(rt);
  const next: Policy = { ...cur, window: { ...cur.window } };
  if (b.mode !== undefined) {
    if (b.mode !== "remind" && b.mode !== "window") throw new Error('mode is "remind" or "window".');
    next.mode = b.mode;
  }
  if (b.window !== undefined) {
    const w = (b.window ?? {}) as Record<string, unknown>;
    if (typeof b.window !== "object" || Object.keys(w).some((k) => k !== "day" && k !== "at" && k !== "hours")) throw new Error("window is {day, at, hours}.");
    if (w.day !== undefined) {
      const d = day(w.day);
      if (d === null) throw new Error('day is "daily" or 0 to 6 (Sunday is 0).');
      next.window.day = d;
    }
    if (w.at !== undefined) {
      if (typeof w.at !== "string" || !AT.test(w.at)) throw new Error("at is a time like 03:00.");
      next.window.at = w.at;
    }
    if (w.hours !== undefined) {
      if (!Number.isInteger(w.hours) || (w.hours as number) < 1 || (w.hours as number) > 6) throw new Error("hours is a whole number from 1 to 6.");
      next.window.hours = w.hours as number;
    }
  }
  if (b.pauseDays !== undefined) {
    if (!Number.isInteger(b.pauseDays) || (b.pauseDays as number) < 0 || (b.pauseDays as number) > MAX_PAUSE_DAYS) throw new Error(`pauseDays is 0 (resume) to ${MAX_PAUSE_DAYS}.`);
    next.pausedUntil = (b.pauseDays as number) === 0 ? null : rt.now() + (b.pauseDays as number) * DAY;
  }
  if (b.snoozeHours !== undefined) {
    if (!Number.isInteger(b.snoozeHours) || (b.snoozeHours as number) < 0 || (b.snoozeHours as number) > 168) throw new Error("snoozeHours is 0 (stop snoozing) to 168.");
    next.snoozedUntil = (b.snoozeHours as number) === 0 ? null : rt.now() + (b.snoozeHours as number) * HOUR;
  }
  rt.state.setSetting(KEY, next);
  return next;
}

export const isPaused = (p: Policy, now: number) => p.pausedUntil !== null && p.pausedUntil > now;
export const isSnoozed = (p: Policy, now: number) => p.snoozedUntil !== null && p.snoozedUntil > now;

const startOf = (w: Window, d: Date) => {
  const [h, m] = w.at.split(":").map(Number);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
};

/** Whether `now` is inside the maintenance window (on this device's clock). A window that crosses midnight belongs to the day it started. */
export function inWindow(p: Policy, now: number): boolean {
  const d = new Date(now);
  for (const back of [0, 1]) {
    const base = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
    if (p.window.day !== "daily" && base.getDay() !== p.window.day) continue;
    const start = startOf(p.window, base);
    if (now >= start && now < start + p.window.hours * HOUR) return true;
  }
  return false;
}

/** When the maintenance window next opens (or is open now: the current time). */
export function nextWindow(p: Policy, now: number): number {
  if (inWindow(p, now)) return now;
  for (let ahead = 0; ahead <= 7; ahead++) {
    const base = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate() + ahead);
    if (p.window.day !== "daily" && base.getDay() !== p.window.day) continue;
    const start = startOf(p.window, base);
    if (start > now) return start;
  }
  return now + DAY;
}

// ---- History

export interface HistoryEntry {
  id: string;
  at: number;
  action: "update" | "rollback";
  from: string | null;
  to: string | null;
  /** The administrator, "schedule" for the maintenance window, or "host shell" for one done outside the console. */
  by: string;
  result: "done" | "failed" | "rolled_back";
  message: string;
}
export interface Pending {
  action: "update" | "rollback";
  from: string | null;
  to: string | null;
  by: string;
  at: number;
}

const HISTORY = "pin.update.history";
const PENDING = "pin.update.pending";
const SEEN = "pin.update.seen";
const MAX_HISTORY = 100;

export const readHistory = (rt: PinRuntime): HistoryEntry[] => {
  const v = rt.state.getSetting<HistoryEntry[]>(HISTORY);
  return Array.isArray(v) ? v : [];
};
export const setPending = (rt: PinRuntime, p: Pending | null) => rt.state.setSetting(PENDING, p);

export function addHistory(rt: PinRuntime, e: Omit<HistoryEntry, "id">) {
  const list = readHistory(rt);
  const id = `${e.at}-${list.length}`;
  rt.state.setSetting(HISTORY, [{ id, ...e, message: e.message.slice(0, 300) }, ...list].slice(0, MAX_HISTORY));
}

const TERMINAL: Record<string, HistoryEntry["result"]> = { done: "done", failed: "failed", rolled_back: "rolled_back" };

/**
 * Writes down what happened. A request made here is matched with the helper's final status; a version that changed
 * with no request (someone ran `epaperclip update` in a shell) is recorded as the host shell's doing.
 */
export function syncHistory(rt: PinRuntime, installed: string | null, status: { phase: string; message: string; at: number | null } | null) {
  const pending = rt.state.getSetting<Pending | null>(PENDING) ?? null;
  const seen = rt.state.getSetting<{ version: string | null; statusAt: number | null }>(SEEN) ?? { version: null, statusAt: null };
  const done = status && TERMINAL[status.phase] && status.at !== null && status.at !== seen.statusAt && (!pending || status.at >= pending.at - 5000) ? status : null;
  if (done && pending) {
    addHistory(rt, { at: done.at!, action: pending.action, from: pending.from, to: pending.to ?? installed, by: pending.by, result: TERMINAL[done.phase], message: done.message });
    setPending(rt, null);
  } else if (installed && seen.version && installed !== seen.version && !pending) {
    addHistory(rt, { at: rt.now(), action: "update", from: seen.version, to: installed, by: "host shell", result: "done", message: `Changed from ${seen.version} to ${installed} outside the console.` });
  }
  const next = { version: installed ?? seen.version, statusAt: done ? done.at : seen.statusAt };
  if (next.version !== seen.version || next.statusAt !== seen.statusAt) rt.state.setSetting(SEEN, next);
}

/** Whether an update to this version was already tried by the schedule and didn't finish. It isn't tried again on its own. */
export const failedBefore = (rt: PinRuntime, version: string) => readHistory(rt).some((h) => h.to === version && h.by === "schedule" && h.result !== "done");

// ---- Who hears about updates

const WATCHERS = "pin.update.watchers";
export const watchers = (rt: PinRuntime): string[] => {
  const v = rt.state.getSetting<string[]>(WATCHERS);
  return Array.isArray(v) ? v : [];
};
/** Administrators who have looked at updates are the ones reminded about them. */
export function watch(rt: PinRuntime, user: string) {
  const list = watchers(rt);
  if (list.includes(user)) return;
  rt.state.setSetting(WATCHERS, [user, ...list].slice(0, 20));
}
