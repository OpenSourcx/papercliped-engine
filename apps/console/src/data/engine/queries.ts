import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { createEngineClient, EngineError, type CreateAgentBody, type CreateGoalBody, type CreateIssueBody, type CreateProjectBody, type UpdateIssueBody } from "@papercliped-engine/engine-client";
import { useSession } from "../../auth/session.tsx";
import { usePollInterval } from "./events.ts";
import { host, HostError, type EngineStatus, type ResourceGroupSize } from "./host.ts";
import { qk } from "./keys.ts";

/**
 * Hooks for the engine's data, live mode only. Each returns react-query's result (data, isPending, error, refetch);
 * writes refresh what they change. Nothing here runs in the demo.
 */

export const engine = createEngineClient();

/** A plain sentence for any failure, for showing on screen. */
export function errorText(e: unknown): string {
  if (e instanceof EngineError || e instanceof HostError) {
    if (e.status === 0) return e.message;
    if (e.status === 401) return "Your session ended. Sign in again.";
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

export type EngineGate =
  | { state: "demo" }
  | { state: "checking" }
  | { state: "ready"; status: EngineStatus }
  | { state: "not_installed" | "unreachable" | "starting" | "unknown"; status: EngineStatus | null; message: string };

/** Whether the engine can be used right now, asked of the host service and re-checked every 30 seconds. */
export function useEngineStatus(): EngineGate {
  const live = useSession().session.mode === "live";
  const q = useQuery({ queryKey: qk.status, queryFn: host.engineStatus, enabled: live, refetchInterval: (query) => (query.state.data?.ready ? 60_000 : 10_000), retry: 1 });
  if (!live) return { state: "demo" };
  if (q.isPending) return { state: "checking" };
  if (q.error || !q.data) return { state: "unknown", status: null, message: errorText(q.error) };
  const s = q.data;
  if (s.ready) return { state: "ready", status: s };
  if (!s.installed) return { state: "not_installed", status: s, message: s.error ?? "The engine isn't installed on this device." };
  if (!s.reachable) return { state: "unreachable", status: s, message: s.error ?? "The engine is installed but isn't answering." };
  return { state: "starting", status: s, message: s.error ?? (s.bootstrap === "pending" ? "The engine is still being set up." : "The engine is starting.") };
}

/** True when live and the engine is ready: the condition every engine query waits for. */
export function useEngineReady(): boolean {
  return useEngineStatus().state === "ready";
}

export function useMe() {
  const ready = useEngineReady();
  return useQuery({ queryKey: qk.me, queryFn: engine.me, enabled: ready, staleTime: 5 * 60_000 });
}

export function useOrgs() {
  const ready = useEngineReady();
  return useQuery({ queryKey: qk.orgs, queryFn: engine.companies.list, enabled: ready, refetchInterval: 60_000 });
}

/** The agents of several organizations at once (for the rail and Home), sharing the cache with useAgents. */
export function useAgentsOf(companyIds: string[]) {
  const ready = useEngineReady();
  return useQueries({ queries: companyIds.map((id) => ({ queryKey: qk.agents(id), queryFn: () => engine.agents.list(id), enabled: ready, refetchInterval: 30_000 })) });
}

export function useResourceGroupsOf(companyIds: string[]) {
  const ready = useEngineReady();
  return useQueries({ queries: companyIds.map((id) => ({ queryKey: qk.resourceGroup(id), queryFn: () => host.resourceGroups.get(id), enabled: ready, retry: false, staleTime: 60_000 })) });
}

function useCompanyQuery<T>(companyId: string | null | undefined, key: readonly unknown[], fn: (id: string) => Promise<T>, opts: { poll?: boolean } = {}) {
  const ready = useEngineReady();
  const interval = usePollInterval(companyId);
  return useQuery({ queryKey: key, queryFn: () => fn(companyId!), enabled: ready && !!companyId, refetchInterval: opts.poll === false ? false : interval });
}

export const useOrg = (companyId: string | null | undefined) => useCompanyQuery(companyId, qk.detail(companyId ?? ""), (id) => engine.companies.get(id));
export const useDashboard = (companyId: string | null | undefined) => useCompanyQuery(companyId, qk.dashboard(companyId ?? ""), (id) => engine.companies.dashboard(id));
export const useAgents = (companyId: string | null | undefined) => useCompanyQuery(companyId, qk.agents(companyId ?? ""), (id) => engine.agents.list(id));
export const useAgent = (companyId: string | null | undefined, agentId: string) => useCompanyQuery(companyId, qk.agent(companyId ?? "", agentId), () => engine.agents.get(agentId));
export const useRuns = (companyId: string | null | undefined, agentId?: string) => useCompanyQuery(companyId, qk.runs(companyId ?? "", agentId), (id) => engine.agents.runs(id, agentId, 10));
export const useIssues = (companyId: string | null | undefined) => useCompanyQuery(companyId, qk.issues(companyId ?? ""), (id) => engine.issues.list(id));
export const useIssue = (companyId: string | null | undefined, ref: string) => useCompanyQuery(companyId, qk.issue(companyId ?? "", ref), () => engine.issues.get(ref));
export const useComments = (companyId: string | null | undefined, ref: string) => useCompanyQuery(companyId, qk.comments(companyId ?? "", ref), () => engine.issues.comments(ref));
export const useGoals = (companyId: string | null | undefined) => useCompanyQuery(companyId, qk.goals(companyId ?? ""), (id) => engine.goals.list(id));
export const useProjects = (companyId: string | null | undefined) => useCompanyQuery(companyId, qk.projects(companyId ?? ""), (id) => engine.projects.list(id));
export const useApprovals = (companyId: string | null | undefined) => useCompanyQuery(companyId, qk.approvals(companyId ?? ""), (id) => engine.approvals.list(id));
export const useCosts = (companyId: string | null | undefined) =>
  useCompanyQuery(companyId, qk.costs(companyId ?? ""), async (id) => {
    const [summary, byAgent] = await Promise.all([engine.costs.summary(id), engine.costs.byAgent(id)]);
    return { summary, byAgent };
  });
export const useActivity = (companyId: string | null | undefined) => useCompanyQuery(companyId, qk.activity(companyId ?? ""), (id) => engine.activity(id, 50));
export const useMembers = (companyId: string | null | undefined) => useCompanyQuery(companyId, qk.members(companyId ?? ""), (id) => engine.companies.members(id), { poll: false });
export const useResourceGroup = (companyId: string | null | undefined) => useCompanyQuery(companyId, qk.resourceGroup(companyId ?? ""), (id) => host.resourceGroups.get(id), { poll: false });

export function useAdapters() {
  const ready = useEngineReady();
  return useQuery({ queryKey: qk.adapters, queryFn: engine.adapters, enabled: ready, staleTime: 5 * 60_000 });
}

export function useAdapterModels(companyId: string | null | undefined, type: string | null) {
  const ready = useEngineReady();
  return useQuery({ queryKey: qk.models(companyId ?? "", type ?? ""), queryFn: () => engine.adapterModels(companyId!, type!), enabled: ready && !!companyId && !!type, staleTime: 5 * 60_000, retry: false });
}

// Writes. Each refreshes what it changed; the live socket refreshes the rest.

export interface CreateOrgResult {
  companyId: string;
  slugSource: { id: string; issuePrefix: string };
  /** Set when the organization was created but its resource group couldn't be. */
  resourceGroupError: string | null;
}

/** Creates the organization in the engine, then asks the host service for its resource group. The second step can fail on its own. */
export async function createOrganization(input: { name: string; description?: string | null; size: ResourceGroupSize }): Promise<CreateOrgResult> {
  const company = await engine.companies.create({ name: input.name.trim(), description: input.description || null });
  let resourceGroupError: string | null = null;
  try {
    await host.resourceGroups.put(company.id, input.size);
  } catch (e) {
    resourceGroupError = errorText(e);
  }
  return { companyId: company.id, slugSource: { id: company.id, issuePrefix: company.issuePrefix }, resourceGroupError };
}

export function useCreateOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createOrganization,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.orgs });
      void qc.invalidateQueries({ queryKey: qk.me });
      void qc.invalidateQueries({ queryKey: qk.resourceGroup(r.companyId) });
    },
  });
}

export function useSetResourceGroup(companyId: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (size: ResourceGroupSize) => host.resourceGroups.put(companyId, size), onSettled: () => qc.invalidateQueries({ queryKey: qk.resourceGroup(companyId) }) });
}

export function useCreateIssue(companyId: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: CreateIssueBody) => engine.issues.create(companyId, body), onSuccess: () => qc.invalidateQueries({ queryKey: qk.company(companyId) }) });
}

export function useUpdateIssue(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateIssueBody }) => engine.issues.update(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.issues(companyId) });
      void qc.invalidateQueries({ queryKey: qk.anyIssue(companyId) });
      void qc.invalidateQueries({ queryKey: qk.anyComments(companyId) });
      void qc.invalidateQueries({ queryKey: qk.dashboard(companyId) });
      void qc.invalidateQueries({ queryKey: qk.activity(companyId) });
    },
  });
}

export function useAddComment(companyId: string, ref: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: string) => engine.issues.comment(ref, body), onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.comments(companyId, ref) }); void qc.invalidateQueries({ queryKey: qk.activity(companyId) }); } });
}

export function useCreateAgent(companyId: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: CreateAgentBody) => engine.agents.create(companyId, body), onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.agents(companyId) }); void qc.invalidateQueries({ queryKey: qk.dashboard(companyId) }); void qc.invalidateQueries({ queryKey: qk.approvals(companyId) }); void qc.invalidateQueries({ queryKey: qk.activity(companyId) }); } });
}

export function useAgentAction(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "pause" | "resume" | "wakeup" }) => (action === "wakeup" ? engine.agents.wakeup(id) : action === "pause" ? engine.agents.pause(id) : engine.agents.resume(id)),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: qk.agents(companyId) });
      void qc.invalidateQueries({ queryKey: qk.agent(companyId, v.id) });
      void qc.invalidateQueries({ queryKey: qk.runs(companyId) });
      void qc.invalidateQueries({ queryKey: qk.dashboard(companyId) });
    },
  });
}

export function useCreateGoal(companyId: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: CreateGoalBody) => engine.goals.create(companyId, body), onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.goals(companyId) }); void qc.invalidateQueries({ queryKey: qk.activity(companyId) }); } });
}

export function useCreateProject(companyId: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: CreateProjectBody) => engine.projects.create(companyId, body), onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.projects(companyId) }); void qc.invalidateQueries({ queryKey: qk.activity(companyId) }); } });
}

export function useDecide(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, approve, note }: { id: string; approve: boolean; note?: string }) => (approve ? engine.approvals.approve(id, note) : engine.approvals.reject(id, note)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.approvals(companyId) });
      void qc.invalidateQueries({ queryKey: qk.dashboard(companyId) });
      void qc.invalidateQueries({ queryKey: qk.agents(companyId) });
      void qc.invalidateQueries({ queryKey: qk.activity(companyId) });
    },
  });
}

export function useConnectors() {
  const live = useSession().session.mode === "live";
  return useQuery({ queryKey: qk.connectors, queryFn: host.connectors.list, enabled: live });
}

export function useConnectorAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: { id: string; kind: "set"; apiKey: string } | { id: string; kind: "test" | "remove" }) => {
      if (a.kind === "set") return host.connectors.setKey(a.id, a.apiKey);
      if (a.kind === "test") return host.connectors.test(a.id);
      return host.connectors.remove(a.id);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.connectors }),
  });
}
