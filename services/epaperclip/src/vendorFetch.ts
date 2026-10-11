import { request } from "node:https";
import { isIP } from "node:net";

/**
 * Fetches a vendor's published checksum file as text. The Library's catalog fixes which addresses are ever asked for;
 * this adds limits so a misbehaving server can't hold the service up: https only, a few redirects (never to an IP
 * address or localhost), a size cap, and a timeout. The text is parsed, never passed on.
 */
export type FetchText = (url: string) => Promise<string>;

const MAX_BYTES = 2 * 1024 * 1024;

function refuse(u: URL): string | null {
  if (u.protocol !== "https:") return "only https is allowed";
  if (isIP(u.hostname.replace(/^\[|\]$/g, "")) !== 0 || u.hostname === "localhost" || u.hostname.endsWith(".local")) return "addresses on this network are not allowed";
  return null;
}

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
      const req = request(u, { method: "GET", timeout: 15_000, headers: { "User-Agent": "ePaperclip-library", Accept: "text/plain, */*" } }, (res) => {
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
