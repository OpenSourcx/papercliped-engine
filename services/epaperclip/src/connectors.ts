import { HttpError } from "./http.ts";
import type { StateStore } from "./state.ts";

/**
 * Connectors: the credentials ePaperclip holds for outside services. v1 has the model providers Pin can use, each with
 * one API key. Keys are sealed in the vault; what anyone may read is only whether a key is set, its last four
 * characters, who set it and when, and how its last test went. Only Proxmox administrators may change them (checked by
 * the caller). Which models exist is always read from the provider, never written down here.
 */

export type ProviderId = "anthropic" | "openai" | "gemini" | "openrouter";

export const PROVIDERS: readonly { id: ProviderId; label: string }[] = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "gemini", label: "Google Gemini" },
  { id: "openrouter", label: "OpenRouter" },
];

export const isProvider = (v: unknown): v is ProviderId => typeof v === "string" && PROVIDERS.some((p) => p.id === v);
export const providerLabel = (id: ProviderId) => PROVIDERS.find((p) => p.id === id)!.label;

/** Outbound HTTP to providers; tests inject a fake. Same shape as the global fetch. */
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

const BASE: Record<ProviderId, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  openrouter: "https://openrouter.ai/api/v1",
};

/** How to call a provider's API with a key. Gemini's key goes in a header rather than the URL, so it never lands in a log line. */
export function providerRequest(id: ProviderId, key: string, path: string): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> =
    id === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : id === "gemini" ? { "x-goog-api-key": key } : { Authorization: `Bearer ${key}` };
  return { url: `${BASE[id]}${path}`, headers };
}

/** The cheapest authenticated call for each provider. OpenRouter's model list is public, so its key endpoint is used. */
const TEST_PATH: Record<ProviderId, string> = { anthropic: "/models?limit=1", openai: "/models", gemini: "/models?pageSize=1", openrouter: "/key" };

export interface ConnectorRecord {
  last4: string;
  updatedAt: number;
  updatedBy: string;
  testedAt?: number;
  ok?: boolean;
  error?: string;
}

export interface ConnectorView {
  id: ProviderId;
  kind: "model";
  label: string;
  configured: boolean;
  last4?: string;
  updatedAt?: number;
  updatedBy?: string;
  testedAt?: number;
  ok?: boolean;
  error?: string;
}

const secretName = (id: ProviderId) => `connector.${id}.apiKey`;

/** A loose shape check: long enough to be a key, short enough not to be a file, and only characters keys use. */
export function checkApiKey(v: unknown): string {
  const key = typeof v === "string" ? v.trim() : "";
  if (key.length < 20 || key.length > 512 || !/^[A-Za-z0-9_\-.:+/=]+$/.test(key)) throw new HttpError(400, "bad_key", "That doesn't look like an API key. Paste the whole key.");
  return key;
}

/** Turns a provider's HTTP status into words a person can act on. Never includes the key. */
export function providerProblem(id: ProviderId, status: number, detail?: string): { code: string; message: string } {
  const label = providerLabel(id);
  if (status === 401 || status === 403) return { code: "provider_auth", message: `${label} rejected the API key. An administrator can replace it in Connectors.` };
  if (status === 429) return { code: "provider_rate_limited", message: `${label} is rate-limiting this key, or its quota ran out. Try again shortly.` };
  if (status === 529 || status === 503 || status === 502) return { code: "provider_overloaded", message: `${label} is overloaded right now. Try again in a moment.` };
  if (status === 404) return { code: "provider_rejected", message: `${label} doesn't know that model${detail ? `: ${detail}` : "."}` };
  if (status >= 400 && status < 500) return { code: "provider_rejected", message: `${label} refused the request${detail ? `: ${detail}` : "."}` };
  return { code: "provider_error", message: `${label} answered ${status}.` };
}

/** Pulls a provider's error message out of its JSON error body, trimmed. */
export function errorDetail(text: string): string | undefined {
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const m = typeof j.error === "string" ? j.error : typeof j.error?.message === "string" ? j.error.message : typeof j.message === "string" ? j.message : undefined;
    return m ? m.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

export class Connectors {
  private readonly state: StateStore;
  private readonly fetch: HttpFetch;
  private readonly now: () => number;

  constructor(state: StateStore, fetchImpl: HttpFetch, now: () => number = Date.now) {
    this.state = state;
    this.fetch = fetchImpl;
    this.now = now;
  }

  private records(): Partial<Record<ProviderId, ConnectorRecord>> {
    return this.state.getSetting<Partial<Record<ProviderId, ConnectorRecord>>>("connectors") ?? {};
  }

  list(): ConnectorView[] {
    const recs = this.records();
    return PROVIDERS.map((p) => {
      const r = recs[p.id];
      const configured = !!r && this.state.getSecret(secretName(p.id)) !== null;
      return configured ? { id: p.id, kind: "model" as const, label: p.label, configured, ...r } : { id: p.id, kind: "model" as const, label: p.label, configured: false };
    });
  }

  /** Providers with a key, in the order they are listed. */
  configured(): ProviderId[] {
    return this.list().filter((c) => c.configured).map((c) => c.id);
  }

  /** The key itself, for server-side calls only. */
  key(id: ProviderId): string | null {
    return this.state.getSecret(secretName(id));
  }

  /** Something that changes whenever the key does, so caches built with the old key are dropped. */
  keyStamp(id: ProviderId): string {
    const r = this.records()[id];
    return r ? `${r.updatedAt}:${r.last4}` : "none";
  }

  setKey(id: ProviderId, apiKey: unknown, who: string): ConnectorView {
    const key = checkApiKey(apiKey);
    this.state.setSecret(secretName(id), key);
    this.state.setSetting("connectors", { ...this.records(), [id]: { last4: key.slice(-4), updatedAt: this.now(), updatedBy: who } satisfies ConnectorRecord });
    return this.list().find((c) => c.id === id)!;
  }

  remove(id: ProviderId) {
    this.state.deleteSecret(secretName(id));
    const recs = this.records();
    delete recs[id];
    this.state.setSetting("connectors", recs);
  }

  /** Makes one real, minimal call with the stored key and records how it went. */
  async test(id: ProviderId): Promise<ConnectorView> {
    const key = this.key(id);
    const rec = this.records()[id];
    if (!key || !rec) throw new HttpError(404, "not_configured", `${providerLabel(id)} has no API key yet`);
    const { url, headers } = providerRequest(id, key, TEST_PATH[id]);
    let result: { ok: boolean; error?: string };
    try {
      const r = await this.fetch(url, { method: "GET", headers: { ...headers, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      const text = await r.text();
      result = r.ok ? { ok: true } : { ok: false, error: providerProblem(id, r.status, errorDetail(text)).message };
    } catch (e) {
      const name = (e as Error).name;
      result = { ok: false, error: name === "TimeoutError" || name === "AbortError" ? `${providerLabel(id)} didn't answer within 10 seconds.` : `Couldn't reach ${providerLabel(id)}.` };
    }
    const recs = this.records();
    if (recs[id]) {
      recs[id] = { ...recs[id]!, testedAt: this.now(), ok: result.ok, error: result.error };
      if (result.ok) delete recs[id]!.error;
      this.state.setSetting("connectors", recs);
    }
    return this.list().find((c) => c.id === id)!;
  }
}
