import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { HttpError, limits } from "../http.ts";

/**
 * Small pieces the connector features share: salted hashing for tokens the host keeps only as hashes, PKCE, the
 * redirect-URI rules, a sliding-window rate limiter, and a body reader for the OAuth endpoints (which take
 * form-encoded bodies as well as JSON). Nothing here logs or returns a secret.
 */

export const hashSecret = (salt: string, secret: string): string => createHash("sha256").update(salt).update("\0").update(secret).digest("hex");
export const newSalt = (): string => randomBytes(16).toString("hex");
export const newSecret = (): string => randomBytes(32).toString("base64url");
export const newHexId = (): string => randomBytes(8).toString("hex");

/** Constant-time comparison of two hex digests of the same length. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** PKCE S256 (RFC 7636): the verifier is 43 to 128 unreserved characters; the challenge is its SHA-256, base64url. */
export const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
export const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER_RE.test(verifier) || !CHALLENGE_RE.test(challenge)) return false;
  const want = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const got = Buffer.from(challenge);
  return want.length === got.length && timingSafeEqual(want, got);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Schemes that can never be a redirect address, whatever an administrator allows: they run code, read local data or open
 * a connection of their own. `http:` is not here because it has its own rule (loopback only); `https:` needs no allowance.
 */
export const DENIED_SCHEMES: readonly string[] = ["javascript", "data", "file", "blob", "about", "vbscript", "ws", "wss", "ftp", "ftps", "gopher", "view-source", "filesystem", "chrome", "chrome-extension", "resource"];
const SCHEME_RE = /^[a-z][a-z0-9+.-]{0,31}$/;

/** One entry of the administrator's allow-list of custom-scheme redirect addresses: an exact address, or a prefix (ending in "/"). */
export interface RedirectAllow {
  uri: string;
  kind: "exact" | "prefix";
  addedBy: string;
  addedAt: number;
}

/** True when the (already parsed and normalised) address is covered by an entry of the allow-list. */
export function redirectAllowed(href: string, allow: readonly Pick<RedirectAllow, "uri" | "kind">[]): boolean {
  return allow.some((e) => (e.kind === "exact" ? href === e.uri : href.startsWith(e.uri)));
}

/** Checks an address an administrator wants to allow and returns it normalised with its scheme. Throws for anything that could never be safe. */
export function checkAllowEntry(rawUri: unknown, rawKind: unknown): { uri: string; kind: "exact" | "prefix"; scheme: string } {
  const bad = (m: string) => new HttpError(400, "bad_request", m);
  if (rawKind !== "exact" && rawKind !== "prefix") throw bad("Say whether this is an exact address or a prefix.");
  if (typeof rawUri !== "string" || rawUri.length === 0 || rawUri.length > 500 || /[\u0000-\u0020\u007f"<>\\^`{|}*#]/.test(rawUri)) throw bad("That is not a plain address: no spaces, wildcards or fragments.");
  let u: URL;
  try {
    u = new URL(rawUri);
  } catch {
    throw bad("That is not an address, for example cursor://anysphere.cursor-mcp/oauth/callback");
  }
  const scheme = u.protocol.slice(0, -1);
  if (!SCHEME_RE.test(scheme)) throw bad("That scheme is not valid.");
  if (scheme === "https" || scheme === "http") throw bad("Web addresses are handled already: https is allowed and http only on this computer's own loopback address. This list is for app schemes such as cursor:// or vscode://.");
  if (DENIED_SCHEMES.includes(scheme)) throw bad(`${scheme}: can never be allowed. It can run code, read local files or open connections.`);
  if (u.username || u.password) throw bad("An address can't carry a user name or password.");
  if (rawUri.includes("?") && rawKind === "prefix") throw bad("A prefix can't have a query.");
  if (!u.host) throw bad("Include the app's name after the scheme, for example cursor://anysphere.cursor-mcp/. Allowing a whole scheme is not possible.");
  if (rawKind === "prefix" && !u.href.endsWith("/")) throw bad("A prefix must end with /, so cursor://app/ can't match cursor://app-evil/.");
  return { uri: u.href, kind: rawKind, scheme };
}

/**
 * The redirect-URI rules (OAuth 2.1 and RFC 8252). https addresses are allowed as they are; plain http only for a
 * loopback address (a command-line app on the same computer). No fragments, no user names, no wildcards, nothing over
 * 2000 characters. An app-specific scheme (`cursor://`, `vscode://`) is refused unless an administrator listed that exact
 * address or a prefix of it (`allow`); `javascript:`, `data:`, `file:` and the other denied schemes are never accepted.
 * Returns the normalised address or throws.
 */
export function checkRedirectUri(raw: unknown, allow: readonly Pick<RedirectAllow, "uri" | "kind">[] = []): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000 || /[\u0000- \u007f"<>\\^`{|}]/.test(raw)) throw new HttpError(400, "invalid_redirect_uri", "A redirect address must be a plain web address.");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, "invalid_redirect_uri", "A redirect address must be a plain web address.");
  }
  if (u.hash || raw.includes("#")) throw new HttpError(400, "invalid_redirect_uri", "A redirect address can't have a fragment.");
  if (u.username || u.password) throw new HttpError(400, "invalid_redirect_uri", "A redirect address can't carry a user name or password.");
  if (raw.includes("*")) throw new HttpError(400, "invalid_redirect_uri", "A redirect address can't have wildcards.");
  if (u.protocol === "https:") return u.href;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return u.href;
  const scheme = u.protocol.slice(0, -1);
  if (u.protocol !== "http:" && SCHEME_RE.test(scheme) && !DENIED_SCHEMES.includes(scheme) && redirectAllowed(u.href, allow)) return u.href;
  throw new HttpError(400, "invalid_redirect_uri", "A redirect address must be https, or http on this computer's own loopback address. An app-specific address such as cursor:// needs a Proxmox administrator to allow it in Connected apps.");
}

export const isLoopbackUri = (uri: string): boolean => {
  try {
    const u = new URL(uri);
    return u.protocol === "http:" && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
};

/** Exact match, except that a loopback address may use any port (RFC 8252 section 7.3). */
export function redirectMatches(registered: readonly string[], given: string): boolean {
  if (registered.includes(given)) return true;
  if (!isLoopbackUri(given)) return false;
  const g = new URL(given);
  return registered.some((r) => {
    if (!isLoopbackUri(r)) return false;
    const x = new URL(r);
    return x.hostname === g.hostname && x.pathname === g.pathname && x.search === g.search;
  });
}

/** Text that came from outside (a client's name) and will be shown to a person: no control characters, trimmed, capped. */
export const cleanText = (v: unknown, max: number): string => (typeof v === "string" ? v : "").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** A sliding window: `take(key)` is true while the key made fewer than `max` requests in the last `windowMs`. */
export class RateWindow {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  constructor(max: number, windowMs: number, now: () => number) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }
  take(key: string): boolean {
    const t = this.now();
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.every((x) => t - x >= this.windowMs)) this.hits.delete(k);
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}

/** A request body of up to `max` bytes, as text, that has to arrive within the usual 30 seconds. */
export async function readBodyText(req: IncomingMessage, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  let timer: NodeJS.Timeout | undefined;
  const slow = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(408, "request_timeout", "The request took too long to arrive")), limits.bodyTimeoutMs);
  });
  slow.catch(() => {});
  const read = (async () => {
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > max) throw new HttpError(413, "too_large", "Request body too large");
      chunks.push(c as Buffer);
    }
  })();
  read.catch(() => {});
  try {
    await Promise.race([read, slow]);
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads a form-encoded or JSON object body (the token and registration endpoints take either). Only string values are kept from forms. */
export async function readFormOrJson(req: IncomingMessage, max = 16 * 1024): Promise<Record<string, unknown>> {
  const type = String(req.headers["content-type"] ?? "").toLowerCase();
  const text = await readBodyText(req, max);
  if (type.startsWith("application/json")) {
    try {
      const v = JSON.parse(text || "{}");
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
      return v as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "invalid_request", "Body must be a JSON object");
    }
  }
  if (type.startsWith("application/x-www-form-urlencoded")) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(text)) if (!(k in out)) out[k] = v;
    return out;
  }
  throw new HttpError(415, "invalid_request", "Send application/x-www-form-urlencoded or JSON");
}

/** Counts bad attempts per address; too many from one address locks it out for a while. */
export class FailureCounter {
  private readonly fails = new Map<string, { n: number; first: number }>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  constructor(max: number, windowMs: number, now: () => number) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }
  blocked(k: string): boolean {
    const f = this.fails.get(k);
    return f !== undefined && this.now() - f.first < this.windowMs && f.n >= this.max;
  }
  fail(k: string) {
    const t = this.now();
    if (this.fails.size > 10_000) for (const [key, f] of this.fails) if (t - f.first >= this.windowMs) this.fails.delete(key);
    const f = this.fails.get(k);
    this.fails.set(k, !f || t - f.first >= this.windowMs ? { n: 1, first: t } : { n: f.n + 1, first: f.first });
  }
}
