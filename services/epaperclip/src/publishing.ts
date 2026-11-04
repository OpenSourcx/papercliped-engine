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

export interface PublishZone { id: string; name: string }

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

  async test(): Promise<PublisherView> {
    const current = this.records().cloudflare;
    if (!current || !this.token()) throw new HttpError(404, "not_configured", "Cloudflare publishing has no API token yet");
    const response = await this.request("/user/tokens/verify");
    const detail = response.ok ? undefined : await responseMessage(response);
    this.save({ ...current, testedAt: this.now(), ok: response.ok, ...(detail ? { error: `Cloudflare rejected the token: ${detail}` } : response.ok ? {} : { error: "Cloudflare rejected the token." }) });
    return this.list()[0]!;
  }

  async zones(): Promise<PublishZone[]> {
    const response = await this.request("/zones?status=active&per_page=50");
    if (!response.ok) throw new HttpError(response.status === 401 || response.status === 403 ? 403 : 502, "zones_unavailable", "Cloudflare could not list the active domains for this token.");
    const body = await response.json() as { result?: unknown };
    if (!Array.isArray(body.result)) throw new HttpError(502, "zones_unavailable", "Cloudflare returned an invalid domain list.");
    return body.result.flatMap((zone): PublishZone[] => {
      if (!zone || typeof zone !== "object") return [];
      const z = zone as { id?: unknown; name?: unknown };
      return typeof z.id === "string" && typeof z.name === "string" ? [{ id: z.id, name: z.name }] : [];
    });
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
