import type { ProxmoxClient } from "@papercliped-engine/proxmox-client";
import type { EngineGateway } from "../engine.ts";
import type { Session } from "../sessions.ts";
import type { FeatureCtx } from "./index.ts";
import { DEFAULT_PREFS, INBOX_MAX, NOTICE_KINDS, newId, runtimeFor, type NoticeKind, type NoticeLevel, type Prefs, type PinRuntime } from "./pin-core.ts";

/**
 * Pin's notifications: task finished, backup failed, node events, engine approvals, automation results and proposals
 * waiting for a decision. A quiet inbox: every notice lands in the person's inbox, but only the ones that need them
 * (warnings and failures, outside their quiet hours, for kinds they haven't made quiet) are allowed to make the island
 * expand. Each person chooses which kinds they get at all, which stay quiet, and their quiet hours.
 *
 * Notices are collected for a person when they (or their open console) ask, as that person, so they only ever hear
 * about what Proxmox lets them see. Automation and proposal notices are added by the runner for the owner.
 */

const COLLECT_EVERY_MS = 20_000;
const FIRST_WINDOW_MS = 6 * 3600_000;

/** Task types worth a notice when they finish, with the words used for them. */
const TASKS: Record<string, string> = {
  vzdump: "Backup",
  vzrestore: "Restore", qmrestore: "Restore",
  qmstart: "Start", vzstart: "Start", qmstop: "Stop", vzstop: "Stop", qmshutdown: "Shut down", vzshutdown: "Shut down", qmreboot: "Reboot", vzreboot: "Reboot",
  qmcreate: "Create machine", vzcreate: "Create container", qmdestroy: "Delete machine", vzdestroy: "Delete container",
  qmclone: "Clone", qmigrate: "Migrate", vzmigrate: "Migrate",
  qmsnapshot: "Snapshot", vzsnapshot: "Snapshot", qmrollback: "Roll back", vzrollback: "Roll back",
  download: "Download", imgcopy: "Copy disk", move_volume: "Move disk",
};

export const isNoticeKind = (v: unknown): v is NoticeKind => typeof v === "string" && (NOTICE_KINDS as readonly string[]).includes(v);

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Whether `now` (the host's local time) is inside the person's quiet hours, which may run past midnight. */
export function inQuietHours(p: Prefs, now: number): boolean {
  const q = p.quietHours;
  if (!q.enabled) return false;
  const d = new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();
  const at = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const from = at(q.from);
  const to = at(q.to);
  if (from === to) return false;
  return from < to ? mins >= from && mins < to : mins >= from || mins < to;
}

export function parsePrefs(raw: Record<string, unknown>, cur: Prefs): Prefs {
  const bad = (m: string): never => {
    throw Object.assign(new Error(m), { bad: true });
  };
  const kinds = (v: unknown, what: string): NoticeKind[] => {
    if (!Array.isArray(v) || v.length > 20 || !v.every(isNoticeKind)) return bad(`${what} must be a list of notification kinds`);
    return [...new Set(v as NoticeKind[])];
  };
  const known = new Set(["muted", "quiet", "quietHours"]);
  for (const k of Object.keys(raw)) if (!known.has(k)) bad(`unknown field ${k}`);
  const next: Prefs = { ...cur, quietHours: { ...cur.quietHours } };
  if (raw.muted !== undefined) next.muted = kinds(raw.muted, "muted");
  if (raw.quiet !== undefined) next.quiet = kinds(raw.quiet, "quiet");
  if (raw.quietHours !== undefined) {
    const q = raw.quietHours as Record<string, unknown>;
    if (!q || typeof q !== "object" || Array.isArray(q)) bad("quietHours must be an object");
    for (const k of Object.keys(q)) if (!["enabled", "from", "to"].includes(k)) bad(`unknown field quietHours.${k}`);
    if (q.enabled !== undefined) {
      if (typeof q.enabled !== "boolean") bad("quietHours.enabled must be true or false");
      next.quietHours.enabled = q.enabled as boolean;
    }
    for (const k of ["from", "to"] as const) {
      if (q[k] === undefined) continue;
      if (typeof q[k] !== "string" || !HHMM.test(q[k] as string)) bad(`quietHours.${k} must look like 22:00`);
      next.quietHours[k] = q[k] as string;
    }
  }
  return next;
}

export interface NoticeInput {
  key: string;
  kind: NoticeKind;
  level: NoticeLevel;
  title: string;
  body: string;
  link?: string;
  at?: number;
}

/** Adds a notice to one person's inbox unless they muted the kind or they already have it. Returns whether it was added. */
export function pushNotice(rt: PinRuntime, user: string, n: NoticeInput): boolean {
  const prefs = rt.store.prefs(user);
  if (prefs.muted.includes(n.kind)) return false;
  const list = rt.store.inbox(user);
  if (list.some((x) => x.key === n.key)) return false;
  const at = n.at ?? rt.now();
  const peek = n.level !== "info" && !prefs.quiet.includes(n.kind) && !inQuietHours(prefs, rt.now());
  list.unshift({ id: newId(6), key: n.key, kind: n.kind, level: n.level, title: n.title.slice(0, 160), body: n.body.slice(0, 600), at, read: false, peek, ...(n.link ? { link: n.link } : {}) });
  rt.store.saveInbox(user, list.slice(0, INBOX_MAX));
  return true;
}

/** Removes notices that stopped being true (an approval someone else decided). */
function dropNotices(rt: PinRuntime, user: string, kind: NoticeKind, keep: (key: string) => boolean) {
  const list = rt.store.inbox(user);
  const next = list.filter((n) => n.kind !== kind || keep(n.key));
  if (next.length !== list.length) rt.store.saveInbox(user, next);
}

async function collectTasks(rt: PinRuntime, user: string, pve: ProxmoxClient, node: string) {
  const cur = rt.store.cursor(user);
  const since = cur.tasksSince || rt.now() - FIRST_WINDOW_MS;
  let newest = since;
  const tasks = await pve.tasks(node, 50).catch(() => []);
  for (const t of tasks) {
    if (typeof t.endtime !== "number") continue;
    const end = t.endtime * 1000;
    if (end <= since) continue;
    newest = Math.max(newest, end);
    const label = TASKS[t.type];
    if (!label) continue;
    const failed = !!t.status && t.status !== "OK" && !/^WARNINGS/.test(t.status);
    const what = `${label}${t.id ? ` ${t.id}` : ""}`;
    if (t.type === "vzdump") {
      // A backup failing matters to everyone who can see it, whoever started it.
      if (failed) pushNotice(rt, user, { key: `task:${t.upid}`, kind: "backup_failed", level: "critical", title: `Backup${t.id ? ` of ${t.id}` : ""} failed`, body: `${(t.status ?? "").slice(0, 300)}. Open Tasks for the log.`, link: "tasks", at: end });
      else if (t.user === user) pushNotice(rt, user, { key: `task:${t.upid}`, kind: "task_finished", level: "info", title: `${what} finished`, body: "Backup finished on Proxmox.", link: "tasks", at: end });
      continue;
    }
    if (t.user !== user) continue;
    pushNotice(rt, user, { key: `task:${t.upid}`, kind: "task_finished", level: failed ? "warning" : "info", title: failed ? `${what} failed` : `${what} finished`, body: failed ? `${(t.status ?? "").slice(0, 300)}. Open Tasks for the log.` : "Finished on Proxmox.", link: "tasks", at: end });
  }
  rt.store.saveCursor(user, { tasksSince: newest, collectedAt: rt.now() });
}

async function collectNodes(rt: PinRuntime, user: string, pve: ProxmoxClient) {
  const res = await pve.call<{ type: string; node?: string; status?: string }[]>("GET", "/cluster/resources", { type: "node" }).catch(() => []);
  const states = rt.store.nodeStates();
  const next = { ...states };
  for (const r of res) {
    if (r.type !== "node" || !r.node) continue;
    const now = r.status === "online" ? "online" : "offline";
    const before = states[r.node];
    next[r.node] = now;
    if (before === now || (before === undefined && now === "online")) continue;
    // The state change is keyed by when it was first seen, so going offline twice is two notices.
    const stamp = Math.floor(rt.now() / 60_000);
    if (now === "offline") pushNotice(rt, user, { key: `node:${r.node}:offline:${stamp}`, kind: "node_event", level: "critical", title: `${r.node} went offline`, body: "Proxmox reports this device as not online. Machines on it are unreachable until it is back.", link: "home" });
    else pushNotice(rt, user, { key: `node:${r.node}:online:${stamp}`, kind: "node_event", level: "info", title: `${r.node} is back online`, body: "Proxmox reports this device as online again.", link: "home" });
  }
  rt.store.saveNodeStates(next);
}

async function collectApprovals(rt: PinRuntime, user: string, s: Session, gw: EngineGateway | null) {
  if (!gw) return;
  const companies = await gw.userJson<{ id: string; name: string }[]>(s, "GET", "/api/companies").catch(() => null);
  if (!companies) return;
  const pending = new Set<string>();
  let complete = true;
  for (const c of companies.slice(0, 50)) {
    const list = await gw.userJson<{ id: string; type?: string; status?: string }[]>(s, "GET", `/api/companies/${encodeURIComponent(c.id)}/approvals?status=pending`).catch(() => null);
    if (!list) {
      complete = false;
      continue;
    }
    for (const a of list.slice(0, 100)) {
      const key = `approval:${a.id}`;
      pending.add(key);
      pushNotice(rt, user, { key, kind: "approval", level: "warning", title: `A decision is waiting in ${c.name}`, body: `${a.type ? `A ${String(a.type).replace(/[_-]+/g, " ")} request needs` : "A request needs"} an owner's approval.`, link: "home" });
    }
  }
  // Only forget decided approvals when every organization answered, so a hiccup doesn't empty the inbox.
  if (complete) dropNotices(rt, user, "approval", (k) => pending.has(k));
}

/** Gathers what's new for one person. Quick when called often: at most one pass every 20 seconds. */
export async function collectFor(rt: PinRuntime, pve: ProxmoxClient, s: Session, node: string, gw: EngineGateway | null, force = false) {
  const cur = rt.store.cursor(s.username);
  if (!force && rt.now() - cur.collectedAt < COLLECT_EVERY_MS) return;
  // Mark the pass first so two open tabs don't collect at once.
  rt.store.saveCursor(s.username, { ...cur, collectedAt: rt.now() });
  await Promise.all([collectTasks(rt, s.username, pve, node), collectNodes(rt, s.username, pve), collectApprovals(rt, s.username, s, gw)]).catch(() => {});
}

/** Routes: /api/pin/notifications and /api/pin/notification-prefs. */
export async function notifyRoutes(ctx: FeatureCtx): Promise<boolean> {
  const { path, method, HttpError } = ctx;
  if (!path.startsWith("/api/pin/notification")) return false;
  const rt = runtimeFor(ctx.state);

  if (path === "/api/pin/notifications" && method === "GET") {
    const s = ctx.session();
    // Collecting reads Proxmox as the person. A token with no permissions simply collects nothing.
    await ctx.asUser((pve, sess) => collectFor(rt, pve, sess, ctx.node, ctx.gateway, ctx.url.searchParams.get("refresh") === "1")).catch((e) => {
      if (e instanceof HttpError && e.status === 401) throw e;
    });
    const list = rt.store.inbox(s.username);
    return ctx.json(200, { notifications: list, unread: list.filter((n) => !n.read).length, prefs: rt.store.prefs(s.username), kinds: NOTICE_KINDS }), true;
  }

  if (path === "/api/pin/notifications/read" && method === "POST") {
    ctx.sameSite();
    const s = ctx.session();
    const b = await ctx.readJson();
    const ids = b.ids;
    if (b.all !== true && !(Array.isArray(ids) && ids.length <= 200 && ids.every((i) => typeof i === "string" && /^[0-9a-f]{12}$/.test(i)))) throw new HttpError(400, "bad_request", "Send {all: true} or a list of notification ids");
    const set = new Set(b.all === true ? [] : (ids as string[]));
    rt.store.saveInbox(s.username, rt.store.inbox(s.username).map((n) => (b.all === true || set.has(n.id) ? { ...n, read: true, peek: false } : n)));
    return ctx.json(200, { ok: true }), true;
  }

  if (path === "/api/pin/notifications/clear" && method === "POST") {
    ctx.sameSite();
    const s = ctx.session();
    // Clearing removes what has been read; anything unread stays so nothing is lost by accident.
    rt.store.saveInbox(s.username, rt.store.inbox(s.username).filter((n) => !n.read));
    return ctx.json(200, { ok: true }), true;
  }

  if (path === "/api/pin/notification-prefs") {
    const s = ctx.session();
    if (method === "GET") return ctx.json(200, { prefs: rt.store.prefs(s.username), defaults: DEFAULT_PREFS, kinds: NOTICE_KINDS }), true;
    if (method === "PUT") {
      ctx.sameSite();
      const b = await ctx.readJson();
      try {
        const next = parsePrefs(b, rt.store.prefs(s.username));
        rt.store.savePrefs(s.username, next);
        return ctx.json(200, { prefs: next }), true;
      } catch (e) {
        if ((e as { bad?: boolean }).bad) throw new HttpError(400, "bad_request", (e as Error).message);
        throw e;
      }
    }
  }
  throw new HttpError(405, "method", "Method not allowed");
}
