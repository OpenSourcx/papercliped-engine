import { NodeApiError } from "./nodeApi.ts";

/**
 * The host service's connector routes (services/epaperclip/src/features/connect*.ts, docs/CONNECTORS.md): connected AI
 * apps (the Papercliped bridge), model connections, agents' AI accounts and adapters. Every call is made by the host
 * service as the signed-in person; keys are never returned.
 */

async function req<T>(method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: method === "GET" ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json", "X-EPC-Request": "1" },
      body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new NodeApiError(0, "Can't reach this device", "offline");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; error_description?: string; code?: string };
    throw new NodeApiError(res.status, d.error_description ?? d.error ?? (res.status === 404 ? "This device doesn't offer that yet" : `Request failed (${res.status})`), d.code ?? null);
  }
  return data as T;
}

const enc = encodeURIComponent;

/** The Router (docs/ROUTER.md): its address, the models clients can name, connections resting after failures, and its keys (never the keys themselves). */
export interface RouterKey { id: string; name: string; last4: string; createdAt: number; createdBy: string; lastUsedAt?: number }
export interface RouterStatus { listen: string | null; models: { id: string; owner: string; label: string }[]; resting: { pid: string; fails: number; openUntil: number }[]; keys: RouterKey[] }

export type Level = "paperclip:read" | "paperclip:control";
export interface ScopeInfo { id: Level; label: string; description: string }
export interface ConnectOverview {
  mcpUrl: string;
  issuer: string;
  scopes: ScopeInfo[];
  user: string;
  canManageAll: boolean;
  orgs: { id: string; name: string }[];
  fetchUrl: boolean;
  tools: { name: string; title: string; access: "read" | "control"; destructive: boolean }[];
  grantDays: number;
}
export interface ConnectedApp {
  id: string;
  clientName: string;
  clientHost: string;
  userid: string;
  scope: Level;
  direct: boolean;
  orgs: string[] | null;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
}
export interface AppCall { at: number; grantId: string; user: string; client: string; tool: string; ok: boolean; control: boolean; note?: string }
export interface AuditEvent { at: number; actor: string; action: string; target?: string; detail?: string }
export interface AuthRequestInfo {
  client: { id: string; name: string; redirectHost: string; redirectUri: string; loopback: boolean; customScheme: boolean };
  scope: Level;
  scopes: ScopeInfo[];
  user: string;
  orgs: { id: string; name: string }[] | null;
  lifetimeDays: number;
}

export interface CatalogEntry {
  id: string;
  label: string;
  kind: "hosted" | "local" | "custom";
  protocol: "anthropic" | "openai" | "gemini";
  base: string;
  baseEditable: boolean;
  keyRequired: boolean;
  keysUrl?: string;
  note?: string;
  builtin?: boolean;
  engine?: string;
  subscription?: boolean;
}
export interface Connection {
  id: string;
  catalog: string;
  label: string;
  baseUrl?: string;
  builtin: boolean;
  enabled: boolean;
  pin: boolean;
  orgs: string[];
  model: string | null;
  price: { inPerM: number; outPerM: number } | null;
  last4?: string;
  configured: boolean;
  testedAt?: number;
  ok?: boolean;
  error?: string;
  latencyMs?: number;
  modelCount?: number;
  entry: { kind: string; protocol: string; keyRequired: boolean; engine?: string; subscription?: boolean; keysUrl?: string; note?: string };
}
export interface UsageReport {
  days: number;
  perDay: { day: string; tokensIn: number; tokensOut: number; calls: number }[];
  byConnection: { id: string; label: string; calls: number; tokensIn: number; tokensOut: number; costUsd: number | null; priced: boolean }[];
}
export interface LoginView {
  id: string;
  adapter: string;
  provider: string;
  flow: "device" | "setup-token";
  status: string;
  verificationUrl: string | null;
  userCode: string | null;
  needsCode: boolean;
  expiresAt: number | null;
  message: string | null;
  done: boolean;
  failed: boolean;
}
export interface AdapterRow {
  type: string;
  name: string;
  summary: string;
  runs: "container" | "remote";
  source: "builtin" | "external";
  verified: boolean;
  registered: boolean | null;
  enabled: boolean | null;
  packageName?: string | null;
}
export interface AdapterList {
  adapters: AdapterRow[];
  available: { id: string; name: string; vendor: string; summary: string; version: string; permissions: string[]; packageName: string }[];
  engine: { ok: boolean; problem?: string };
  marketProblem: { code: string; message: string } | null;
}

export interface RedirectAllowEntry { uri: string; kind: "exact" | "prefix"; addedBy: string; addedAt: number }

export const connectApi = {
  redirectAllow: {
    list: () => req<{ entries: RedirectAllowEntry[]; deniedSchemes: string[] }>("GET", "/api/connect/redirect-allow"),
    add: (b: { uri: string; kind: "exact" | "prefix"; confirm: string }) => req<{ entries: RedirectAllowEntry[] }>("POST", "/api/connect/redirect-allow", b),
    remove: (e: { uri: string; kind: "exact" | "prefix" }) => req<{ entries: RedirectAllowEntry[] }>("DELETE", `/api/connect/redirect-allow?${new URLSearchParams(e)}`),
  },
  overview: () => req<ConnectOverview>("GET", "/api/connect/overview"),
  authRequest: (query: string) => req<AuthRequestInfo>("GET", `/api/connect/oauth/request?${query}`),
  consent: (b: Record<string, unknown>) => req<{ redirect: string }>("POST", "/api/connect/oauth/consent", b),
  apps: (all = false) => req<{ apps: ConnectedApp[]; scope: "mine" | "all" }>("GET", `/api/connect/apps${all ? "?all=1" : ""}`),
  updateApp: (id: string, patch: Partial<Pick<ConnectedApp, "scope" | "direct" | "orgs">>) => req<{ app: ConnectedApp }>("PATCH", `/api/connect/apps/${enc(id)}`, patch),
  revokeApp: (id: string) => req<{ ok: boolean; warnings: string[] }>("DELETE", `/api/connect/apps/${enc(id)}`),
  activity: (all = false) => req<{ calls: AppCall[]; events: AuditEvent[] }>("GET", `/api/connect/activity${all ? "?all=1" : ""}`),
  setFetchUrl: (fetchUrl: boolean) => req<{ fetchUrl: boolean }>("PUT", "/api/connect/settings", { fetchUrl }),

  catalog: () => req<{ catalog: CatalogEntry[] }>("GET", "/api/connect/catalog"),
  connections: () => req<{ connections: Connection[]; canManage: boolean; fallbacks: string[] }>("GET", "/api/connect/connections"),
  addConnection: (b: Record<string, unknown>) => req<{ connection: Connection }>("POST", "/api/connect/connections", b),
  updateConnection: (id: string, patch: Record<string, unknown>) => req<{ connection: Connection }>("PATCH", `/api/connect/connections/${enc(id)}`, patch),
  setConnectionKey: (id: string, apiKey: string) => req<{ connection: Connection }>("PUT", `/api/connect/connections/${enc(id)}/key`, { apiKey }),
  removeConnection: (id: string) => req<{ ok: boolean }>("DELETE", `/api/connect/connections/${enc(id)}`),
  testConnection: (id: string) => req<{ connection: Connection }>("POST", `/api/connect/connections/${enc(id)}/test`, {}),
  connectionModels: (id: string) => req<{ models: { id: string; label: string }[] }>("GET", `/api/connect/connections/${enc(id)}/models`),
  setFallbacks: (order: string[]) => req<{ order: string[] }>("PUT", "/api/connect/fallbacks", { order }),
  usage: (days = 30) => req<UsageReport>("GET", `/api/connect/usage?days=${days}`),
  router: () => req<RouterStatus>("GET", "/api/router"),
  makeRouterKey: (name: string) => req<{ key: string; view: RouterKey }>("POST", "/api/router/keys", { name }),
  revokeRouterKey: (id: string) => req<{ ok: true }>("DELETE", `/api/router/keys/${enc(id)}`),

  orgAi: (company: string) => req<{ connections: { id: string | null; provider: string | null; method: string | null; name: string | null; ownership: string | null; status: string | null }[] }>("GET", `/api/connect/orgs/${enc(company)}/ai`),
  applyToOrg: (company: string, id: string) => req<{ applied: boolean }>("POST", `/api/connect/orgs/${enc(company)}/apply/${enc(id)}`, {}),
  startLogin: (company: string, b: { provider: "anthropic" | "openai"; flow?: "device" | "setup-token"; name?: string }) => req<{ login: LoginView }>("POST", `/api/connect/orgs/${enc(company)}/login`, b),
  pollLogin: (company: string, id: string) => req<{ login: LoginView }>("GET", `/api/connect/orgs/${enc(company)}/login/${enc(id)}`),
  sendLoginCode: (company: string, id: string, browserCode: string) => req<{ login: LoginView }>("POST", `/api/connect/orgs/${enc(company)}/login/${enc(id)}/code`, { browserCode }),
  cancelLogin: (company: string, id: string) => req<{ ok: boolean }>("POST", `/api/connect/orgs/${enc(company)}/login/${enc(id)}/cancel`, {}),

  adapters: () => req<AdapterList>("GET", "/api/connect/adapters"),
  setAdapter: (type: string, enabled: boolean) => req<{ type: string; enabled: boolean }>("PUT", `/api/connect/adapters/${enc(type)}`, { enabled }),
  installAdapter: (id: string) => req<{ installed: boolean }>("POST", "/api/connect/adapters/install", { id }),
  removeAdapter: (type: string) => req<{ ok: boolean }>("DELETE", `/api/connect/adapters/${enc(type)}`),
};
