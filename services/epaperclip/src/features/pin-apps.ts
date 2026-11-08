import { HttpError } from "../http.ts";
import { PinApps, type EngineCall, type PinAppMode } from "../pin-apps.ts";
import { appendAudit } from "./access-tokens.ts";
import type { FeatureCtx } from "./index.ts";

/**
 * Settings for Pin's identity in an organization: enable it, choose what it may do per action (Off, Ask, Allow), revoke it.
 * Every change is made in the engine as the signed-in person, so the engine's own permissions decide who may do this; the
 * host adds no authority. See src/pin-apps.ts.
 */
export async function pinAppsRoutes(ctx: FeatureCtx): Promise<boolean> {
  const m = ctx.path.match(/^\/api\/pin\/apps\/([A-Za-z0-9_-]{1,64})(?:\/connections\/([A-Za-z0-9_-]{1,64}))?$/);
  if (!m) return false;
  const s = ctx.session();
  if (s.apiToken) throw new HttpError(403, "ticket_only", "Sign in to the console to manage Pin's access to apps.");
  const gw = ctx.gateway;
  if (!gw) throw new HttpError(503, "engine_unavailable", "The engine isn't set up on this host.");
  const call: EngineCall = (method, path, body) => gw.userJson(s, method, path, body);
  const pin = new PinApps(ctx.state);
  const [, companyId, connectionId] = m;
  const audit = (action: string, detail: string) => { try { appendAudit(ctx.state, ctx.now, { actor: s.username, action, target: companyId!, detail: detail.slice(0, 200) }); } catch { /* best effort */ } };

  if (!connectionId && ctx.method === "GET") return ctx.json(200, await pin.access(call, companyId!)), true;
  if (!connectionId && ctx.method === "POST") {
    ctx.sameSite();
    const r = await pin.enable(call, companyId!);
    audit("pin.apps.enable", r.agentId);
    return ctx.json(200, { enabled: true, agentId: r.agentId }), true;
  }
  if (!connectionId && ctx.method === "DELETE") {
    ctx.sameSite();
    await pin.revokeAll(call, companyId!);
    audit("pin.apps.revoke", "all");
    return ctx.json(200, { ok: true }), true;
  }
  if (connectionId && ctx.method === "PUT") {
    ctx.sameSite();
    const b = await ctx.readJson();
    if (Object.keys(b).some((k) => k !== "choices") || !Array.isArray(b.choices)) throw new HttpError(400, "bad_request", "Send { choices: [{ catalogEntryId, mode }] }");
    await pin.setAccess(call, companyId!, connectionId, b.choices as { catalogEntryId: string; mode: PinAppMode }[]);
    audit("pin.apps.access", `${connectionId}: ${(b.choices as unknown[]).length} choices`);
    return ctx.json(200, await pin.access(call, companyId!)), true;
  }
  throw new HttpError(405, "method", "Method not allowed");
}
