export const DEFAULT_CONTROL_URL = "http://127.0.0.1:3130";
export const DEFAULT_TIMEOUT_MS = 120_000;

export interface Requirements { arch?: string; tools?: string[]; gpu?: boolean; localModel?: string; minFreeMemMb?: number }

export interface RemoteWorkerConfig {
  controlUrl: string;
  controlToken: string | null;
  workerId: string | null;
  requirements: Requirements;
  needsInference: boolean;
  reuseLease: boolean;
  timeoutMs: number;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function parseConfig(raw: Record<string, unknown>): RemoteWorkerConfig {
  const r = (raw.requirements && typeof raw.requirements === "object" ? raw.requirements : {}) as Record<string, unknown>;
  const requirements: Requirements = {};
  if (str(r.arch)) requirements.arch = str(r.arch)!;
  if (Array.isArray(r.tools)) requirements.tools = r.tools.filter((t): t is string => typeof t === "string" && !!t);
  if (typeof r.gpu === "boolean") requirements.gpu = r.gpu;
  if (str(r.localModel)) requirements.localModel = str(r.localModel)!;
  if (typeof r.minFreeMemMb === "number") requirements.minFreeMemMb = r.minFreeMemMb;
  return {
    controlUrl: (str(raw.controlUrl) ?? DEFAULT_CONTROL_URL).replace(/\/+$/, ""),
    controlToken: str(raw.controlToken),
    workerId: str(raw.workerId),
    requirements,
    needsInference: raw.needsInference === true,
    reuseLease: raw.reuseLease === true,
    timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** The control token is a credential: it may cross only loopback or TLS. */
export function checkConfig(c: RemoteWorkerConfig): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  let u: URL | null = null;
  try {
    u = new URL(c.controlUrl);
  } catch {
    errors.push("controlUrl must be a URL, for example http://127.0.0.1:3130.");
  }
  if (u) {
    if (u.protocol !== "http:" && u.protocol !== "https:") errors.push("controlUrl must be http or https.");
    else if (u.protocol === "http:" && !LOOPBACK.has(u.hostname)) errors.push("controlUrl must be https unless it is on this machine (the token would cross the network in clear text).");
  }
  if (!c.controlToken) errors.push("controlToken is required: ePaperclip creates it when it makes the environment.");
  if (!Number.isInteger(c.timeoutMs) || c.timeoutMs < 1000 || c.timeoutMs > 86_400_000) errors.push("timeoutMs must be between 1000 and 86400000.");
  if (!c.workerId && Object.keys(c.requirements).length === 0) warnings.push("No worker and no requirements are set: any adopted worker allowed for this organization may be used.");
  return { errors, warnings };
}
