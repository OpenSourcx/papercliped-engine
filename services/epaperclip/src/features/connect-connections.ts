import { HttpError } from "../http.ts";
import { Connectors, checkApiKey, errorDetail, isProvider, providerProblem, providerRequest, redact, type Endpoint, type HttpFetch, type ProviderRef } from "../connectors.ts";
import type { ExtraProviders } from "../pin.ts";
import type { StateStore } from "../state.ts";
import { CATALOG, catalogEntry, checkBaseUrl, type CatalogEntry } from "./connect-catalog.ts";
import { cleanText } from "./connect-util.ts";
import { appendAudit } from "./access-tokens.ts";
import type { FeatureCtx } from "./index.ts";

/**
 * Connections: every model service ePaperclip can use, in one list. The four built-in providers keep their keys in the
 * connectors store; hosted services from the catalog and local or custom OpenAI-compatible servers (Ollama, LM Studio,
 * llama.cpp, vLLM ...) are added here, with their key sealed in the vault. For each one an administrator sets:
 *
 *  - who may use it: Pin, and which organizations' agents (docs/CONNECTORS.md),
 *  - a default model (used for fallbacks and tests), an optional price per million tokens (for cost display),
 *  - its place in the fallback chain Pin follows when the chosen service can't answer.
 *
 * Keys are write-only. Usage (calls and tokens per day, connection and model) is kept for 62 days, with no text.
 */

const META = "connect.connections";
const USAGE = "connect.usage";
const FALLBACKS = "connect.fallbacks";
const USAGE_DAYS = 62;
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const COMPANY = /^[A-Za-z0-9_-]{1,64}$/;
const MODEL = /^[\w.:/@+-]{1,200}$/;

export interface ConnectionMeta {
  id: string;
  catalog: string;
  label: string;
  /** Custom connections only. */
  baseUrl?: string;
  builtin: boolean;
  enabled: boolean;
  pin: boolean;
  /** Organizations whose agents may use it (company ids). */
  orgs: string[];
  model: string | null;
  price: { inPerM: number; outPerM: number } | null;
  createdAt: number;
  createdBy: string;
  last4?: string;
  testedAt?: number;
  ok?: boolean;
  error?: string;
  latencyMs?: number;
  modelCount?: number;
}

type UsageDay = Record<string, [calls: number, tokensIn: number, tokensOut: number]>;

export const pidOf = (m: Pick<ConnectionMeta, "id" | "builtin">) => (m.builtin ? m.id : `x:${m.id}`);

export class ConnectionsStore {
  private readonly state: StateStore;
  private readonly connectors: Connectors;
  private readonly fetch: HttpFetch;
  private readonly now: () => number;
  private readonly lastTest = new Map<string, number>();

  constructor(o: { state: StateStore; connectors: Connectors; fetch: HttpFetch; now: () => number }) {
    this.state = o.state;
    this.connectors = o.connectors;
    this.fetch = o.fetch;
    this.now = o.now;
  }

  private metas = (): Record<string, ConnectionMeta> => this.state.getSetting<Record<string, ConnectionMeta>>(META) ?? {};
  private saveMetas = (m: Record<string, ConnectionMeta>) => this.state.setSetting(META, m);
  private secretName = (id: string) => `connection.${id}.apiKey`;

  /** Everything, built-in providers first (whether or not a key is set), then the added ones. */
  list(): (ConnectionMeta & { configured: boolean; entry: Pick<CatalogEntry, "kind" | "protocol" | "keyRequired" | "engine" | "subscription" | "keysUrl" | "note"> })[] {
    const metas = this.metas();
    const out: ReturnType<ConnectionsStore["list"]> = [];
    const builtin = this.connectors.list();
    for (const c of builtin) {
      const m = metas[c.id];
      const e = catalogEntry(c.id)!;
      out.push({
        id: c.id, catalog: c.id, label: c.label, builtin: true, enabled: m?.enabled ?? true, pin: m?.pin ?? true, orgs: m?.orgs ?? [], model: m?.model ?? null, price: m?.price ?? null,
        createdAt: m?.createdAt ?? c.updatedAt ?? 0, createdBy: c.updatedBy ?? "", configured: c.configured, ...(c.last4 ? { last4: c.last4 } : {}),
        ...(c.testedAt ? { testedAt: c.testedAt, ok: c.ok, ...(c.error ? { error: c.error } : {}) } : {}), ...(m?.latencyMs ? { latencyMs: m.latencyMs } : {}), ...(m?.modelCount !== undefined ? { modelCount: m.modelCount } : {}),
        entry: pick(e),
      });
    }
    for (const m of Object.values(metas).filter((x) => !x.builtin).sort((a, b) => a.createdAt - b.createdAt)) {
      const e = catalogEntry(m.catalog);
      if (!e) continue;
      out.push({ ...m, configured: !e.keyRequired || this.hasKey(m.id), entry: pick(e) });
    }
    return out;
  }

  private hasKey(id: string): boolean {
    try {
      return this.state.getSecret(this.secretName(id)) !== null;
    } catch {
      return false;
    }
  }

  get(id: string) {
    return this.list().find((c) => c.id === id);
  }

  create(b: Record<string, unknown>, who: string) {
    for (const k of Object.keys(b)) if (!["catalog", "id", "label", "baseUrl", "apiKey", "model"].includes(k)) throw new HttpError(400, "bad_request", `Unknown field ${cleanText(k, 30)}`);
    const e = typeof b.catalog === "string" ? catalogEntry(b.catalog) : undefined;
    if (!e) throw new HttpError(400, "bad_request", "Pick a provider from the catalog.");
    if (e.builtin) throw new HttpError(400, "builtin", `${e.label} is built in. Set its key in the list.`);
    const metas = this.metas();
    const id = b.id === undefined ? this.freeId(e.id, metas) : String(b.id);
    if (!ID.test(id) || catalogEntry(id)?.builtin || metas[id]) throw new HttpError(409, "id_taken", "That name is taken or not allowed. Use lowercase letters, digits and dashes.");
    if (Object.keys(metas).length >= 40) throw new HttpError(409, "too_many", "That's enough connections. Remove one you don't use.");
    const baseUrl = e.baseEditable ? checkBaseUrl(b.baseUrl ?? e.base) : undefined;
    if (e.kind === "custom" && !baseUrl) throw new HttpError(400, "bad_address", "Enter the server's address.");
    const label = cleanText(b.label, 60) || e.label;
    const model = b.model === undefined || b.model === null || b.model === "" ? null : this.modelId(b.model);
    let key: string | null = null;
    if (b.apiKey !== undefined && b.apiKey !== "") key = checkApiKey(b.apiKey);
    if (e.keyRequired && !key) throw new HttpError(400, "bad_key", `${e.label} needs an API key.`);
    if (key) this.state.setSecret(this.secretName(id), key);
    metas[id] = { id, catalog: e.id, label, ...(baseUrl ? { baseUrl } : {}), builtin: false, enabled: true, pin: true, orgs: [], model, price: null, createdAt: this.now(), createdBy: who, ...(key ? { last4: key.slice(-4) } : {}) };
    try {
      this.saveMetas(metas);
    } catch (err) {
      if (key) this.state.deleteSecret(this.secretName(id));
      throw err;
    }
    this.audit(who, "connection.create", id, `${label} (${e.id})`);
    return this.get(id)!;
  }

  private freeId(base: string, metas: Record<string, ConnectionMeta>): string {
    for (let i = 0; i < 100; i++) {
      const id = i === 0 ? base : `${base}-${i + 1}`;
      if (!metas[id] && !catalogEntry(id)?.builtin) return id;
    }
    throw new HttpError(409, "id_taken", "Pick a name for this connection.");
  }

  private modelId(v: unknown): string {
    if (typeof v !== "string" || !MODEL.test(v)) throw new HttpError(400, "bad_request", "Pick a model from the list.");
    return v;
  }

  private audit(actor: string, action: string, target: string, detail?: string) {
    try {
      appendAudit(this.state, this.now, { actor, action, target, ...(detail ? { detail: detail.slice(0, 200) } : {}) });
    } catch {
      /* never break a request */
    }
  }

  update(id: string, b: Record<string, unknown>, who: string) {
    const cur = this.get(id);
    if (!cur) throw new HttpError(404, "not_found", "No such connection");
    for (const k of Object.keys(b)) if (!["label", "enabled", "pin", "orgs", "model", "price", "baseUrl"].includes(k)) throw new HttpError(400, "bad_request", `Unknown field ${cleanText(k, 30)}`);
    const metas = this.metas();
    const m: ConnectionMeta = metas[id] ?? { id, catalog: id, label: cur.label, builtin: true, enabled: true, pin: true, orgs: [], model: null, price: null, createdAt: this.now(), createdBy: who };
    if (b.label !== undefined) {
      if (m.builtin) throw new HttpError(400, "builtin", "Built-in providers keep their names.");
      m.label = cleanText(b.label, 60) || m.label;
    }
    for (const k of ["enabled", "pin"] as const) {
      if (b[k] === undefined) continue;
      if (typeof b[k] !== "boolean") throw new HttpError(400, "bad_request", `${k} is true or false`);
      m[k] = b[k] as boolean;
    }
    if (b.orgs !== undefined) {
      if (!Array.isArray(b.orgs) || b.orgs.length > 100 || !b.orgs.every((x) => typeof x === "string" && COMPANY.test(x))) throw new HttpError(400, "bad_request", "orgs is a list of organization ids");
      m.orgs = [...new Set(b.orgs as string[])];
    }
    if (b.model !== undefined) m.model = b.model === null || b.model === "" ? null : this.modelId(b.model);
    if (b.price !== undefined) {
      if (b.price === null) m.price = null;
      else {
        const p = b.price as { inPerM?: unknown; outPerM?: unknown };
        const ok = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100_000;
        if (!p || typeof p !== "object" || !ok(p.inPerM) || !ok(p.outPerM) || Object.keys(p).length !== 2) throw new HttpError(400, "bad_request", "price is { inPerM, outPerM } in dollars per million tokens");
        m.price = { inPerM: p.inPerM as number, outPerM: p.outPerM as number };
      }
    }
    if (b.baseUrl !== undefined) {
      const e = catalogEntry(m.catalog);
      if (m.builtin || !e?.baseEditable) throw new HttpError(400, "fixed_address", "This provider's address is fixed.");
      m.baseUrl = checkBaseUrl(b.baseUrl);
    }
    metas[id] = m;
    this.saveMetas(metas);
    this.audit(who, "connection.update", id, Object.keys(b).join(", "));
    return this.get(id)!;
  }

  setKey(id: string, apiKey: unknown, who: string) {
    const cur = this.get(id);
    if (!cur) throw new HttpError(404, "not_found", "No such connection");
    if (cur.builtin) return this.connectors.setKey(id as never, apiKey, who);
    const key = checkApiKey(apiKey);
    this.state.setSecret(this.secretName(id), key);
    const metas = this.metas();
    metas[id] = { ...metas[id], last4: key.slice(-4), ok: undefined, error: undefined, testedAt: undefined };
    this.saveMetas(metas);
    this.audit(who, "connection.key", id, "key replaced");
    return this.get(id)!;
  }

  remove(id: string, who: string) {
    const cur = this.get(id);
    if (!cur) throw new HttpError(404, "not_found", "No such connection");
    const metas = this.metas();
    if (cur.builtin) this.connectors.remove(id as never);
    else this.state.deleteSecret(this.secretName(id));
    delete metas[id];
    this.saveMetas(metas);
    this.setFallbacks(this.fallbackOrder().filter((x) => x !== pidOf(cur)));
    this.audit(who, "connection.remove", id, cur.label);
  }

  // ---- Talking to the service

  /** Where the service is and the key to use. Built-in providers go through their own record. */
  private endpoint(id: string): { ref: ProviderRef; key: string } | null {
    if (isProvider(id)) {
      const key = this.connectors.key(id);
      return key ? { ref: id, key } : null;
    }
    const m = this.metas()[id];
    const e = m && catalogEntry(m.catalog);
    if (!m || !e) return null;
    let key = "";
    try {
      key = this.state.getSecret(this.secretName(id)) ?? "";
    } catch {
      key = "";
    }
    if (e.keyRequired && !key) return null;
    const base = (m.baseUrl ?? e.base).replace(/\/+$/, "");
    const ref: Endpoint = { id: pidOf(m), label: m.label, protocol: e.protocol, base, modern: false };
    return { ref, key };
  }

  /** One real, minimal request with the stored key: lists models, or asks for one token where there is no list. */
  async test(id: string, who: string) {
    const cur = this.get(id);
    if (!cur) throw new HttpError(404, "not_found", "No such connection");
    const t = this.lastTest.get(id) ?? 0;
    if (this.now() - t < 3000) throw new HttpError(429, "rate_limited", "Wait a few seconds between tests.");
    this.lastTest.set(id, this.now());
    const ep = this.endpoint(id);
    if (!ep) throw new HttpError(400, "not_configured", `${cur.label} has no API key yet`);
    const e = catalogEntry(cur.catalog)!;
    const started = this.now();
    let result: { ok: boolean; error?: string; modelCount?: number };
    try {
      if (e.testModel) {
        const { url, headers } = providerRequest(ep.ref, ep.key, "/chat/completions");
        const r = await this.fetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ model: e.testModel, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }), signal: AbortSignal.timeout(15_000) });
        const text = await r.text();
        result = r.ok ? { ok: true } : { ok: false, error: providerProblem(ep.ref, r.status, redact(errorDetail(text), ep.key)).message };
      } else {
        const models = await this.discover(ep);
        result = { ok: true, modelCount: models.length };
      }
    } catch (err) {
      result = { ok: false, error: err instanceof HttpError ? err.message : this.unreachable(cur, err) };
    }
    const ms = this.now() - started;
    if (!isProvider(id)) {
      const metas = this.metas();
      if (metas[id]) {
        metas[id] = { ...metas[id], testedAt: this.now(), ok: result.ok, latencyMs: ms, ...(result.modelCount !== undefined ? { modelCount: result.modelCount } : {}) };
        if (result.ok) delete metas[id].error;
        else metas[id].error = result.error;
        this.saveMetas(metas);
      }
    } else {
      // Built-in providers keep their last result in the connectors store; the extras go beside it.
      await this.connectors.test(id as never).catch(() => undefined);
      const metas = this.metas();
      metas[id] = { ...(metas[id] ?? { id, catalog: id, label: cur.label, builtin: true, enabled: true, pin: true, orgs: [], model: null, price: null, createdAt: this.now(), createdBy: who }), latencyMs: ms, ...(result.modelCount !== undefined ? { modelCount: result.modelCount } : {}) };
      this.saveMetas(metas);
    }
    return { ...this.get(id)!, ok: result.ok, ...(result.error ? { error: result.error } : {}) };
  }

  private unreachable(cur: { label: string; baseUrl?: string }, err: unknown): string {
    const name = (err as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") return `${cur.label} didn't answer within 15 seconds.`;
    let where = "";
    try {
      where = cur.baseUrl ? ` at ${new URL(cur.baseUrl).host}` : "";
    } catch {
      where = "";
    }
    return `Couldn't reach ${cur.label}${where}. Is it running, and can this host reach that address?`;
  }

  /** The models a connection offers, read from the service (never written down here). */
  async discover(ep: { ref: ProviderRef; key: string }): Promise<{ id: string; label: string }[]> {
    const proto = typeof ep.ref === "string" ? (ep.ref === "anthropic" ? "anthropic" : ep.ref === "gemini" ? "gemini" : "openai") : ep.ref.protocol;
    const path = proto === "anthropic" ? "/models?limit=1000" : proto === "gemini" ? "/models?pageSize=1000" : "/models";
    const { url, headers } = providerRequest(ep.ref, ep.key, path);
    const r = await this.fetch(url, { method: "GET", headers: { ...headers, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    const text = await r.text();
    if (!r.ok) {
      const p = providerProblem(ep.ref, r.status, redact(errorDetail(text), ep.key));
      throw new HttpError(502, p.code, p.message);
    }
    let j: Record<string, any>;
    try {
      j = JSON.parse(text);
    } catch {
      throw new HttpError(502, "provider_error", "The server sent a model list that couldn't be read.");
    }
    const raw: any[] = proto === "gemini" ? (Array.isArray(j.models) ? j.models : []) : Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
    const out = raw
      .map((m) => ({ id: String(proto === "gemini" ? (m?.name ?? "").replace(/^models\//, "") : (m?.id ?? m?.name ?? m?.model ?? "")), label: String(m?.display_name ?? m?.displayName ?? m?.id ?? m?.name ?? "") }))
      .filter((m) => MODEL.test(m.id));
    return out.slice(0, 1000);
  }

  async models(id: string): Promise<{ id: string; label: string }[]> {
    const ep = this.endpoint(id);
    if (!ep) throw new HttpError(404, "not_configured", "That connection has no key yet");
    try {
      return await this.discover(ep);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, "provider_unreachable", this.unreachable(this.get(id)!, err));
    }
  }

  /** Where the Router sends a request for this connection, and the key: null when it is switched off or has no key. */
  routeTarget(id: string): { ref: ProviderRef; key: string } | null {
    const c = this.get(id);
    return c && c.enabled && c.configured ? this.endpoint(id) : null;
  }

  // ---- Fallbacks and Pin

  fallbackOrder = (): string[] => this.state.getSetting<string[]>(FALLBACKS) ?? [];
  setFallbacks(order: string[]) {
    this.state.setSetting(FALLBACKS, order);
  }
  saveFallbackOrder(order: unknown, who: string): string[] {
    if (!Array.isArray(order) || order.length > 20 || !order.every((x) => typeof x === "string")) throw new HttpError(400, "bad_request", "order is a list of connection ids");
    const known = new Set(this.list().map((c) => pidOf(c)));
    const ids = [...new Set(order as string[])];
    for (const x of ids) if (!known.has(x)) throw new HttpError(400, "bad_request", "Unknown connection in the list");
    for (const x of ids) {
      const c = this.list().find((y) => pidOf(y) === x)!;
      if (!c.model) throw new HttpError(400, "no_model", `${c.label} needs a default model before it can be a fallback.`);
    }
    this.setFallbacks(ids);
    this.audit(who, "connection.fallbacks", "chain", ids.join(" > "));
    return ids;
  }

  /** The view Pin uses: the added connections, their fallbacks, and the usage ledger. */
  forPin(): ExtraProviders & { hidden(pid: string): boolean } {
    const self = this;
    return {
      usable: () => this.list().filter((c) => !c.builtin && c.enabled && c.pin && c.configured).map((c) => ({ id: pidOf(c), label: c.label })),
      hidden: (pid) => {
        const c = this.list().find((x) => x.builtin && x.id === pid);
        return !!c && (!c.enabled || !c.pin);
      },
      resolve: (pid) => {
        const id = pid.replace(/^x:/, "");
        const c = this.get(id);
        if (!c || c.builtin || !c.enabled || !c.pin) return null;
        const ep = this.endpoint(id);
        return ep && typeof ep.ref !== "string" ? { ref: ep.ref, key: ep.key } : null;
      },
      stamp: (pid) => {
        const c = this.get(pid.replace(/^x:/, ""));
        return c ? `${c.last4 ?? ""}:${c.baseUrl ?? ""}` : "none";
      },
      fallbacks: (pid) =>
        self.fallbackOrder()
          .filter((x) => x !== pid)
          .map((x) => {
            const c = self.list().find((y) => pidOf(y) === x);
            return c && c.enabled && c.pin && c.configured && c.model ? { pid: x, model: c.model } : null;
          })
          .filter((x): x is { pid: string; model: string } => x !== null),
      usage: (pid, model, t) => this.recordUsage(pid, model, t),
    };
  }

  // ---- Usage and cost

  private day(t: number) {
    return new Date(t).toISOString().slice(0, 10);
  }

  recordUsage(pid: string, model: string, t: { in: number; out: number }) {
    try {
      const all = this.state.getSetting<Record<string, UsageDay>>(USAGE) ?? {};
      const d = this.day(this.now());
      const day = (all[d] ??= {});
      const k = `${pid}|${model}`.slice(0, 220);
      const cur = day[k] ?? [0, 0, 0];
      day[k] = [cur[0] + 1, cur[1] + Math.max(0, Math.round(t.in)), cur[2] + Math.max(0, Math.round(t.out))];
      for (const old of Object.keys(all).sort().slice(0, Math.max(0, Object.keys(all).length - USAGE_DAYS))) delete all[old];
      this.state.setSetting(USAGE, all);
    } catch {
      /* usage is a convenience; never break a chat for it */
    }
  }

  usage(days: number) {
    const all = this.state.getSetting<Record<string, UsageDay>>(USAGE) ?? {};
    const since = this.day(this.now() - (days - 1) * 86_400_000);
    const rows = new Map<string, { connection: string; model: string; calls: number; tokensIn: number; tokensOut: number }>();
    const perDay: { day: string; tokensIn: number; tokensOut: number; calls: number }[] = [];
    for (const [d, entries] of Object.entries(all).sort()) {
      if (d < since) continue;
      let ti = 0, to = 0, c = 0;
      for (const [k, [calls, i, o]] of Object.entries(entries)) {
        const [connection, model] = k.split("|");
        const r = rows.get(k) ?? { connection, model, calls: 0, tokensIn: 0, tokensOut: 0 };
        r.calls += calls;
        r.tokensIn += i;
        r.tokensOut += o;
        rows.set(k, r);
        ti += i; to += o; c += calls;
      }
      perDay.push({ day: d, tokensIn: ti, tokensOut: to, calls: c });
    }
    const list = this.list();
    const byConnection = new Map<string, { id: string; label: string; calls: number; tokensIn: number; tokensOut: number; costUsd: number | null; priced: boolean }>();
    for (const r of rows.values()) {
      const c = list.find((x) => pidOf(x) === r.connection);
      const b = byConnection.get(r.connection) ?? { id: r.connection, label: c?.label ?? r.connection, calls: 0, tokensIn: 0, tokensOut: 0, costUsd: c?.price ? 0 : null, priced: !!c?.price };
      b.calls += r.calls;
      b.tokensIn += r.tokensIn;
      b.tokensOut += r.tokensOut;
      if (c?.price) b.costUsd = (b.costUsd ?? 0) + (r.tokensIn * c.price.inPerM + r.tokensOut * c.price.outPerM) / 1_000_000;
      byConnection.set(r.connection, b);
    }
    return { days, perDay, byConnection: [...byConnection.values()].map((b) => ({ ...b, costUsd: b.costUsd === null ? null : Math.round(b.costUsd * 1_000_000) / 1_000_000 })), byModel: [...rows.values()] };
  }

  /** Per-organization access: lets the engine's agents use this provider's key (supported providers only). */
  engineProviderFor(id: string): "anthropic" | "openai" | "openrouter" | "xai" | null {
    const c = this.get(id);
    return c ? (catalogEntry(c.catalog)?.engine ?? null) : null;
  }
  secretKey(id: string): string | null {
    const ep = this.endpoint(id);
    return ep?.key || null;
  }
}

const pick = (e: CatalogEntry) => ({ kind: e.kind, protocol: e.protocol, keyRequired: e.keyRequired, engine: e.engine, subscription: e.subscription, keysUrl: e.keysUrl, note: e.note });

// One store per state store, so the routes (which only see the request context) can find it.
const registry = new WeakMap<StateStore, ConnectionsStore>();
export const registerConnections = (state: StateStore, s: ConnectionsStore) => void registry.set(state, s);
export const connectionsOf = (state: StateStore): ConnectionsStore | undefined => registry.get(state);

// ---- Routes

export async function connectionRoutes(ctx: FeatureCtx): Promise<boolean> {
  const { path, method } = ctx;
  if (path !== "/api/connect/catalog" && !path.startsWith("/api/connect/connections") && path !== "/api/connect/fallbacks" && path !== "/api/connect/usage") return false;
  const store = connectionsOf(ctx.state);
  const E = ctx.HttpError;
  if (!store) throw new E(503, "connect_unavailable", "Connections aren't set up on this host.");
  const s = ctx.session();
  if (s.apiToken) throw new E(403, "ticket_only", "Connections are managed from the console by a signed-in person, not with an API token.");
  const admin = async () => {
    if (!(await ctx.asUser((pve) => ctx.isNodeAdmin(pve)))) throw new E(403, "forbidden", "Only Proxmox administrators (Sys.Modify on /) can change connections");
  };

  if (path === "/api/connect/catalog" && method === "GET") return ctx.json(200, { catalog: CATALOG }), true;
  if (path === "/api/connect/usage" && method === "GET") {
    const days = Number(ctx.url.searchParams.get("days") ?? 30);
    if (!Number.isInteger(days) || days < 1 || days > 62) throw new E(400, "bad_request", "days is 1 to 62");
    return ctx.json(200, store.usage(days)), true;
  }
  if (path === "/api/connect/fallbacks") {
    if (method === "GET") return ctx.json(200, { order: store.fallbackOrder() }), true;
    if (method === "PUT") {
      ctx.sameSite();
      await admin();
      const b = await ctx.readJson();
      return ctx.json(200, { order: store.saveFallbackOrder(b.order, s.username) }), true;
    }
  }
  if (path === "/api/connect/connections" && method === "GET") {
    const isAdmin = await ctx.asUser((pve) => ctx.isNodeAdmin(pve));
    return ctx.json(200, { connections: store.list(), canManage: isAdmin, fallbacks: store.fallbackOrder() }), true;
  }
  if (path === "/api/connect/connections" && method === "POST") {
    ctx.sameSite();
    await admin();
    return ctx.json(201, { connection: store.create(await ctx.readJson(), s.username) }), true;
  }
  const one = path.match(/^\/api\/connect\/connections\/([a-z0-9-]{1,32})(?:\/(key|test|models))?$/);
  if (one) {
    const id = one[1];
    const act = one[2];
    if (method === "GET" && act === "models") {
      await admin();
      return ctx.json(200, { models: await store.models(id) }), true;
    }
    if (method === "POST" && act === "test") {
      ctx.sameSite();
      await admin();
      return ctx.json(200, { connection: await store.test(id, s.username) }), true;
    }
    if (method === "PUT" && act === "key") {
      ctx.sameSite();
      await admin();
      const b = await ctx.readJson();
      store.setKey(id, b.apiKey, s.username);
      return ctx.json(200, { connection: store.get(id) }), true;
    }
    if (method === "PATCH" && !act) {
      ctx.sameSite();
      await admin();
      return ctx.json(200, { connection: store.update(id, await ctx.readJson(), s.username) }), true;
    }
    if (method === "DELETE" && !act) {
      ctx.sameSite();
      await admin();
      store.remove(id, s.username);
      return ctx.json(200, { ok: true }), true;
    }
  }
  throw new E(404, "not_found", "Not found");
}
