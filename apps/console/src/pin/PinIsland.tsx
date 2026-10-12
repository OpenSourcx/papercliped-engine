import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Bell, Maximize2, Settings2, Sparkles, X } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { cn } from "../lib/storage.ts";
import { Button, IconButton, Segmented } from "../ui/primitives.tsx";
import { Modal, useAnyModalOpen } from "../ui/Modal.tsx";
import { useSpringBox } from "../ui/spring.ts";
import { usePin } from "./PinContext.tsx";
import { PinOrb } from "./PinOrb.tsx";
import { PinThread } from "./PinThread.tsx";
import { QuickActionBar } from "./QuickActionBar.tsx";

export { PinOrb } from "./PinOrb.tsx";

/**
 * Pin's island: one shape at the top of every page that morphs between what Pin is doing, like Apple's Dynamic Island.
 *
 *   rest     a small pill: Pin, its mode, unread count
 *   status   a wider pill while Pin thinks or writes, or a task this console started is running
 *   peek     a notice, briefly, then it settles back
 *   actions  on hover: quick actions for the page you're on
 *   open     the panel: chat and notifications
 *
 * The shape springs (ui/spring.ts) and is interruptible; content cross-fades in layers laid out at their final size,
 * so text never reflows while the shape moves. Reduced motion skips the springs and keeps a plain fade.
 */
type View = "rest" | "status" | "peek" | "actions" | "open";

const timeAgo = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

function useViewport() {
  const read = () => ({ w: typeof window === "undefined" ? 1280 : window.innerWidth, h: typeof window === "undefined" ? 800 : window.innerHeight });
  const [vp, setVp] = useState(read);
  useEffect(() => {
    const on = () => setVp(read());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return vp;
}

/** The island's shape for each view, in px. Heights of content-sized views come from measuring the content. */
export function islandBox(view: View, vp: { w: number; h: number }, measured: number | null): { width: number; height: number; radius: number } {
  const room = vp.w - 16;
  switch (view) {
    case "open": return { width: Math.min(480, room), height: Math.min(640, vp.h - 20), radius: 24 };
    case "actions": return { width: Math.min(720, room), height: Math.max(56, (measured ?? 54) + 2), radius: 28 };
    case "peek": return { width: Math.min(380, room), height: Math.max(60, (measured ?? 58) + 2), radius: 28 };
    case "status": return { width: Math.min(300, room), height: 40, radius: 20 };
    default: return { width: 184, height: 40, radius: 20 };
  }
}

export function PinIsland() {
  const pin = usePin();
  const engine = useEngine();
  const vp = useViewport();
  const modalOpen = useAnyModalOpen();
  const mode = engine.setup?.pinMode ?? "assistant";
  const unread = engine.data.notices.filter((n) => !n.read).length;
  const wrap = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const enter = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const leave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const canHover = typeof window !== "undefined" && !!window.matchMedia?.("(hover: hover)").matches;
  const open = pin.state === "open";
  const runningTask = engine.running[0];
  const busy = pin.thinking || pin.streaming || !!runningTask;

  const view: View = open ? "open" : pin.state === "actions" && pin.actions?.items.length ? "actions" : pin.state === "peek" && pin.peek ? "peek" : busy ? "status" : "rest";

  // Content layers: the new view enters while the old one leaves, so the cross-fade never waits on the shape.
  const [layers, setLayers] = useState<{ view: View; phase: "enter" | "in" | "exit" }[]>([{ view, phase: "in" }]);
  useLayoutEffect(() => {
    setLayers((prev) => (prev.some((l) => l.view === view && l.phase !== "exit") ? prev : [...prev.filter((l) => l.view !== view).map((l) => ({ ...l, phase: "exit" as const })), { view, phase: "enter" }]));
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setLayers((prev) => prev.map((l) => (l.view === view && l.phase === "enter" ? { ...l, phase: "in" } : l)))));
    const t = setTimeout(() => setLayers((prev) => prev.filter((l) => l.phase !== "exit")), 220);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [view]);

  // Measure the current layer so content-sized views (actions, peek) get exactly the height they need.
  const [measured, setMeasured] = useState<number | null>(null);
  const current = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = current.current;
    if (!el) return;
    const read = () => setMeasured(Math.ceil(el.getBoundingClientRect().height));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [view, layers.length]);

  const box = islandBox(view, vp, measured);
  useSpringBox(shell, box);

  // Ctrl/Cmd+K toggles Pin; Esc closes it and returns focus to the pill. A click outside closes it too.
  const wasOpen = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        pin.setState(open ? "rest" : "open");
      }
      if (e.key === "Escape" && open && !document.querySelector('[aria-modal="true"]')) pin.setState("rest");
    };
    const onDown = (e: MouseEvent) => {
      if (open && wrap.current && !wrap.current.contains(e.target as Node) && !(e.target as Element).closest?.('[aria-modal="true"]')) pin.setState("rest");
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, pin]);
  useEffect(() => {
    if (wasOpen.current && !open && wrap.current?.contains(document.activeElement ?? null) === false && document.activeElement === document.body) pillRef.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);

  const hoverIn = () => {
    clearTimeout(leave.current);
    if (!canHover || !(pin.state === "rest" || pin.state === "peek") || !pin.actions?.items.length) return;
    enter.current = setTimeout(() => pin.setState("actions"), 90);
  };
  const hoverOut = () => {
    clearTimeout(enter.current);
    clearTimeout(leave.current);
    leave.current = setTimeout(() => pin.state === "actions" && pin.setState("rest"), 260);
  };

  const modelLabel = pin.settings?.model ? `${mode === "agent" ? "Agent" : "Assistant"} · ${pin.settings.model}` : mode === "agent" ? "Agent mode" : "Assistant mode";

  const render = (v: View): ReactNode => {
    switch (v) {
      case "rest":
        return (
          <button ref={pillRef} type="button" onClick={() => pin.setState("open")} className="flex h-9.5 w-full items-center gap-2.5 pl-2 pr-2.5 text-left" aria-label={`Open Pin${unread ? `, ${unread} unread` : ""}`} aria-keyshortcuts="Control+K Meta+K">
            <PinOrb size={24} />
            <span className="flex-1 min-w-0 truncate text-compact font-medium">Pin <span className="font-normal text-ink-3">· {mode === "agent" ? "Agent" : "Assistant"}</span></span>
            {unread > 0 && <span className="min-w-5 h-5 px-1.5 rounded-full bg-accent text-primary-ink text-micro font-semibold flex items-center justify-center tabular-nums">{unread}</span>}
          </button>
        );
      case "status":
        return (
          <button ref={pillRef} type="button" onClick={() => pin.setState("open")} className="flex h-9.5 w-full items-center gap-2.5 pl-2 pr-3.5 text-left" aria-label="Open Pin">
            <PinOrb size={24} thinking />
            <span className="flex-1 min-w-0 truncate text-compact font-medium">
              {pin.thinking ? <span className="shimmer-text">Thinking</span> : pin.streaming ? <span className="shimmer-text">Writing</span> : <>{runningTask?.label}</>}
            </span>
            <span className="pin-dots" aria-hidden><span /><span /><span /></span>
          </button>
        );
      case "peek":
        return (
          <button type="button" onClick={() => pin.setState("open")} className="flex w-full items-center gap-3 px-3 py-2.5 text-left" aria-label={`Open Pin: ${pin.peek?.title ?? ""}`}>
            <PinOrb size={36} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-compact font-medium">{pin.peek?.title}</span>
              {pin.peek?.body && <span className="block truncate text-xs text-ink-3">{pin.peek.body}</span>}
            </span>
          </button>
        );
      case "actions":
        return pin.actions ? (
          <div className="flex items-start gap-3 pl-2 pr-2.5 py-2">
            <button type="button" onClick={() => pin.setState("open")} className="flex items-center gap-2.5 shrink-0 h-9 rounded-full pr-1" aria-label="Open Pin">
              <PinOrb size={32} />
              <span className="hidden sm:block text-left">
                <span className="block text-micro text-ink-3">On this page</span>
                <span className="block text-compact font-medium max-w-28 truncate">{pin.actions.context}</span>
              </span>
            </button>
            <QuickActionBar onDone={() => pin.setState("rest")} />
          </div>
        ) : null;
      case "open":
        return <PinPanel modelLabel={modelLabel} unread={unread} />;
    }
  };

  return (
    <>
      <div
        ref={wrap}
        className={cn("fixed inset-x-0 top-2 z-(--z-island) flex justify-center px-2 pointer-events-none transition-opacity duration-(--duration-base)", modalOpen && !pin.confirm && "opacity-0")}
        inert={modalOpen && !pin.confirm ? true : undefined}
      >
        <div
          ref={shell}
          data-pin-island={view}
          className={cn("island glass", view === "open" && "solid")}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
          role={view === "open" ? "dialog" : undefined}
          aria-label={view === "open" ? "Pin" : undefined}
        >
          {layers.map((l) => {
            const b = islandBox(l.view, vp, measured);
            const isCurrent = l.view === view && l.phase !== "exit";
            return (
              <div
                key={l.view}
                ref={isCurrent ? current : undefined}
                className="island-layer"
                data-phase={l.phase}
                aria-hidden={isCurrent ? undefined : true}
                inert={isCurrent ? undefined : true}
                style={{ width: b.width - 2, height: l.view === "open" ? b.height - 2 : undefined }}
              >
                {render(l.view)}
              </div>
            );
          })}
        </div>
      </div>
      {pin.confirm?.confirm && (
        <Modal
          size="sm"
          title={pin.confirm.confirm.title}
          subtitle={pin.confirm.confirm.body}
          onClose={() => pin.setConfirm(null)}
          footer={<><Button variant="ghost" onClick={() => pin.setConfirm(null)}>Cancel</Button><Button variant={pin.confirm.danger ? "danger" : "primary"} onClick={() => { const c = pin.findLatest(pin.confirm!.id) ?? pin.confirm!; pin.setConfirm(null); c.run(); }}>{pin.confirm.confirm.label}</Button></>}
        >
          {null}
        </Modal>
      )}
    </>
  );
}

/** The open island: header, chat or notifications, and the composer. */
function PinPanel({ modelLabel, unread }: { modelLabel: string; unread: number }) {
  const pin = usePin();
  const engine = useEngine();
  const device = engine.setup?.deviceName ?? "pve";
  const hasActions = !!pin.actions?.items.length;
  const samples = ["How is my server?", engine.data.orgs.length ? "Which agents are idle?" : "Which machines use the most memory?", "If a container uses more than 50% of its memory, shut it down"];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 pl-4 pr-2 pt-3 pb-2.5">
        <PinOrb size={30} thinking={pin.thinking || pin.streaming} />
        <div className="flex-1 min-w-0">
          <div className="text-body font-semibold leading-tight">Pin</div>
          <div className="text-xs text-ink-3 truncate">{modelLabel}</div>
        </div>
        <Link to={`/${device}/pin?tab=settings`} onClick={() => pin.setState("rest")} aria-label="Pin's settings" title="Pin's settings" className="transition-control h-8 w-8 rounded-full flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2"><Settings2 className="h-4 w-4" /></Link>
        <Link to={`/${device}/pin?tab=chat`} onClick={() => pin.setState("rest")} aria-label="Open Pin's page" title="Open Pin's page" className="transition-control h-8 w-8 rounded-full flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2"><Maximize2 className="h-3.5 w-3.5" /></Link>
        <IconButton size="sm" label="Close Pin" onClick={() => pin.setState("rest")}><X className="h-4 w-4" /></IconButton>
      </div>
      <div className="px-4 pb-2.5 border-b border-line">
        <Segmented
          size="sm"
          label="Pin"
          value={pin.tab}
          onChange={(t) => { pin.setTab(t); if (t === "notices") engine.markRead(); }}
          options={[
            { value: "chat", label: <span className="inline-flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" />Chat</span> },
            { value: "notices", label: <span className="inline-flex items-center gap-1.5"><Bell className="h-3.5 w-3.5" />Notifications{unread > 0 && <span className="text-accent tabular-nums">{unread}</span>}</span> },
          ]}
        />
      </div>
      {pin.tab === "chat" ? (
        <PinThread
          className="flex-1"
          autoFocus
          footer={hasActions && pin.messages.length > 0 ? <div className="px-3 pt-2"><QuickActionBar compact scroll /></div> : null}
          empty={
            <div className="pt-4">
              <p className="text-sm text-ink-2 text-pretty">Ask about this device or an organization, or tell Pin what to automate.</p>
              {hasActions && (
                <div className="mt-4">
                  <div className="mb-2 text-micro font-semibold uppercase tracking-label text-ink-3">On {pin.actions!.context}</div>
                  <QuickActionBar compact />
                </div>
              )}
              <div className="mt-5 mb-2 text-micro font-semibold uppercase tracking-label text-ink-3">Try</div>
              <div className="flex flex-col items-start gap-1.5">
                {samples.map((s, i) => (
                  <button key={s} type="button" onClick={() => pin.send(s)} style={{ "--i": i } as React.CSSProperties} className="stagger-in transition-control max-w-full rounded-xl border border-line bg-surface-2/50 px-3 py-1.5 text-left text-compact text-ink-2 hover:bg-surface-3 hover:text-ink">{s}</button>
                ))}
              </div>
            </div>
          }
        />
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2">
          {engine.data.notices.length === 0 && <p className="text-center text-ink-3 text-sm pt-10">No notifications. Pin tells you here when something needs you.</p>}
          {engine.data.notices.map((n, i) => (
            <div key={n.id} style={{ "--i": i } as React.CSSProperties} className="stagger-in rounded-xl border border-line bg-surface-2/40 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="text-sm font-medium">{n.title}</div>
                <div className="text-micro text-ink-3 shrink-0 tabular-nums">{timeAgo(n.at)}</div>
              </div>
              <p className="text-compact text-ink-2 mt-1 text-pretty">{n.body}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
