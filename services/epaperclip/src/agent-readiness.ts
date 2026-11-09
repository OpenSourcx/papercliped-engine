import type { EngineGateway } from "./engine.ts";
import type { Session } from "./sessions.ts";

/**
 * Whether an agent can run right now, computed from what the engine really holds rather than from the agent row
 * existing. ePaperclip agents run only in sandbox environments (containers), so readiness needs all three:
 *
 *   1. an adapter (and, when the engine reports capabilities, one that supports a sandbox driver);
 *   2. a credential reference (a managed AI connection, an agent env binding, or an organization credential the
 *      engine's own cheap auth signal reports as present);
 *   3. an active sandbox environment set as the agent's default.
 *
 * The engine's `status` is a lifecycle state ("paused", "pending_approval", ...), not a readiness answer. It still
 * blocks a run, so it is reported separately and makes `ready` false without hiding whether the configuration is
 * otherwise complete (`configured`).
 */

export interface ReadinessAgent {
  id: string;
  companyId?: string;
  name: string;
  status?: string;
  adapterType?: string | null;
  adapterConfig?: Record<string, unknown> | null;
  runtimeConfig?: Record<string, unknown> | null;
  defaultEnvironmentId?: string | null;
}

export interface ReadinessEnvironment {
  id: string;
  companyId?: string;
  name?: string;
  driver?: string;
  status?: string;
}

export interface ReadinessCapabilities {
  adapters?: { adapterType?: string; drivers?: Record<string, string> }[];
}

export type AuthSignal = "present" | "absent" | "unknown";

export interface ReadinessIssue {
  code:
    | "no_adapter"
    | "adapter_not_sandbox"
    | "credential_missing"
    | "credential_unknown"
    | "no_environment"
    | "environment_missing"
    | "environment_not_sandbox"
    | "environment_inactive"
    | "agent_terminated"
    | "agent_pending_approval"
    | "agent_paused";
  detail: string;
}

export interface AgentReadiness {
  agentId: string;
  companyId: string;
  name: string;
  status: string;
  /** True only when the agent is configured and its lifecycle state allows a run. */
  ready: boolean;
  /** True when the adapter, credential and sandbox environment are all in place, ignoring pause/pending/terminated. */
  configured: boolean;
  adapter: { type: string | null; ok: boolean };
  credential: { ok: boolean; source: "ai_connection" | "agent_environment" | "organization_credential" | "none" | "unknown"; detail?: string };
  environment: { ok: boolean; id: string | null; driver: string | null; status: string | null };
  issues: ReadinessIssue[];
  checkedAt: string;
}

/** Credential environment variables each harness reads. A binding under one of these is a credential reference. */
const CREDENTIAL_ENV_KEYS: Record<string, string[]> = {
  claude_local: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex_local: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  gemini_local: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  grok_local: ["XAI_API_KEY", "GROK_API_KEY"],
  opencode_local: ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENCODE_AUTH_JSON"],
  pi_local: ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"],
  kimi_local: ["KIMI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
};

const ALL_CREDENTIAL_KEYS = [...new Set(Object.values(CREDENTIAL_ENV_KEYS).flat())];

/** Adapters that never execute in a sandbox, even before the engine reports capabilities. */
const NON_SANDBOX_ADAPTERS = new Set(["http", "process"]);

const TERMINAL = new Set(["terminated", "pending_approval", "paused"]);

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A binding counts when it names a secret that still exists, a user secret key, or a non-empty plain value. */
function bindingPresent(v: unknown, secrets: Set<string> | null): boolean {
  if (typeof v === "string") return v.trim().length > 0;
  const b = asRecord(v);
  if (!b) return false;
  if (b.type === "secret_ref") {
    if (typeof b.secretId !== "string" || !b.secretId) return false;
    return secrets === null || secrets.has(b.secretId);
  }
  if (b.type === "user_secret_ref") return typeof b.key === "string" && b.key.length > 0;
  if (b.type === "plain") return typeof b.value === "string" && b.value.trim().length > 0;
  return Object.keys(b).length > 0;
}

function credentialReference(agent: ReadinessAgent, secrets: Set<string> | null): { source: "ai_connection" | "agent_environment"; detail: string } | null {
  if (asRecord(agent.runtimeConfig?.aiConnection)) return { source: "ai_connection", detail: "runtimeConfig.aiConnection" };
  const env = asRecord(agent.adapterConfig?.env);
  if (!env) return null;
  const keys = CREDENTIAL_ENV_KEYS[agent.adapterType ?? ""] ?? ALL_CREDENTIAL_KEYS;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) continue;
    if (bindingPresent(env[key], secrets)) return { source: "agent_environment", detail: key };
  }
  return null;
}

export function evaluateAgentReadiness(
  agent: ReadinessAgent,
  opts: {
    environment?: ReadinessEnvironment | null;
    /** The engine's cheap host-local credential signal, when it was read. Null means it was not needed. */
    authSignal?: AuthSignal | null;
    /** From the engine's environment capabilities; null/undefined means unknown, so the adapter is not refused on it. */
    sandboxSupported?: boolean | null;
    /** Company secret ids, so a secret_ref that no longer resolves is not counted. Null means the map wasn't read. */
    secrets?: Set<string> | null;
    now?: number;
  } = {},
): AgentReadiness {
  const companyId = agent.companyId ?? "";
  const status = agent.status ?? "idle";
  const issues: ReadinessIssue[] = [];

  const type = typeof agent.adapterType === "string" && agent.adapterType.trim() ? agent.adapterType.trim() : null;
  let adapterOk = type !== null;
  if (!type) issues.push({ code: "no_adapter", detail: "The agent has no adapter, so there is nothing to run." });
  else if (opts.sandboxSupported === false || NON_SANDBOX_ADAPTERS.has(type)) {
    adapterOk = false;
    issues.push({ code: "adapter_not_sandbox", detail: `${type} cannot run in a sandbox environment.` });
  }

  let credential: AgentReadiness["credential"];
  const local = credentialReference(agent, opts.secrets ?? null);
  if (local) credential = { ok: true, source: local.source, detail: local.detail };
  else if (opts.authSignal === "present") credential = { ok: true, source: "organization_credential", detail: "The engine reports a credential for this adapter." };
  else if (opts.authSignal === "unknown") {
    credential = { ok: false, source: "unknown", detail: "The engine could not say whether this adapter has a credential." };
    issues.push({ code: "credential_unknown", detail: credential.detail! });
  } else {
    credential = { ok: false, source: "none" };
    issues.push({ code: "credential_missing", detail: "No model credential is connected for this agent." });
  }

  const env = opts.environment ?? null;
  let environmentOk = false;
  if (!agent.defaultEnvironmentId) issues.push({ code: "no_environment", detail: "The agent has no default environment." });
  else if (!env) issues.push({ code: "environment_missing", detail: "The agent's default environment no longer exists." });
  else if (env.companyId && companyId && env.companyId !== companyId) issues.push({ code: "environment_missing", detail: "The agent's default environment belongs to another organization." });
  else if (env.driver !== "sandbox") issues.push({ code: "environment_not_sandbox", detail: `The agent's default environment is ${env.driver ?? "unknown"}, not a sandbox.` });
  else if ((env.status ?? "active") !== "active") issues.push({ code: "environment_inactive", detail: `The agent's sandbox is ${env.status ?? "unknown"}.` });
  else environmentOk = true;

  if (status === "terminated") issues.push({ code: "agent_terminated", detail: "The agent was terminated." });
  else if (status === "pending_approval") issues.push({ code: "agent_pending_approval", detail: "The agent is waiting for approval." });
  else if (status === "paused") issues.push({ code: "agent_paused", detail: "The agent is paused." });

  const configured = adapterOk && credential.ok && environmentOk;
  return {
    agentId: agent.id,
    companyId,
    name: agent.name,
    status,
    ready: configured && !TERMINAL.has(status),
    configured,
    adapter: { type, ok: adapterOk },
    credential,
    environment: { ok: environmentOk, id: agent.defaultEnvironmentId ?? null, driver: env?.driver ?? null, status: env?.status ?? null },
    issues,
    checkedAt: new Date(opts.now ?? Date.now()).toISOString(),
  };
}

const asSignal = (v: unknown): AuthSignal => (v === "present" || v === "absent" || v === "unknown" ? v : "unknown");

async function readAuthSignal(gw: EngineGateway, s: Session, companyId: string, type: string, environmentId: string | null | undefined): Promise<AuthSignal> {
  const path = `/api/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/auth-signal${environmentId ? `?environmentId=${encodeURIComponent(environmentId)}` : ""}`;
  try {
    const r = await gw.userJson<{ status?: unknown }>(s, "GET", path);
    return asSignal(r?.status);
  } catch {
    // A failed read is not a claim that the credential is absent: say unknown, never ready.
    return "unknown";
  }
}

/**
 * Reads one organization and returns each agent's readiness. Reads are made as the signed-in person, so the engine's
 * own membership checks apply. Optional reads (environments, capabilities, secrets) fail soft: the affected condition
 * is then unknown and the agent is not marked ready.
 */
export async function companyAgentReadiness(gw: EngineGateway, s: Session, companyId: string, now = Date.now()): Promise<{ companyId: string; checkedAt: string; agents: AgentReadiness[] }> {
  const base = `/api/companies/${encodeURIComponent(companyId)}`;
  const [agents, envs, caps, secrets] = await Promise.all([
    gw.userJson<ReadinessAgent[]>(s, "GET", `${base}/agents`),
    gw.userJson<ReadinessEnvironment[]>(s, "GET", `${base}/environments`).catch(() => null),
    gw.userJson<ReadinessCapabilities>(s, "GET", `${base}/environments/capabilities`).catch(() => null),
    gw.userJson<{ id?: unknown }[]>(s, "GET", `${base}/secrets`).catch(() => null),
  ]);
  const secretIds = Array.isArray(secrets) ? new Set(secrets.flatMap((x) => (typeof x?.id === "string" ? [x.id] : []))) : null;
  const byEnv = new Map((Array.isArray(envs) ? envs : []).filter((e) => typeof e?.id === "string").map((e) => [e.id, e]));
  const sandboxSupport = new Map<string, boolean>();
  for (const a of caps?.adapters ?? []) if (typeof a?.adapterType === "string") sandboxSupport.set(a.adapterType, a.drivers?.sandbox === "supported");

  const signals = new Map<string, AuthSignal>();
  const out: AgentReadiness[] = [];
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (!agent || typeof agent.id !== "string") continue;
    const local = credentialReference({ ...agent, companyId }, secretIds);
    let signal: AuthSignal | null = null;
    if (!local && typeof agent.adapterType === "string" && agent.adapterType) {
      const key = `${agent.adapterType}\u0000${agent.defaultEnvironmentId ?? ""}`;
      if (!signals.has(key)) signals.set(key, await readAuthSignal(gw, s, companyId, agent.adapterType, agent.defaultEnvironmentId));
      signal = signals.get(key)!;
    }
    out.push(
      evaluateAgentReadiness(
        { ...agent, companyId },
        {
          environment: agent.defaultEnvironmentId ? byEnv.get(agent.defaultEnvironmentId) ?? null : null,
          authSignal: signal,
          sandboxSupported: agent.adapterType ? sandboxSupport.get(agent.adapterType) ?? null : null,
          secrets: secretIds,
          now,
        },
      ),
    );
  }
  return { companyId, checkedAt: new Date(now).toISOString(), agents: out };
}
