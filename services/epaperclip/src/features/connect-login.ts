import { redact } from "../connectors.ts";
import type { EngineGateway } from "../engine.ts";
import { HttpError } from "../http.ts";
import type { Session } from "../sessions.ts";
import { appendAudit } from "./access-tokens.ts";
import { connectionsOf } from "./connect-connections.ts";
import { RateWindow, cleanText } from "./connect-util.ts";
import type { FeatureCtx } from "./index.ts";

/**
 * Agents' model access, per organization (docs/CONNECTORS.md):
 *
 *  1. Apply a connection's API key to an organization. The host service sends the sealed key to the engine as that
 *     organization's AI connection, as the person (who must own or administer the organization), and never shows it.
 *  2. Sign in with a subscription from an agent container. The engine runs the provider's own CLI login in a
 *     terminal (a PTY) INSIDE the organization's agent container, never on the host, and stores the resulting
 *     credential in its own secret store. This service only starts and watches that login as the person and relays what
 *     they need to finish it in their own browser: the provider's sign-in address and one-time device code, or the
 *     code the browser shows back. Every answer is rebuilt from a short allow-list of fields (status, address on a
 *     fixed list of provider hosts, device code, expiry, a redacted message); the credential, tokens and raw terminal
 *     output never leave this service.
 */

const COMPANY = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const ADAPTERS: Record<string, { adapter: string; provider: "anthropic" | "openai"; label: string }> = {
  anthropic: { adapter: "claude_local", provider: "anthropic", label: "Claude (Anthropic subscription)" },
  openai: { adapter: "codex_local", provider: "openai", label: "Codex (OpenAI subscription)" },
};
/** Where a provider's sign-in page may live. An address anywhere else in the engine's answer is dropped, not shown. */
const SIGNIN_HOSTS = [/(^|\.)claude\.ai$/, /(^|\.)claude\.com$/, /(^|\.)anthropic\.com$/, /(^|\.)openai\.com$/, /(^|\.)chatgpt\.com$/, /(^|\.)x\.ai$/];
const SECRETY = /token|secret|credential|api[-_]?key|password|cookie|authorization|refresh|bearer|private/i;

export interface LoginView {
  id: string;
  adapter: string;
  provider: string;
  flow: "device" | "setup-token";
  status: string;
  verificationUrl: string | null;
  userCode: string | null;
  needsCode: boolean;
  expiresAt: number | null;
  message: string | null;
  done: boolean;
  failed: boolean;
  connectionName: string | null;
}

export function signInAddress(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2000) return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return SIGNIN_HOSTS.some((re) => re.test(u.hostname)) ? u.href : null;
  } catch {
    return null;
  }
}

/** Finds the first value under a key matching `re`, anywhere in the engine's answer (it is not typed in the spec), skipping secret-looking keys. */
function findValue(o: unknown, re: RegExp, accept: (v: unknown) => boolean, depth = 0): unknown {
  if (!o || typeof o !== "object" || depth > 4) return undefined;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (SECRETY.test(k)) continue;
    if (re.test(k) && accept(v)) return v;
  }
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (SECRETY.test(k)) continue;
    const found = findValue(v, re, accept, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

const DONE = /^(complete|completed|succeeded|success|connected|done|ready|saved)$/i;
const FAILED = /^(failed|error|errored|cancelled|canceled|expired|denied|timed[-_]?out|timeout)$/i;

/** What a person may see of the engine's login session. Built from allow-listed fields only. */
export function sanitizeLogin(raw: unknown, ctx: { adapter: string; provider: string; flow: LoginView["flow"]; fallbackId: string }): LoginView {
  const status = String(findValue(raw, /^(status|state|phase)$/i, (v) => typeof v === "string" && /^[\w -]{1,40}$/.test(v)) ?? "starting").toLowerCase().replace(/\s+/g, "_");
  const text = JSON.stringify(
    (function strip(o: unknown, d = 0): unknown {
      if (typeof o === "string") return o.slice(0, 4000);
      if (!o || typeof o !== "object" || d > 4) return o;
      if (Array.isArray(o)) return o.slice(0, 50).map((x) => strip(x, d + 1));
      return Object.fromEntries(Object.entries(o).filter(([k]) => !SECRETY.test(k)).map(([k, v]) => [k, strip(v, d + 1)]));
    })(raw),
  );
  const urlField = findValue(raw, /(verification|login|auth|sign.?in|device).*(url|uri|link)|^(url|uri|link)$/i, (v) => signInAddress(v) !== null);
  const urlText = text.match(/https:\/\/[A-Za-z0-9./?=&%_#:~+-]{8,600}/g)?.map((u) => signInAddress(u.replace(/[.,)\]]+$/, ""))).find((u): u is string => !!u);
  const codeField = findValue(raw, /^(user.?code|device.?code|verification.?code)$/i, (v) => typeof v === "string" && /^[A-Z0-9][A-Z0-9-]{3,15}$/.test(v));
  const codeText = text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/)?.[0];
  const expires = findValue(raw, /expires?(at|_at|in)?$/i, (v) => typeof v === "number" || typeof v === "string");
  let expiresAt: number | null = null;
  if (typeof expires === "number") expiresAt = expires > 1e12 ? expires : expires > 1e9 ? expires * 1000 : null;
  else if (typeof expires === "string" && !Number.isNaN(Date.parse(expires))) expiresAt = Date.parse(expires);
  const msg = findValue(raw, /^(message|hint|detail|error)$/i, (v) => typeof v === "string");
  const name = findValue(raw, /^(connectionName|name)$/i, (v) => typeof v === "string");
  const id = findValue(raw, /^(id|sessionId)$/i, (v) => typeof v === "string" && SESSION.test(v));
  const done = DONE.test(status);
  const failed = FAILED.test(status);
  return {
    id: String(id ?? ctx.fallbackId),
    adapter: ctx.adapter,
    provider: ctx.provider,
    flow: ctx.flow,
    status,
    verificationUrl: (urlField as string | undefined) ? signInAddress(urlField) : (urlText ?? null),
    userCode: (codeField as string | undefined) ?? codeText ?? null,
    needsCode: ctx.flow === "setup-token" && /code|prompt|waiting/.test(status),
    expiresAt,
    message: typeof msg === "string" ? (redact(cleanText(msg, 200)) ?? null) : null,
    done,
    failed,
    connectionName: typeof name === "string" ? cleanText(name, 80) : null,
  };
}

interface Tracked {
  user: string;
  companyId: string;
  adapter: string;
  provider: string;
  flow: LoginView["flow"];
  at: number;
}
// Sign-ins in progress and start limits, per host service (found through its state store).
const books = new WeakMap<object, { tracked: Map<string, Tracked>; startLimit: Map<string, RateWindow> }>();
const bookFor = (state: object) => {
  let b = books.get(state);
  if (!b) books.set(state, (b = { tracked: new Map(), startLimit: new Map() }));
  return b;
};

async function ownerOrAdmin(gw: EngineGateway | null, s: Session, companyId: string): Promise<EngineGateway> {
  if (!gw) throw new HttpError(503, "engine_unavailable", "The engine isn't set up on this host.");
  const m = await gw.membership(s, companyId);
  if (!m) throw new HttpError(403, "not_member", "You aren't a member of that organization.");
  if (m.role !== "owner" && m.role !== "admin") throw new HttpError(403, "forbidden", "Only the organization's owners and admins can connect its agents to an AI account.");
  return gw;
}

const audit = (ctx: FeatureCtx, action: string, target: string, detail?: string) => {
  try {
    appendAudit(ctx.state, ctx.now, { actor: ctx.session().username, action, target, ...(detail ? { detail: detail.slice(0, 200) } : {}) });
  } catch {
    /* best effort */
  }
};

/** Engine AI connections as a person may see them. */
function connectionView(c: Record<string, any>) {
  return {
    id: typeof c.id === "string" ? c.id : null,
    provider: typeof c.provider === "string" ? c.provider : null,
    method: typeof c.method === "string" ? c.method : null,
    name: typeof c.name === "string" ? cleanText(c.name, 80) : null,
    ownership: typeof c.ownership === "string" ? c.ownership : null,
    status: typeof c.status === "string" ? c.status : null,
  };
}

export async function loginRoutes(ctx: FeatureCtx): Promise<boolean> {
  const m = ctx.path.match(/^\/api\/connect\/orgs\/([A-Za-z0-9_-]{1,64})\/(ai|apply|login)(?:\/([A-Za-z0-9_-]{1,128}))?(?:\/(code|cancel))?$/);
  if (!m) return false;
  const E = ctx.HttpError;
  const s = ctx.session();
  if (s.apiToken) throw new E(403, "ticket_only", "Connecting AI accounts is done in the console by a signed-in person, not with an API token.");
  const companyId = m[1];
  if (!COMPANY.test(companyId)) throw new E(400, "bad_request", "Unknown organization");
  const enc = encodeURIComponent;
  const { tracked, startLimit } = bookFor(ctx.state);

  // What the organization's agents can use now.
  if (m[2] === "ai" && ctx.method === "GET" && !m[3]) {
    const gw = ctx.gateway;
    if (!gw) throw new E(503, "engine_unavailable", "The engine isn't set up on this host.");
    const r = await gw.userJson<unknown>(s, "GET", `/api/companies/${enc(companyId)}/ai-connections`);
    const list = Array.isArray(r) ? r : Array.isArray((r as { connections?: unknown })?.connections) ? (r as { connections: unknown[] }).connections : [];
    return ctx.json(200, { connections: list.slice(0, 50).filter((c): c is Record<string, any> => !!c && typeof c === "object").map(connectionView) }), true;
  }

  // 1. Apply a stored key.
  if (m[2] === "apply" && ctx.method === "POST" && m[3]) {
    ctx.sameSite();
    const gw = await ownerOrAdmin(ctx.gateway, s, companyId);
    const store = connectionsOf(ctx.state);
    const conn = store?.get(m[3]);
    if (!store || !conn) throw new E(404, "not_found", "No such connection");
    if (!conn.enabled) throw new E(409, "disabled", `${conn.label} is switched off.`);
    if (!conn.orgs.includes(companyId)) throw new E(403, "not_shared", `${conn.label} hasn't been shared with this organization. An administrator can do that in Connectors.`);
    const provider = store.engineProviderFor(m[3]);
    if (!provider) throw new E(400, "unsupported", `${conn.label} can't be handed to agents through the engine (it supports Anthropic, OpenAI, OpenRouter and xAI). Agents can still use it through an adapter that takes its own settings.`);
    const key = store.secretKey(m[3]);
    if (!key) throw new E(400, "not_configured", `${conn.label} has no API key yet`);
    try {
      const r = await gw.userJson<Record<string, any>>(s, "POST", `/api/companies/${enc(companyId)}/ai-connections`, { provider, method: "api_key", name: cleanText(conn.label, 160), ownership: "shared", apiKey: key, allAgents: true });
      audit(ctx, "connection.apply", `${m[3]} -> ${companyId}`, conn.label);
      return ctx.json(200, { applied: true, connection: connectionView(r && typeof r === "object" ? r : {}) }), true;
    } catch (e) {
      // The engine's answer may echo the key it rejected; show only a redacted, short reason.
      if (e instanceof HttpError) throw new E(e.status >= 500 ? 502 : e.status, e.code, redact(e.message, key) ?? "The engine refused the key.");
      throw e;
    }
  }

  // 2. Subscription sign-in inside the agent container.
  if (m[2] === "login") {
    const gw = await ownerOrAdmin(ctx.gateway, s, companyId);
    if (ctx.method === "POST" && !m[3]) {
      ctx.sameSite();
      const b = await ctx.readJson();
      for (const k of Object.keys(b)) if (!["provider", "name", "ownership", "flow"].includes(k)) throw new E(400, "bad_request", `Unknown field ${cleanText(k, 30)}`);
      const spec = typeof b.provider === "string" ? ADAPTERS[b.provider] : undefined;
      if (!spec) throw new E(400, "bad_request", "Subscription sign-in is available for anthropic (Claude) and openai (Codex).");
      const flow = b.flow === undefined ? "device" : b.flow;
      if (flow !== "device" && flow !== "setup-token") throw new E(400, "bad_request", "flow is device or setup-token");
      if (flow === "setup-token" && spec.provider !== "anthropic") throw new E(400, "bad_request", "setup-token is for Claude");
      const ownership = b.ownership === undefined ? "shared" : b.ownership;
      if (ownership !== "shared" && ownership !== "personal") throw new E(400, "bad_request", "ownership is shared or personal");
      const name = cleanText(b.name, 160) || spec.label;
      const limiter = startLimit.get(s.username) ?? new RateWindow(5, 10 * 60_000, ctx.now);
      startLimit.set(s.username, limiter);
      if (!limiter.take(companyId)) throw new E(429, "rate_limited", "Too many sign-in attempts. Wait a few minutes.");
      for (const [id, t] of tracked) if (ctx.now() - t.at > 24 * 3600_000) tracked.delete(id);
      // The organization's container environment: where the login runs. Never the host.
      const envs = await gw.userJson<{ id: string; driver?: string; status?: string; metadata?: { epaperclip?: string } | null }[]>(s, "GET", `/api/companies/${enc(companyId)}/environments`);
      const env = (Array.isArray(envs) ? envs : []).find((e) => e?.driver === "sandbox" && e.status !== "archived" && e.metadata?.epaperclip === "agent-containers");
      if (!env) throw new E(409, "no_environment", "This organization has no agent container environment yet. Set up agent containers first (Settings, Agent containers).");
      const aiConnection = { provider: spec.provider, method: "subscription", name, ownership, allAgents: true };
      const path = flow === "setup-token" ? `/api/companies/${enc(companyId)}/setup-token-login-sessions` : `/api/companies/${enc(companyId)}/adapters/${spec.adapter}/login-sessions`;
      const raw = await gw.userJson<unknown>(s, "POST", path, { aiConnection, environmentId: env.id });
      const view = sanitizeLogin(raw, { adapter: spec.adapter, provider: spec.provider, flow, fallbackId: "" });
      if (!view.id || !SESSION.test(view.id)) throw new E(502, "engine_error", "The engine started a sign-in but didn't say which. Check the engine.");
      tracked.set(view.id, { user: s.username, companyId, adapter: spec.adapter, provider: spec.provider, flow, at: ctx.now() });
      audit(ctx, "connection.login.start", `${spec.provider} -> ${companyId}`, flow);
      return ctx.json(201, { login: view }), true;
    }
    const t = m[3] ? tracked.get(m[3]) : undefined;
    if (!t || t.user !== s.username || t.companyId !== companyId) throw new E(404, "not_found", "No such sign-in. Start again.");
    const base = t.flow === "setup-token" ? `/api/companies/${enc(companyId)}/setup-token-login-sessions/${enc(m[3]!)}` : `/api/companies/${enc(companyId)}/adapters/${t.adapter}/login-sessions/${enc(m[3]!)}`;
    const seen = (raw: unknown) => sanitizeLogin(raw, { adapter: t.adapter, provider: t.provider, flow: t.flow, fallbackId: m[3]! });
    if (ctx.method === "GET" && !m[4]) {
      let raw = await gw.userJson<unknown>(s, "GET", base);
      let view = seen(raw);
      // The Claude setup-token flow has the address on a separate prompt route.
      if (t.flow === "setup-token" && !view.verificationUrl && !view.done && !view.failed) {
        raw = await gw.userJson<unknown>(s, "GET", `${base}/prompt`).catch(() => raw);
        const p = seen(raw);
        view = { ...view, verificationUrl: p.verificationUrl, userCode: p.userCode ?? view.userCode, message: p.message ?? view.message };
      }
      if (view.done || view.failed) tracked.delete(m[3]!);
      if (view.done) audit(ctx, "connection.login.done", `${t.provider} -> ${companyId}`);
      return ctx.json(200, { login: view }), true;
    }
    if (ctx.method === "POST" && m[4] === "code") {
      ctx.sameSite();
      if (t.flow !== "setup-token") throw new E(400, "bad_request", "This sign-in doesn't take a code.");
      const b = await ctx.readJson();
      if (Object.keys(b).some((k) => k !== "browserCode") || typeof b.browserCode !== "string" || !/^[\x21-\x7E]{1,512}$/.test(b.browserCode)) throw new E(400, "bad_request", "Paste the code the browser showed.");
      const raw = await gw.userJson<unknown>(s, "POST", `${base}/code`, { browserCode: b.browserCode }).catch((e) => {
        // Never repeat the code back, even inside an error.
        if (e instanceof HttpError) throw new E(e.status >= 500 ? 502 : e.status, e.code, redact(e.message, b.browserCode as string) ?? "The engine refused the code.");
        throw e;
      });
      return ctx.json(200, { login: seen(raw) }), true;
    }
    if (ctx.method === "POST" && m[4] === "cancel") {
      ctx.sameSite();
      await gw.userJson<unknown>(s, "POST", `${base}/cancel`, {}).catch(() => undefined);
      tracked.delete(m[3]!);
      audit(ctx, "connection.login.cancel", `${t.provider} -> ${companyId}`);
      return ctx.json(200, { ok: true }), true;
    }
  }
  throw new E(404, "not_found", "Not found");
}
