import { chmodSync, lstatSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ConnectLink } from "./connectLink.ts";
import { HttpError, readJson, sendJson } from "./http.ts";

/**
 * The host's control socket: how `epaperclip login | logout | whoami` (run as root on the Proxmox host) drive the same Papercliped
 * pairing the web console does. The caller is authenticated by the socket itself: it is a Unix socket in the service's private
 * state directory (0600), so only root and the service's own user can open it. There is no network listener, no cookie and no token,
 * and only the actions listed here exist. The administrator's consent is still asked for by the CLI before anything is confirmed.
 */
export interface CtlDeps {
  link: Pick<ConnectLink, "statusLive" | "start" | "poll" | "confirm" | "cancel" | "unpair">;
  /** Identity links are revoked first on unpair, while this device's registration still exists at Connect (same as the console route). */
  revokeIdentityLinks: () => Promise<unknown>;
}

const ROUTES: Record<string, "GET" | "POST"> = {
  "/v1/connect/status": "GET", "/v1/connect/pairing/start": "POST", "/v1/connect/pairing/poll": "POST",
  "/v1/connect/pairing/confirm": "POST", "/v1/connect/pairing/cancel": "POST", "/v1/connect/unpair": "POST",
};

export function ctlHandler(d: CtlDeps) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const path = new URL(req.url ?? "/", "http://ctl.invalid").pathname;
      if (!(path in ROUTES)) throw new HttpError(404, "not_found", "Unknown control action");
      if (ROUTES[path] !== req.method) throw new HttpError(405, "method", "Method not allowed");
      if (req.headers.origin) throw new HttpError(403, "forbidden", "The control socket is not for browsers");
      const body = req.method === "POST" ? await readJson(req, 4 * 1024) : {};
      const out = path.endsWith("/status") ? await d.link.statusLive()
        : path.endsWith("/pairing/start") ? await d.link.start()
        : path.endsWith("/pairing/poll") ? await d.link.poll()
        : path.endsWith("/pairing/confirm") ? await d.link.confirm(body.accountId, body.deviceName)
        : path.endsWith("/pairing/cancel") ? d.link.cancel()
        : (await d.revokeIdentityLinks(), await d.link.unpair());
      sendJson(res, 200, out, { "Cache-Control": "no-store" });
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.code, message: e.message });
      sendJson(res, 500, { error: "internal", message: "The service could not do that." });
    }
  };
}

/** Listen on a Unix socket owned by the service, readable and writable by nobody else. A stale socket from a crash is replaced; anything else at the path is left alone and is an error. */
export function listenCtl(path: string, handler: ReturnType<typeof ctlHandler>): Server {
  try { if (lstatSync(path).isSocket()) rmSync(path); } catch { /* nothing there */ }
  const server = createServer(handler);
  server.headersTimeout = 10_000; server.requestTimeout = 30_000;
  server.listen(path, () => { try { chmodSync(path, 0o600); } catch { /* the state directory is 0700 anyway */ } });
  return server;
}
