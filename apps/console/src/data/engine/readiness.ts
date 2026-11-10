import { useQueries, useQuery } from "@tanstack/react-query";
import type { Agent } from "@papercliped-engine/engine-client";
import { connectApi } from "./connectApi.ts";
import { vaultApi } from "./vaultApi.ts";
import { lifecycleError, setupState, setupSummary } from "./lifecycle.ts";
import { engine, useAdapters, useAgentContainers, useAgentReadiness as useBackendAgentReadiness, useSandboxAdapters } from "./queries.ts";

/**
 * Whether an agent can actually execute, derived from what the backend already returns.
 *
 * Assumed backend contract (Lane D, 2026-11-09): an agent payload MAY carry
 *   readiness?: { ready: boolean; reasons?: string[] }
 * When `ready` is a boolean it is treated as the engine's own answer and wins over a derived
 * "ready". It can never turn a blocking derived check into "ready": a disabled adapter or a
 * missing container is still shown.
 *
 * Until that field ships, readiness is derived from existing, real signals only:
 *   - the agent's lifecycle status and the adapters the engine lists for this company;
 *   - the model connection: the agent's AI-connection binding, a Vault key shared with this
 *     agent, the organization's AI connections, or an adapter sign-in the engine confirms;
 *   - the organization's agent container, from the host service.
 * A signal that is still loading or failed is reported as "unknown" — never as "ready".
 */

export type ReadinessState = "ready" | "blocked" | "unknown";
export type CheckState = "ok" | "blocked" | "unknown";
export type CheckId = "adapter" | "model" | "environment";

export interface ReadinessCheck {
  id: CheckId;
  label: string;
  state: CheckState;
  detail: string;
}

export interface AgentReadiness {
  state: ReadinessState;
  /** One plain sentence, safe to show on a card. */
  summary: string;
  checks: ReadinessCheck[];
  source: "backend" | "derived";
}

/** An unknown/missing signal is not a negative: do not claim an agent can run when we could not check it. */
type Signal = { state: CheckState; detail: string };
const ok = (detail: string): Signal => ({ state: "ok", detail });
const no = (detail: string): Signal => ({ state: "blocked", detail });
const unknown = (detail: string): Signal => ({ state: "unknown", detail });

/** The engine's own readiness answer, when it is present and understandable. The host service computes it from live
 * adapters, credentials and environments; the derived checks below are only the fallback when it is absent. */
interface BackendAnswer { ready: boolean; reasons: string[]; checks?: ReadinessCheck[] }
function backendReadiness(value: unknown): BackendAnswer | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (typeof r.ready !== "boolean") return null;
  const reasons = Array.isArray(r.issues)
    ? (r.issues as { detail?: unknown }[]).map((i) => (typeof i?.detail === "string" ? i.detail : "")).filter(Boolean).slice(0, 5)
    : Array.isArray(r.reasons)
      ? r.reasons.filter((x): x is string => typeof x === "string").slice(0, 5)
      : [];
  const adapter = r.adapter as { type?: string | null; ok?: boolean } | undefined;
  const credential = r.credential as { ok?: boolean; detail?: string } | undefined;
  const environment = r.environment as { ok?: boolean; id?: string | null } | undefined;
  let checks: ReadinessCheck[] | undefined;
  if (adapter && credential && environment) {
    checks = [
      { id: "adapter", label: "Runtime", state: adapter.ok ? "ok" : "blocked", detail: adapter.ok ? `The ${adapter.type ?? "runtime"} runtime can run in a container.` : `The ${adapter.type ?? "runtime"} runtime can't run in a container.` },
      { id: "model", label: "Model", state: credential.ok ? "ok" : "blocked", detail: credential.detail ?? (credential.ok ? "A model credential is available to this agent." : "No model credential is available to this agent.") },
      { id: "environment", label: "Sandbox environment", state: environment.ok ? "ok" : "blocked", detail: environment.ok ? "The organization's container environment is active." : "This agent has no active sandbox environment." },
    ];
  }
  return { ready: r.ready, reasons, ...(checks ? { checks } : {}) };
}

const LIFECYCLE_BLOCK: Record<string, string> = {
  terminated: "This agent has been terminated.",
  paused: "This agent is paused; it can't execute until it is resumed.",
  pending_approval: "This agent is waiting for approval before it can run.",
  error: "This agent is in an error state.",
};

export function evaluateAgentReadiness(input: {
  agent: Pick<Agent, "status" | "adapterType"> & { errorReason?: string | null; readiness?: unknown; lifecycleState?: unknown; lifecycleError?: unknown };
  adapter: Signal;
  model: Signal;
  environment: Signal;
}): AgentReadiness {
  const backend = backendReadiness(input.agent.readiness);
  const source = backend ? "backend" : "derived";
  const checks: ReadinessCheck[] = backend?.checks ?? [
    { id: "adapter", label: "Runtime", ...input.adapter },
    { id: "model", label: "Model", ...input.model },
    { id: "environment", label: "Sandbox environment", ...input.environment },
  ];
  const lifecycle = LIFECYCLE_BLOCK[input.agent.status];

  // Preparing or verifying shows up as "paused", but nobody paused it and Resume is refused: say what it waits for.
  const setup = setupState(input.agent);
  if (setup) {
    const blockers = checks.filter((c) => c.state === "blocked").map((c) => c.detail);
    const failed = lifecycleError(input.agent);
    return { state: "blocked", summary: failed ? `${setupSummary(setup, blockers)} The engine reported: ${failed}` : setupSummary(setup, blockers), checks, source };
  }

  // A lifecycle stop says more than any readiness signal, and stays true even if the engine has not
  // learned about it yet. An agent error carries the engine's own reason.
  if (lifecycle) {
    const detail = input.agent.status === "error" && input.agent.errorReason ? input.agent.errorReason : lifecycle;
    return { state: "blocked", summary: detail, checks, source };
  }

  // The host service's full answer (with its three checks) is authoritative: it is computed from the
  // engine's live adapters, credentials and environments, which the browser cannot see in full. A bare
  // { ready } without those checks is treated conservatively below.
  if (backend?.checks) {
    return backend.ready
      ? { state: "ready", summary: "Ready to run.", checks, source }
      : { state: "blocked", summary: backend.reasons.join(" ") || "The engine reports that this agent is not ready.", checks, source };
  }

  const blocking = checks.filter((c) => c.state === "blocked");
  if (blocking.length > 0) {
    return { state: "blocked", summary: blocking.map((c) => c.detail).join(" "), checks, source };
  }
  if (backend && !backend.ready) {
    return { state: "blocked", summary: backend.reasons.join(" ") || "The engine reports that this agent is not ready.", checks, source };
  }
  if (backend?.ready) return { state: "ready", summary: "The engine reports that this agent is ready to run.", checks, source };

  const uncertain = checks.filter((c) => c.state === "unknown");
  if (uncertain.length > 0) {
    return { state: "unknown", summary: `Readiness couldn't be confirmed: ${uncertain.map((c) => c.detail).join(" ")}`, checks, source };
  }
  return { state: "ready", summary: "The runtime, a model and the sandbox environment are all ready.", checks, source };
}

/** Vault variable names each harness reads. An account sign-in lives in the same Vault, under its OAuth token name. */
const MODEL_ENV: Record<string, string[]> = {
  claude_local: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex_local: ["OPENAI_API_KEY"],
  grok_local: ["XAI_API_KEY"],
  gemini_local: ["GEMINI_API_KEY"],
};
/** Adapters whose account sign-in the engine can report per organization. */
const ACCOUNT_ADAPTERS = new Set(["claude_local", "codex_local", "grok_local"]);
/** Runtimes that do not call a model service. Their readiness is decided by the runtime check. */
const MODEL_FREE_ADAPTERS = new Set(["process", "http"]);

export function useAgentReadiness(companyId: string | null | undefined, agents: Agent[]): Map<string, AgentReadiness> {
  const backend = useBackendAgentReadiness(companyId);
  const containers = useAgentContainers();
  const adapters = useAdapters();
  const sandbox = useSandboxAdapters(companyId);
  const accounts = useQuery({ queryKey: ["connect", "org-ai", companyId], queryFn: () => connectApi.orgAi(companyId!), enabled: !!companyId, retry: 1 });
  const vault = useQuery({ queryKey: ["vault"], queryFn: vaultApi.list, retry: 1 });
  const environment = containers.data?.environments.find((e) => e.companyId === companyId) ?? null;
  const environmentId = environment?.ok ? environment.environmentId : null;
  const accountTypes = [...new Set(agents.map((a) => a.adapterType))].filter((t) => ACCOUNT_ADAPTERS.has(t));
  const signals = useQueries({
    queries: accountTypes.map((type) => ({
      queryKey: ["agent-auth", companyId, type, environmentId],
      queryFn: () => engine.agentAuth.signal(companyId!, type, environmentId ?? undefined),
      enabled: !!companyId && !!environmentId,
      retry: false,
    })),
  });
  const auth = new Map(accountTypes.map((type, i) => [type, signals[i]] as const));

  const adapterSignal = (agent: Agent): Signal => {
    if (adapters.isPending) return unknown("the runtime list is still loading.");
    if (adapters.error) return unknown("the runtime list couldn't be read.");
    const info = adapters.data?.find((a) => a.type === agent.adapterType);
    if (!info) return no(`The engine does not list a "${agent.adapterType}" runtime.`);
    const label = info.label || info.type;
    if (info.disabled) return no(`${label} is switched off.`);
    if (info.loaded === false) return no(`${label} isn't installed on this device.`);
    if (sandbox.isPending) return unknown(`whether ${label} can run in a container is still loading.`);
    if (sandbox.error) return unknown(`whether ${label} can run in a container couldn't be read.`);
    if (!sandbox.data?.has(agent.adapterType)) return no(`${label} can't run inside an agent container.`);
    return ok(`${label} is installed and can run in a container.`);
  };

  const environmentSignal = (): Signal => {
    if (containers.isPending) return unknown("the agent containers are still being checked.");
    if (containers.error) return unknown("the agent containers couldn't be read.");
    if (!containers.data) return unknown("the agent containers aren't known yet.");
    if (containers.data.state !== "ready") return no("Agent containers aren't set up on this device.");
    if (!environment) return no("This organization doesn't have a container environment yet.");
    if (!environment.ok) return no("This organization's container environment isn't healthy.");
    return ok("The organization's container environment is ready.");
  };

  const modelSignal = (agent: Agent): Signal => {
    const bound = !!(agent.runtimeConfig && typeof agent.runtimeConfig === "object" && (agent.runtimeConfig as { aiConnection?: unknown }).aiConnection);
    if (bound) return ok("Bound to a model connection in the engine.");
    const envNames = MODEL_ENV[agent.adapterType];
    const sharedKey = envNames && vault.data?.items.find((i) =>
      envNames.includes(i.name) && i.targets.some((t) => t.companyId === companyId && t.agentId === agent.id));
    if (sharedKey) return ok(`${sharedKey.name} is shared with this agent.`);
    const orgConnection = accounts.data?.connections.some((c) => c.status === "connected" || c.status === "active");
    if (orgConnection) return ok("The organization has a connected model account.");
    const signal = auth.get(agent.adapterType);
    if (signal?.data?.status === "authenticated") return ok("An account is signed in for this adapter in the organization.");
    if (MODEL_FREE_ADAPTERS.has(agent.adapterType)) return ok("This runtime doesn't call a model service.");

    // Only call it missing when every source that could prove otherwise has loaded. An unreadable or
    // uncheckable source stays "unknown" rather than becoming a made-up negative.
    if (accounts.isPending || vault.isPending) return unknown("the model connections are still loading.");
    if (accounts.error || vault.error) return unknown("the model connections couldn't be read.");
    if (envNames && environmentId && signal?.isPending) return unknown("the adapter sign-in is still being checked.");
    if (envNames && environmentId && signal?.error) return unknown("the adapter sign-in couldn't be checked.");
    return no("No model account or API key is visible for this agent.");
  };

  return new Map(agents.map((agent) => {
    // The host service's per-agent answer is the source of truth; a mapped agent may already carry it.
    const answer = backend.data?.agents.find((r) => r.agentId === agent.id) ?? (agent as { readiness?: unknown }).readiness;
    return [agent.id, evaluateAgentReadiness({
      agent: { ...agent, readiness: answer },
      adapter: adapterSignal(agent),
      model: modelSignal(agent),
      environment: environmentSignal(),
    })];
  }));
}
