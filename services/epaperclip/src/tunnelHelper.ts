import { createConnection } from "node:net";

/**
 * Client of the root-owned publishing helper (deploy/epaperclip-publish.mjs). The helper is the ONLY owner of the
 * cloudflared service and its token file; this process never touches either, and the token only travels over the
 * private unix socket (0660 root:epaperclip) and is never returned by any of these calls.
 */
export type TunnelOwner = "self" | "connect";
export interface TunnelHelperStatus { owner: TunnelOwner | null; installed: boolean; active: boolean }
export interface TunnelHelper {
  install(owner: TunnelOwner, token: string): Promise<void>;
  /** Stops and removes the tunnel service and token, but only if `owner` holds it. */
  remove(owner: TunnelOwner): Promise<void>;
  status(): Promise<TunnelHelperStatus>;
}

const SOCKET = "/run/epaperclip-publish/publish.sock";

export function socketTunnelHelper(path = SOCKET, timeoutMs = 40_000): TunnelHelper {
  const call = (request: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = createConnection(path);
    let data = "";
    const timer = setTimeout(() => socket.destroy(new Error("timeout")), timeoutMs);
    socket.on("connect", () => socket.end(JSON.stringify(request)));
    socket.on("data", (b) => {
      data += b.toString();
      if (data.length > 64 * 1024) socket.destroy(new Error("too large"));
    });
    socket.on("error", () => { clearTimeout(timer); reject(new Error("The ePaperclip publishing helper isn't available. Update ePaperclip on this machine and enable epaperclip-publish.socket.")); });
    socket.on("end", () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(data) as Record<string, unknown>;
        if (typeof r.error === "string") return reject(new Error(r.error));
        resolve(r);
      } catch { reject(new Error("The publishing helper returned an invalid response.")); }
    });
  });
  return {
    async install(owner, token) { await call({ operation: "install", owner, token }); },
    async remove(owner) { await call({ operation: "remove", owner }); },
    async status() {
      const r = await call({ operation: "status" });
      const owner = r.owner === "self" || r.owner === "connect" ? r.owner : null;
      return { owner, installed: r.installed === true, active: r.active === true };
    },
  };
}
