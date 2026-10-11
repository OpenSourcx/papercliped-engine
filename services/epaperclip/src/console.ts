import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";

/**
 * Live consoles. The browser opens a WebSocket to /api/console/...; the service checks the session and the Origin,
 * asks Proxmox for a terminal proxy *as that user* (termproxy), connects to Proxmox's vncwebsocket with the user's
 * ticket, completes Proxmox's handshake, and from then on relays bytes both ways. Neither the Proxmox ticket nor the
 * one-time terminal ticket ever reaches the browser.
 *
 * The browser speaks Proxmox's termproxy framing: "0:<bytes>:<data>" for input, "1:<cols>:<rows>:" to resize and "2" to
 * keep the connection alive. Output comes back as raw terminal bytes.
 */

/** What Proxmox needs to open the far side, already authorised as the user. */
export interface ConsoleTarget {
  url: string; // wss://.../vncwebsocket?port=&vncticket=
  headers: Record<string, string>; // the user's PVEAuthCookie
  handshake: string; // "<user>:<vncticket>\n"
}

/** Something that speaks WebSocket to Proxmox: the real `ws` client, or a fake in tests. */
export type Connect = (target: ConsoleTarget) => WebSocket;

export function realConnect(caPem?: string): Connect {
  return (t) => new WebSocket(t.url, ["binary"], { headers: t.headers, ca: caPem, maxPayload: 1024 * 1024, handshakeTimeout: 15_000 });
}

const MAX_FRAME = 64 * 1024;

export function createConsoleRelay(opts: {
  /** Checks the request and returns how to reach Proxmox, or throws an Error whose message is shown in the terminal. */
  authorize: (req: IncomingMessage, url: URL) => Promise<ConsoleTarget>;
  /** Called before the upgrade: refuse with an HTTP status (401 signed out, 403 cross-site) or allow. */
  precheck: (req: IncomingMessage) => { status: number; reason: string } | null;
  connect: Connect;
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });

  return function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? "/", "http://epaperclip");
    if (!/^\/api\/console\/(node|guests\/\d+)$/.test(url.pathname)) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const refused = opts.precheck(req);
    if (refused) {
      socket.end(`HTTP/1.1 ${refused.status} ${refused.reason}\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (browser) => {
      let pve: WebSocket | null = null;
      let ready = false;
      const pending: (Buffer | string)[] = [];
      const fail = (msg: string) => {
        if (browser.readyState === WebSocket.OPEN) {
          browser.send(`\r\n\x1b[31m${msg}\x1b[0m\r\n`);
          browser.close(4000, msg.slice(0, 100));
        }
        pve?.terminate();
      };

      browser.on("message", (data, isBinary) => {
        const frame = isBinary ? (data as Buffer) : data.toString();
        if (!ready) {
          if (pending.length < 64) pending.push(frame);
          return;
        }
        pve?.send(frame);
      });
      browser.on("close", () => pve?.close());
      browser.on("error", () => pve?.terminate());

      opts.authorize(req, url).then(
        (target) => {
          if (browser.readyState !== WebSocket.OPEN) return;
          pve = opts.connect(target);
          let greeted = false;
          pve.on("open", () => pve!.send(target.handshake));
          pve.on("message", (data) => {
            const text = data.toString();
            // Proxmox answers the handshake with "OK" before any terminal output.
            if (!greeted) {
              greeted = true;
              if (!text.startsWith("OK")) return fail("Proxmox refused the console session.");
              ready = true;
              for (const f of pending.splice(0)) pve!.send(f);
              const rest = text.slice(2);
              if (rest) browser.send(rest);
              return;
            }
            if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary: false });
          });
          pve.on("close", () => browser.readyState === WebSocket.OPEN && browser.close(1000, "Session ended"));
          pve.on("error", (e) => fail(`Can't reach the console (${(e as NodeJS.ErrnoException).code ?? e.message}).`));
        },
        (e: Error) => fail(e.message || "Couldn't open the console."),
      );
    });
  };
}
