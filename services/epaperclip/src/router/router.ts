import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import { activity } from "../activity.ts";
import { errorDetail, providerRequest, redact, refProtocol, type Endpoint, type HttpFetch, type ProviderRef } from "../connectors.ts";
import { HttpError } from "../http.ts";
import { appendAudit } from "../features/access-tokens.ts";
import { pidOf, type ConnectionsStore } from "../features/connect-connections.ts";
import { sseEvents } from "../pin.ts";
import type { StateStore } from "../state.ts";
import { FormatError, StreamError, anthropicEvents, anthropicJson, collect, fromAnthropic, fromOpenAI, openaiEvents, openaiJson, toAnthropic, toOpenAI, writeAnthropicStream, writeOpenAIStream, type NReq } from "./formats.ts";

/**
 * The Router: one local endpoint that speaks OpenAI's Chat Completions and Anthropic's Messages, in front of every model
 * service added in Connectors (docs/ROUTER.md). A client (an agent's Claude Code or Codex, a script) sends a request in
 * its own format with a Router key; the Router picks a connection, translates when the formats differ, and falls back
 * along the administrator's chain when a service is down, out of credit or rate-limiting. Same-format calls are passed
 * through untouched, so provider features (thinking, prompt caching, betas) keep working. Usage goes into the same
 * ledger as Pin's. Provider keys never leave this process; clients only ever hold a Router key.
 */

export type Format = "openai" | "anthropic";

interface Candidate {
  pid: string;
  label: string;
  model: string;
  ref: ProviderRef;
  key: string;
}

// ---- Router keys: what clients present. Only a hash is kept; the key is shown once, when it is made.

const KEYS = "router.keys";
const MAX_KEYS = 50;
const KEY_NAME = /^[\w .:@()'-]{1,60}$/;

export interface RouterKey {
  id: string;
  name: string;
  hash: string;
  last4: string;
  createdAt: number;
  createdBy: string;
  lastUsedAt?: number;
}
export type RouterKeyView = Omit<RouterKey, "hash">;

const sha = (s: string) => createHash("sha256").update(s).digest();

export class RouterKeys {
  private readonly state: StateStore;
  private readonly now: () => number;
  constructor(state: StateStore, now: () => number) {
    this.state = state;
    this.now = now;
  }
  private all = (): RouterKey[] => this.state.getSetting<RouterKey[]>(KEYS) ?? [];

  list(): RouterKeyView[] {
    return this.all().map(({ hash: _h, ...rest }) => rest);
  }

  create(name: unknown, who: string): { key: string; view: RouterKeyView } {
    const n = typeof name === "string" ? name.trim() : "";
    if (!KEY_NAME.test(n)) throw new HttpError(400, "bad_request", "Give the key a name of up to 60 letters, digits and spaces, such as the agent or script that will use it.");
    const all = this.all();
    if (all.length >= MAX_KEYS) throw new HttpError(409, "too_many", "That's enough Router keys. Revoke one you don't use.");
    if (all.some((k) => k.name.toLowerCase() === n.toLowerCase())) throw new HttpError(409, "name_taken", "A key with that name already exists.");
    const key = `epr_${randomBytes(24).toString("base64url")}`;
    const rec: RouterKey = { id: randomBytes(6).toString("hex"), name: n, hash: sha(key).toString("hex"), last4: key.slice(-4), createdAt: this.now(), createdBy: who };
    this.state.setSetting(KEYS, [...all, rec]);
    this.audit(who, "router.key.create", rec.id, n);
    const { hash: _h, ...view } = rec;
    return { key, view };
  }

  revoke(id: string, who: string) {
    const all = this.all();
    const k = all.find((x) => x.id === id);
    if (!k) throw new HttpError(404, "not_found", "No such Router key.");
    this.state.setSetting(KEYS, all.filter((x) => x.id !== id));
    this.audit(who, "router.key.revoke", id, k.name);
  }

  /** The key a client presented, or null. Every stored hash is compared, so the time taken says nothing about which matched. */
  check(token: string | undefined): RouterKey | null {
    if (!token || !token.startsWith("epr_") || token.length > 100) return null;
    const h = sha(token);
    let hit: RouterKey | null = null;
    for (const k of this.all()) if (timingSafeEqual(Buffer.from(k.hash, "hex"), h)) hit = k;
    if (hit && (!hit.lastUsedAt || this.now() - hit.lastUsedAt > 60_000)) {
      // Written at most once a minute per key, so busy agents don't rewrite the state file on every call.
      const id = hit.id;
      try {
        this.state.setSetting(KEYS, this.all().map((k) => (k.id === id ? { ...k, lastUsedAt: this.now() } : k)));
      } catch {
        /* a convenience */
      }
    }
    return hit;
  }

  private audit(actor: string, action: string, target: string, detail: string) {
    try {
      appendAudit(this.state, this.now, { actor, action, target, detail: detail.slice(0, 200) });
    } catch {
      /* never break a request */
    }
  }
}

// ---- The router

/** Statuses after which the next connection in the chain is tried: the service, the key or the account is the problem, not the request. */
const FALL_BACK = new Set([401, 402, 403, 404, 408, 409, 425, 429, 500, 502, 503, 504, 529]);
const HEADERS_TIMEOUT_MS = 120_000;
const BREAKER_FAILS = 3;
const BREAKER_OPEN_MS = 60_000;
const MAX_COOLDOWN_MS = 5 * 60_000;

/** Gemini speaks OpenAI's format at its /openai address, which also gives it tools. */
const GEMINI_OPENAI = "https://generativelanguage.googleapis.com/v1beta/openai";

export class Router {
  private readonly connections: ConnectionsStore;
  private readonly fetch: HttpFetch;
  private readonly now: () => number;
  private readonly health = new Map<string, { fails: number; openUntil: number }>();

  constructor(o: { connections: ConnectionsStore; fetch: HttpFetch; now: () => number }) {
    this.connections = o.connections;
    this.fetch = o.fetch;
    this.now = o.now;
  }

  /** The connections the Router can use right now: switched on, with a key where one is needed. */
  private usable() {
    return this.connections.list().filter((c) => c.enabled && c.configured);
  }

  private candidate(pid: string, model: string): Candidate | null {
    const c = this.usable().find((x) => pidOf(x) === pid);
    const t = c && this.connections.routeTarget(c.id);
    if (!c || !t) return null;
    let ref = t.ref;
    if (refProtocol(ref) === "gemini") ref = { id: pidOf(c), label: c.label, protocol: "openai", base: typeof ref === "string" ? GEMINI_OPENAI : `${ref.base}/openai`, modern: false } satisfies Endpoint;
    return { pid, label: c.label, model, ref, key: t.key };
  }

  /**
   * Which connections to try, in order, for the model a client named:
   *   "auto"                      the fallback chain, each with its default model
   *   "<connection>/<model>"      that connection first ("deepseek/deepseek-chat", "x:ollama/llama3.1", "openrouter/anthropic/claude-sonnet-4")
   *   "claude-...", "gpt-...", "gemini-..."  the provider that makes it, when it is connected
   *   anything else               a connection whose default model it is
   * then the rest of the chain. A client like Claude Code that always names a Claude model is still answered by the
   * chain when Anthropic isn't connected.
   */
  resolve(model: string): Candidate[] {
    const usable = this.usable();
    const out: Candidate[] = [];
    const add = (c: Candidate | null) => {
      if (c && !out.some((x) => x.pid === c.pid && x.model === c.model)) out.push(c);
    };
    if (model !== "auto") {
      const slash = model.indexOf("/");
      const head = slash > 0 ? model.slice(0, slash).replace(/^x:/, "") : "";
      const named = head ? usable.find((c) => c.id === head) : undefined;
      if (named && slash < model.length - 1) add(this.candidate(pidOf(named), model.slice(slash + 1)));
      else {
        const maker = /^claude-/.test(model) ? "anthropic" : /^(gpt-|chatgpt-|o[1-9](-|$))/.test(model) ? "openai" : /^gemini-/.test(model) ? "gemini" : null;
        if (maker && usable.some((c) => c.id === maker)) add(this.candidate(maker, model));
        const owner = usable.find((c) => c.model === model);
        if (owner) add(this.candidate(pidOf(owner), model));
      }
    }
    const chain = this.connections.fallbackOrder();
    for (const pid of chain.length ? chain : usable.map((c) => pidOf(c))) {
      const c = usable.find((x) => pidOf(x) === pid);
      if (c?.model && !out.some((x) => x.pid === pid)) add(this.candidate(pid, c.model));
    }
    return out;
  }

  private open(pid: string): boolean {
    return (this.health.get(pid)?.openUntil ?? 0) > this.now();
  }
  private failed(pid: string, retryAfterMs?: number) {
    const h = this.health.get(pid) ?? { fails: 0, openUntil: 0 };
    h.fails++;
    if (retryAfterMs !== undefined) h.openUntil = this.now() + Math.min(retryAfterMs, MAX_COOLDOWN_MS);
    else if (h.fails >= BREAKER_FAILS) h.openUntil = this.now() + BREAKER_OPEN_MS;
    this.health.set(pid, h);
  }
  private worked(pid: string) {
    this.health.delete(pid);
  }

  /** For the console: which connections are resting after repeated failures, and until when. */
  status() {
    return [...this.health.entries()].filter(([, h]) => h.openUntil > this.now()).map(([pid, h]) => ({ pid, fails: h.fails, openUntil: h.openUntil }));
  }

  /** Answers one request on `res`. Errors are written in the client's own format. */
  async serve(fmt: Format, body: Record<string, unknown>, headers: { anthropicVersion?: string; anthropicBeta?: string }, res: ServerResponse, clientGone: AbortSignal, keyName: string): Promise<void> {
    let n: NReq;
    try {
      n = fmt === "openai" ? fromOpenAI(body) : fromAnthropic(body);
    } catch (e) {
      if (e instanceof FormatError) return sendError(res, fmt, 400, e.message);
      throw e;
    }
    const all = this.resolve(n.model);
    if (!all.length) return sendError(res, fmt, 503, "The Router has no model service to use. An administrator can add one in Connectors and give it a default model.");
    // Connections resting after failures are skipped, unless every one is resting.
    const tryOrder = all.some((c) => !this.open(c.pid)) ? all.filter((c) => !this.open(c.pid)) : all;
    const t0 = this.now();
    const problems: string[] = [];
    let lastStatus = 502;
    for (const c of tryOrder) {
      if (clientGone.aborted) return;
      const up = refProtocol(c.ref) === "anthropic" ? "anthropic" : "openai";
      const same = up === fmt;
      const payload = same ? { ...body, model: c.model } : up === "anthropic" ? toAnthropic(n, c.model) : toOpenAI(n, c.model, c.ref === "openai" || (typeof c.ref !== "string" && c.ref.modern));
      const { url, headers: auth } = providerRequest(c.ref, c.key, up === "anthropic" ? "/messages" : "/chat/completions");
      const extra: Record<string, string> = up === "anthropic" && same ? { ...(headers.anthropicVersion ? { "anthropic-version": headers.anthropicVersion } : {}), ...(headers.anthropicBeta ? { "anthropic-beta": headers.anthropicBeta } : {}) } : {};
      const wantsStream = same ? body.stream === true : true;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new DOMException("headers", "TimeoutError")), HEADERS_TIMEOUT_MS);
      let r: Response;
      try {
        r = await this.fetch(url, { method: "POST", headers: { ...auth, ...extra, "Content-Type": "application/json", Accept: wantsStream ? "text/event-stream" : "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.any([clientGone, ac.signal]) });
      } catch (e) {
        clearTimeout(timer);
        if (clientGone.aborted) return;
        const timeout = (e as Error)?.name === "TimeoutError" || ac.signal.aborted;
        this.failed(c.pid);
        problems.push(`${c.label}: ${timeout ? "didn't answer in time" : "unreachable"}`);
        activity.warn("router", "router.fallback", `${c.label} ${timeout ? "timed out" : "unreachable"}`, { key: keyName, connection: c.pid, model: c.model });
        continue;
      }
      clearTimeout(timer);
      if (!r.ok) {
        const detail = redact(errorDetail(await r.text().catch(() => "")), c.key);
        if (FALL_BACK.has(r.status) || (r.status === 400 && /\btools?\b|function[ _]call|model/i.test(detail ?? ""))) {
          this.failed(c.pid, r.status === 429 ? retryAfterMs(r) ?? 30_000 : undefined);
          lastStatus = r.status === 429 ? 429 : 502;
          problems.push(`${c.label}: ${r.status}${detail ? ` ${detail}` : ""}`);
          activity.warn("router", "router.fallback", `${c.label} answered ${r.status}`, { key: keyName, connection: c.pid, model: c.model, status: r.status });
          continue;
        }
        activity.warn("router", "router.rejected", `${c.label} refused the request (${r.status})`, { key: keyName, connection: c.pid, model: c.model, status: r.status });
        return sendError(res, fmt, r.status >= 400 && r.status < 500 ? r.status : 502, `${c.label} refused the request${detail ? `: ${detail}` : "."}`);
      }
      if (!r.body) {
        this.failed(c.pid);
        problems.push(`${c.label}: empty answer`);
        continue;
      }
      this.worked(c.pid);
      const usage = await this.answer(fmt, same, wantsStream, n, c, r, res);
      if (usage.in || usage.out) this.connections.recordUsage(c.pid, c.model, usage);
      activity.info("router", "router.request", `${keyName} → ${c.label} / ${c.model}`, { key: keyName, format: fmt, connection: c.pid, model: c.model, translated: !same, stream: n.stream, ms: this.now() - t0, tokensIn: usage.in, tokensOut: usage.out, fellBack: c !== tryOrder[0] });
      return;
    }
    activity.error("router", "router.failed", "No connection could answer", { key: keyName, model: n.model, tried: problems.length });
    sendError(res, fmt, lastStatus, `No model service could answer. ${problems.join("; ").slice(0, 600)}`);
  }

  private async answer(fmt: Format, same: boolean, wantsStream: boolean, n: NReq, c: Candidate, r: Response, res: ServerResponse): Promise<{ in: number; out: number }> {
    const body = r.body as unknown as AsyncIterable<Uint8Array>;
    const id = `${fmt === "anthropic" ? "msg" : "chatcmpl"}_${randomBytes(12).toString("hex")}`;
    if (same && !wantsStream) {
      const text = await r.text();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(text);
      return usageOfJson(fmt, text);
    }
    if (same) {
      // Passed through byte for byte; the stream is read alongside only to count tokens.
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" });
      const scan = usageScanner(fmt);
      try {
        for await (const chunk of body) {
          res.write(chunk);
          scan.feed(chunk);
        }
      } catch {
        /* the provider or the client went away mid-answer */
      }
      res.end();
      return scan.result();
    }
    const events = refProtocol(c.ref) === "anthropic" ? anthropicEvents(body) : openaiEvents(body);
    const created = Math.floor(this.now() / 1000);
    if (!n.stream) {
      try {
        const a = await collect(events);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(fmt === "openai" ? openaiJson(a, { id, model: n.model, created }) : anthropicJson(a, { id, model: n.model })));
        return a.usage;
      } catch (e) {
        sendError(res, fmt, e instanceof StreamError ? e.status : 502, `${c.label} stopped mid-answer${e instanceof StreamError ? `: ${redact(e.message, c.key)}` : "."}`);
        return { in: 0, out: 0 };
      }
    }
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" });
    const write = (s: string) => {
      if (!res.writableEnded) res.write(s);
    };
    try {
      return fmt === "openai" ? await writeOpenAIStream(events, { id, model: n.model, created, wantsUsage: n.wantsUsage }, write) : await writeAnthropicStream(events, { id, model: n.model }, write);
    } catch (e) {
      const message = `${c.label} stopped mid-answer${e instanceof StreamError ? `: ${redact(e.message, c.key)}` : "."}`;
      write(fmt === "openai" ? `data: ${JSON.stringify({ error: { message, type: "api_error" } })}\n\n` : `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`);
      return { in: 0, out: 0 };
    } finally {
      res.end();
    }
  }

  /** The models a client can name: "auto" and each usable connection's default model. */
  models(): { id: string; owner: string; label: string }[] {
    const list = this.usable().filter((c) => c.model);
    return [{ id: "auto", owner: "router", label: "Auto (the fallback chain)" }, ...list.map((c) => ({ id: `${c.id}/${c.model}`, owner: c.id, label: `${c.label}: ${c.model}` }))];
  }
}

function retryAfterMs(r: Response): number | undefined {
  const h = r.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(h) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

function usageOfJson(fmt: Format, text: string): { in: number; out: number } {
  try {
    const u = JSON.parse(text).usage ?? {};
    return fmt === "anthropic"
      ? { in: (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0), out: Number(u.output_tokens) || 0 }
      : { in: Number(u.prompt_tokens) || 0, out: Number(u.completion_tokens) || 0 };
  } catch {
    return { in: 0, out: 0 };
  }
}

/** Reads token counts out of a stream that is being passed through. */
function usageScanner(fmt: Format) {
  const usage = { in: 0, out: 0 };
  // Only the start and the end of a stream carry usage, and the middle can be long: keep the first 64 KB and the last pieces.
  const head: Uint8Array[] = [];
  const tail: Uint8Array[] = [];
  let size = 0;
  return {
    feed(c: Uint8Array) {
      if (size < 64_000) {
        head.push(c);
        size += c.byteLength;
      } else {
        tail.push(c);
        if (tail.length > 16) tail.shift();
      }
    },
    async result() {
      try {
        async function* replay() {
          for (const c of [...head, ...tail]) yield c;
        }
        for await (const e of sseEvents(replay())) {
          if (e.data === "[DONE]") continue;
          let d: Record<string, any>;
          try {
            d = JSON.parse(e.data);
          } catch {
            continue;
          }
          if (fmt === "anthropic") {
            const s = d.message?.usage;
            if (d.type === "message_start" && s) usage.in = (Number(s.input_tokens) || 0) + (Number(s.cache_read_input_tokens) || 0) + (Number(s.cache_creation_input_tokens) || 0);
            if (d.type === "message_delta") usage.out = Number(d.usage?.output_tokens) || usage.out;
          } else if (d.usage) {
            usage.in = Number(d.usage.prompt_tokens) || usage.in;
            usage.out = Number(d.usage.completion_tokens) || usage.out;
          }
        }
      } catch {
        /* counting is best effort */
      }
      return usage;
    },
  };
}

const ANTHROPIC_TYPE: Record<number, string> = { 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error", 413: "request_too_large", 429: "rate_limit_error", 529: "overloaded_error" };

/** An error in the client's own format. */
export function sendError(res: ServerResponse, fmt: Format, status: number, message: string) {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  const body = fmt === "anthropic" ? { type: "error", error: { type: ANTHROPIC_TYPE[status] ?? "api_error", message } } : { error: { message, type: status === 429 ? "rate_limit_error" : status < 500 ? "invalid_request_error" : "api_error", code: null } };
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
