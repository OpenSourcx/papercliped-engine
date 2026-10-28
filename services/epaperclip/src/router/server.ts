import type { IncomingMessage, ServerResponse } from "node:http";
import { activity } from "../activity.ts";
import { sendError, type Format, type Router, type RouterKeys } from "./router.ts";

/**
 * The Router's own listener (docs/ROUTER.md). It is separate from the console: it binds to loopback by default
 * (EPC_ROUTER_LISTEN), takes no cookies, and answers only with a Router key, given the way each client sends one:
 * `Authorization: Bearer <key>` (OpenAI clients, Claude Code's ANTHROPIC_AUTH_TOKEN) or `x-api-key: <key>` (Anthropic
 * clients, Claude Code's ANTHROPIC_API_KEY).
 *
 *   GET  /health                     no key needed
 *   GET  /v1/models                  OpenAI's list, or Anthropic's when the request carries anthropic-version
 *   POST /v1/chat/completions        OpenAI format in, OpenAI format out
 *   POST /v1/messages                Anthropic format in, Anthropic format out
 *   POST /v1/messages/count_tokens   an estimate, for clients that ask before sending
 */

const MAX_BODY = 20 * 1024 * 1024;
const AT_ONCE = 32;
const PER_KEY_AT_ONCE = 12;

export function routerHandler(o: { router: Router; keys: RouterKeys }) {
  const open = new Map<string, number>();
  let total = 0;

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://router");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const fmt: Format = path.startsWith("/v1/messages") || (path === "/v1/models" && !!req.headers["anthropic-version"]) ? "anthropic" : "openai";
    // Browsers have no business here: a page that reached loopback can't use it with someone's key.
    if (req.headers.origin) return sendError(res, fmt, 403, "The Router doesn't take requests from web pages.");
    if (path === "/health" && req.method === "GET") return json(res, 200, { ok: true });
    const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
    const xKey = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined;
    const key = o.keys.check(bearer ?? xKey);
    if (!key) return sendError(res, fmt, 401, "That isn't a Router key. An administrator makes one in Connectors, under Router.");

    if (path === "/v1/models" && req.method === "GET") {
      const models = o.router.models();
      return fmt === "anthropic"
        ? json(res, 200, { data: models.map((m) => ({ type: "model", id: m.id, display_name: m.label, created_at: "1970-01-01T00:00:00Z" })), has_more: false, first_id: models[0]?.id ?? null, last_id: models[models.length - 1]?.id ?? null })
        : json(res, 200, { object: "list", data: models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: m.owner })) });
    }
    const isChat = path === "/v1/chat/completions" || path === "/v1/messages";
    const isCount = path === "/v1/messages/count_tokens";
    if (!(isChat || isCount) || req.method !== "POST") return sendError(res, fmt, 404, "Not found. The Router answers /v1/chat/completions, /v1/messages and /v1/models.");

    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (e) {
      return sendError(res, fmt, (e as { status?: number }).status ?? 400, (e as Error).message);
    }
    if (isCount) {
      // A rough count (about four characters a token): enough for a client deciding whether to trim its context.
      const chars = JSON.stringify([body.system ?? "", body.messages ?? [], body.tools ?? []]).length;
      return json(res, 200, { input_tokens: Math.ceil(chars / 4) });
    }
    if (total >= AT_ONCE || (open.get(key.id) ?? 0) >= PER_KEY_AT_ONCE) return sendError(res, fmt, 429, "The Router is busy with other requests. Try again in a moment.");
    total++;
    open.set(key.id, (open.get(key.id) ?? 0) + 1);
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    try {
      await o.router.serve(fmt, body, { anthropicVersion: header(req, "anthropic-version"), anthropicBeta: header(req, "anthropic-beta") }, res, gone.signal, key.name);
    } catch (e) {
      activity.error("router", "router.crash", e instanceof Error ? `${e.name}: ${e.message}` : "unknown", { key: key.name });
      sendError(res, fmt, 500, "The Router hit an unexpected problem.");
    } finally {
      total--;
      const n = (open.get(key.id) ?? 1) - 1;
      if (n <= 0) open.delete(key.id);
      else open.set(key.id, n);
    }
  };
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === "string" && v.length <= 500 ? v : undefined;
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("The request is too large (20 MB at most)."), { status: 413 });
    chunks.push(c as Buffer);
  }
  let v: unknown;
  try {
    v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("The request body isn't JSON.");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("The request body must be a JSON object.");
  return v as Record<string, unknown>;
}
