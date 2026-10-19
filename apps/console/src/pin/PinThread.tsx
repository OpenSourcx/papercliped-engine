import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowUp, Square } from "lucide-react";
import { cn } from "../lib/storage.ts";
import { PinCardView, ToolCard } from "./PinCards.tsx";
import { usePin, type PinMessage } from "./PinContext.tsx";
import { PinOrb } from "./PinOrb.tsx";
import { Markdown } from "../pages/pin/notes/Markdown.tsx";

/**
 * Pin's conversation, shared by the island and Pin's page: the messages, then the composer. Pin's words sit on the
 * page; yours sit in a bubble on the right. While Pin writes, a soft caret breathes at the end of its words.
 */
export function PinThread({ inPlace, empty, footer, className, autoFocus }: { inPlace?: boolean; empty: ReactNode; footer?: ReactNode; className?: string; autoFocus?: boolean }) {
  const pin = usePin();
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
    </div>
  );
}

function Message({ m, inPlace }: { m: PinMessage; inPlace?: boolean }) {
  const pin = usePin();
  if (m.from === "you") {
    return (
      <div className="flex justify-end fade-in">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-3 px-3.5 py-2 text-pretty"><Markdown text={m.text} chat /></div>
      </div>
    );
  }
  const waiting = m.streaming && !m.text && !m.error;
  return (
    <div className="flex gap-2.5 fade-in">
      {inPlace && <span className="mt-0.5"><PinOrb size={22} thinking={m.streaming} /></span>}
      <div className="min-w-0 flex-1 text-sm leading-relaxed">
        {waiting ? (
          <span className="inline-flex items-center h-6" role="status"><span className="pin-dots" aria-hidden><span /><span /><span /></span><span className="sr-only">Pin is thinking</span></span>
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
export function PinInput({ inPlace, autoFocus, placeholder = "Ask Pin" }: { inPlace?: boolean; autoFocus?: boolean; placeholder?: string }) {
  const pin = usePin();
  const [draft, setDraft] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);
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
          placeholder={placeholder}
          aria-label="Message Pin"
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
