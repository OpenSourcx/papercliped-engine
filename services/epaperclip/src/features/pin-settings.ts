import { Connectors, errorDetail, isProvider, providerLabel, providerProblem, providerRequest, redact, type ProviderId } from "../connectors.ts";
import type { FeatureCtx } from "./index.ts";
import { runtimeFor } from "./pin-core.ts";

/**
 * Pin's model settings, checked end to end: `POST /api/pin/settings/test` makes one real, tiny request with the saved
 * provider key and the chosen model, so a wrong key, a model the key can't use, an exhausted quota or an unreachable
 * provider shows up now, in words, instead of in the middle of a conversation. It never returns the key or any text the
 * provider sent that contains it.
 */

const MODEL_ID = /^[\w.:/@+-]{1,200}$/;
const last = new Map<string, number>();

function probe(id: ProviderId, model: string): { path: string; body: unknown } {
  const ask = "Reply with the word ok.";
  if (id === "anthropic") return { path: "/messages", body: { model, max_tokens: 8, messages: [{ role: "user", content: ask }] } };
  if (id === "gemini") {
    if (!/^[\w.-]{1,128}$/.test(model)) throw Object.assign(new Error("That Gemini model name can't be used."), { bad: true });
    return { path: `/models/${model}:generateContent`, body: { contents: [{ role: "user", parts: [{ text: ask }] }], generationConfig: { maxOutputTokens: 8 } } };
  }
  return { path: "/chat/completions", body: { model, messages: [{ role: "user", content: ask }], ...(id === "openai" ? { max_completion_tokens: 16 } : { max_tokens: 16 }) } };
}

export async function settingsRoute(ctx: FeatureCtx): Promise<boolean> {
  if (ctx.path !== "/api/pin/settings/test") return false;
  const { HttpError } = ctx;
  if (ctx.method !== "POST") throw new HttpError(405, "method", "Method not allowed");
  ctx.sameSite();
  const s = ctx.session();
  const rt = runtimeFor(ctx.state);
  const connectors = new Connectors(ctx.state, async () => new Response(null, { status: 500 }), rt.now);
  const send = rt.opts.fetch ?? ((u: string, i: RequestInit) => fetch(u, i));
  const saved = (ctx.state.getSetting<Record<string, { provider?: string; model?: string | null }>>("pin.settings") ?? {})[s.username] ?? {};
  const b = await ctx.readJson();
  const provider = b.provider ?? saved.provider;
  const model = b.model ?? saved.model;
  if (!isProvider(provider)) throw new HttpError(400, "no_provider", "Choose a model provider first. An administrator can add an API key in Connectors.");
  if (typeof model !== "string" || !MODEL_ID.test(model)) throw new HttpError(400, "no_model", "Pick a model first.");
  const key = connectors.key(provider);
  if (!key) throw new HttpError(400, "not_configured", `${providerLabel(provider)} has no API key yet. An administrator can add one in Connectors.`);
  // A test spends a few tokens: once every few seconds per person is plenty.
  const prev = last.get(s.username) ?? 0;
  if (rt.now() - prev < 3000) throw new HttpError(429, "rate_limited", "Wait a few seconds between tests.");
  last.set(s.username, rt.now());
  let p: ReturnType<typeof probe>;
  try {
    p = probe(provider, model);
  } catch (e) {
    throw new HttpError(400, "bad_model", (e as Error).message);
  }
  const { url, headers } = providerRequest(provider, key, p.path);
  const started = Date.now();
  try {
    const r = await send(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(p.body), signal: AbortSignal.timeout(20_000) });
    const text = await r.text();
    if (r.ok) return ctx.json(200, { ok: true, provider, model, ms: Date.now() - started }), true;
    const prob = providerProblem(provider, r.status, redact(errorDetail(text), key));
    return ctx.json(200, { ok: false, provider, model, code: prob.code, error: prob.message }), true;
  } catch (e) {
    const name = (e as Error).name;
    return ctx.json(200, { ok: false, provider, model, code: name === "TimeoutError" ? "provider_timeout" : "provider_unreachable", error: name === "TimeoutError" || name === "AbortError" ? `${providerLabel(provider)} took too long to answer.` : `Couldn't reach ${providerLabel(provider)}.` }), true;
  }
}

