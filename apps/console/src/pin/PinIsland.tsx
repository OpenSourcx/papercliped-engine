import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, Bell, Bot, Sparkles, X } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { cn } from "../lib/storage.ts";
import { Segmented } from "../ui/primitives.tsx";
import { PinCardView } from "./PinCards.tsx";
import { usePin } from "./PinContext.tsx";

export function PinOrb({ size = 22, thinking = false }: { size?: number; thinking?: boolean }) {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} aria-hidden>
      <span className={cn("pin-orb absolute inset-0 rounded-full", thinking && "thinking")} />
      <span className="absolute rounded-full bg-bg/25 blur-[1px]" style={{ inset: size * 0.22 }} />
      <span className="absolute rounded-full bg-white/70" style={{ width: size * 0.18, height: size * 0.18, top: size * 0.2, left: size * 0.26 }} />
    </span>
  );
}

const timeAgo = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

/**
 * Pin's home: a floating island at the top of every page. At rest it is a small glass pill; a new notice expands it
 * briefly (a "live activity"); clicking it, or pressing Ctrl/Cmd+K, opens it into Pin's panel.
 */
export function PinIsland() {
  const pin = usePin();
  const engine = useEngine();
  const mode = engine.setup?.pinMode ?? "assistant";
  const unread = engine.data.notices.filter((n) => !n.read).length;
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const open = pin.state === "open";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        pin.setState(open ? "rest" : "open");
      }
      if (e.key === "Escape" && open) pin.setState("rest");
    };
    const onDown = (e: MouseEvent) => {
      if (open && ref.current && !ref.current.contains(e.target as Node)) pin.setState("rest");
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, pin]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 250);
  }, [open]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [pin.messages, pin.thinking]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    pin.send(draft);
    setDraft("");
  };

  const size = open
    ? { width: "min(460px, calc(100vw - 24px))", height: "min(600px, calc(100dvh - 32px))", borderRadius: 28 }
    : pin.state === "peek"
      ? { width: "min(380px, calc(100vw - 24px))", height: 68, borderRadius: 26 }
      : { width: 196, height: 40, borderRadius: 999 };

  return (
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[58]" ref={ref}>
      <div className={cn("glass island overflow-hidden", open && "solid")} style={size}>
        {!open && (
          <button
            onClick={() => pin.setState("open")}
            className="absolute inset-0 flex items-center gap-2.5 px-2 pr-3 text-left"
            aria-label={`Open Pin${unread ? `, ${unread} unread` : ""}`}
          >
            <PinOrb size={pin.state === "peek" ? 40 : 26} thinking={pin.thinking} />
            {pin.state === "peek" && pin.peek ? (
              <span className="min-w-0 flex-1 fade-in">
                <span className="block text-[13px] font-medium truncate">{pin.peek.title}</span>
                {pin.peek.body && <span className="block text-[12px] text-ink-3 truncate">{pin.peek.body}</span>}
              </span>
            ) : (
              <>
                <span className="flex-1 min-w-0 text-[13px] font-medium truncate">
                  {pin.thinking ? <span className="shimmer-text">Thinking…</span> : <>Pin <span className="text-ink-3 font-normal">· {mode === "agent" ? "Agent" : "Assistant"}</span></>}
                </span>
                {unread > 0 && <span className="min-w-5 h-5 px-1.5 rounded-full bg-accent text-primary-ink text-[11px] font-semibold flex items-center justify-center tabular-nums">{unread}</span>}
              </>
            )}
          </button>
        )}

        {open && (
          <div className="flex flex-col h-full fade-in">
            <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-3 border-b border-line">
              <PinOrb size={28} thinking={pin.thinking} />
              <div className="flex-1 min-w-0">
                <div className="text-[15px] font-semibold leading-tight">Pin</div>
                <div className="text-[12px] text-ink-3">{mode === "agent" ? "Acts on its own, tells you after" : "Asks before it acts"}</div>
              </div>
              <Segmented size="sm" value={mode} onChange={(m) => engine.setPinMode(m)} options={[{ value: "assistant", label: "Assistant" }, { value: "agent", label: "Agent" }]} />
              <button onClick={() => pin.setState("rest")} className="h-7 w-7 rounded-full hover:bg-surface-3 flex items-center justify-center text-ink-3" aria-label="Close Pin">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex gap-1 px-3 pt-2">
              {(["chat", "notices"] as const).map((t) => (
                <button key={t} onClick={() => { pin.setTab(t); if (t === "notices") engine.markRead(); }} className={cn("px-3 h-7 rounded-full text-[13px] inline-flex items-center gap-1.5", pin.tab === t ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink-2")}>
                  {t === "chat" ? <Sparkles className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
                  {t === "chat" ? "Chat" : "Notifications"}
                  {t === "notices" && unread > 0 && <span className="text-accent tabular-nums">{unread}</span>}
                </button>
              ))}
            </div>

            {pin.tab === "chat" ? (
              <>
                <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                  {pin.messages.length === 0 && (
                    <div className="text-center pt-10 px-4">
                      <Bot className="h-6 w-6 mx-auto text-ink-3" />
                      <p className="text-[14px] text-ink-2 mt-3">Ask me about your device, your organizations, or tell me what to automate.</p>
                      <div className="flex flex-wrap justify-center gap-2 mt-4">
                        {["How is my server?", "If a container uses more than 50% of its memory, shut it down", "Create a company called Lumen"].map((s) => (
                          <button key={s} onClick={() => pin.send(s)} className="text-[12px] px-3 py-1.5 rounded-full border border-line bg-surface-2 hover:bg-surface-3 text-ink-2 text-left">{s}</button>
                        ))}
                      </div>
                    </div>
                  )}
                  {pin.messages.map((m) => (
                    <div key={m.id} className={cn("fade-in flex", m.from === "you" ? "justify-end" : "justify-start")}>
                      <div className={cn("max-w-[88%] text-[14px] leading-relaxed", m.from === "you" ? "bg-surface-3 rounded-2xl rounded-br-md px-3.5 py-2" : "")}>
                        {m.text}
                        {m.card && <PinCardView card={m.card} done={m.done} onDone={() => pin.markDone(m.id)} />}
                      </div>
                    </div>
                  ))}
                  {pin.thinking && <div className="text-[14px] shimmer-text">Pin is thinking…</div>}
                </div>
                <form onSubmit={submit} className="p-3 pt-1">
                  <div className="flex items-center gap-2 rounded-full bg-surface/80 border border-line pl-4 pr-1.5 h-11 focus-within:border-line-strong">
                    <input ref={inputRef} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask Pin" aria-label="Message Pin" className="flex-1 bg-transparent outline-none focus-visible:outline-none text-[14px] placeholder:text-ink-3 min-w-0" />
                    <button type="submit" disabled={!draft.trim()} className="h-8 w-8 rounded-full bg-primary text-primary-ink flex items-center justify-center disabled:opacity-30" aria-label="Send">
                      <ArrowUp className="h-4 w-4" />
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
                {engine.data.notices.length === 0 && <p className="text-center text-ink-3 text-sm pt-10">Nothing yet.</p>}
                {engine.data.notices.map((n) => (
                  <div key={n.id} className="rounded-xl border border-line bg-surface/70 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-[14px] font-medium">{n.title}</div>
                      <div className="text-[11px] text-ink-3 shrink-0 tabular-nums">{timeAgo(n.at)}</div>
                    </div>
                    <p className="text-[13px] text-ink-2 mt-1">{n.body}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
