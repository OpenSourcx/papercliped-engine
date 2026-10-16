import type { ServerResponse } from "node:http";
import { ProxmoxError } from "@papercliped-engine/proxmox-client";
import { HttpError } from "../http.ts";
import { readAudit, newTokenParts, pveTokenName, storeToken } from "./access-tokens.ts";
import { GRANT_TTL_MS, SCOPES, SCOPE_CONTROL, SCOPE_READ, connectOf, type ConnectService, type GrantRec, type Scope } from "./connect-oauth.ts";
import { MCP_TOOLS, toolFailureText, toolsFor } from "./connect-tools.ts";
import { DENIED_SCHEMES, checkAllowEntry, readBodyText, readFormOrJson, cleanText } from "./connect-util.ts";
import type { FeatureCtx } from "./index.ts";

/**
 * Routes of the Papercliped bridge (docs/CONNECTORS.md): the OAuth endpoints and `/mcp` at the root of the host
 * service, and the console's `/api/connect/*` routes (consent, connected apps, activity).
 */

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_MCP_BODY = 256 * 1024;
const TOOL_TIMEOUT_MS = 25_000;
const CORS_PATHS = /^(\/\.well-known\/oauth-(authorization-server|protected-resource)(\/mcp)?|\/oauth\/(register|token|revoke)|\/mcp)$/;

const isRootPath = (p: string) => p === "/mcp" || p.startsWith("/.well-known/oauth-") || p.startsWith("/oauth/");

/** Paths the host service hands to `connectRoot` before the console's static files. */
export const isConnectRoot = isRootPath;

function service(ctx: FeatureCtx): ConnectService {
  const s = connectOf(ctx.state);
  if (!s) throw new HttpError(503, "connect_unavailable", "Connecting apps isn't set up on this host.");
  return s;
}

/** Public endpoints that apps call from anywhere get open CORS (they take no cookies; every one needs a token or is public metadata). */
function cors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id");
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

const oauthJson = (ctx: FeatureCtx, status: number, body: unknown, extra: Record<string, string> = {}) => ctx.json(status, body, { "Cache-Control": "no-store", Pragma: "no-cache", ...extra });

/** OAuth errors are `{error, error_description}` (RFC 6749), not our usual shape. */
function oauthFail(ctx: FeatureCtx, e: unknown): true {
  if (e instanceof HttpError) {
    oauthJson(ctx, e.status, { error: e.code, error_description: e.message }, e.status === 401 ? { "WWW-Authenticate": 'Basic realm="ePaperclip"' } : {});
    return true;
  }
  throw e;
}

// ---- Root routes

export async function connectRoot(ctx: FeatureCtx): Promise<boolean> {
  const { path, method, req, res } = ctx;
  if (!isRootPath(path)) return false;
  const svc = service(ctx);
  if (CORS_PATHS.test(path)) cors(res);
  if (method === "OPTIONS" && CORS_PATHS.test(path)) {
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
    return true;
  }
  const origin = svc.origin(req);

  if (path.startsWith("/.well-known/oauth-protected-resource") && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
    if (method !== "GET") throw new HttpError(405, "method", "GET only");
    return oauthJson(ctx, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: [SCOPE_READ, SCOPE_CONTROL], bearer_methods_supported: ["header"], resource_name: "ePaperclip" }), true;
  }
  if (path === "/.well-known/oauth-authorization-server") {
    if (method !== "GET") throw new HttpError(405, "method", "GET only");
    return oauthJson(ctx, 200, {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [SCOPE_READ, SCOPE_CONTROL],
      authorization_response_iss_parameter_supported: true,
      service_documentation: "https://docs.papercliped.co/connect",
    }), true;
  }

  if (path === "/oauth/register") {
    if (method !== "POST") throw new HttpError(405, "method", "POST only");
    try {
      const body = await readFormOrJson(req, 16 * 1024);
      return oauthJson(ctx, 201, svc.register(body, req.socket.remoteAddress ?? "?")), true;
    } catch (e) {
      return oauthFail(ctx, e);
    }
  }
  if (path === "/oauth/token") {
    if (method !== "POST") throw new HttpError(405, "method", "POST only");
    try {
      const body = await readFormOrJson(req);
      return oauthJson(ctx, 200, await svc.token(body, req.socket.remoteAddress ?? "?")), true;
    } catch (e) {
      return oauthFail(ctx, e);
    }
  }
  if (path === "/oauth/revoke") {
    if (method !== "POST") throw new HttpError(405, "method", "POST only");
    try {
      await svc.revokeByToken(await readFormOrJson(req));
    } catch {
      /* the answer is the same whatever was sent */
    }
    return oauthJson(ctx, 200, {}), true;
  }
  if (path === "/oauth/authorize") {
    if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method", "GET only");
    // Check the app and its redirect address before showing anything, so a wrong one never gets a redirect. The consent
    // page itself is the console (the session cookie only reaches our own pages), which re-validates everything.
    try {
      svc.validateAuthRequest(ctx.url.searchParams, origin);
    } catch (e) {
      if (e instanceof HttpError && (e.code === "invalid_client" || (e.code === "invalid_request" && /redirect/i.test(e.message)))) return oauthFail(ctx, e);
    }
    return false; // the console's /oauth/authorize page
  }
  if (path === "/mcp") return mcpEndpoint(ctx, svc, origin);
  return false;
}

// ---- MCP (Streamable HTTP, JSON responses)

type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

async function mcpEndpoint(ctx: FeatureCtx, svc: ConnectService, origin: string): Promise<true> {
  const { req, res, method } = ctx;
  if (method !== "POST") {
    res.writeHead(405, { Allow: "POST, OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "This MCP endpoint takes POST requests with JSON-RPC messages.", code: "method" }));
    return true;
  }
  let principal;
  try {
    principal = await svc.authenticate(req);
  } catch (e) {
    const h = (e as { headers?: Record<string, string> }).headers;
    if (h) for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    throw e;
  }
  const version = req.headers["mcp-protocol-version"];
  if (typeof version === "string" && !VERSIONS.includes(version)) throw new HttpError(400, "bad_protocol_version", `Unsupported MCP protocol version. Supported: ${VERSIONS.join(", ")}.`);
  const type = String(req.headers["content-type"] ?? "");
  if (!type.toLowerCase().startsWith("application/json")) throw new HttpError(415, "json_only", "Send application/json.");
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readBodyText(req, MAX_MCP_BODY)) || "null");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return ctx.json(200, rpcError(null, -32700, "That isn't valid JSON.")), true;
  }
  const batch = Array.isArray(parsed);
  const messages = (batch ? parsed : [parsed]) as Rpc[];
  if (messages.length === 0 || messages.length > 20) return ctx.json(200, rpcError(null, -32600, "Send one message, or a batch of 1 to 20.")), true;

  const state = ctx.state;
  const allowFetch = state.getSetting<boolean>("connect.fetchUrl") === true;
  const out: unknown[] = [];

  for (const m of messages) {
    if (!m || typeof m !== "object" || Array.isArray(m) || m.jsonrpc !== "2.0") {
      out.push(rpcError((m as Rpc | null)?.id, -32600, "Each message must be a JSON-RPC 2.0 object."));
      continue;
    }
    if (typeof m.method !== "string") continue; // a response from the client: nothing to do
    const notification = m.id === undefined;
    const params = asObject(m.params);
    const reply = (r: unknown) => {
      if (!notification) out.push(r);
    };
    switch (m.method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        reply(rpcResult(m.id, {
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "epaperclip", title: "ePaperclip", version: "1" },
          instructions: `This is a Proxmox host running ePaperclip, with Paperclip organizations of AI agents. You are acting for ${principal.session.username} with ${principal.grant.scope === SCOPE_CONTROL ? "Full control" : "Read only"} access. ${principal.grant.scope === SCOPE_CONTROL ? "Changes to the host become plans the person approves in the console unless they allowed you to act directly. " : ""}Proxmox's own permissions apply to everything you do.`,
        }));
        break;
      }
      case "ping":
        reply(rpcResult(m.id, {}));
        break;
      case "tools/list":
        reply(rpcResult(m.id, { tools: toolsFor(principal.grant, allowFetch).map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: t.access === "read", destructiveHint: t.destructive === true, idempotentHint: t.idempotent === true, openWorldHint: t.name === "fetch_url" } })) }));
        break;
      case "resources/list":
        reply(rpcResult(m.id, { resources: [] }));
        break;
      case "prompts/list":
        reply(rpcResult(m.id, { prompts: [] }));
        break;
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        const tool = toolsFor(principal.grant, allowFetch).find((t) => t.name === name);
        if (!tool) {
          // A control tool asked of a Read only app is said plainly, not as "unknown".
          const known = MCP_TOOLS.find((t) => t.name === name);
          reply(known ? rpcResult(m.id, { content: [{ type: "text", text: "This app has Read only access, so it can't use that tool. The person can change that in Connected apps." }], isError: true }) : rpcError(m.id, -32602, `There is no tool called ${cleanText(name, 60)}.`));
          break;
        }
        const args = asObject(params.arguments);
        if (!svc.toolLimit.take(`grant:${principal.grant.id}`)) {
          reply(rpcResult(m.id, { content: [{ type: "text", text: "Too many tool calls this minute. Wait a moment and try again." }], isError: true }));
          break;
        }
        let ok = true;
        let text: string;
        try {
          const result = await Promise.race([
            tool.run(args, { grant: principal.grant, username: principal.session.username, node: ctx.node, pve: svc.clientFor(principal), gateway: ctx.gateway, session: principal.session, state, now: ctx.now, allowFetch }),
            new Promise<never>((_, rej) => setTimeout(() => rej(new HttpError(504, "tool_timeout", "The tool took too long.")), TOOL_TIMEOUT_MS).unref()),
          ]);
          const t = JSON.stringify(result ?? {});
          text = t.length > 100_000 ? `${t.slice(0, 100_000)}... (cut short)` : t;
        } catch (e) {
          if (e instanceof ProxmoxError && e.status === 401) throw svc.challenge(req, "invalid_token");
          ok = false;
          text = toolFailureText(e);
        }
        svc.logCall({ grantId: principal.grant.id, user: principal.session.username, client: principal.grant.clientName, tool: name, ok, control: tool.access === "control", ...(ok ? {} : { note: text.slice(0, 160) }) });
        // Anything that can change something also goes in the main audit trail, with the app's name.
        if (tool.access === "control") svc.auditFor(principal.session.username, "app.tool", `grant ${principal.grant.id}`, `${principal.grant.clientName}: ${name}${ok ? "" : " (failed)"}`, req.socket.remoteAddress ?? undefined);
        reply(rpcResult(m.id, { content: [{ type: "text", text }], isError: !ok }));
        break;
      }
      default:
        if (m.method.startsWith("notifications/")) break;
        reply(rpcError(m.id, -32601, "That MCP method isn't supported here."));
    }
  }
  void origin;
  if (out.length === 0) {
    res.writeHead(202, { "Cache-Control": "no-store" });
    res.end();
    return true;
  }
  return ctx.json(200, batch ? out : out[0]), true;
}

// ---- Console routes (cookie sessions only)

function person(ctx: FeatureCtx) {
  const s = ctx.session();
  if (s.apiToken) throw new HttpError(403, "ticket_only", "Connected apps are managed from the console by a signed-in person, not with an API token.");
  return s;
}

async function companiesOf(ctx: FeatureCtx): Promise<{ id: string; name: string }[] | null> {
  if (!ctx.gateway) return null;
  try {
    const list = await ctx.gateway.userJson<{ id: string; name: string }[]>(ctx.session(), "GET", "/api/companies");
    return list.filter((c) => typeof c?.id === "string").map((c) => ({ id: c.id, name: String(c.name ?? c.id) }));
  } catch {
    return null;
  }
}

const publicApp = (g: GrantRec | ReturnType<ConnectService["list"]>[number]) => ({
  id: g.id, clientName: g.clientName, clientHost: "redirectHost" in g ? g.redirectHost : "", userid: g.userid, scope: g.scope, direct: g.direct, orgs: g.orgs,
  createdAt: g.createdAt, expiresAt: g.expiresAt, lastUsedAt: g.lastUsedAt,
});

export async function connectApi(ctx: FeatureCtx): Promise<boolean> {
  const { path, method } = ctx;
  if (!path.startsWith("/api/connect/")) return false;
  const svc = service(ctx);
  const { HttpError: E } = ctx;

  if (path === "/api/connect/overview" && method === "GET") {
    const s = person(ctx);
    const admin = await ctx.asUser((pve) => ctx.isNodeAdmin(pve));
    const origin = svc.origin(ctx.req);
    svc.sweepExpired();
    return ctx.json(200, {
      mcpUrl: `${origin}/mcp`, issuer: origin, scopes: SCOPES, user: s.username, canManageAll: admin, orgs: (await companiesOf(ctx)) ?? [],
      fetchUrl: ctx.state.getSetting<boolean>("connect.fetchUrl") === true,
      tools: MCP_TOOLS.map((t) => ({ name: t.name, title: t.title, access: t.access, destructive: t.destructive === true })),
      grantDays: Math.round(GRANT_TTL_MS / 86_400_000),
    }), true;
  }

  if (path === "/api/connect/oauth/request" && method === "GET") {
    const s = person(ctx);
    const origin = svc.origin(ctx.req);
    const r = svc.validateAuthRequest(ctx.url.searchParams, origin);
    const orgs = await companiesOf(ctx);
    return ctx.json(200, {
      client: { id: r.client.id, name: r.client.name, redirectHost: new URL(r.redirectUri).host, redirectUri: r.redirectUri, loopback: new URL(r.redirectUri).protocol === "http:", customScheme: !/^https?:$/.test(new URL(r.redirectUri).protocol) },
      scope: r.scope, scopes: SCOPES, user: s.username, orgs, lifetimeDays: Math.round(GRANT_TTL_MS / 86_400_000),
    }), true;
  }

  if (path === "/api/connect/oauth/consent" && method === "POST") {
    ctx.sameSite();
    const s = person(ctx);
    const b = await ctx.readJson();
    const origin = svc.origin(ctx.req);
    if (!svc.consentLimit.take(`user:${s.username}`)) throw new E(429, "rate_limited", "Slow down. Try again in a minute.");
    const q = new URLSearchParams();
    for (const k of ["client_id", "redirect_uri", "response_type", "scope", "state", "code_challenge", "code_challenge_method", "resource"]) if (typeof b[k] === "string") q.set(k, b[k] as string);
    const req = svc.validateAuthRequest(q, origin);
    if (b.approve !== true) {
      svc.auditFor(s.username, "oauth.deny", req.client.id, req.client.name, ctx.req.socket.remoteAddress ?? undefined);
      return ctx.json(200, { redirect: svc.redirectWith(req, origin, { error: "access_denied", error_description: "The person declined." }) }), true;
    }
    // What the person chose: how far (this can only narrow the request), whether the app may act directly, which organizations.
    const scope: Scope = b.scope === SCOPE_READ ? SCOPE_READ : req.scope;
    const direct = b.direct === true && scope === SCOPE_CONTROL;
    let orgs: string[] | null = null;
    if (b.orgs !== undefined && b.orgs !== null) {
      if (!Array.isArray(b.orgs) || b.orgs.length > 50 || !b.orgs.every((x) => typeof x === "string" && ID.test(x))) throw new E(400, "bad_request", "Pick organizations from the list.");
      const mine = await companiesOf(ctx);
      const mineIds = new Set((mine ?? []).map((c) => c.id));
      if (!(b.orgs as string[]).every((x) => mineIds.has(x))) throw new E(400, "bad_request", "You can only share organizations you belong to.");
      orgs = [...new Set(b.orgs as string[])];
    }
    // A real Proxmox API token of this person (acts as them, never more), sealed in the vault. The app never sees it.
    const { id, secret } = newTokenParts();
    const t = ctx.now();
    const expiresAt = t + GRANT_TTL_MS;
    const pveName = pveTokenName(id);
    const level = scope === SCOPE_CONTROL ? "Full control" : "Read only";
    const created = await ctx.asUser((pve) => pve.callFull<{ value?: string }>("POST", `/access/users/${encodeURIComponent(s.username)}/token/${encodeURIComponent(pveName)}`, { comment: `ePaperclip app: ${req.client.name} (${level})`.slice(0, 120), expire: Math.floor(expiresAt / 1000), privsep: false }));
    const value = created.data?.value;
    if (!value) throw new E(502, "proxmox_error", "Proxmox didn't return a token secret");
    try {
      storeToken(ctx.state, ctx.now, { name: `App: ${req.client.name} (${level})`.slice(0, 64), userid: s.username, expiresAt, readOnly: scope === SCOPE_READ, privsep: false, pveSecret: value, id, secret });
    } catch (e) {
      await ctx.asUser((pve) => pve.call("DELETE", `/access/users/${encodeURIComponent(s.username)}/token/${encodeURIComponent(pveName)}`)).catch(() => {});
      throw e;
    }
    const { code, grant } = svc.createGrant({ req: { ...req, scope }, userid: s.username, direct, orgs, tokenId: id });
    svc.auditFor(s.username, "oauth.consent", `grant ${grant.id}`, `${req.client.name} (${level}${direct ? ", direct" : ""}${orgs ? `, ${orgs.length} org(s)` : ""})`, ctx.req.socket.remoteAddress ?? undefined);
    // Tidy up Proxmox tokens that earlier unfinished approvals left behind.
    await ctx.asUser((pve, sess) => svc.sweepOrphans(pve, sess.username, false)).catch(() => ({ deleted: 0, failed: 0 }));
    return ctx.json(200, { redirect: svc.redirectWith(req, origin, { code }) }), true;
  }

  if (path === "/api/connect/apps" && method === "GET") {
    const s = person(ctx);
    const admin = ctx.url.searchParams.get("all") === "1" ? await ctx.asUser((pve) => ctx.isNodeAdmin(pve)) : false;
    svc.sweepExpired();
    await ctx.asUser((pve, sess) => svc.sweepOrphans(pve, sess.username, admin)).catch(() => null);
    const mine = svc.list(admin ? undefined : s.username);
    return ctx.json(200, { apps: mine.map(publicApp), scope: admin ? "all" : "mine" }), true;
  }

  const one = path.match(/^\/api\/connect\/apps\/([0-9a-f]{16})$/);
  if (one && (method === "PATCH" || method === "DELETE")) {
    ctx.sameSite();
    const s = person(ctx);
    const g = svc.grant(one[1]);
    if (!g || g.status !== "active") throw new E(404, "not_found", "No such connected app");
    if (g.userid !== s.username) {
      const admin = await ctx.asUser((pve) => ctx.isNodeAdmin(pve));
      if (!admin) throw new E(403, "forbidden", "Only the person who connected it, or a Proxmox administrator, can change this.");
    }
    if (method === "DELETE") {
      const rec = await svc.revoke(g.id, s.username);
      const warnings: string[] = [];
      if (rec) {
        // Delete its Proxmox token now (as the owner, or as the administrator doing this); anything left is retried later.
        const r = await ctx.asUser((pve) => svc.sweepOrphans(pve, s.username, rec.userid !== s.username)).catch((e: Error) => ({ deleted: 0, failed: 1, why: e.message }));
        if (r.failed) warnings.push(`Access is ended here, but its Proxmox token (${rec.userid}!${pveTokenName(rec.tokenId)}) couldn't be deleted yet. It will be removed the next time ${rec.userid} opens Connected apps.`);
      }
      return ctx.json(200, { ok: true, warnings }), true;
    }
    const b = await ctx.readJson();
    const patch: { scope?: Scope; direct?: boolean; orgs?: string[] | null } = {};
    for (const k of Object.keys(b)) if (!["scope", "direct", "orgs"].includes(k)) throw new E(400, "bad_request", `Unknown field ${cleanText(k, 30)}`);
    if (b.scope !== undefined) {
      if (b.scope !== SCOPE_READ && b.scope !== SCOPE_CONTROL) throw new E(400, "bad_request", "scope is paperclip:read or paperclip:control");
      patch.scope = b.scope;
    }
    if (b.direct !== undefined) {
      if (typeof b.direct !== "boolean") throw new E(400, "bad_request", "direct is true or false");
      patch.direct = b.direct;
    }
    if (b.orgs !== undefined) {
      if (b.orgs !== null && (!Array.isArray(b.orgs) || b.orgs.length > 50 || !b.orgs.every((x) => typeof x === "string" && ID.test(x)))) throw new E(400, "bad_request", "orgs is a list of organization ids, or null for all");
      patch.orgs = b.orgs as string[] | null;
    }
    return ctx.json(200, { app: publicApp(svc.update(g.id, patch, s.username)) }), true;
  }

  if (path === "/api/connect/activity" && method === "GET") {
    const s = person(ctx);
    const admin = ctx.url.searchParams.get("all") === "1" ? await ctx.asUser((pve) => ctx.isNodeAdmin(pve)) : false;
    const grant = ctx.url.searchParams.get("grant");
    const calls = svc.callLog().filter((c) => (admin || c.user === s.username) && (!grant || c.grantId === grant)).slice(-100).reverse();
    const events = readAudit(ctx.state).filter((a) => /^(oauth|app)\./.test(a.action) && (admin || a.actor === s.username)).slice(-100).reverse();
    return ctx.json(200, { calls, events }), true;
  }

  // Custom-scheme redirect addresses (cursor://, vscode://): refused unless a Proxmox administrator listed them, with a typed confirmation to add.
  if (path === "/api/connect/redirect-allow") {
    const who = person(ctx).username;
    if (!(await ctx.asUser((pve) => ctx.isNodeAdmin(pve)))) throw new E(403, "forbidden", "Only Proxmox administrators can change this.");
    if (method === "GET") return ctx.json(200, { entries: svc.redirectAllow(), deniedSchemes: DENIED_SCHEMES }), true;
    if (method === "POST") {
      ctx.sameSite();
      const b = await ctx.readJson();
      const e = checkAllowEntry(b.uri, b.kind);
      if (typeof b.confirm !== "string" || b.confirm.trim() !== `allow ${e.scheme}`) throw new E(409, "confirm", `Type "allow ${e.scheme}" to allow apps to return to ${e.uri}.`);
      return ctx.json(200, { entry: svc.addRedirectAllow(b.uri, b.kind, who, ctx.req.socket.remoteAddress ?? undefined), entries: svc.redirectAllow() }), true;
    }
    if (method === "DELETE") {
      ctx.sameSite();
      const uri = ctx.url.searchParams.get("uri");
      if (uri === null || !svc.removeRedirectAllow(uri, ctx.url.searchParams.get("kind"), who, ctx.req.socket.remoteAddress ?? undefined)) throw new E(404, "not_found", "That address is not on the list.");
      return ctx.json(200, { entries: svc.redirectAllow() }), true;
    }
  }

  if (path === "/api/connect/settings" && method === "PUT") {
    ctx.sameSite();
    person(ctx);
    if (!(await ctx.asUser((pve) => ctx.isNodeAdmin(pve)))) throw new E(403, "forbidden", "Only Proxmox administrators can change this.");
    const b = await ctx.readJson();
    if (typeof b.fetchUrl !== "boolean" || Object.keys(b).length !== 1) throw new E(400, "bad_request", "Send { fetchUrl: true | false }");
    ctx.state.setSetting("connect.fetchUrl", b.fetchUrl);
    return ctx.json(200, { fetchUrl: b.fetchUrl }), true;
  }

  return false;
}
