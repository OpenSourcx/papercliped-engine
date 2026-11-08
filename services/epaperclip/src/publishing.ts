import { HttpError } from "./http.ts";
import type { HttpFetch } from "./connectors.ts";
import type { StateStore } from "./state.ts";

/**
 * Machine-wide publishing connections.  They deliberately live beside (but
 * separate from) model connectors: publishing a device changes its network
 * exposure and must never become something an organisation or an agent can
 * silently enable.
 *
 * Cloudflare is the first provider.  The public shape is provider-neutral so
 * other hosting services can use the same Settings → Advertising surface.
 */
export type PublisherId = "cloudflare";

export interface PublisherRecord {
  updatedAt: number;
  updatedBy: string;
  testedAt?: number;
  ok?: boolean;
  error?: string;
}

export interface PublisherView {
  id: PublisherId;
  kind: "hosting";
  label: string;
  configured: boolean;
  /** Publishing is an administrator-only device capability, never a Pin/agent connector. */
  machineWide: true;
  updatedAt?: number;
  updatedBy?: string;
  testedAt?: number;
  ok?: boolean;
  error?: string;
}

export interface PublishZone { id: string; name: string; accountId?: string; accountName?: string }

/** The permissions the customer's own Cloudflare API token needs. Shown before the token is accepted and named when one is missing. */
export const CLOUDFLARE_PERMISSIONS = [
  { id: "zone-read", label: "Zone: Zone: Read", required: true, why: "List your domains and find the one you choose." },
  { id: "dns-edit", label: "Zone: DNS: Edit", required: true, why: "Create and remove the one DNS record for this device's address." },
  { id: "tunnel-edit", label: "Account: Cloudflare Tunnel: Edit", required: true, why: "Create, configure and delete this device's named tunnel and read its run token." },
  { id: "account-read", label: "Account: Account Settings: Read", required: false, why: "Optional. Lets ePaperclip show your account name; without it the account is taken from the domain." },
] as const;

/** One Cloudflare API answer. `need` names the permission the call depends on so a refusal can say exactly what is missing. */
export interface CfCall { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; need?: string; allow404?: boolean }
export interface CfAnswer<T> { status: number; result: T; info?: { total_pages?: number; page?: number } }

export interface PublicationPlan {
  provider: PublisherId;
  hostname: string;
  origin: "https://127.0.0.1:443";
  access: "epaperclip-login";
  /** A named tunnel is required for a stable hostname and Pin's SSE stream. */
  mode: "named-tunnel";
}

const TOKEN = "publisher.cloudflare.apiToken";
const RECORDS = "publishers";
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const responseMessage = async (r: Response): Promise<string | undefined> => {
  try {
    const body = await r.json() as { errors?: { message?: unknown }[] };
    const message = body.errors?.find((e) => typeof e.message === "string")?.message;
    return typeof message === "string" ? message.slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
};

function apiToken(value: unknown): string {
  const token = typeof value === "string" ? value.trim() : "";
  // Cloudflare user tokens and account-owned tokens are opaque bearer tokens.
  // Only accept a single token, never a pasted curl command or configuration.
  if (token.length < 20 || token.length > 512 || !/^[A-Za-z0-9_.-]+$/.test(token)) throw new HttpError(400, "bad_key", "Paste a Cloudflare API token, not a command or configuration file.");
  return token;
}

export class Publishing {
  private readonly state: StateStore;
  private readonly fetch: HttpFetch;
  private readonly now: () => number;

  constructor(state: StateStore, fetch: HttpFetch, now: () => number = Date.now) {
    this.state = state;
    this.fetch = fetch;
    this.now = now;
  }

  private records(): Partial<Record<PublisherId, PublisherRecord>> {
    return this.state.getSetting<Partial<Record<PublisherId, PublisherRecord>>>(RECORDS) ?? {};
  }

  private save(record: PublisherRecord | undefined) {
    const records = this.records();
    if (record) records.cloudflare = record;
    else delete records.cloudflare;
    this.state.setSetting(RECORDS, records);
  }

  token(): string | null { return this.state.getSecret(TOKEN); }

  list(): PublisherView[] {
    const record = this.records().cloudflare;
    const configured = !!record && this.token() !== null;
    return [configured
      ? { id: "cloudflare", kind: "hosting", label: "Cloudflare publishing", configured: true, machineWide: true, ...record! }
      : { id: "cloudflare", kind: "hosting", label: "Cloudflare publishing", configured: false, machineWide: true }];
  }

  setToken(value: unknown, who: string): PublisherView {
    const token = apiToken(value);
    this.state.setSecret(TOKEN, token);
    this.save({ updatedAt: this.now(), updatedBy: who });
    return this.list()[0]!;
  }

  remove() {
    this.state.deleteSecret(TOKEN);
    this.save(undefined);
  }

  private async request(path: string): Promise<Response> {
    const token = this.token();
    if (!token) throw new HttpError(404, "not_configured", "Cloudflare publishing has no API token yet");
    try {
      return await this.fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      if ((e as Error).name === "TimeoutError") throw new HttpError(502, "publisher_timeout", "Cloudflare did not answer within 10 seconds.");
      throw new HttpError(502, "publisher_unreachable", "Could not reach Cloudflare.");
    }
  }

  private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Tests make rate-limit waits instant. */
  setSleep(f: (ms: number) => Promise<void>) { this.sleep = f; }

  /**
   * One Cloudflare API call with the device's token. Rate limits (429) are waited out twice (Retry-After, capped at 5 s),
   * then reported. Refusals name the missing permission. The token is never part of any message.
   */
  async cf<T = unknown>(path: string, o: CfCall = {}): Promise<CfAnswer<T>> {
    const token = this.token();
    if (!token) throw new HttpError(404, "not_configured", "Cloudflare publishing has no API token yet");
    const method = o.method ?? "GET";
    for (let attempt = 0; ; attempt++) {
      let r: Response;
      try {
        r = await this.fetch(`https://api.cloudflare.com/client/v4${path}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(o.body !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}), signal: AbortSignal.timeout(15_000) });
      } catch (e) {
        if ((e as Error).name === "TimeoutError") throw new HttpError(502, "publisher_timeout", "Cloudflare did not answer within 15 seconds. Nothing was lost; try again.");
        throw new HttpError(502, "publisher_unreachable", "Could not reach Cloudflare. Check this device's internet connection.");
      }
      if (r.status === 429) {
        if (attempt >= 2) throw new HttpError(429, "rate_limited", "Cloudflare is rate limiting this token. Wait a minute, then press Resume. Nothing was lost.");
        const wait = Math.min(Math.max(Number(r.headers.get("retry-after")) || 1, 1), 5) * 1000;
        await this.sleep(wait);
        continue;
      }
      if (r.status === 404 && o.allow404) return { status: 404, result: undefined as T };
      let body: { success?: boolean; result?: T; result_info?: { total_pages?: number; page?: number }; errors?: { code?: number; message?: unknown }[] } = {};
      try { body = await r.json() as typeof body; } catch { /* non-JSON error page */ }
      if (r.ok && body.success !== false) return { status: r.status, result: body.result as T, info: body.result_info };
      const detail = body.errors?.find((e) => typeof e.message === "string")?.message;
      const text = typeof detail === "string" ? ` (${detail.slice(0, 160)})` : "";
      if (r.status === 401) throw new HttpError(403, "token_invalid", `Cloudflare does not accept this API token${text}. Create a new token and paste it again.`);
      if (r.status === 403) throw new HttpError(403, "missing_permission", `This token is missing a permission: ${o.need ?? "access to this Cloudflare resource"}.${text} Edit the token in Cloudflare (My Profile, API Tokens), add it, then try again.`);
      if (r.status >= 500) throw new HttpError(502, "cloudflare_unavailable", `Cloudflare had a problem (${r.status}). Nothing was lost; try again shortly.`);
      throw new HttpError(r.status === 409 ? 409 : 400, r.status === 409 ? "cloudflare_conflict" : "cloudflare_refused", `Cloudflare refused the request${text || ` (${r.status})`}.`);
    }
  }

  async test(): Promise<PublisherView> {
    const current = this.records().cloudflare;
    if (!current || !this.token()) throw new HttpError(404, "not_configured", "Cloudflare publishing has no API token yet");
    const response = await this.request("/user/tokens/verify");
    const detail = response.ok ? undefined : await responseMessage(response);
    this.save({ ...current, testedAt: this.now(), ok: response.ok, ...(detail ? { error: `Cloudflare rejected the token: ${detail}` } : response.ok ? {} : { error: "Cloudflare rejected the token." }) });
    return this.list()[0]!;
  }

  /** Active domains, all pages. A missing Zone: Read permission is named, never "could not load". */
  async zones(): Promise<PublishZone[]> {
    const out: PublishZone[] = [];
    for (let page = 1; page <= 20; page++) {
      const a = await this.cf<unknown>(`/zones?status=active&per_page=50&page=${page}`, { need: "Zone: Zone: Read" });
      if (!Array.isArray(a.result)) throw new HttpError(502, "zones_unavailable", "Cloudflare returned an invalid domain list.");
      for (const zone of a.result) {
        if (!zone || typeof zone !== "object") continue;
        const z = zone as { id?: unknown; name?: unknown; account?: { id?: unknown; name?: unknown } };
        if (typeof z.id !== "string" || typeof z.name !== "string") continue;
        out.push({ id: z.id, name: z.name, ...(typeof z.account?.id === "string" ? { accountId: z.account.id } : {}), ...(typeof z.account?.name === "string" ? { accountName: z.account.name } : {}) });
      }
      if (a.result.length < 50 || page >= (a.info?.total_pages ?? 1)) break;
    }
    return out;
  }

  /**
   * Validate and return the exact stable-publication plan.  Provisioning the
   * named tunnel is intentionally a separate privileged host job: the host
   * service itself does not get root or a cloudflared token in its process
   * arguments.
   */
  plan(zone: unknown, subdomain: unknown): PublicationPlan {
    const name = typeof zone === "string" ? zone.trim().toLowerCase() : "";
    const label = typeof subdomain === "string" ? subdomain.trim().toLowerCase() : "";
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name)) throw new HttpError(400, "bad_zone", "Choose a valid Cloudflare domain.");
    if (!LABEL.test(label)) throw new HttpError(400, "bad_subdomain", "Use one subdomain label: letters, numbers and hyphens only.");
    return { provider: "cloudflare", hostname: `${label}.${name}`, origin: "https://127.0.0.1:443", access: "epaperclip-login", mode: "named-tunnel" };
  }
}
