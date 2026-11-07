import type { FeatureCtx } from "./index.ts";

const CALLBACK_FIELDS = new Set(["state", "code", "error", "iss"]);

/** Provider callbacks navigate to our UI first, then complete as the signed-in person with CSRF protection. */
export async function nativeAppRoutes(ctx: FeatureCtx): Promise<boolean> {
  if (ctx.path === "/api/tools/oauth/callback" && ctx.method === "GET") {
    const fields = new URLSearchParams();
    for (const key of CALLBACK_FIELDS) {
      const values = ctx.url.searchParams.getAll(key);
      if (values.length > 1 || (values[0]?.length ?? 0) > 8192) throw new ctx.HttpError(400, "oauth_invalid", "Invalid provider response.");
      if (values[0]) fields.set(key, values[0]);
    }
    ctx.res.writeHead(303, { Location: `/provider-callback#${fields}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    ctx.res.end();
    return true;
  }
  if (ctx.path === "/api/tools/oauth/client-metadata" && ctx.method === "GET") {
    if (!ctx.gateway) throw new ctx.HttpError(503, "engine_unavailable", "The engine is not ready.");
    ctx.json(200, await ctx.gateway.oauthClientMetadata(), { "Cache-Control": "no-store" });
    return true;
  }
  if (!ctx.path.startsWith("/api/native-apps/")) return false;
  const session = ctx.session();
  if (session.apiToken) throw new ctx.HttpError(403, "ticket_only", "Sign in to the console to connect a provider.");
  if (!ctx.gateway) throw new ctx.HttpError(503, "engine_unavailable", "The engine is not ready.");
  if (ctx.path === "/api/native-apps/status" && ctx.method === "GET") {
    ctx.json(200, { callbackUrl: `${ctx.gateway.publicUrl}/api/tools/oauth/callback` });
    return true;
  }
  if (ctx.path === "/api/native-apps/complete" && ctx.method === "POST") {
    ctx.sameSite();
    const raw = await ctx.readJson(20_000);
    if (!raw || Array.isArray(raw) || Object.keys(raw).some((key) => !CALLBACK_FIELDS.has(key)) || Object.values(raw).some((value) => typeof value !== "string" || !value || value.length > 8192) || !raw.state || Boolean(raw.code) === Boolean(raw.error)) throw new ctx.HttpError(400, "oauth_invalid", "The provider response is incomplete or invalid.");
    const query = new URLSearchParams(raw as Record<string, string>);
    // The engine binds the one-time state to its company, connection and initiating user. Never complete as a service account.
    const reply = await ctx.gateway.userCall(session, "GET", `/api/tools/oauth/callback?${query}`);
    if (reply.status !== 200) throw new ctx.HttpError(400, "oauth_failed", "Provider sign-in could not be completed. Return to the app and start sign-in again.");
    ctx.json(200, { ok: true }, { "Cache-Control": "no-store" });
    return true;
  }
  throw new ctx.HttpError(404, "not_found", "Not found");
}
