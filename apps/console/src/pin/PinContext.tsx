import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useEngine } from "../data/store.tsx";
import { think, type PinCard } from "./brain.ts";

export interface PinMessage {
  id: string;
  from: "you" | "pin";
  text: string;
  card?: PinCard;
  done?: boolean; // a card the user already acted on
}

export type IslandState = "rest" | "peek" | "open";

interface PinCtx {
  state: IslandState;
  setState: (s: IslandState) => void;
  messages: PinMessage[];
  thinking: boolean;
  peek: { title: string; body?: string } | null;
  send: (text: string) => void;
  markDone: (id: string) => void;
  tab: "chat" | "notices";
  setTab: (t: "chat" | "notices") => void;
}

const Ctx = createContext<PinCtx | null>(null);

export function PinProvider({ children }: { children: ReactNode }) {
  const engine = useEngine();
  const [state, setState] = useState<IslandState>("rest");
  const [tab, setTab] = useState<"chat" | "notices">("chat");
  const [messages, setMessages] = useState<PinMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const [peek, setPeek] = useState<{ title: string; body?: string } | null>(null);
  const seen = useRef(new Set(engine.data.notices.map((n) => n.id)));
  const engineRef = useRef(engine);
  engineRef.current = engine;

  // A new notice briefly expands the island, like a live activity, then it settles back.
  useEffect(() => {
    const fresh = engine.data.notices.find((n) => !seen.current.has(n.id));
    engine.data.notices.forEach((n) => seen.current.add(n.id));
    if (!fresh || state === "open") return;
    setPeek({ title: fresh.title, body: fresh.body });
    setState("peek");
    const t = setTimeout(() => {
      setState((s) => (s === "peek" ? "rest" : s));
      setPeek(null);
    }, 4200);
    return () => clearTimeout(t);
  }, [engine.data.notices, state]);

  const send = useCallback((text: string) => {
    const clean = text.trim();
    if (!clean) return;
    setMessages((m) => [...m, { id: `u-${Date.now()}`, from: "you", text: clean }]);
    setTab("chat");
    setState("open");
    setThinking(true);
    const e = engineRef.current;
    const reply = think(clean, { host: e.host, data: e.data, mode: e.setup?.pinMode ?? "assistant", device: e.setup?.deviceName ?? "pve" });
    setTimeout(() => {
      setMessages((m) => [...m, { id: `p-${Date.now()}`, from: "pin", ...reply }]);
      setThinking(false);
    }, 650 + Math.min(900, clean.length * 12));
  }, []);

  const value = useMemo<PinCtx>(
    () => ({ state, setState, messages, thinking, peek, send, markDone: (id) => setMessages((m) => m.map((x) => (x.id === id ? { ...x, done: true } : x))), tab, setTab }),
    [state, messages, thinking, peek, send, tab],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePin(): PinCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePin outside PinProvider");
  return v;
}
