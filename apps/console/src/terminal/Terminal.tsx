import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import "@xterm/xterm/css/xterm.css";
import { ExternalLink, Maximize2, Minimize2, RotateCcw } from "lucide-react";
import { cn } from "../lib/storage.ts";
import { Chip } from "../ui/primitives.tsx";
import type { TerminalTransport } from "./transport.ts";

/** Reads a design token (index.css or the active theme) so the terminal follows the theme. */
function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * An interactive terminal (xterm.js) bound to a transport. Fills its container and refits on resize.
 *
 * With `popout` (the address of a page that shows only this console), the corner button opens it in a window of its own and
 * this one steps aside until that window is closed. A blocked pop-up falls back to full screen in the page.
 */
export function Terminal({ make, title, className, popout }: { make: () => TerminalTransport; title: string; className?: string; popout?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState(0);
  const [ended, setEnded] = useState(false);
  const [full, setFull] = useState(false);
  const [live, setLive] = useState(false);
  const [away, setAway] = useState<Window | null>(null);

  // Back here when the other window is closed.
  useEffect(() => {
    if (!away) return;
    const t = setInterval(() => away.closed && setAway(null), 1000);
    return () => clearInterval(t);
  }, [away]);

  const popOut = () => {
    const w = window.open(popout, `epc-console:${popout}`, "popup,width=960,height=640");
    if (!w) return setFull(true);
    w.focus();
    setFull(false);
    setAway(w);
  };

  useEffect(() => {
    if (away || !host.current) return;
    const term = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: cssVar("--bg"),
        foreground: cssVar("--ink"),
        cursor: cssVar("--accent"),
        selectionBackground: cssVar("--accent-soft"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // The canvas renderer draws text itself. xterm's default DOM renderer injects <style> elements, which the strict
    // CSP (style-src 'self') blocks, losing colours and cell sizing on a real host.
    try {
      term.loadAddon(new CanvasAddon());
    } catch {
      // no canvas (very old browser): the DOM renderer still shows plain text
    }
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
    t.resize?.(term.cols, term.rows);
    const sizeSub = term.onResize(({ cols, rows }) => t.resize?.(cols, rows));
    const sub = term.onData((d) => t.input(d));
    term.focus();
    return () => {
      sub.dispose();
      sizeSub.dispose();
      ro.disconnect();
      t.close();
      // xterm schedules a viewport sync right after open; disposing in the same tick makes that timer read a renderer that
      // is gone (seen when React mounts twice in development). One tick later it has run.
      setTimeout(() => term.dispose(), 0);
    };
    // `make` is stable per machine; a new session restarts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, away]);

  return (
    <div className={cn("flex flex-col rounded-xl border border-line overflow-hidden bg-bg", full && "fixed inset-3 z-(--z-fullscreen) shadow-modal", className)}>
      <div className="flex items-center gap-2 px-3 h-10 border-b border-line bg-surface">
        <span className="flex gap-1.5" aria-hidden><span className="h-2.5 w-2.5 rounded-full bg-critical/70" /><span className="h-2.5 w-2.5 rounded-full bg-warning/70" /><span className="h-2.5 w-2.5 rounded-full bg-good/70" /></span>
        <span className="text-compact font-medium ml-1 truncate">{title}</span>
        {live ? <Chip tone="accent">Live</Chip> : <Chip tone="warning">Demo shell</Chip>}
        <span className="flex-1" />
        {!away && <button onClick={() => setSession((s) => s + 1)} className="h-7 px-2 rounded-md hover:bg-surface-2 text-xs text-ink-2 inline-flex items-center gap-1.5" aria-label="New session"><RotateCcw className="h-3.5 w-3.5" />{ended ? "Reconnect" : "Restart"}</button>}
        {popout && !full
          ? !away && <button onClick={popOut} className="h-7 w-7 rounded-md hover:bg-surface-2 flex items-center justify-center text-ink-2" aria-label="Open in its own window" title="Open in its own window"><ExternalLink className="h-3.5 w-3.5" /></button>
          : <button onClick={() => setFull((f) => !f)} className="h-7 w-7 rounded-md hover:bg-surface-2 flex items-center justify-center text-ink-2" aria-label={full ? "Exit full screen" : "Full screen"}>{full ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}</button>}
      </div>
      {away
        ? <div className="flex-1 min-h-[320px] flex flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-compact text-ink-2">This console is open in its own window.</p>
            <div className="flex gap-2">
              <button onClick={() => away.focus()} className="h-8 px-3 rounded-md border border-line hover:bg-surface-2 text-compact">Go to the window</button>
              <button onClick={() => { away.close(); setAway(null); }} className="h-8 px-3 rounded-md hover:bg-surface-2 text-compact text-ink-2">Show it here instead</button>
            </div>
          </div>
        : <div ref={host} className="flex-1 min-h-[320px] p-2" onClick={() => host.current?.querySelector("textarea")?.focus()} />}
    </div>
  );
}
