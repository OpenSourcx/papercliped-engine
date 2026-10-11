import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { QuickAction, QuickActions } from "./quickActions.ts";
import { useEngine } from "../data/store.tsx";
import { think, type PinCard } from "./brain.ts";

export interface PinMessage {
  id: string;
  from: "you" | "pin";
  text: string;
  card?: PinCard;
  done?: boolean; // a card the user already acted on
}

export type IslandState = "rest" | "peek" | "actions" | "open";

interface PinCtx {
  state: IslandState;
  setState: (s: IslandState) => void;
  messages: PinMessage[];
  thinking: boolean;
  peek: { title: string; body?: string } | null;
  /** Sends a message to Pin. `inPlace` keeps the island closed (used by Pin's own page, which shows the chat itself). */
  send: (text: string, opts?: { inPlace?: boolean }) => void;
  markDone: (id: string) => void;
  tab: "chat" | "notices";
  setTab: (t: "chat" | "notices") => void;
  /** Quick actions for whatever the user is looking at: the most specific registered set (highest priority). */
  actions: QuickActions | null;
  register: (source: string, a: QuickActions | null, priority: number) => void;
  /** The newest version of an action, so a click always runs current code, not a stale closure. */
  findLatest: (id: string) => QuickAction | undefined;
  latestBySource: React.MutableRefObject<Map<string, QuickActions | null>>;
  /** A risky action waiting for the user to confirm. Lives here so it survives the island collapsing. */
  confirm: QuickAction | null;
  setConfirm: (a: QuickAction | null) => void;
}

const Ctx = createContext<PinCtx | null>(null);

export function PinProvider({ children }: { children: ReactNode }) {
  const engine = useEngine();
  const [state, setState] = useState<IslandState>("rest");
  const [tab, setTab] = useState<"chat" | "notices">("chat");
  const [messages, setMessages] = useState<PinMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const [peek, setPeek] = useState<{ title: string; body?: string } | null>(null);
  const registry = useRef(new Map<string, { priority: number; actions: QuickActions }>());
  const latestBySource = useRef(new Map<string, QuickActions | null>());
  const [actions, setActions] = useState<QuickActions | null>(null);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const register = useCallback((source: string, a: QuickActions | null, priority: number) => {
    if (a) registry.current.set(source, { priority, actions: a });
    else registry.current.delete(source);
    // The most specific set leads (a machine's power actions); the page's broader suggestions follow it, so the island
    // always shows everything you can do from here.
    const ranked = [...registry.current].sort((a, b) => b[1].priority - a[1].priority);
    const best = ranked[0];
    if (!best) {
      setActions(null);
      setActiveSource(null);
      return;
    }
    const items = [...best[1].actions.items];
    for (const [, r] of ranked.slice(1)) for (const it of r.actions.items) if (!items.some((x) => x.id === it.id)) items.push({ ...it, more: true });
    setActions({ context: best[1].actions.context, items });
    setActiveSource(best[0]);
  }, []);
  const findLatest = useCallback(
    (id: string) => {
      const sources = [activeSource, ...[...registry.current].sort((a, b) => b[1].priority - a[1].priority).map(([s]) => s)];
      for (const s of sources) {
        const hit = s ? latestBySource.current.get(s)?.items.find((x) => x.id === id) : undefined;
        if (hit) return hit;
      }
      return undefined;
    },
    [activeSource],
  );
  const [confirm, setConfirm] = useState<QuickAction | null>(null);
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

  const send = useCallback((text: string, opts?: { inPlace?: boolean }) => {
    const clean = text.trim();
    if (!clean) return;
    setMessages((m) => [...m, { id: `u-${Date.now()}`, from: "you", text: clean }]);
    setTab("chat");
    if (!opts?.inPlace) setState("open");
    setThinking(true);
    const e = engineRef.current;
    const reply = think(clean, { host: e.host, data: e.data, mode: e.setup?.pinMode ?? "assistant", device: e.setup?.deviceName ?? "pve" });
    setTimeout(() => {
      setMessages((m) => [...m, { id: `p-${Date.now()}`, from: "pin", ...reply }]);
      setThinking(false);
    }, 650 + Math.min(900, clean.length * 12));
  }, []);

  const value = useMemo<PinCtx>(
    () => ({ state, setState, messages, thinking, peek, send, markDone: (id) => setMessages((m) => m.map((x) => (x.id === id ? { ...x, done: true } : x))), tab, setTab, actions, register, findLatest, latestBySource, confirm, setConfirm }),
    [state, messages, thinking, peek, send, tab, actions, register, findLatest, confirm],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Gives Pin the quick actions for the current page. Call it every render with the current list. The most specific
 * registration wins: pages use a higher priority than the app shell's defaults. Cleared when the caller unmounts.
 */
export function usePinActions(actions: QuickActions | null, priority = 10) {
  const pin = useContext(Ctx);
  const source = useId();
  if (pin) pin.latestBySource.current.set(source, actions);
  const ref = useRef(actions);
  ref.current = actions;
  const key = actions ? `${actions.context}|${actions.items.map((i) => `${i.id}:${i.disabled ? 1 : 0}:${i.label}`).join(",")}` : "";
  useEffect(() => {
    pin?.register(source, ref.current, priority);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, priority]);
  useEffect(() => () => {
    pin?.latestBySource.current.delete(source);
    pin?.register(source, null, priority);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

export function usePin(): PinCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePin outside PinProvider");
  return v;
}
