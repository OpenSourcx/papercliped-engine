import { HttpError } from "./http.ts";

export interface BrokerGroupPolicy {
  name: string;
  pool: string;
  tag: string;
  vmidRange: [number, number];
  profiles: string[];
  limits: { maxLeases: number; maxCores: number; maxMemoryMb: number; maxTtlMinutes: number; defaultTtlMinutes: number };
}

export interface BrokerAdminConfig { url: string; token: string; fetch?: typeof fetch }

/** A deliberately tiny local-only client. This capability can change policy, never call Proxmox directly. */
export class BrokerAdmin {
  private readonly url: string;
  private readonly token: string;
  private readonly f: typeof fetch;
  constructor(c: BrokerAdminConfig) {
    const parsed = new URL(c.url);
    if (parsed.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(parsed.hostname)) throw new Error("Broker administration must use a loopback URL");
    if (!/^[A-Za-z0-9._~+/=-]{24,512}$/.test(c.token)) throw new Error("Broker management token is invalid");
    this.url = parsed.toString().replace(/\/$/, "");
    this.token = c.token;
    this.f = c.fetch ?? fetch;
  }

  async overview(): Promise<{ groups: Record<string, BrokerGroupPolicy>; profiles: string[] }> {
    const r = await this.request("GET");
    return r;
  }

  async replace(groups: Record<string, BrokerGroupPolicy>): Promise<Record<string, BrokerGroupPolicy>> {
    const r = await this.request("PUT", { groups });
    return r.groups;
  }

  private async request(method: "GET" | "PUT", body?: unknown): Promise<{ groups: Record<string, BrokerGroupPolicy>; profiles: string[] }> {
    let res: Response;
    try {
      res = await this.f(`${this.url}/v1/admin/groups`, { method, headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5_000) });
    } catch {
      throw new HttpError(503, "broker_unavailable", "The local resource broker isn't answering yet.");
    }
    const text = await res.text();
    let data: { groups?: Record<string, BrokerGroupPolicy>; profiles?: string[]; error?: string; code?: string } = {};
    try { data = JSON.parse(text) as typeof data; } catch { /* handled below */ }
    if (!res.ok || !data.groups) throw new HttpError(res.status === 401 ? 503 : 502, data.code ?? "broker_error", data.error ?? "The local resource broker refused the resource policy.");
    return { groups: data.groups, profiles: Array.isArray(data.profiles) ? data.profiles.filter((p): p is string => typeof p === "string") : [] };
  }
}
