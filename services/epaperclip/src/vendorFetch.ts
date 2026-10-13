import { lookup as dnsLookup } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";

/**
 * Fetches a vendor's published checksum file as text. The Library's catalog fixes which addresses are ever asked for;
 * this adds limits so a misbehaving server can't hold the service up: https only, a few redirects (never to an IP
 * address or localhost), a size cap, and a timeout. The text is parsed, never passed on.
 */
export type FetchText = (url: string) => Promise<string>;

const MAX_BYTES = 2 * 1024 * 1024;

/** True for loopback, private, link-local, unique-local, CGNAT, multicast and other addresses that are never a public vendor. */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (isIP(v) === 4) {
    const [a, b] = v.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(v) === 6) return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff") || v.startsWith("64:ff9b:") || v.startsWith("2001:db8");
  return true; // not an address at all
}

function refuse(u: URL): string | null {
  if (u.protocol !== "https:") return "only https is allowed";
  // A trailing dot names the same host ("localhost."), and a name with no dot is a machine on this network.
  const host = u.hostname.replace(/\.$/, "").toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0 || !host.includes(".") || host === "localhost" || /\.(local|localhost|localdomain|internal|lan|home|corp|intranet|home\.arpa)$/.test(host)) return "addresses on this network are not allowed";
  return null;
}

/** DNS answers are checked too: a public-looking name that points at this network (or a rebind) is refused. */
const safeLookup = ((host: string, options: { all?: boolean; family?: number }, cb: (...a: unknown[]) => void) => {
  dnsLookup(host, { ...options, all: true }, (err, list) => {
    if (err) return cb(err);
    const addrs = list as unknown as { address: string; family: number }[];
    const bad = addrs.find((a) => isPrivateAddress(a.address));
    if (bad || addrs.length === 0) return cb(Object.assign(new Error("addresses on this network are not allowed"), { code: "EBLOCKED" }));
    return options.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
  });
}) as unknown as NonNullable<Parameters<typeof request>[1]>["lookup"];

export const fetchVendorText: FetchText = (start) =>
  new Promise((resolve, reject) => {
    const go = (url: string, hops: number) => {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return reject(new Error("bad address"));
      }
      const why = refuse(u);
      if (why) return reject(new Error(why));
      const req = request(u, { method: "GET", timeout: 15_000, lookup: safeLookup, headers: { "User-Agent": "ePaperclip-library", Accept: "text/plain, */*" } }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (hops >= 3) return reject(new Error("too many redirects"));
          return go(new URL(res.headers.location, u).href, hops + 1);
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`the vendor answered ${status}`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy(new Error("the file was larger than expected"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error("timed out")));
      req.on("error", reject);
      req.end();
    };
    go(start, 0);
  });
