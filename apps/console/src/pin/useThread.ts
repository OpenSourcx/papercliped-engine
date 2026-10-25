import { useCallback, useEffect, useRef, useState } from "react";
import type { PinCard } from "./brain.ts";
import type { PinChatError, PinToolEvent } from "./live.ts";

/**
 * One conversation, whoever is on the other end: Pin, an organization's agent, later a Collaborate room. The thread owns the
 * messages and the "waiting / writing" state; a source (a function) says where the words come from and reports them as
 * events. Pin's island and page use it through PinContext; PinView and organization chats use it directly.
 */

export interface ToolState extends PinToolEvent {
  /** What the person did with a proposal: ran it (and how that went) or cancelled it. */
  resolved?: "done" | "cancelled" | "failed";
  note?: string;
}

/** Who wrote a message: the person, Pin, or an agent (with its name, so the thread can label it). */
export type Author = "you" | "pin" | "agent";

export interface ThreadMessage {
  id: string;
  from: Author;
  /** For agents and other people: the name to show. */
  name?: string;
  text: string;
  card?: PinCard;
  done?: boolean; // a card the user already acted on
  tool?: ToolState;
  error?: PinChatError;
  /** True while the other side is still writing this message. */
  streaming?: boolean;
}

/** What a source reports while it answers. */
export type ThreadEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; tool: PinToolEvent }
  | { type: "card"; card: PinCard }
  | { type: "error"; error: PinChatError };

export interface HistoryItem { role: "user" | "assistant"; content: string }

/** Produces the answer to one message. Resolves when the answer is complete; must stop when `signal` aborts. */
export type ThreadSource = (io: { emit: (ev: ThreadEvent) => void; signal: AbortSignal; history: HistoryItem[] }) => Promise<void>;

let seq = 0;
export const newId = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

/** Resolves false when `signal` aborts first, so a source can pace itself and still stop at once. */
export const wait = (ms: number, signal: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    if (signal.aborted) return resolve(false);
    const t = setTimeout(() => { signal.removeEventListener("abort", off); resolve(true); }, ms);
    const off = () => { clearTimeout(t); resolve(false); };
    signal.addEventListener("abort", off, { once: true });
  });

export function useThread() {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const patch = useCallback((id: string, fn: (m: ThreadMessage) => ThreadMessage) => setMessages((list) => list.map((m) => (m.id === id ? fn(m) : m))), []);

  const stop = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setThinking(false);
    setStreaming(false);
    setMessages((list) => list.filter((m) => !(m.streaming && !m.text && !m.card)).map((m) => (m.streaming ? { ...m, streaming: false } : m)));
  }, []);

  /** Replaces the whole conversation (opening a saved one, starting a new one). */
  const reset = useCallback((list: ThreadMessage[] = []) => {
    stop();
    setMessages(list);
  }, [stop]);

  /** Adds the person's message and the answer it gets from `source`. `as` names the answering side when it isn't Pin. */
  const run = useCallback((text: string, source: ThreadSource, as?: { from: Author; name?: string }) => {
    abort.current?.abort();
    const history = messagesRef.current.filter((m) => m.text && !m.error).map((m) => ({ role: m.from === "you" ? ("user" as const) : ("assistant" as const), content: m.text }));
    const who = as ?? { from: "pin" as const };
    let replyId = newId("p");
    setMessages((m) => [...m.map((x) => (x.streaming ? { ...x, streaming: false } : x)), { id: newId("u"), from: "you", text }, { id: replyId, ...who, text: "", streaming: true }]);
    setThinking(true);
    setStreaming(true);
    const ctl = new AbortController();
    abort.current = ctl;

    const finish = () => {
      setThinking(false);
      setStreaming(false);
      setMessages((list) => list.filter((m) => !(m.streaming && !m.tool && !m.text && !m.card && !m.error)).map((m) => (m.streaming ? { ...m, streaming: false } : m)));
    };

    const emit = (ev: ThreadEvent) => {
      if (ctl.signal.aborted) return;
      if (ev.type === "delta") {
        setThinking(false);
        patch(replyId, (m) => ({ ...m, text: m.text + ev.text }));
      } else if (ev.type === "card") {
        setThinking(false);
        patch(replyId, (m) => ({ ...m, card: ev.card }));
      } else if (ev.type === "tool") {
        setThinking(false);
        if (messagesRef.current.some((m) => m.tool?.id === ev.tool.id)) {
          setMessages((list) => list.map((m) => (m.tool?.id === ev.tool.id ? { ...m, tool: { ...m.tool!, ...ev.tool } } : m)));
          return;
        }
        // A new step goes after whatever has been said so far, and what comes next starts below it, so the thread reads in order.
        const prev = replyId;
        const fresh = newId("p");
        replyId = fresh;
        setMessages((list) => {
          const out: ThreadMessage[] = [];
          for (const m of list) {
            if (m.id !== prev) out.push(m);
            else {
              if (m.text || m.card || m.error) out.push({ ...m, streaming: false });
              out.push({ id: newId("t"), ...who, text: "", tool: ev.tool }, { id: fresh, ...who, text: "", streaming: true });
            }
          }
          return out;
        });
      } else if (ev.type === "error") {
        patch(replyId, (m) => ({ ...m, error: ev.error }));
      }
    };

    void source({ emit, signal: ctl.signal, history }).finally(() => {
      if (abort.current === ctl) abort.current = null;
      if (!ctl.signal.aborted) finish();
    });
  }, [patch]);

  const markDone = useCallback((id: string) => setMessages((m) => m.map((x) => (x.id === id ? { ...x, done: true } : x))), []);
  const resolveTool = useCallback((id: string, p: Pick<ToolState, "resolved" | "note">) => setMessages((m) => m.map((x) => (x.id === id && x.tool ? { ...x, tool: { ...x.tool, ...p } } : x))), []);

  return { messages, thinking, streaming, run, stop, reset, markDone, resolveTool };
}
