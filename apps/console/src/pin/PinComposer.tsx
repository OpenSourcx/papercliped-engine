import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, Building2, ChevronDown, Mic, Plus, RefreshCw, Workflow } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { cn } from "../lib/storage.ts";
import { usePin } from "./PinContext.tsx";

type SpeechCtor = new () => { lang: string; interimResults: boolean; onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void; onend: () => void; start: () => void; stop: () => void };

/** The big "Ask Pin" bar on the home page. Sending opens the island with the conversation. */
export function PinComposer() {
  const pin = usePin();
  const engine = useEngine();
  const mode = engine.setup?.pinMode ?? "assistant";
  const [text, setText] = useState("");
  const [menu, setMenu] = useState<null | "plus" | "mode">(null);
  const [listening, setListening] = useState(false);
  const wrap = useRef<HTMLFormElement>(null);
  const Speech = (typeof window !== "undefined" && ((window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: SpeechCtor }).webkitSpeechRecognition)) || null;

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, []);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim()) return;
    pin.send(text);
    setText("");
  };

  const listen = () => {
    if (!Speech) return;
    const r = new Speech();
    r.lang = navigator.language || "en-US";
    r.interimResults = false;
    r.onresult = (e) => setText((t) => `${t}${t ? " " : ""}${e.results[0][0].transcript}`);
    r.onend = () => setListening(false);
    setListening(true);
    r.start();
  };

  const quick = [
    { icon: <Building2 className="h-4 w-4" />, label: "Create an organization", text: "Create a company called " },
    { icon: <Workflow className="h-4 w-4" />, label: "Add an automation", text: "If a container uses more than 50% of its memory, shut it down" },
    { icon: <RefreshCw className="h-4 w-4" />, label: "Check for updates", text: "Are there any updates?" },
  ];

  return (
    <form ref={wrap} onSubmit={submit} className="relative w-full">
      <div className="glass flex items-center gap-1 sm:gap-2 rounded-full h-16 pl-3 pr-2.5 sm:pl-4 transition focus-within:border-accent/40">
        <button type="button" onClick={() => setMenu(menu === "plus" ? null : "plus")} className="h-10 w-10 rounded-full flex items-center justify-center text-ink-2 hover:text-ink hover:bg-surface-3 shrink-0" aria-label="Suggestions" aria-expanded={menu === "plus"}>
          <Plus className="h-5 w-5" />
        </button>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask Pin" aria-label="Ask Pin" className="flex-1 min-w-0 bg-transparent outline-none focus-visible:outline-none text-lead placeholder:text-ink-3 px-1" />
        <button type="button" onClick={() => setMenu(menu === "mode" ? null : "mode")} className="hidden sm:inline-flex items-center gap-1.5 h-9 px-3 rounded-full hover:bg-surface-3 text-sm shrink-0" aria-expanded={menu === "mode"}>
          <span className="font-medium">Pin</span>
          <span className="text-ink-3">{mode === "agent" ? "Agent" : "Assistant"}</span>
          <ChevronDown className="h-4 w-4 text-ink-3" />
        </button>
        {text.trim() ? (
          <button type="submit" className="h-10 w-10 rounded-full bg-primary text-primary-ink flex items-center justify-center shrink-0" aria-label="Send">
            <ArrowUp className="h-5 w-5" />
          </button>
        ) : (
          <button type="button" onClick={listen} disabled={!Speech} title={Speech ? "Speak to Pin" : "Voice input isn't supported in this browser"} className={cn("h-10 w-10 rounded-full flex items-center justify-center shrink-0 disabled:opacity-40", listening ? "bg-accent text-primary-ink" : "text-ink-2 hover:text-ink hover:bg-surface-3")} aria-label="Voice input">
            <Mic className="h-5 w-5" />
          </button>
        )}
      </div>

      {menu === "plus" && (
        <div className="glass solid absolute left-0 top-[calc(100%+8px)] w-72 rounded-2xl p-1.5 z-20 fade-in">
          {quick.map((q) => (
            <button key={q.label} type="button" onClick={() => { setText(q.text); setMenu(null); }} className="w-full flex items-center gap-3 px-3 h-10 rounded-xl hover:bg-surface-3 text-sm text-left">
              <span className="text-ink-3">{q.icon}</span>
              {q.label}
            </button>
          ))}
        </div>
      )}
      {menu === "mode" && (
        <div className="glass solid absolute right-12 top-[calc(100%+8px)] w-72 rounded-2xl p-1.5 z-20 fade-in">
          {(["assistant", "agent"] as const).map((m) => (
            <button key={m} type="button" onClick={() => { engine.setPinMode(m); setMenu(null); }} className={cn("w-full text-left px-3 py-2.5 rounded-xl hover:bg-surface-3", mode === m && "bg-surface-3/70")}>
              <div className="text-sm font-medium">{m === "agent" ? "Agent" : "Assistant"}</div>
              <div className="text-xs text-ink-3">{m === "agent" ? "Works on its own, follows your schedule and triggers" : "Monitors and does light tasks; asks before acting"}</div>
            </button>
          ))}
        </div>
      )}
    </form>
  );
}
