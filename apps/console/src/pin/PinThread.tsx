import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowUp, MoreHorizontal, Square } from "lucide-react";
import { Menu, type MenuEntry } from "../ui/primitives.tsx";
import { cn } from "../lib/storage.ts";
import { PinCardView, ToolCard } from "./PinCards.tsx";
import type { PinMessage } from "./PinContext.tsx";
import { useThreadApi } from "./ThreadContext.tsx";
import { PinOrb } from "./PinOrb.tsx";
import { Markdown } from "../pages/pin/notes/Markdown.tsx";

/**
 * Pin's conversation, shared by the island and Pin's page: the messages, then the composer. Pin's words sit on the
 * page; yours sit in a bubble on the right. While Pin writes, a soft caret breathes at the end of its words.
 */
export function PinThread({ inPlace, empty, footer, below, className, autoFocus }: { inPlace?: boolean; empty: ReactNode; footer?: ReactNode; /** Under the composer: what the conversation is running with. */ below?: ReactNode; className?: string; autoFocus?: boolean }) {
  const pin = useThreadApi();
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow the conversation while the reader is at the bottom; leave them be if they scrolled up to read.
  const onScroll = () => {
    const el = list.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  useLayoutEffect(() => {
    const el = list.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [pin.messages, pin.thinking]);

  return (
    <div className={cn("flex flex-col min-h-0", className)}>
      <div ref={list} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 py-4" aria-live="polite" aria-busy={pin.streaming}>
        {pin.messages.length === 0 ? empty : (
          <div className="space-y-4">
            {pin.messages.map((m) => <Message key={m.id} m={m} inPlace={inPlace} />)}
          </div>
        )}
      </div>
      {footer}
      <PinInput inPlace={inPlace} autoFocus={autoFocus} />
      {below}
    </div>
  );
}

/** The dots while Pin waits for its model; after a few seconds it says so, since a slow model looks like a stuck one. */
function Waiting() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(t);
  }, []);
  return (
    <span className="inline-flex items-center gap-2 h-6" role="status">
      <span className="pin-dots" aria-hidden><span /><span /><span /></span>
      {slow ? <span className="text-compact text-ink-3">Still waiting for the model. Some are slow; Stop ends it, or pick another model in Pin's settings.</span> : <span className="sr-only">Pin is thinking</span>}
    </span>
  );
}

/** Markdown as a person would read it: no markers, links as their words. */
export const plainText = (md: string) =>
  md.replace(/```[a-z0-9]*\n?/gi, "").replace(/`([^`]*)`/g, "$1").replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/^>\s?/gm, "");

/** Puts a message into the composer as a quote, so the next message refers to it. */
export const quoteIntoComposer = (text: string) => window.dispatchEvent(new CustomEvent("pin:quote", { detail: text }));

function MessageMenu({ text }: { text: string }) {
  const items: MenuEntry[] = [
    { label: "Copy message", onSelect: () => void navigator.clipboard?.writeText(plainText(text)).catch(() => undefined) },
    { label: "Copy message as Markdown", onSelect: () => void navigator.clipboard?.writeText(text).catch(() => undefined) },
    { kind: "separator" },
    { label: "Quote in reply", onSelect: () => quoteIntoComposer(text) },
  ];
  return <span className="absolute -top-2 right-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 rounded-lg bg-surface border border-line shadow-raised"><Menu size="sm" label="Message options" icon={<MoreHorizontal className="h-4 w-4" />} items={items} /></span>;
}

function Message({ m, inPlace }: { m: PinMessage; inPlace?: boolean }) {
  const pin = useThreadApi();
  if (m.from === "you") {
    return (
      <div className="group relative flex justify-end fade-in">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-3 px-3.5 py-2 text-pretty"><Markdown text={m.text} chat /></div>
        {m.text && <MessageMenu text={m.text} />}
      </div>
    );
  }
  const waiting = m.streaming && !m.text && !m.error;
  return (
    <div className="group relative flex gap-2.5 fade-in">
      {m.text && !m.streaming && <MessageMenu text={m.text} />}
      {inPlace && <span className="mt-0.5"><PinOrb size={22} thinking={m.streaming} /></span>}
      <div className="min-w-0 flex-1 text-sm leading-relaxed">
        {m.name && <div className="text-xs text-ink-3 mb-0.5">{m.name}</div>}
        {waiting ? (
          <Waiting />
        ) : m.text ? (
          <div><Markdown text={m.text} chat />{m.streaming && <span className="pin-cursor" aria-hidden />}</div>
        ) : null}
        {m.error && (
          <div role="alert" className="mt-1 rounded-xl border border-critical/25 bg-critical/5 px-3.5 py-2.5 text-compact fade-in">
            <div className="text-ink">{m.error.message}</div>
            {m.error.fix && <Link to={m.error.fix.to} className="mt-1 inline-flex items-center gap-1 font-medium text-accent hover:underline">{m.error.fix.label}</Link>}
          </div>
        )}
        {m.card && <PinCardView card={m.card} done={m.done} onDone={() => pin.markDone(m.id)} />}
        {m.tool && <ToolCard messageId={m.id} tool={m.tool} />}
      </div>
    </div>
  );
}

/** The composer: grows with the text, Enter sends, Shift+Enter starts a new line, and Stop ends an answer. */
export function PinInput({ inPlace, autoFocus, placeholder }: { inPlace?: boolean; autoFocus?: boolean; placeholder?: string }) {
  const pin = useThreadApi();
  const [draft, setDraft] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);
  // "Quote in reply" from a message's menu: the quote goes on top of whatever is being written.
  useEffect(() => {
    const onQuote = (e: Event) => {
      const text = String((e as CustomEvent).detail ?? "").trim();
      if (!text) return;
      setDraft((d) => `${text.split("\n").map((l) => `> ${l}`).join("\n")}\n\n${d}`);
      setTimeout(() => area.current?.focus({ preventScroll: true }), 0);
    };
    window.addEventListener("pin:quote", onQuote);
    return () => window.removeEventListener("pin:quote", onQuote);
  }, []);
  useEffect(() => {
    if (!autoFocus) return;
    const t = setTimeout(() => area.current?.focus({ preventScroll: true }), 120);
    return () => clearTimeout(t);
  }, [autoFocus]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (pin.streaming && !draft.trim()) return pin.stop();
    if (!draft.trim()) return;
    pin.send(draft, { inPlace });
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const canStop = pin.streaming && !draft.trim();

  return (
    <form onSubmit={submit} className="p-3 pt-2">
      <div className="transition-control flex items-end gap-2 rounded-2xl bg-surface-2 border border-line pl-4 pr-1.5 py-1.5 focus-within:border-line-strong focus-within:ring-2 focus-within:ring-accent/20">
        <textarea
          ref={area}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder={placeholder ?? (pin.name ? `Message ${pin.name}` : "Ask Pin")}
          aria-label={`Message ${pin.name ?? "Pin"}`}
          className="flex-1 min-w-0 resize-none bg-transparent py-1.5 text-sm leading-6 outline-none focus-visible:outline-none placeholder:text-ink-3"
        />
        <button
          type="submit"
          disabled={!canStop && !draft.trim()}
          className="transition-control h-8 w-8 shrink-0 rounded-full bg-primary text-primary-ink flex items-center justify-center disabled:opacity-30 active:scale-95"
          aria-label={canStop ? "Stop" : "Send"}
          title={canStop ? "Stop" : "Send"}
        >
          {canStop ? <Square className="h-3 w-3 fill-current" /> : <ArrowUp className="h-4 w-4" />}
        </button>
      </div>
    </form>
  );
}
