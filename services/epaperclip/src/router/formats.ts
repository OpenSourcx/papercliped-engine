import { sseEvents } from "../pin.ts";

/**
 * The Router's two wire formats, OpenAI's Chat Completions and Anthropic's Messages, and the plain shape between them.
 *
 * A request in either format becomes a `NReq`; a `NReq` becomes a request in either format. Answers go the other way:
 * a provider's stream (always streamed upstream, whatever the client asked) is read into `Ev` events, and the events
 * are written to the client as a stream or a single JSON answer in the client's own format. Same-format calls never
 * come through here: they are passed through untouched (router.ts), so provider-only features survive.
 */

export type Part = { type: "text"; text: string } | { type: "image"; mediaType: string; data: string } | { type: "image_url"; url: string };
export interface NCall {
  id: string;
  name: string;
  /** The arguments as JSON text, as OpenAI carries them. */
  args: string;
}
/** `system` mid-conversation: an instruction that arrives between turns (Claude Code sends these), kept in its place. */
export type NMsg = { role: "user"; parts: Part[] } | { role: "assistant"; parts: Part[]; calls: NCall[] } | { role: "tool"; id: string; content: string; isError?: boolean } | { role: "system"; text: string };
export interface NTool {
  name: string;
  description?: string;
  schema: Record<string, unknown>;
}
export type ToolChoice = "auto" | "none" | "required" | { name: string };
export interface NReq {
  model: string;
  system: string;
  messages: NMsg[];
  tools: NTool[];
  toolChoice: ToolChoice;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  stream: boolean;
  /** OpenAI clients that asked for a usage chunk at the end of a stream. */
  wantsUsage: boolean;
}

export type Stop = "end" | "tool" | "length" | "stop";
export type Ev = { t: "text"; text: string } | { t: "tool"; index: number; id: string; name: string } | { t: "args"; index: number; json: string } | { t: "stop"; reason: Stop } | { t: "usage"; in: number; out: number };

/** A request that can't be read or translated: answered 400 in the client's format. */
export class FormatError extends Error {}
/** An error a provider reported inside its stream, after the answer had started. */
export class StreamError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const stops = (v: unknown): string[] | undefined => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").slice(0, 8) : undefined);

function needModel(b: Record<string, any>): string {
  if (typeof b.model !== "string" || !/^[\w.:/@+-]{1,200}$/.test(b.model)) throw new FormatError("model is required: a model id, a connection and model such as \"deepseek/deepseek-chat\", or \"auto\".");
  return b.model;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : typeof obj(p).text === "string" ? obj(p).text : "")).filter(Boolean).join("\n");
  return "";
}

/** An image given as a URL: a data: URL is kept as its bytes so both formats can carry it. */
function imageFromUrl(url: string): Part {
  const m = /^data:([\w./+-]+);base64,(.*)$/s.exec(url);
  return m ? { type: "image", mediaType: m[1], data: m[2] } : { type: "image_url", url };
}

// ---- Reading requests

export function fromOpenAI(raw: unknown): NReq {
  const b = obj(raw);
  const model = needModel(b);
  if (!Array.isArray(b.messages) || !b.messages.length) throw new FormatError("messages must be a non-empty list.");
  const system: string[] = [];
  const messages: NMsg[] = [];
  for (const m0 of b.messages) {
    const m = obj(m0);
    if (m.role === "system" || m.role === "developer") {
      if (messages.length) messages.push({ role: "system", text: textOf(m.content) });
      else system.push(textOf(m.content));
    }
    else if (m.role === "user") {
      const parts: Part[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : [];
      if (Array.isArray(m.content))
        for (const p0 of m.content) {
          const p = obj(p0);
          if (p.type === "text" && typeof p.text === "string") parts.push({ type: "text", text: p.text });
          else if (p.type === "image_url" && typeof obj(p.image_url).url === "string") parts.push(imageFromUrl(obj(p.image_url).url));
        }
      messages.push({ role: "user", parts });
    } else if (m.role === "assistant") {
      const text = textOf(m.content);
      const calls: NCall[] = (Array.isArray(m.tool_calls) ? m.tool_calls : []).map((c0: unknown, i: number) => {
        const c = obj(c0);
        const f = obj(c.function);
        return { id: typeof c.id === "string" && c.id ? c.id : `call_${i}`, name: String(f.name ?? ""), args: typeof f.arguments === "string" ? f.arguments : JSON.stringify(f.arguments ?? {}) };
      });
      messages.push({ role: "assistant", parts: text ? [{ type: "text", text }] : [], calls });
    } else if (m.role === "tool") messages.push({ role: "tool", id: String(m.tool_call_id ?? ""), content: textOf(m.content) });
    else throw new FormatError(`Unknown message role ${JSON.stringify(String(m.role)).slice(0, 40)}.`);
  }
  const tools: NTool[] = (Array.isArray(b.tools) ? b.tools : [])
    .map((t0: unknown) => obj(obj(t0).function))
    .filter((f: Record<string, any>) => typeof f.name === "string")
    .map((f: Record<string, any>) => ({ name: f.name, ...(typeof f.description === "string" ? { description: f.description } : {}), schema: obj(f.parameters) }));
  const tc = b.tool_choice;
  const toolChoice: ToolChoice = tc === "none" || tc === "required" ? tc : typeof obj(obj(tc).function).name === "string" ? { name: obj(obj(tc).function).name } : "auto";
  return {
    model, system: system.filter(Boolean).join("\n\n"), messages, tools, toolChoice,
    maxTokens: num(b.max_completion_tokens) ?? num(b.max_tokens), temperature: num(b.temperature), topP: num(b.top_p), stop: stops(b.stop),
    stream: b.stream === true, wantsUsage: obj(b.stream_options).include_usage === true,
  };
}

export function fromAnthropic(raw: unknown): NReq {
  const b = obj(raw);
  const model = needModel(b);
  if (!Array.isArray(b.messages) || !b.messages.length) throw new FormatError("messages must be a non-empty list.");
  const messages: NMsg[] = [];
  for (const m0 of b.messages) {
    const m = obj(m0);
    const blocks: Record<string, any>[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content.map(obj) : [];
    if (m.role === "user") {
      const parts: Part[] = [];
      for (const k of blocks) {
        if (k.type === "tool_result") messages.push({ role: "tool", id: String(k.tool_use_id ?? ""), content: textOf(k.content), ...(k.is_error === true ? { isError: true } : {}) });
        else if (k.type === "text" && typeof k.text === "string") parts.push({ type: "text", text: k.text });
        else if (k.type === "image") {
          const s = obj(k.source);
          if (s.type === "base64" && typeof s.data === "string") parts.push({ type: "image", mediaType: String(s.media_type ?? "image/png"), data: s.data });
          else if (s.type === "url" && typeof s.url === "string") parts.push({ type: "image_url", url: s.url });
        }
      }
      if (parts.length) messages.push({ role: "user", parts });
    } else if (m.role === "assistant") {
      const text = blocks.filter((k) => k.type === "text" && typeof k.text === "string").map((k) => k.text as string).join("");
      const calls = blocks.filter((k) => k.type === "tool_use").map((k) => ({ id: String(k.id ?? ""), name: String(k.name ?? ""), args: JSON.stringify(k.input ?? {}) }));
      messages.push({ role: "assistant", parts: text ? [{ type: "text", text }] : [], calls });
    } else if (m.role === "system") {
      const text = blocks.filter((k) => k.type === "text" && typeof k.text === "string").map((k) => k.text as string).join("\n");
      if (text) messages.push({ role: "system", text });
    } else throw new FormatError(`Unknown message role ${JSON.stringify(String(m.role)).slice(0, 40)}.`);
  }
  // Server tools (web search and the like) have a `type` and no schema: only Anthropic can run them, so they are left out.
  const tools: NTool[] = (Array.isArray(b.tools) ? b.tools : [])
    .map(obj)
    .filter((t: Record<string, any>) => typeof t.name === "string" && t.input_schema)
    .map((t: Record<string, any>) => ({ name: t.name, ...(typeof t.description === "string" ? { description: t.description } : {}), schema: obj(t.input_schema) }));
  const tc = obj(b.tool_choice);
  const toolChoice: ToolChoice = tc.type === "none" ? "none" : tc.type === "any" ? "required" : tc.type === "tool" && typeof tc.name === "string" ? { name: tc.name } : "auto";
  return {
    model, system: textOf(b.system), messages, tools, toolChoice,
    maxTokens: num(b.max_tokens), temperature: num(b.temperature), topP: num(b.top_p), stop: stops(b.stop_sequences),
    stream: b.stream === true, wantsUsage: false,
  };
}

// ---- Writing requests (always streamed upstream)

export function toOpenAI(r: NReq, model: string, modern: boolean): Record<string, unknown> {
  const messages: Record<string, unknown>[] = r.system ? [{ role: "system", content: r.system }] : [];
  for (const m of r.messages) {
    if (m.role === "system") messages.push({ role: "system", content: m.text });
    else if (m.role === "tool") messages.push({ role: "tool", tool_call_id: m.id, content: m.content });
    else if (m.role === "assistant")
      messages.push({ role: "assistant", content: m.parts.map((p) => (p.type === "text" ? p.text : "")).join("") || null, ...(m.calls.length ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })) } : {}) });
    else {
      const onlyText = m.parts.every((p) => p.type === "text");
      messages.push({
        role: "user",
        content: onlyText
          ? m.parts.map((p) => (p as { text: string }).text).join("\n")
          : m.parts.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: p.type === "image" ? `data:${p.mediaType};base64,${p.data}` : p.url } })),
      });
    }
  }
  const out: Record<string, unknown> = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (r.tools.length) {
    out.tools = r.tools.map((t) => ({ type: "function", function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.schema } }));
    out.tool_choice = typeof r.toolChoice === "string" ? r.toolChoice : { type: "function", function: { name: r.toolChoice.name } };
  }
  if (r.maxTokens !== undefined) out[modern ? "max_completion_tokens" : "max_tokens"] = r.maxTokens;
  if (r.temperature !== undefined) out.temperature = r.temperature;
  if (r.topP !== undefined) out.top_p = r.topP;
  if (r.stop?.length) out.stop = r.stop;
  return out;
}

/** Anthropic needs turns that alternate, starting with the person, and tool results inside the person's turn. */
export function toAnthropic(r: NReq, model: string): Record<string, unknown> {
  const turns: { role: "user" | "assistant"; content: Record<string, unknown>[] }[] = [];
  const push = (role: "user" | "assistant", blocks: Record<string, unknown>[]) => {
    if (!blocks.length) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };
  const later: string[] = [];
  for (const m of r.messages) {
    // Anthropic takes one system prompt: an instruction that arrives later joins it.
    if (m.role === "system") later.push(m.text);
    else if (m.role === "tool") push("user", [{ type: "tool_result", tool_use_id: m.id, content: m.content, ...(m.isError ? { is_error: true } : {}) }]);
    else if (m.role === "assistant")
      push("assistant", [
        ...m.parts.filter((p) => p.type === "text" && p.text).map((p) => ({ type: "text", text: (p as { text: string }).text })),
        ...m.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: parseObject(c.args) })),
      ]);
    else
      push("user", m.parts.map((p) => (p.type === "text" ? { type: "text", text: p.text } : p.type === "image" ? { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } } : { type: "image", source: { type: "url", url: p.url } })).filter((k) => k.type !== "text" || (k as { text: string }).text));
  }
  if (turns[0]?.role !== "user") turns.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });
  const out: Record<string, unknown> = { model, max_tokens: r.maxTokens ?? 4096, messages: turns, stream: true };
  const system = [r.system, ...later].filter(Boolean).join("\n\n");
  if (system) out.system = system;
  // Tools stay defined even when none may be called: earlier turns' tool calls need their definitions.
  if (r.tools.length) {
    out.tools = r.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), input_schema: { type: "object", ...t.schema } }));
    out.tool_choice = r.toolChoice === "none" ? { type: "none" } : r.toolChoice === "required" ? { type: "any" } : typeof r.toolChoice === "object" ? { type: "tool", name: r.toolChoice.name } : { type: "auto" };
  }
  if (r.temperature !== undefined) out.temperature = Math.min(1, r.temperature);
  if (r.topP !== undefined) out.top_p = r.topP;
  if (r.stop?.length) out.stop_sequences = r.stop;
  return out;
}

export function parseObject(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// ---- Reading provider streams

export async function* openaiEvents(body: AsyncIterable<Uint8Array>): AsyncGenerator<Ev> {
  // Some servers send a tool call's name in pieces, or its arguments before its name: emit the call once its name is known.
  const slots = new Map<number, { id: string; name: string; held: string; open: boolean }>();
  for await (const e of sseEvents(body)) {
    if (e.data === "[DONE]") break;
    let d: Record<string, any>;
    try {
      d = JSON.parse(e.data);
    } catch {
      continue;
    }
    if (d.error) throw new StreamError(typeof d.error.code === "number" ? d.error.code : 502, String(d.error.message ?? "The provider reported an error."));
    if (d.usage) yield { t: "usage", in: Number(d.usage.prompt_tokens) || 0, out: Number(d.usage.completion_tokens) || 0 };
    const ch = d.choices?.[0];
    if (!ch) continue;
    const delta = ch.delta ?? {};
    if (typeof delta.content === "string" && delta.content) yield { t: "text", text: delta.content };
    for (const tc of delta.tool_calls ?? []) {
      const i = Number(tc.index ?? 0);
      const s = slots.get(i) ?? { id: "", name: "", held: "", open: false };
      slots.set(i, s);
      if (tc.id) s.id = tc.id;
      if (tc.function?.name) s.name += tc.function.name;
      const args = typeof tc.function?.arguments === "string" ? tc.function.arguments : "";
      if (!s.open && s.name) {
        s.open = true;
        yield { t: "tool", index: i, id: s.id || `call_${i}`, name: s.name };
        if (s.held) yield { t: "args", index: i, json: s.held };
      }
      if (args) {
        if (s.open) yield { t: "args", index: i, json: args };
        else s.held += args;
      }
    }
    if (ch.finish_reason) yield { t: "stop", reason: ch.finish_reason === "tool_calls" || ch.finish_reason === "function_call" ? "tool" : ch.finish_reason === "length" ? "length" : "end" };
  }
}

export async function* anthropicEvents(body: AsyncIterable<Uint8Array>): AsyncGenerator<Ev> {
  let input = 0;
  for await (const e of sseEvents(body)) {
    if (e.event === "ping") continue;
    let d: Record<string, any>;
    try {
      d = JSON.parse(e.data);
    } catch {
      continue;
    }
    if (d.type === "error") {
      const t = d.error?.type;
      throw new StreamError(t === "overloaded_error" ? 529 : t === "rate_limit_error" ? 429 : 502, String(d.error?.message ?? "The provider reported an error."));
    }
    if (d.type === "message_start") {
      const u = d.message?.usage ?? {};
      input = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
    } else if (d.type === "content_block_start" && d.content_block?.type === "tool_use") yield { t: "tool", index: Number(d.index), id: String(d.content_block.id), name: String(d.content_block.name) };
    else if (d.type === "content_block_delta" && d.delta?.type === "text_delta") yield { t: "text", text: String(d.delta.text ?? "") };
    else if (d.type === "content_block_delta" && d.delta?.type === "input_json_delta") yield { t: "args", index: Number(d.index), json: String(d.delta.partial_json ?? "") };
    else if (d.type === "message_delta") {
      const r = d.delta?.stop_reason;
      if (r) yield { t: "stop", reason: r === "tool_use" ? "tool" : r === "max_tokens" ? "length" : r === "stop_sequence" ? "stop" : "end" };
      yield { t: "usage", in: input || Number(d.usage?.input_tokens) || 0, out: Number(d.usage?.output_tokens) || 0 };
    }
  }
}

// ---- Writing answers to the client

const sse = (event: string | null, data: unknown) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
const OPENAI_STOP: Record<Stop, string> = { end: "stop", tool: "tool_calls", length: "length", stop: "stop" };
const ANTHROPIC_STOP: Record<Stop, string> = { end: "end_turn", tool: "tool_use", length: "max_tokens", stop: "stop_sequence" };

/** The answer as OpenAI chat.completion.chunk events. Calls `write` for each piece; returns the usage seen. */
export async function writeOpenAIStream(events: AsyncIterable<Ev>, o: { id: string; model: string; created: number; wantsUsage: boolean }, write: (s: string) => void) {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => write(sse(null, { id: o.id, object: "chat.completion.chunk", created: o.created, model: o.model, choices: [{ index: 0, delta, finish_reason: finish }] }));
  chunk({ role: "assistant", content: "" });
  const order = new Map<number, number>();
  const usage = { in: 0, out: 0 };
  let stop: Stop = "end";
  for await (const e of events) {
    if (e.t === "text") chunk({ content: e.text });
    else if (e.t === "tool") {
      order.set(e.index, order.size);
      chunk({ tool_calls: [{ index: order.get(e.index), id: e.id, type: "function", function: { name: e.name, arguments: "" } }] });
    } else if (e.t === "args" && order.has(e.index)) chunk({ tool_calls: [{ index: order.get(e.index), function: { arguments: e.json } }] });
    else if (e.t === "stop") stop = e.reason;
    else if (e.t === "usage") Object.assign(usage, { in: e.in || usage.in, out: e.out || usage.out });
  }
  if (order.size && stop === "end") stop = "tool";
  chunk({}, OPENAI_STOP[stop]);
  if (o.wantsUsage) write(sse(null, { id: o.id, object: "chat.completion.chunk", created: o.created, model: o.model, choices: [], usage: { prompt_tokens: usage.in, completion_tokens: usage.out, total_tokens: usage.in + usage.out } }));
  write("data: [DONE]\n\n");
  return usage;
}

/** The answer as Anthropic's message events. */
export async function writeAnthropicStream(events: AsyncIterable<Ev>, o: { id: string; model: string }, write: (s: string) => void) {
  write(sse("message_start", { type: "message_start", message: { id: o.id, type: "message", role: "assistant", model: o.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }));
  let block = -1;
  let kind: "text" | "tool" | null = null;
  const toolBlock = new Map<number, number>();
  const usage = { in: 0, out: 0 };
  let stop: Stop = "end";
  let sawTool = false;
  const close = () => {
    if (kind) write(sse("content_block_stop", { type: "content_block_stop", index: block }));
    kind = null;
  };
  for await (const e of events) {
    if (e.t === "text") {
      if (kind !== "text") {
        close();
        block++;
        kind = "text";
        write(sse("content_block_start", { type: "content_block_start", index: block, content_block: { type: "text", text: "" } }));
      }
      write(sse("content_block_delta", { type: "content_block_delta", index: block, delta: { type: "text_delta", text: e.text } }));
    } else if (e.t === "tool") {
      close();
      block++;
      kind = "tool";
      sawTool = true;
      toolBlock.set(e.index, block);
      write(sse("content_block_start", { type: "content_block_start", index: block, content_block: { type: "tool_use", id: e.id, name: e.name, input: {} } }));
    } else if (e.t === "args" && toolBlock.get(e.index) === block && kind === "tool") write(sse("content_block_delta", { type: "content_block_delta", index: block, delta: { type: "input_json_delta", partial_json: e.json } }));
    else if (e.t === "stop") stop = e.reason;
    else if (e.t === "usage") Object.assign(usage, { in: e.in || usage.in, out: e.out || usage.out });
  }
  close();
  if (sawTool && stop === "end") stop = "tool";
  write(sse("message_delta", { type: "message_delta", delta: { stop_reason: ANTHROPIC_STOP[stop], stop_sequence: null }, usage: { input_tokens: usage.in, output_tokens: usage.out } }));
  write(sse("message_stop", { type: "message_stop" }));
  return usage;
}

/** Collects a whole answer, for clients that didn't ask for a stream. */
export async function collect(events: AsyncIterable<Ev>) {
  let text = "";
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let stop: Stop = "end";
  const usage = { in: 0, out: 0 };
  for await (const e of events) {
    if (e.t === "text") text += e.text;
    else if (e.t === "tool") calls.set(e.index, { id: e.id, name: e.name, args: "" });
    else if (e.t === "args" && calls.has(e.index)) calls.get(e.index)!.args += e.json;
    else if (e.t === "stop") stop = e.reason;
    else if (e.t === "usage") Object.assign(usage, { in: e.in || usage.in, out: e.out || usage.out });
  }
  if (calls.size && stop === "end") stop = "tool";
  return { text, calls: [...calls.values()], stop, usage };
}

export function openaiJson(a: Awaited<ReturnType<typeof collect>>, o: { id: string; model: string; created: number }) {
  return {
    id: o.id, object: "chat.completion", created: o.created, model: o.model,
    choices: [{ index: 0, message: { role: "assistant", content: a.text || null, ...(a.calls.length ? { tool_calls: a.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })) } : {}) }, finish_reason: OPENAI_STOP[a.stop] }],
    usage: { prompt_tokens: a.usage.in, completion_tokens: a.usage.out, total_tokens: a.usage.in + a.usage.out },
  };
}

export function anthropicJson(a: Awaited<ReturnType<typeof collect>>, o: { id: string; model: string }) {
  return {
    id: o.id, type: "message", role: "assistant", model: o.model,
    content: [...(a.text ? [{ type: "text", text: a.text }] : []), ...a.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: parseObject(c.args) }))],
    stop_reason: ANTHROPIC_STOP[a.stop], stop_sequence: null,
    usage: { input_tokens: a.usage.in, output_tokens: a.usage.out },
  };
}
