import type { IncomingMessage, ServerResponse } from "node:http";
import { EngineDown, engineUnavailable, type EngineGateway } from "./engine.ts";
import { HttpError, sendJson } from "./http.ts";
import type { StateStore } from "./state.ts";

/**
 * Routine webhooks from outside the device. The engine's own webhook address is its loopback URL, unreachable from
 * anywhere else, so a service like GitHub can't call it. This is the one unauthenticated door into the engine, and it is
 * kept as small as it can be:
 *
 *   - OFF by default, and opened per organization by a Proxmox administrator (state setting "routineIngress");
 *   - exactly `POST /hooks/routines/<24 hex>/fire`, which is forwarded to the engine's
 *     `POST /api/routine-triggers/public/<id>/fire` and nothing else (no other path, method or engine route);
 *   - only for webhook triggers of an organization that is open (anything else answers the same 404 as a wrong address);
 *   - a 64 KiB cap on the body, JSON only, a short read timeout, and rate limits per address, per trigger and overall;
 *   - the headers a webhook sender signs with are passed through byte for byte (so the engine's HMAC checks work), and
 *     nothing else; the answer is the engine's status and JSON, or a plain error.
 *
 * The engine still decides whether the call is authentic: a trigger with signing mode "none" is protected only by the
 * secrecy of its address. docs/SECURITY.md has the full risk statement.
 */

export const INGRESS_PATH = /^\/hooks\/routines\/([0-9a-f]{24})\/fire$/;
export const INGRESS_MAX_BODY = 64 * 1024;
const SETTING = "routineIngress";
const FORWARD_HEADERS = ["content-type", "authorization", "x-paperclip-signature", "x-paperclip-timestamp", "x-hub-signature-256", "x-hub-signature", "idempotency-key", "x-github-delivery"];
const LIMITS = { perAddress: 60, perTrigger: 30, overall: 600, windowMs: 60_000 };
/** The only engine answers relayed as they are; anything else becomes a 502. */
const RELAYED = new Set([200, 201, 202, 400, 401, 403, 404, 409, 413, 415, 422, 429]);

interface Entry {
  enabledAt: number;
  by: string;
}
export const ingressSettings = (state: StateStore) => state.getSetting<Record<string, Entry>>(SETTING) ?? {};

export function setIngress(state: StateStore, now: () => number, companyId: string, enabled: boolean, by: string) {
  const all = { ...ingressSettings(state) };
  if (enabled) all[companyId] = { enabledAt: now(), by };
  else delete all[companyId];
  state.setSetting(SETTING, all);
}

export interface Hook {
  routineId: string;
  routine: string;
  triggerId: string;
  label: string | null;
  publicId: string;
  signingMode: string;
  enabled: boolean;
}

interface Routine {
  id: string;
  title?: string;
  triggers?: Trigger[];
}
interface Trigger {
  id: string;
  kind?: string;
  label?: string | null;
  publicId?: string | null;
  signingMode?: string | null;
  enabled?: boolean;
  archived?: boolean;
}

/** The webhook triggers of one organization, read from the engine as its administrator. */
export async function hooksOf(gateway: EngineGateway, companyId: string): Promise<Hook[]> {
  const list = (await gateway.serviceJson<Routine[] | { routines?: Routine[] }>("GET", `/api/companies/${encodeURIComponent(companyId)}/routines`)) ?? [];
  const routines = Array.isArray(list) ? list : (list.routines ?? []);
  const out: Hook[] = [];
  for (const r of routines.slice(0, 500)) {
    // The list may leave triggers out; the detail always has them.
    const full = Array.isArray(r.triggers) ? r : ((await gateway.serviceJson<Routine>("GET", `/api/routines/${encodeURIComponent(r.id)}`).catch(() => null)) ?? r);
    for (const t of full.triggers ?? []) {
      if (t.kind !== "webhook" || !t.publicId || !/^[0-9a-f]{24}$/.test(t.publicId) || t.archived) continue;
      out.push({ routineId: r.id, routine: r.title ?? "Routine", triggerId: t.id, label: t.label ?? null, publicId: t.publicId, signingMode: t.signingMode ?? "none", enabled: t.enabled !== false });
    }
  }
  return out;
}

export async function listIngress(state: StateStore, gateway: EngineGateway | null, orgs: { companyId: string; name: string }[]) {
  const on = ingressSettings(state);
  const out = [];
  for (const o of orgs) {
    const e = on[o.companyId];
    let hooks: Hook[] = [];
    let error: string | null = null;
    if (e && gateway) hooks = await hooksOf(gateway, o.companyId).catch((x: Error) => ((error = x.message), []));
    out.push({ companyId: o.companyId, name: o.name, enabled: Boolean(e), enabledAt: e?.enabledAt ?? null, by: e?.by ?? null, hooks, error });
  }
  return { organizations: out, path: "/hooks/routines/{id}/fire", maxBodyBytes: INGRESS_MAX_BODY, limits: { perAddressPerMinute: LIMITS.perAddress, perTriggerPerMinute: LIMITS.perTrigger, overallPerMinute: LIMITS.overall }, engineReady: gateway !== null };
}

class Counter {
  private readonly hits = new Map<string, { n: number; start: number }>();
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  /** Counts one hit; true when it is over the limit. */
  over(key: string, max: number): boolean {
    const t = this.now();
    if (this.hits.size > 20_000) for (const [k, v] of this.hits) if (t - v.start >= LIMITS.windowMs) this.hits.delete(k);
    const h = this.hits.get(key);
    if (!h || t - h.start >= LIMITS.windowMs) {
      this.hits.set(key, { n: 1, start: t });
      return false;
    }
    return ++h.n > max;
  }
}

const notFound = () => new HttpError(404, "not_found", "Not found");

export class RoutineIngress {
  private readonly state: StateStore;
  private readonly gateway: EngineGateway | null;
  private readonly now: () => number;
  private readonly counter: Counter;
  private cache = new Map<string, string>();
  private refreshedAt = 0;

  constructor(o: { state: StateStore; gateway: EngineGateway | null; now: () => number }) {
    this.state = o.state;
    this.gateway = o.gateway;
    this.now = o.now;
    this.counter = new Counter(o.now);
  }

  private async refresh(open: string[]) {
    this.refreshedAt = this.now();
    const next = new Map<string, string>();
    for (const companyId of open) for (const h of await hooksOf(this.gateway!, companyId).catch(() => [] as Hook[])) next.set(h.publicId, companyId);
    this.cache = next;
  }

  /** The organization a trigger belongs to, if it is one of an open organization. Looks again (at most every 20 seconds) when unknown. */
  private async companyOf(publicId: string, open: string[]): Promise<string | null> {
    const known = this.cache.get(publicId);
    if (known && open.includes(known)) return known;
    if (this.now() - this.refreshedAt > 20_000) await this.refresh(open);
    const found = this.cache.get(publicId);
    return found && open.includes(found) ? found : null;
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const m = INGRESS_PATH.exec(url.pathname);
    if (!m) throw notFound();
    const open = Object.keys(ingressSettings(this.state));
    // Off unless an administrator opened an organization: until then this door doesn't exist.
    if (!open.length || !this.gateway) throw notFound();
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      throw new HttpError(405, "method", "Method not allowed");
    }
    const ip = req.socket.remoteAddress ?? "?";
    if (this.counter.over("all", LIMITS.overall) || this.counter.over(`ip:${ip}`, LIMITS.perAddress) || this.counter.over(`id:${m[1]}`, LIMITS.perTrigger)) {
      res.setHeader("Retry-After", "60");
      throw new HttpError(429, "rate_limited", "Too many requests. Slow down.");
    }
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "json_only", "Send the payload as application/json");
    const announced = req.headers["content-length"] === undefined ? null : Number(req.headers["content-length"]);
    if (announced !== null && (!Number.isSafeInteger(announced) || announced < 0)) throw new HttpError(400, "bad_length", "Bad Content-Length");
    if (announced !== null && announced > INGRESS_MAX_BODY) throw new HttpError(413, "too_large", "That payload is too large");
    const body = await readCapped(req, INGRESS_MAX_BODY);
    if (!(await this.companyOf(m[1], open))) throw notFound();
    const headers: Record<string, string> = {};
    for (const name of FORWARD_HEADERS) {
      const v = req.headers[name];
      if (typeof v === "string" && v.length <= 2048 && !/[\r\n\0]/.test(v)) headers[name] = v;
    }
    const r = await this.gateway.firePublicTrigger(m[1], headers, body);
    if (!RELAYED.has(r.status)) throw new HttpError(502, "engine_error", "The engine didn't accept the call");
    let json: unknown = {};
    try {
      json = r.text ? JSON.parse(r.text) : {};
    } catch {
      json = {};
    }
    sendJson(res, r.status, json);
  }
}

async function readCapped(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => req.destroy(new HttpError(408, "request_timeout", "The request took too long to arrive")), 15_000);
  try {
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > max) throw new HttpError(413, "too_large", "That payload is too large");
      chunks.push(c as Buffer);
    }
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks);
}

export { EngineDown, engineUnavailable };
