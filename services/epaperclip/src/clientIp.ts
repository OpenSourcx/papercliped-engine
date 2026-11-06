import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

/**
 * The address a request really came from, for rate limits, lockouts and the audit trail.
 *
 * Behind the Connect tunnel every request arrives from cloudflared on loopback, so the socket address would put the
 * whole internet in one bucket (one attacker could lock everybody out). While the tunnel is ours, a loopback peer's
 * CF-Connecting-IP is believed; from any other peer it is ignored, so a LAN client can't pick its own address.
 * IPv6 clients are bucketed by /64 so rotating addresses inside one allocation doesn't dodge a limit.
 */
let tunnelTrusted: () => boolean = () => false;
export const trustTunnelWhen = (f: () => boolean) => { tunnelTrusted = f; };

const isLoopback = (a: string) => a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";

function v6prefix(ip: string): string {
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t] : h;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "").toLowerCase()).join(":") + "::/64";
}

export function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? "?";
  if (!tunnelTrusted() || !isLoopback(peer)) return peer;
  const h = req.headers["cf-connecting-ip"];
  const ip = typeof h === "string" ? h.trim() : "";
  const kind = isIP(ip);
  if (kind === 4) return ip;
  if (kind === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    return mapped ? mapped[1]! : v6prefix(ip);
  }
  return peer;
}
