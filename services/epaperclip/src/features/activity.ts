import { readFileSync } from "node:fs";
import { activity, type Level } from "../activity.ts";
import type { FeatureCtx } from "./index.ts";
import { runtimeFor } from "./pin-core.ts";

/**
 * What ePaperclip and Pin are doing, for administrators and for scripts (docs/ACTIVITY.md). Both routes answer a Proxmox
 * administrator signed in to the console or holding an API token that acts as one. Nothing here carries what anyone said:
 * no prompts, answers, tool arguments or keys; only names, codes, counts and timings.
 *
 *   GET /api/activity?source=pin|engine|host&level=info|warn|error&event=pin.model&after=<n>&since=<ms>&limit=<1..500>
 *   GET /api/status
 */

const LEVELS = new Set(["info", "warn", "error"]);
const HOUR = 3600_000;

const num = (v: string | null): number | undefined => {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

function installedVersion(ctx: FeatureCtx): string | null {
  try {
    return readFileSync(runtimeFor(ctx.state).opts.update?.versionFile ?? "/opt/epaperclip/VERSION", "utf8").trim() || null;
  } catch {
    return null;
  }
}

export async function handleActivity(ctx: FeatureCtx): Promise<boolean> {
  if (ctx.path !== "/api/activity" && ctx.path !== "/api/status") return false;
  const { HttpError, method } = ctx;
  if (method !== "GET") throw new HttpError(405, "method", "Method not allowed");
  ctx.session();
  if (!(await ctx.asUser((pve) => ctx.isNodeAdmin(pve)))) throw new HttpError(403, "forbidden", "Only Proxmox administrators (Sys.Modify on /) can see what the service is doing.");

  if (ctx.path === "/api/activity") {
    const q = ctx.url.searchParams;
    const level = q.get("level");
    if (level && !LEVELS.has(level)) throw new HttpError(400, "bad_request", "level is info, warn or error.");
    const source = q.get("source");
    if (source && !["host", "pin", "engine"].includes(source)) throw new HttpError(400, "bad_request", "source is host, pin or engine.");
    const events = activity.list({ ...(source ? { source } : {}), ...(level ? { level: level as Level } : {}), ...(q.get("event") ? { event: q.get("event")! } : {}), after: num(q.get("after")), since: num(q.get("since")), limit: num(q.get("limit")) });
    return ctx.json(200, { events, latest: events.at(-1)?.n ?? num(q.get("after")) ?? 0, now: ctx.now() }), true;
  }

  const now = ctx.now();
  const recent = activity.list({ since: now - HOUR, limit: 500 });
  const pin = recent.filter((e) => e.source === "pin");
  const errors = pin.filter((e) => e.event === "pin.chat.error");
  const byCode: Record<string, number> = {};
  for (const e of errors) byCode[String(e.data?.code ?? "unknown")] = (byCode[String(e.data?.code ?? "unknown")] ?? 0) + 1;
  const turns = pin.filter((e) => e.event === "pin.model.turn");
  const ms = turns.map((e) => Number(e.data?.ms ?? 0)).sort((a, b) => a - b);
  const starts = pin.filter((e) => e.event === "pin.chat.start");
  const ended = pin.filter((e) => e.event === "pin.chat.done" || e.event === "pin.chat.error" || e.event === "pin.chat.stopped" || e.event === "pin.chat.crash");
  const lastStart = starts.at(-1);
  const engine = ctx.gateway ? await ctx.gateway.status().catch((e: Error) => ({ reachable: false, ready: false, error: e.message })) : null;
  return ctx.json(200, {
    service: { version: installedVersion(ctx), uptimeSec: Math.round(process.uptime()), node: ctx.node, now },
    engine,
    pin: {
      lastHour: { chats: starts.length, answered: pin.filter((e) => e.event === "pin.chat.done").length, failed: errors.length, stopped: pin.filter((e) => e.event === "pin.chat.stopped").length, retries: pin.filter((e) => e.event === "pin.model.retry").length, fallbacks: pin.filter((e) => e.event === "pin.model.fallback").length, toolFailures: pin.filter((e) => e.event === "pin.tool" && e.level === "warn").length, errorsByCode: byCode },
      modelTurnMs: ms.length ? { count: ms.length, median: ms[Math.floor(ms.length / 2)], max: ms.at(-1) } : null,
      // A chat that started and hasn't ended, or whose model call has been going a while, is the "Pin is stuck" case.
      inFlight: Math.max(0, starts.length - ended.length),
      lastChat: lastStart ? { at: lastStart.at, provider: lastStart.data?.provider ?? null, model: lastStart.data?.model ?? null, permission: lastStart.data?.permission ?? null } : null,
      lastError: errors.at(-1) ?? null,
    },
    problems: recent.filter((e) => e.level !== "info").slice(-10),
  }), true;
}
