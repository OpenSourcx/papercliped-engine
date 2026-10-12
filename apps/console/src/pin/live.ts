import { SseParser } from "./sse.ts";

/**
 * Pin's half of the host service contract (docs/ENGINE.md, "Contracts between the parts"):
 *
 *   GET  /api/connectors                 providers and integrations { id, kind, configured, last4?, testedAt?, ok? }
 *   GET  /api/pin/settings               { provider, model, mode, connectors }
 *   PUT  /api/pin/settings               the same shape
 *   GET  /api/pin/models?provider=       models the configured key can use
 *   POST /api/pin/chat                   { messages, context: { page, device, org? } } answered as server-sent events:
 *                                        delta (text), tool (a proposed or completed action), done, error
 *
 * Writes carry X-EPC-Request: 1. Answers are read tolerantly (bare arrays or wrapped objects) so small differences in
 * the server's envelope don't break the console.
 */

export type PinModeName = "assistant" | "agent";

export interface PinSettings {
  provider: string | null;
  model: string | null;
  mode: PinModeName;
  connectors: string[];
}

export interface ConnectorInfo {
  id: string;
  kind: string;
  name: string;
  configured: boolean;
  last4?: string;
  testedAt?: string;
  ok?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
}

/** Model providers are the connectors Pin can think with; everything else is something Pin may use. */
export const isProvider = (c: { kind: string }) => ["provider", "model", "ai", "llm"].includes(c.kind);

export class PinApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Fetch = typeof fetch;

async function call<T>(f: Fetch, method: "GET" | "PUT" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await f(path, {
      method,
      credentials: "same-origin",
      headers: method === "GET" ? { Accept: "application/json" } : { "Content-Type": "application/json", "X-EPC-Request": "1", Accept: "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new PinApiError(0, "offline", "Can't reach this device.");
  }
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("json") ? ((await res.json()) as T & { error?: string; code?: string }) : null;
  if (!res.ok || !data) throw new PinApiError(res.status, data?.code ?? "error", data?.error ?? `The host service answered ${res.status}.`);
  return data;
}

const pickArray = <T>(v: unknown, key: string): T[] => (Array.isArray(v) ? (v as T[]) : v && typeof v === "object" && Array.isArray((v as Record<string, unknown>)[key]) ? ((v as Record<string, unknown>)[key] as T[]) : []);

export function normalizeConnector(raw: Record<string, unknown>): ConnectorInfo {
  const id = String(raw.id ?? "");
  return {
    id,
    kind: String(raw.kind ?? "integration"),
    name: typeof raw.name === "string" && raw.name ? raw.name : id.charAt(0).toUpperCase() + id.slice(1),
    configured: Boolean(raw.configured),
    ...(typeof raw.last4 === "string" ? { last4: raw.last4 } : {}),
    ...(typeof raw.testedAt === "string" ? { testedAt: raw.testedAt } : {}),
    ...(typeof raw.ok === "boolean" ? { ok: raw.ok } : {}),
  };
}

export function normalizeSettings(raw: Partial<PinSettings> | null | undefined): PinSettings {
  return {
    provider: raw?.provider ?? null,
    model: raw?.model ?? null,
    mode: raw?.mode === "agent" ? "agent" : "assistant",
    connectors: Array.isArray(raw?.connectors) ? raw!.connectors.filter((c): c is string => typeof c === "string") : [],
  };
}

export function pinApi(f: Fetch = (...a) => fetch(...a)) {
  return {
    connectors: async () => pickArray<Record<string, unknown>>(await call<unknown>(f, "GET", "/api/connectors"), "connectors").map(normalizeConnector),
    settings: async () => normalizeSettings(await call<{ settings?: PinSettings } & PinSettings>(f, "GET", "/api/pin/settings").then((r) => r.settings ?? r)),
    saveSettings: async (s: PinSettings) => normalizeSettings(await call<{ settings?: PinSettings } & PinSettings>(f, "PUT", "/api/pin/settings", s).then((r) => (r.settings ?? (r.provider !== undefined ? r : s)))),
    models: async (provider: string) =>
      pickArray<string | { id?: string; name?: string }>(await call<unknown>(f, "GET", `/api/pin/models?provider=${encodeURIComponent(provider)}`), "models")
        .map((m) => (typeof m === "string" ? { id: m, name: m } : { id: String(m.id ?? m.name ?? ""), name: String(m.name ?? m.id ?? "") }))
        .filter((m) => m.id),
  };
}

/* ── Chat ──────────────────────────────────────────────────────────────────────────── */

export interface PinToolEvent {
  id: string;
  name: string;
  title?: string;
  summary?: string;
  args: Record<string, unknown>;
  status: "proposed" | "done" | "failed";
  error?: string;
}

export interface PinChatError {
  message: string;
  code?: string;
  /** What to do about it, as a label and a console address, e.g. "Add a model provider" → "?settings=connectors". */
  fix?: { label: string; to: string };
}

export type PinStreamEvent = { type: "delta"; text: string } | { type: "tool"; tool: PinToolEvent } | { type: "done" } | { type: "error"; error: PinChatError };

export interface PinChatRequest {
  messages: { role: "user" | "assistant"; content: string }[];
  context: { page: string; device: string; org?: string };
}

/** The fix for the errors we can name, so every error says what to do next. */
export function fixFor(code: string | undefined, message: string): PinChatError["fix"] {
  const t = `${code ?? ""} ${message}`.toLowerCase();
  if (/no_provider|provider_missing|no provider|model provider|not configured|missing.*key/.test(t)) return { label: "Add a model provider in Connectors", to: "?settings=connectors" };
  if (/no_model|model_missing|choose a model|no model/.test(t)) return { label: "Choose a model in Pin's settings", to: "pin?tab=settings" };
  if (/invalid_key|unauthorized|401|api key/.test(t)) return { label: "Check the key in Connectors", to: "?settings=connectors" };
  return undefined;
}

const asJson = (data: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(data);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

let toolSeq = 0;

/** Turns one SSE event from /api/pin/chat into a typed stream event (or null for events Pin doesn't know). */
export function toStreamEvent(e: { event: string; data: string }): PinStreamEvent | null {
  const j = asJson(e.data);
  switch (e.event) {
    case "delta":
    case "message": {
      const text = j ? (typeof j.text === "string" ? j.text : typeof j.delta === "string" ? j.delta : typeof j.content === "string" ? j.content : "") : e.data;
      return text ? { type: "delta", text } : null;
    }
    case "tool": {
      if (!j) return null;
      const status = j.status === "done" || j.status === "completed" ? "done" : j.status === "failed" || j.status === "error" ? "failed" : "proposed";
      return {
        type: "tool",
        tool: {
          id: String(j.id ?? `tool-${++toolSeq}`),
          name: String(j.name ?? j.tool ?? "action"),
          ...(typeof j.title === "string" ? { title: j.title } : {}),
          ...(typeof j.summary === "string" ? { summary: j.summary } : {}),
          args: (j.args ?? j.input ?? j.arguments ?? {}) as Record<string, unknown>,
          status,
          ...(typeof j.error === "string" ? { error: j.error } : {}),
        },
      };
    }
    case "done":
      return { type: "done" };
    case "error": {
      const message = j ? String(j.message ?? j.error ?? "Pin couldn't answer.") : e.data || "Pin couldn't answer.";
      const code = j && typeof j.code === "string" ? j.code : undefined;
      const fix = j && j.fix && typeof j.fix === "object" ? (j.fix as PinChatError["fix"]) : fixFor(code, message);
      return { type: "error", error: { message, ...(code ? { code } : {}), ...(fix ? { fix } : {}) } };
    }
    default:
      return null;
  }
}

/**
 * Sends a conversation to Pin and calls onEvent for each event as it streams in. Resolves when the stream ends; an
 * abort (the Stop button) ends it quietly. Failures before the stream starts arrive as one error event.
 */
export async function streamChat(req: PinChatRequest, onEvent: (e: PinStreamEvent) => void, opts: { signal?: AbortSignal; fetch?: Fetch } = {}): Promise<void> {
  const f = opts.fetch ?? ((...a: Parameters<Fetch>) => fetch(...a));
  let res: Response;
  try {
    res = await f("/api/pin/chat", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-EPC-Request": "1", Accept: "text/event-stream" },
      body: JSON.stringify(req),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return;
    onEvent({ type: "error", error: { message: "Can't reach this device.", code: "offline" } });
    return;
  }
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.includes("text/event-stream") || !res.body) {
    let message = `Pin couldn't answer (${res.status}).`;
    let code: string | undefined;
    if (type.includes("json")) {
      const j = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
      if (j?.error) message = j.error;
      code = j?.code;
    }
    const fix = fixFor(code, message);
    onEvent({ type: "error", error: { message, ...(code ? { code } : {}), ...(fix ? { fix } : {}) } });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let ended = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const raw of parser.push(decoder.decode(value, { stream: true }))) {
        const ev = toStreamEvent(raw);
        if (!ev) continue;
        onEvent(ev);
        if (ev.type === "done" || ev.type === "error") ended = true;
      }
    }
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return;
    onEvent({ type: "error", error: { message: "The connection dropped while Pin was answering.", code: "stream_interrupted" } });
    return;
  }
  if (!ended) onEvent({ type: "done" });
}
