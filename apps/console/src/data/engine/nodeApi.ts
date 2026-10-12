/**
 * The host service's node and datacenter endpoints (services/epaperclip/src/features/node*.ts). Every call is made by
 * the host service as the signed-in person, so Proxmox decides what is allowed. Node-scoped calls take an optional
 * node; without one they mean the device the console is signed in to.
 */

export class NodeApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call<T>(method: "GET" | "PUT" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: method === "GET" ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json", "X-EPC-Request": "1" },
      body: body === undefined ? undefined : JSON.stringify(body),
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
    const d = (data ?? {}) as { error?: string; code?: string };
    throw new NodeApiError(res.status, d.error ?? (res.status === 404 ? "This device doesn't offer that yet" : `Request failed (${res.status})`), d.code ?? null);
  }
  return data as T;
}

const enc = encodeURIComponent;
const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
const withNode = (path: string, node?: string | null, extra: Record<string, string | number | boolean | undefined | null> = {}) => `${path}${qs({ node: node ?? undefined, ...extra })}`;
const nodeBody = <T extends object>(node: string | null | undefined, b: T) => (node ? { node, ...b } : b);

// ---- Shapes the host service answers with

export interface NodeInfo { node: string; online: boolean; cpu: number | null; maxcpu: number | null; mem: number | null; maxmem: number | null; uptime: number | null }
export interface ServiceInfo { service: string; name: string; description: string; state: string; activeState: string | null; unitState: string | null; canControl: boolean }
export interface PowerInfo { node: string; local: boolean; thisService: string; running: { vmid: number; name: string; type: string }[]; runningUnknown: boolean; wakeOnLan: "configured" | "not set"; others: { node: string; online: boolean }[] }
export interface SubscriptionInfo { node: string; status: string; level: string | null; productName: string | null; message: string | null; serverId: string | null; sockets: number | null; nextDueDate: string | null; registered: string | null; checkedAt: number | null; url: string | null; keyLast4: string | null }
export interface UpdatePackage { package: string; title: string; description: string; oldVersion: string | null; version: string; origin: string; priority: string; section: string; arch: string }
export interface UpdatesInfo { node: string; packages: UpdatePackage[]; listDenied: boolean; listError: string | null; version: string | null; runningKernel: string | null; newestInstalledKernel: string | null; rebootRequired: boolean; kernelUpdatePending: boolean }
export interface RepoEntry { path: string; fileType: string; index: number; enabled: boolean; types: string[]; uris: string[]; suites: string[]; components: string[]; comment: string | null; kind: string }
export interface ReposInfo {
  node: string;
  digest: string | null;
  repositories: RepoEntry[];
  infos: { path: string | null; index: string | null; kind: string; message: string }[];
  errors: { path: string; error: string }[];
  standardRepos: { handle: string; name: string; status: string | null }[];
  subscriptionStatus: string | null;
  warnings: { id: string; tone: "warning" | "info"; message: string; fix?: "no-subscription" }[];
}
export interface CertInfo { filename: string; subject: string; issuer: string; san: string[]; fingerprint: string; notBefore: number | null; notAfter: number | null; daysLeft: number | null; keyType: string | null; keyBits: number | null; custom: boolean }
export interface TlsStatus { reloaded: boolean; changed: boolean; reason?: string; fingerprint?: string }
export interface AcmeInfo {
  node: string;
  accounts: { name: string }[];
  directories: { name: string; url: string }[];
  plugins: { id: string; type: string; api: string | null; nodes: string | null; disabled: boolean; validationDelay: number | null; hasSettings: boolean; digest: string | null }[] | null;
  pluginsDenied: boolean;
  apis: string[];
  challengeSchema: { id: string; name: string; type: string; fields: Record<string, { type?: string; description?: string }> }[];
  config: { account: string | null; domains: { index: number; domain: string; plugin: string | null; alias: string | null }[]; digest: string | null } | null;
  configDenied: boolean;
}

/** One setting from Proxmox's own parameter definitions (generated on the host service). */
export interface FieldSchema {
  type: "string" | "integer" | "number" | "boolean" | "array";
  description: string;
  required?: boolean;
  enum?: string[];
  min?: number;
  max?: number;
  maxLength?: number;
  default?: string | number | boolean;
  format?: string;
  secret?: boolean;
  items?: FieldSchema;
  props?: Record<string, FieldSchema & { defaultKey?: boolean }>;
}
export type Schema = Record<string, FieldSchema>;
export type Values = Record<string, unknown>;

export interface TaskRow { upid: string; node: string; type: string; id: string | null; user: string; status: string | null; start: number; end: number | null }
export interface TaskDetail { node: string; status: string; exitstatus: string | null; lines: string[]; next: number; total: number | null }
export interface ClusterInfo {
  clustered: boolean;
  name: string | null;
  quorate: boolean;
  configVersion: number | null;
  version: string | null;
  nodes: { name: string; online: boolean; local: boolean; ip: string | null; level: string | null; cpu: number | null; maxcpu: number | null; mem: number | null; maxmem: number | null; uptime: number | null; guests: { running: number; total: number } }[];
  guests: { running: number; total: number };
  statusDenied: boolean;
}
export interface MappingGroup { denied: boolean; items: { id: string; description: string; map: string[]; problems: string[] }[] }
export interface TagInfo { tag: string; count: number; color: { background: string; foreground: string | null } | null; registered: boolean }

export const nodeApi = {
  nodes: () => call<{ local: string; nodes: NodeInfo[] }>("GET", "/api/node/nodes"),

  services: (node?: string | null) => call<{ node: string; services: ServiceInfo[] }>("GET", withNode("/api/node/services", node)),
  serviceAction: (node: string | null | undefined, service: string, action: "start" | "stop" | "restart" | "reload", confirm?: string) => call<{ task: string }>("POST", `/api/node/services/${enc(service)}/${action}`, nodeBody(node, confirm ? { confirm } : {})),

  time: (node?: string | null) => call<{ node: string; time: number; localtime: number; timezone: string }>("GET", withNode("/api/node/time", node)),
  setTimezone: (node: string | null | undefined, timezone: string) => call<{ ok: true }>("PUT", "/api/node/time", nodeBody(node, { timezone })),

  syslog: (node: string | null | undefined, p: { limit: number; start: number; since?: string; until?: string; service?: string }) => call<{ node: string; lines: { n: number; t: string }[]; total: number | null; start: number }>("GET", withNode("/api/node/logs/syslog", node, p)),
  journal: (node: string | null | undefined, p: { lastentries?: number; since?: number; until?: number; unit?: string; priority?: string; kernel?: boolean }) => call<{ node: string; lines: string[] }>("GET", withNode("/api/node/logs/journal", node, { ...p, kernel: p.kernel ? 1 : undefined })),

  power: (node?: string | null) => call<PowerInfo>("GET", withNode("/api/node/power", node)),
  powerCommand: (node: string | null | undefined, command: "reboot" | "shutdown", confirm: string) => call<{ ok: true; selfAffected: boolean }>("POST", "/api/node/power", nodeBody(node, { command, confirm })),
  wakeOnLan: (node: string) => call<{ ok: true; mac: string | null }>("POST", "/api/node/wakeonlan", { node }),

  subscription: (node?: string | null) => call<SubscriptionInfo>("GET", withNode("/api/node/subscription", node)),
  setSubscriptionKey: (node: string | null | undefined, key: string) => call<{ ok: true }>("PUT", "/api/node/subscription", nodeBody(node, { key })),
  checkSubscription: (node?: string | null) => call<{ ok: true }>("POST", "/api/node/subscription/check", nodeBody(node, {})),
  removeSubscription: (node: string | null | undefined, confirm: string) => call<{ ok: true }>("DELETE", "/api/node/subscription", nodeBody(node, { confirm })),

  updates: (node?: string | null) => call<UpdatesInfo>("GET", withNode("/api/node/updates", node)),
  refreshUpdates: (node?: string | null) => call<{ task: string }>("POST", "/api/node/updates/refresh", nodeBody(node, {})),
  changelog: (node: string | null | undefined, name: string, version?: string) => call<{ package: string; version: string | null; text: string }>("GET", withNode("/api/node/updates/changelog", node, { name, version })),
  repos: (node?: string | null) => call<ReposInfo>("GET", withNode("/api/node/repos", node)),
  toggleRepo: (node: string | null | undefined, r: { path: string; index: number; enabled: boolean; digest: string | null }) => call<{ ok: true }>("POST", "/api/node/repos/toggle", nodeBody(node, { path: r.path, index: r.index, enabled: r.enabled, digest: r.digest ?? undefined })),
  addRepo: (node: string | null | undefined, handle: string, digest: string | null) => call<{ ok: true }>("POST", "/api/node/repos/add", nodeBody(node, { handle, digest: digest ?? undefined })),
  switchToNoSubscription: (node?: string | null) => call<{ disabledEnterprise: number; noSubscriptionEnabled: boolean }>("POST", "/api/node/repos/no-subscription", nodeBody(node, {})),

  certificates: (node?: string | null) => call<{ node: string; certificates: CertInfo[]; serving: { fingerprint: string | null } | null }>("GET", withNode("/api/node/certificates", node)),
  uploadCertificate: (node: string | null | undefined, certificates: string, key: string) => call<{ certificate: { filename: string; fingerprint: string; subject: string; issuer: string; notAfter: number }; tls: TlsStatus | null; warnings: string[] }>("POST", "/api/node/certificates/custom", nodeBody(node, { certificates, key })),
  deleteCertificate: (node: string | null | undefined, confirm: string) => call<{ ok: true; tls: TlsStatus | null }>("DELETE", "/api/node/certificates/custom", nodeBody(node, { confirm })),
  reloadCertificate: () => call<TlsStatus>("POST", "/api/node/certificates/reload", {}),
  acme: (node?: string | null) => call<AcmeInfo>("GET", withNode("/api/node/acme", node)),
  acmeTos: (directory?: string) => call<{ tos: string | null; externalAccountRequired: boolean }>("GET", `/api/node/acme/tos${qs({ directory })}`),
  acmeAccount: (name: string) => call<{ name: string; directory: string | null; tos: string | null; status: string | null; contact: string[]; createdAt: string | null }>("GET", `/api/node/acme/accounts/${enc(name)}`),
  createAcmeAccount: (b: { name: string; contact: string; directory?: string; acceptTos: boolean; eabKid?: string; eabHmacKey?: string }) => call<{ task: string }>("POST", "/api/node/acme/accounts", b),
  updateAcmeAccount: (name: string, contact: string) => call<{ task: string }>("PUT", `/api/node/acme/accounts/${enc(name)}`, { contact }),
  deleteAcmeAccount: (name: string) => call<{ task: string }>("DELETE", `/api/node/acme/accounts/${enc(name)}`, { confirm: name }),
  savePlugin: (b: { id: string; type: "dns" | "standalone"; api?: string; settings?: string; nodes?: string; "validation-delay"?: number }, creating: boolean) => (creating ? call<{ ok: true }>("POST", "/api/node/acme/plugins", b) : (({ id, type: _t, ...rest }) => call<{ ok: true }>("PUT", `/api/node/acme/plugins/${enc(id)}`, rest))(b)),
  deletePlugin: (id: string) => call<{ ok: true }>("DELETE", `/api/node/acme/plugins/${enc(id)}`, { confirm: id }),
  saveAcmeConfig: (node: string | null | undefined, b: { account: string | null; domains: { domain: string; plugin?: string; alias?: string }[]; digest?: string | null }) => call<{ ok: true }>("PUT", "/api/node/acme/config", nodeBody(node, { account: b.account, domains: b.domains, digest: b.digest ?? undefined })),
  orderCertificate: (node: string | null | undefined, force = false) => call<{ task: string }>("POST", "/api/node/acme/order", nodeBody(node, force ? { force: true } : {})),
  renewCertificate: (node: string | null | undefined, force = false) => call<{ task: string }>("POST", "/api/node/acme/renew", nodeBody(node, force ? { force: true } : {})),
  revertAcmeCertificate: (node: string | null | undefined, confirm: string) => call<{ task: string }>("DELETE", "/api/node/acme/certificate", nodeBody(node, { confirm })),

  options: () => call<{ values: Values; schema: Schema }>("GET", "/api/node/datacenter/options"),
  saveOptions: (values: Values) => call<{ ok: true }>("PUT", "/api/node/datacenter/options", { values }),
  notifications: () => call<{ targets: { name: string; type: string; comment: string; disabled: boolean; builtin: boolean }[]; matchers: { name: string; comment: string; disabled: boolean; mode: string; targets: string[]; severities: string[]; builtin: boolean }[]; denied: boolean; schemas: Record<"sendmail" | "gotify" | "smtp" | "webhook" | "matcher", Schema> }>("GET", "/api/node/datacenter/notifications"),
  target: (type: string, name: string) => call<{ name: string; type: string; values: Values; digest: string | null; secretsSet: string[] }>("GET", `/api/node/datacenter/notifications/targets/${enc(type)}/${enc(name)}`),
  createTarget: (type: string, name: string, values: Values) => call<{ ok: true }>("POST", `/api/node/datacenter/notifications/targets/${enc(type)}`, { name, values }),
  updateTarget: (type: string, name: string, values: Values, digest: string | null) => call<{ ok: true }>("PUT", `/api/node/datacenter/notifications/targets/${enc(type)}/${enc(name)}`, { values, digest }),
  deleteTarget: (type: string, name: string) => call<{ ok: true }>("DELETE", `/api/node/datacenter/notifications/targets/${enc(type)}/${enc(name)}`, { confirm: name }),
  testTarget: (name: string) => call<{ ok: true }>("POST", `/api/node/datacenter/notifications/targets/${enc(name)}/test`, {}),
  matcher: (name: string) => call<{ name: string; values: Values; digest: string | null }>("GET", `/api/node/datacenter/notifications/matchers/${enc(name)}`),
  createMatcher: (name: string, values: Values) => call<{ ok: true }>("POST", "/api/node/datacenter/notifications/matchers", { name, values }),
  updateMatcher: (name: string, values: Values, digest: string | null) => call<{ ok: true }>("PUT", `/api/node/datacenter/notifications/matchers/${enc(name)}`, { values, digest }),
  deleteMatcher: (name: string) => call<{ ok: true }>("DELETE", `/api/node/datacenter/notifications/matchers/${enc(name)}`, { confirm: name }),
  metrics: () => call<{ servers: { id: string; type: string; server: string; port: number; disabled: boolean }[]; schema: Schema }>("GET", "/api/node/datacenter/metrics"),
  metric: (id: string) => call<{ id: string; values: Values; hasToken: boolean; digest: string | null }>("GET", `/api/node/datacenter/metrics/${enc(id)}`),
  createMetric: (id: string, values: Values) => call<{ ok: true }>("POST", "/api/node/datacenter/metrics", { id, values }),
  updateMetric: (id: string, values: Values, digest: string | null) => call<{ ok: true }>("PUT", `/api/node/datacenter/metrics/${enc(id)}`, { values, digest }),
  deleteMetric: (id: string) => call<{ ok: true }>("DELETE", `/api/node/datacenter/metrics/${enc(id)}`, { confirm: id }),
  mappings: () => call<{ pci: MappingGroup; usb: MappingGroup; dir: MappingGroup }>("GET", "/api/node/datacenter/mappings"),
  tags: () => call<{ tags: TagInfo[]; style: { shape: string; ordering: string; caseSensitive: boolean }; denied: boolean }>("GET", "/api/node/datacenter/tags"),
  saveTags: (b: { colors?: Record<string, { background: string; foreground?: string | null } | null>; shape?: string; ordering?: string }) => call<{ ok: true }>("PUT", "/api/node/datacenter/tags", b),
  cluster: () => call<ClusterInfo>("GET", "/api/node/cluster"),

  tasks: (p: { node?: string; type?: string; user?: string; status?: string; since?: number; limit?: number }) => call<{ tasks: TaskRow[] }>("GET", `/api/node/tasks${qs({ node: p.node ?? "all", type: p.type, user: p.user, status: p.status, since: p.since, limit: p.limit })}`),
  task: (upid: string, start = 0) => call<TaskDetail>("GET", `/api/node/tasks/${enc(upid)}${qs({ start: start || undefined })}`),
  stopTask: (upid: string) => call<{ ok: true }>("DELETE", `/api/node/tasks/${enc(upid)}`, {}),
};
