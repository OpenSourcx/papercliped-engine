import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import type { QuickAction, QuickActions } from "./quickActions.ts";
import { useEngine } from "../data/store.tsx";
import { think, type PinCard } from "./brain.ts";
import { streamChat, type PinChatError, type PinSettings, type PinToolEvent } from "./live.ts";
import { demoSettingsSource, liveSettingsSource, type PinSettingsSource } from "./settings.ts";
import { pageOf } from "./suggestions.ts";
import { prefersReducedMotion } from "../ui/spring.ts";

export interface PinToolState extends PinToolEvent {
  /** What the person did with a proposal: ran it (and how that went) or cancelled it. */
  resolved?: "done" | "cancelled" | "failed";
  note?: string;
}

export interface PinMessage {
  id: string;
  from: "you" | "pin";
  text: string;
  card?: PinCard;
  done?: boolean; // a card the user already acted on
  tool?: PinToolState;
  error?: PinChatError;
  /** True while Pin is still writing this message. */
  streaming?: boolean;
}

export type IslandState = "rest" | "peek" | "actions" | "open";

interface PinCtx {
  state: IslandState;
  setState: (s: IslandState) => void;
  messages: PinMessage[];
  /** Waiting for Pin's first words. */
  thinking: boolean;
  /** Pin is writing an answer; stop() ends it. */
  streaming: boolean;
  stop: () => void;
  peek: { title: string; body?: string } | null;
  /** Sends a message to Pin. `inPlace` keeps the island closed (used by Pin's own page, which shows the chat itself). */
  send: (text: string, opts?: { inPlace?: boolean }) => void;
  markDone: (id: string) => void;
  resolveTool: (id: string, patch: Pick<PinToolState, "resolved" | "note">) => void;
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
  /** Pin's provider, model, mode and connectors, once known (live: from the host service). */
  settings: PinSettings | null;
  setSettings: (s: PinSettings) => void;
  settingsSource: PinSettingsSource;
  /** Switches Assistant/Agent everywhere: the console at once, and the host service's saved settings when live. */
  setMode: (m: "assistant" | "agent") => void;
}

const Ctx = createContext<PinCtx | null>(null);
let seq = 0;
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

export function PinProvider({ children }: { children: ReactNode }) {
  const engine = useEngine();
  const loc = useLocation();
  const [state, setState] = useState<IslandState>("rest");
  const [tab, setTab] = useState<"chat" | "notices">("chat");
  const [messages, setMessages] = useState<PinMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [peek, setPeek] = useState<{ title: string; body?: string } | null>(null);
  const [settings, setSettings] = useState<PinSettings | null>(null);
  const registry = useRef(new Map<string, { priority: number; actions: QuickActions }>());
  const latestBySource = useRef(new Map<string, QuickActions | null>());
  const [actions, setActions] = useState<QuickActions | null>(null);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const abort = useRef<AbortController | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const locRef = useRef(loc.pathname);
  locRef.current = loc.pathname;

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

  const settingsSource = useMemo<PinSettingsSource>(
    () => (engine.live ? liveSettingsSource() : demoSettingsSource({ get data() { return engineRef.current.data; }, get setup() { return engineRef.current.setup; }, setPinMode: (m) => engineRef.current.setPinMode(m), setConnectorAccess: (id, who, on) => engineRef.current.setConnectorAccess(id, who, on) })),
    [engine.live],
  );

  // Live: learn Pin's provider and model once, so the island can show them. Failure is fine; the settings page retries.
  useEffect(() => {
    let alive = true;
    settingsSource.load().then(
      (r) => {
        if (!alive) return;
        setSettings(r.settings);
        if (engineRef.current.setup && engineRef.current.setup.pinMode !== r.settings.mode) engineRef.current.setPinMode(r.settings.mode);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [settingsSource]);

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

  useEffect(() => () => {
    abort.current?.abort();
    timers.current.forEach(clearTimeout);
  }, []);

  const patch = (id: string, fn: (m: PinMessage) => PinMessage) => setMessages((list) => list.map((m) => (m.id === id ? fn(m) : m)));

  const stop = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setThinking(false);
    setStreaming(false);
    setMessages((list) => list.filter((m) => !(m.streaming && !m.text && !m.card)).map((m) => (m.streaming ? { ...m, streaming: false } : m)));
  }, []);

  const send = useCallback((text: string, opts?: { inPlace?: boolean }) => {
    const clean = text.trim();
    if (!clean) return;
    abort.current?.abort();
    timers.current.forEach(clearTimeout);
    timers.current = [];
    const history = messagesRef.current.filter((m) => m.text && !m.error).map((m) => ({ role: m.from === "you" ? ("user" as const) : ("assistant" as const), content: m.text }));
    const replyId = newId("p");
    setMessages((m) => [...m.map((x) => (x.streaming ? { ...x, streaming: false } : x)), { id: newId("u"), from: "you", text: clean }, { id: replyId, from: "pin", text: "", streaming: true }]);
    setTab("chat");
    if (!opts?.inPlace) setState("open");
    setThinking(true);
    setStreaming(true);
    const e = engineRef.current;
    const device = e.setup?.deviceName ?? "pve";

    const finish = () => {
      setThinking(false);
      setStreaming(false);
      setMessages((list) => list.filter((m) => !(m.id === replyId && !m.text && !m.card && !m.error)).map((m) => (m.id === replyId ? { ...m, streaming: false } : m)));
    };

    if (e.live) {
      const ctl = new AbortController();
      abort.current = ctl;
      const ref = pageOf(locRef.current, e.data.orgs.map((o) => o.slug));
      void streamChat(
        { messages: [...history, { role: "user", content: clean }], context: { page: locRef.current, device, ...(ref.org ? { org: ref.org } : {}) } },
        (ev) => {
          if (ctl.signal.aborted) return;
          if (ev.type === "delta") {
            setThinking(false);
            patch(replyId, (m) => ({ ...m, text: m.text + ev.text }));
          } else if (ev.type === "tool") {
            setThinking(false);
            setMessages((list) => {
              const existing = list.find((m) => m.tool?.id === ev.tool.id);
              if (existing) return list.map((m) => (m.tool?.id === ev.tool.id ? { ...m, tool: { ...m.tool!, ...ev.tool } } : m));
              const i = list.findIndex((m) => m.id === replyId);
              const item: PinMessage = { id: newId("t"), from: "pin", text: "", tool: ev.tool };
              return i < 0 ? [...list, item] : [...list.slice(0, i + 1), item, ...list.slice(i + 1)];
            });
          } else if (ev.type === "error") {
            patch(replyId, (m) => ({ ...m, error: ev.error }));
          }
        },
        { signal: ctl.signal },
      ).finally(() => {
        if (abort.current === ctl) abort.current = null;
        if (!ctl.signal.aborted) finish();
      });
      return;
    }

    // Demo: the scripted brain, revealed a few words at a time so it reads like a live answer.
    const reply = think(clean, { host: e.host, data: e.data, mode: e.setup?.pinMode ?? "assistant", device });
    const words = reply.text.split(/(\s+)/);
    const instant = prefersReducedMotion();
    const start = 520 + Math.min(700, clean.length * 10);
    timers.current.push(setTimeout(() => {
      setThinking(false);
      if (instant) {
        patch(replyId, (m) => ({ ...m, text: reply.text, card: reply.card }));
        finish();
        return;
      }
      let i = 0;
      const tick = () => {
        i = Math.min(words.length, i + 3);
        const done = i >= words.length;
        patch(replyId, (m) => ({ ...m, text: words.slice(0, i).join(""), ...(done ? { card: reply.card } : {}) }));
        if (done) finish();
        else timers.current.push(setTimeout(tick, 28));
      };
      tick();
    }, start));
  }, []);

  const value = useMemo<PinCtx>(
    () => ({
      state, setState, messages, thinking, streaming, stop, peek, send,
      markDone: (id) => setMessages((m) => m.map((x) => (x.id === id ? { ...x, done: true } : x))),
      resolveTool: (id, p) => setMessages((m) => m.map((x) => (x.id === id && x.tool ? { ...x, tool: { ...x.tool, ...p } } : x))),
      tab, setTab, actions, register, findLatest, latestBySource, confirm, setConfirm, settings, setSettings, settingsSource,
      setMode: (m) => {
        engineRef.current.setPinMode(m);
        if (settings && settings.mode !== m) {
          const next = { ...settings, mode: m };
          setSettings(next);
          if (engineRef.current.live) settingsSource.save(next).catch(() => setSettings(settings));
        }
      },
    }),
    [state, messages, thinking, streaming, stop, peek, send, tab, actions, register, findLatest, confirm, settings, settingsSource],
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
