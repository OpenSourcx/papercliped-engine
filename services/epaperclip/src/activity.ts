import { redact } from "./connectors.ts";

/**
 * What the host service and Pin are doing, as a short in-memory log (the last few hundred events) that is also printed
 * to the service's journal. It exists so a failure that used to leave no trace (a model that never answers, a rate
 * limit, a tool that timed out) can be seen with `journalctl -u epaperclip` and through `GET /api/activity`.
 *
 * It records what happened and how long it took, never what anyone said: no prompts, no answers, no tool arguments or
 * results, no keys. Free text from outside (a provider's error message) is passed through `redact` and cut short.
 */

export type Level = "info" | "warn" | "error";
export type Source = "host" | "pin" | "engine";

export interface ActivityEvent {
  /** Counts up from 1 for the life of the process, so a reader can ask for "everything after n". */
  n: number;
  at: number;
  level: Level;
  source: Source;
  /** A stable name such as `pin.model.retry`, for filtering and alerting. */
  event: string;
  message: string;
  /** Small scalar facts: names, codes, milliseconds, counts. */
  data?: Record<string, string | number | boolean | null>;
}

const MAX = 500;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function clean(data: Record<string, unknown> | undefined): ActivityEvent["data"] {
  if (!data) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (typeof v === "string") out[k] = clip(redact(v) ?? "", 200);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
  }
  return out;
}

export class ActivityLog {
  private events: ActivityEvent[] = [];
  private seq = 0;
  /** Where lines go besides memory; the journal in production, nowhere in tests. */
  out: ((level: Level, line: string) => void) | null = null;
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  record(level: Level, source: Source, event: string, message: string, data?: Record<string, unknown>): ActivityEvent {
    const e: ActivityEvent = { n: ++this.seq, at: this.now(), level, source, event, message: clip(redact(message) ?? "", 300), ...(data ? { data: clean(data) } : {}) };
    this.events.push(e);
    if (this.events.length > MAX) this.events.splice(0, this.events.length - MAX);
    this.out?.(level, `epaperclip: ${source} ${event}: ${e.message}${e.data ? ` ${JSON.stringify(e.data)}` : ""}`);
    return e;
  }
  info = (source: Source, event: string, message: string, data?: Record<string, unknown>) => this.record("info", source, event, message, data);
  warn = (source: Source, event: string, message: string, data?: Record<string, unknown>) => this.record("warn", source, event, message, data);
  error = (source: Source, event: string, message: string, data?: Record<string, unknown>) => this.record("error", source, event, message, data);

  /** Newest last. `after` is an event number from an earlier read; `level` is the lowest level wanted. */
  list(f: { source?: string; level?: Level; after?: number; since?: number; event?: string; limit?: number } = {}): ActivityEvent[] {
    const rank: Record<Level, number> = { info: 0, warn: 1, error: 2 };
    const min = f.level ? rank[f.level] : 0;
    const hit = this.events.filter((e) => (!f.source || e.source === f.source) && rank[e.level] >= min && (f.after === undefined || e.n > f.after) && (f.since === undefined || e.at >= f.since) && (!f.event || e.event.startsWith(f.event)));
    return hit.slice(-Math.min(Math.max(f.limit ?? 100, 1), MAX));
  }

  clear() {
    this.events = [];
  }
}

/** The one log for the process. */
export const activity = new ActivityLog();
activity.out = (level, line) => (level === "error" ? console.error(line) : level === "warn" ? console.warn(line) : console.log(line));
