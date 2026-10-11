import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Maximize2, Minimize2, RotateCcw } from "lucide-react";
import { cn } from "../lib/storage.ts";
import { Chip } from "../ui/primitives.tsx";
import type { TerminalTransport } from "./transport.ts";

function cssVar(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** An interactive terminal (xterm.js) bound to a transport. Fills its container and refits on resize. */
export function Terminal({ make, title, className }: { make: () => TerminalTransport; title: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState(0);
  const [ended, setEnded] = useState(false);
  const [full, setFull] = useState(false);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!host.current) return;
    const term = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: cssVar("--bg", "#171612"),
        foreground: cssVar("--ink", "#f4ecdc"),
        cursor: cssVar("--accent", "#e8b25c"),
        selectionBackground: "rgba(232,178,92,0.25)",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    const refit = () => {
      try {
        fit.fit();
      } catch {
        // container not laid out yet
      }
    };
    refit();
    const ro = new ResizeObserver(refit);
    ro.observe(host.current);
    const t = make();
    setLive(t.live);
    setEnded(false);
    t.open((d) => term.write(d), () => setEnded(true));
    const sub = term.onData((d) => t.input(d));
    term.focus();
    return () => {
      sub.dispose();
      ro.disconnect();
      t.close();
      term.dispose();
    };
    // `make` is stable per machine; a new session restarts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  return (
    <div className={cn("flex flex-col rounded-xl border border-line overflow-hidden bg-bg", full && "fixed inset-3 z-[65] shadow-2xl", className)}>
      <div className="flex items-center gap-2 px-3 h-10 border-b border-line bg-surface">
        <span className="flex gap-1.5" aria-hidden><span className="h-2.5 w-2.5 rounded-full bg-critical/70" /><span className="h-2.5 w-2.5 rounded-full bg-warning/70" /><span className="h-2.5 w-2.5 rounded-full bg-good/70" /></span>
        <span className="text-[13px] font-medium ml-1 truncate">{title}</span>
        {live ? <Chip tone="accent">Live</Chip> : <Chip tone="warning">Demo shell</Chip>}
        <span className="flex-1" />
        <button onClick={() => setSession((s) => s + 1)} className="h-7 px-2 rounded-md hover:bg-surface-2 text-[12px] text-ink-2 inline-flex items-center gap-1.5" aria-label="New session"><RotateCcw className="h-3.5 w-3.5" />{ended ? "Reconnect" : "Restart"}</button>
        <button onClick={() => setFull((f) => !f)} className="h-7 w-7 rounded-md hover:bg-surface-2 flex items-center justify-center text-ink-2" aria-label={full ? "Exit full screen" : "Full screen"}>{full ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}</button>
      </div>
      <div ref={host} className="flex-1 min-h-[320px] p-2" onClick={() => host.current?.querySelector("textarea")?.focus()} />
    </div>
  );
}
