import { useEffect, useRef, useState } from "react";
import { Expand, Keyboard, Loader2, Maximize2, Minimize2, RotateCcw } from "lucide-react";
import { api, ApiError } from "../../data/api.ts";
import { cn } from "../../lib/storage.ts";
import { Chip } from "../../ui/primitives.tsx";

type State = "connecting" | "connected" | "ended" | "failed";

/**
 * A VM's screen, through noVNC. The host service opens Proxmox's VNC proxy as the signed-in user and hands this page a
 * one-time session id and VNC password; the WebSocket goes through the service, which holds the Proxmox ticket.
 */
export default function Screen({ vmid, name }: { vmid: number; name: string }) {
  const box = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<{ sendCtrlAltDel(): void; disconnect(): void; scaleViewport: boolean; focus(): void } | null>(null);
  const [state, setState] = useState<State>("connecting");
  const [message, setMessage] = useState<string | null>(null);
  const [session, setSession] = useState(0);
  const [full, setFull] = useState(false);
  const [scale, setScale] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setState("connecting");
    setMessage(null);
    (async () => {
      try {
        const [{ default: RFB }, s] = await Promise.all([import("@novnc/novnc"), api.screen(vmid)]);
        if (cancelled || !box.current) return;
        box.current.replaceChildren();
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const rfb = new RFB(box.current, `${proto}//${window.location.host}/api/vnc/${s.id}`, { credentials: { password: s.password }, wsProtocols: ["binary"] });
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.background = "transparent";
        rfb.addEventListener("connect", () => {
          setState("connected");
          rfb.focus();
        });
        rfb.addEventListener("disconnect", (e) => {
          const clean = (e as CustomEvent<{ clean: boolean }>).detail?.clean;
          setState(clean ? "ended" : "failed");
          if (!clean) setMessage("The connection to the screen dropped.");
        });
        rfb.addEventListener("securityfailure", () => setMessage("The screen refused the session. Reconnect to get a new one."));
        rfb.addEventListener("credentialsrequired", () => rfb.sendCredentials({ password: s.password }));
        rfbRef.current = rfb;
      } catch (e) {
        if (cancelled) return;
        setState("failed");
        setMessage(e instanceof ApiError ? e.message : "Couldn't open the screen.");
      }
    })();
    return () => {
      cancelled = true;
      rfbRef.current?.disconnect();
      rfbRef.current = null;
    };
  }, [vmid, session]);

  useEffect(() => {
    if (rfbRef.current) rfbRef.current.scaleViewport = scale;
  }, [scale]);

  return (
    <div className={cn("flex flex-col rounded-xl border border-line overflow-hidden bg-black", full && "fixed inset-3 z-[65] shadow-2xl")}>
      <div className="flex items-center gap-2 px-3 h-10 border-b border-line bg-surface">
        <span className="text-[13px] font-medium truncate">{name}</span>
        {state === "connected" ? <Chip tone="accent">Live</Chip> : state === "connecting" ? <Chip>Connecting</Chip> : <Chip tone="warning">Disconnected</Chip>}
        <span className="flex-1" />
        <button onClick={() => rfbRef.current?.sendCtrlAltDel()} disabled={state !== "connected"} className="h-7 px-2 rounded-md hover:bg-surface-2 text-[12px] text-ink-2 inline-flex items-center gap-1.5 disabled:opacity-40"><Keyboard className="h-3.5 w-3.5" />Ctrl+Alt+Del</button>
        <button onClick={() => setScale((v) => !v)} aria-pressed={scale} className="h-7 px-2 rounded-md hover:bg-surface-2 text-[12px] text-ink-2 inline-flex items-center gap-1.5"><Expand className="h-3.5 w-3.5" />{scale ? "Fit" : "Actual size"}</button>
        <button onClick={() => setSession((n) => n + 1)} className="h-7 px-2 rounded-md hover:bg-surface-2 text-[12px] text-ink-2 inline-flex items-center gap-1.5"><RotateCcw className="h-3.5 w-3.5" />Reconnect</button>
        <button onClick={() => setFull((f) => !f)} className="h-7 w-7 rounded-md hover:bg-surface-2 flex items-center justify-center text-ink-2" aria-label={full ? "Exit full screen" : "Full screen"}>{full ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}</button>
      </div>
      <div className={cn("relative", full ? "flex-1" : "h-[min(600px,calc(100dvh-300px))]")}>
        <div ref={box} className="absolute inset-0" aria-label={`${name}'s screen`} />
        {state !== "connected" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6 pointer-events-none">
            {state === "connecting" ? <Loader2 className="h-5 w-5 animate-spin text-ink-3" /> : null}
            <p className="text-[14px] text-ink-2">{state === "connecting" ? `Opening ${name}'s screen…` : message ?? "Session ended."}</p>
          </div>
        )}
      </div>
    </div>
  );
}
