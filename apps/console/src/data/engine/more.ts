import { useMutation, useQueries, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { AgentPermissionsBody, BudgetPolicyBody, CreateSecretBody, RoutineBody, RoutineTriggerBody } from "@papercliped-engine/engine-client";
import { engine, useCompanyQuery, useEngineReady } from "./queries.ts";
import { qk } from "./keys.ts";

/**
 * Hooks for the organization screens that go beyond tasks and agents: routines, the inbox, chat, skills, artifacts,
 * workspaces, budgets, agent settings and search. Same rules as queries.ts: live mode only, one cache key family per
 * organization, and writes refresh what they touch.
 */

type Id = string | null | undefined;
const k = (id: Id) => id ?? "";

// ---- Routines

export const useRoutines = (companyId: Id) => useCompanyQuery(companyId, qk.routines(k(companyId)), (id) => engine.routines.list(id));
export const useRoutine = (companyId: Id, routineId: string) => useCompanyQuery(companyId, qk.routine(k(companyId), routineId), () => engine.routines.get(routineId));
export const useRoutineRuns = (companyId: Id, routineId: string) => useCompanyQuery(companyId, qk.routineRuns(k(companyId), routineId), () => engine.routines.runs(routineId, 25));
export const useRoutineRevisions = (companyId: Id, routineId: string) => useCompanyQuery(companyId, qk.routineRevisions(k(companyId), routineId), () => engine.routines.revisions(routineId), { poll: false });

/** Runs a write, then refreshes every key the caller names. */
function useWrite<V, R>(fn: (v: V) => Promise<R>, keys: QueryKey[]) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey }))) });
}

export function useRoutineWrites(companyId: string) {
  const keys = [qk.routines(companyId), qk.anyRoutine(companyId), qk.issues(companyId)];
  const create = useWrite((b: RoutineBody) => engine.routines.create(companyId, b), keys);
  const update = useWrite(({ id, body }: { id: string; body: RoutineBody }) => engine.routines.update(id, body), [...keys, qk.routineRevisions(companyId, "")]);
  const run = useWrite((id: string) => engine.routines.run(id), [...keys, qk.dashboard(companyId)]);
  const addTrigger = useWrite(({ id, body }: { id: string; body: RoutineTriggerBody }) => engine.routines.addTrigger(id, body), keys);
  const updateTrigger = useWrite(({ id, body }: { id: string; body: { enabled?: boolean; label?: string | null; cronExpression?: string | null; timezone?: string | null } }) => engine.routines.updateTrigger(id, body), keys);
  const removeTrigger = useWrite((id: string) => engine.routines.removeTrigger(id), keys);
  const rotate = useWrite((id: string) => engine.routines.rotateSecret(id), keys);
  const restore = useWrite(({ id, revisionId }: { id: string; revisionId: string }) => engine.routines.restore(id, revisionId), keys);
  return { create, update, run, addTrigger, updateTrigger, removeTrigger, rotate, restore };
}

// ---- Inbox and decisions

export const useAttention = (companyId: Id) => useCompanyQuery(companyId, qk.attention(k(companyId)), (id) => engine.inbox.attention(id, { limit: 100 }));
export const useBadges = (companyId: Id) => useCompanyQuery(companyId, qk.badges(k(companyId)), (id) => engine.inbox.badges(id));
export const useMine = (companyId: Id) => useCompanyQuery(companyId, qk.mine(k(companyId)), (id) => engine.inbox.touchedByMe(id, 50));

export function useInboxWrites(companyId: string) {
  const keys = [qk.attention(companyId), qk.badges(companyId), qk.mine(companyId), qk.approvals(companyId), qk.anyIssue(companyId), qk.anyComments(companyId), qk.dashboard(companyId), qk.activity(companyId), qk.agents(companyId)];
  return {
    dismiss: useWrite((itemKey: string) => engine.inbox.dismiss(companyId, itemKey), keys),
    markRead: useWrite((issueId: string) => engine.inbox.markRead(issueId), keys),
    archive: useWrite((issueId: string) => engine.inbox.archive(issueId), keys),
    requestRevision: useWrite(({ id, note }: { id: string; note?: string }) => engine.inbox.requestRevision(id, note), keys),
    respond: useWrite(({ issueId, interactionId, body }: { issueId: string; interactionId: string; body: Record<string, unknown> }) => engine.inbox.respond(issueId, interactionId, body), keys),
    accept: useWrite(({ issueId, interactionId }: { issueId: string; interactionId: string }) => engine.inbox.accept(issueId, interactionId), keys),
    reject: useWrite(({ issueId, interactionId }: { issueId: string; interactionId: string }) => engine.inbox.reject(issueId, interactionId), keys),
  };
}

export const useIssueInteractions = (companyId: Id, issueId: string | null) =>
  useCompanyQuery(companyId, ["engine", "co", k(companyId), "interactions", issueId ?? ""], () => engine.inbox.interactions(issueId!)) as ReturnType<typeof useQuery<Awaited<ReturnType<typeof engine.inbox.interactions>>>>;

// ---- Chat

export function useChatSettings() {
  const ready = useEngineReady();
  return useQuery({ queryKey: qk.chatSettings, queryFn: engine.chat.settings, enabled: ready, staleTime: 30_000, retry: false });
}
export const useChats = (companyId: Id, enabled: boolean) =>
  useCompanyQuery(enabled ? companyId : null, qk.chats(k(companyId)), (id) => engine.chat.list(id), { retry: false });

/** The saved agent chats of several organizations at once (PinView's list), sharing the cache with useChats. */
export function useChatsOf(companyIds: string[]) {
  const ready = useEngineReady();
  return useQueries({ queries: companyIds.map((id) => ({ queryKey: qk.chats(id), queryFn: () => engine.chat.list(id), enabled: ready, retry: false, refetchInterval: 30_000 })) });
}

export function useChatWrites(companyId: string) {
  const qc = useQueryClient();
  return {
    enable: useMutation({ mutationFn: () => engine.chat.enable(), onSuccess: () => qc.invalidateQueries({ queryKey: qk.chatSettings }) }),
    open: useMutation({ mutationFn: (agentRef: string) => engine.chat.open(companyId, agentRef), onSuccess: () => qc.invalidateQueries({ queryKey: qk.chats(companyId) }) }),
  };
}

// ---- Skills

export const useSkills = (companyId: Id) => useCompanyQuery(companyId, qk.skills(k(companyId)), (id) => engine.skills.list(id));
export const useSkill = (companyId: Id, skillId: string | null) => useCompanyQuery(skillId ? companyId : null, qk.skill(k(companyId), skillId ?? ""), (id) => engine.skills.get(id, skillId!), { poll: false });
export const useSkillFile = (companyId: Id, skillId: string | null, path: string | null) =>
  useCompanyQuery(skillId && path ? companyId : null, qk.skillFile(k(companyId), skillId ?? "", path ?? ""), (id) => engine.skills.file(id, skillId!, path!), { poll: false });
export const useSkillSources = (companyId: Id) => useCompanyQuery(companyId, qk.skillSources(k(companyId)), (id) => engine.skills.sources(id), { poll: false });
export const useAgentSkills = (companyId: Id, agentId: string) => useCompanyQuery(companyId, qk.agentSkills(k(companyId), agentId), () => engine.skills.forAgent(agentId), { poll: false });
export function useSkillCatalog(enabled: boolean) {
  const ready = useEngineReady();
  return useQuery({ queryKey: qk.skillCatalog, queryFn: engine.skills.catalog, enabled: ready && enabled, staleTime: 5 * 60_000, retry: false });
}
export function useSkillWrites(companyId: string) {
  const keys = [qk.skills(companyId), qk.skillSources(companyId)];
  return {
    syncAgent: useWrite(({ agentId, mode, desired }: { agentId: string; mode: "add" | "remove" | "replace"; desired: string[] }) => engine.skills.syncAgent(agentId, mode, desired), [qk.agentSkills(companyId, ""), ["engine", "co", companyId, "agent-skills"], ["engine", "co", companyId, "skill"], ...keys]),
    installCatalog: useWrite((catalogSkillId: string) => engine.skills.installCatalog(companyId, { catalogSkillId }), keys),
    refreshSource: useWrite((sourceId: string) => engine.skills.refreshSource(companyId, sourceId), keys),
  };
}

// ---- Artifacts and workspaces

export const useArtifacts = (companyId: Id, kind?: string, q?: string) =>
  useCompanyQuery(companyId, [...qk.artifacts(k(companyId)), kind ?? "", q ?? ""], (id) => engine.artifacts.list(id, { kind: kind && kind !== "all" ? kind : undefined, q: q || undefined, limit: 60 }));
export const useWorkspaces = (companyId: Id) => useCompanyQuery(companyId, qk.workspaces(k(companyId)), (id) => engine.workspaces.list(id));
export const useWorkspace = (companyId: Id, wsId: string) => useCompanyQuery(companyId, qk.workspace(k(companyId), wsId), () => engine.workspaces.get(wsId));

// ---- Settings, budgets, costs, secrets

export function useOrgSettingsWrites(companyId: string) {
  const qc = useQueryClient();
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: qk.orgs }), qc.invalidateQueries({ queryKey: qk.detail(companyId) }), qc.invalidateQueries({ queryKey: qk.dashboard(companyId) })]);
  return {
    update: useMutation({ mutationFn: (body: { name?: string; description?: string | null; budgetMonthlyCents?: number; requireBoardApprovalForNewAgents?: boolean }) => engine.companies.update(companyId, body), onSuccess: refresh }),
    budget: useMutation({ mutationFn: (cents: number) => engine.settings.budget(companyId, cents), onSuccess: async () => { await refresh(); await Promise.all([qc.invalidateQueries({ queryKey: qk.costs(companyId) }), qc.invalidateQueries({ queryKey: qk.budgets(companyId) })]); } }),
    archive: useMutation({ mutationFn: () => engine.settings.archive(companyId), onSuccess: refresh }),
    unarchive: useMutation({ mutationFn: () => engine.companies.update(companyId, { status: "active" }), onSuccess: refresh }),
  };
}
export const useBudgets = (companyId: Id) => useCompanyQuery(companyId, qk.budgets(k(companyId)), (id) => engine.budgets.overview(id));
export function useBudgetWrites(companyId: string) {
  const keys = [qk.budgets(companyId), qk.costs(companyId), qk.agents(companyId), qk.detail(companyId), qk.orgs, qk.dashboard(companyId)];
  return {
    policy: useWrite((b: BudgetPolicyBody) => engine.budgets.upsertPolicy(companyId, b), keys),
    resolve: useWrite(({ incidentId, action, amount }: { incidentId: string; action: "keep_paused" | "raise_budget_and_resume"; amount?: number }) => engine.budgets.resolveIncident(companyId, incidentId, { action, amount }), keys),
    agent: useWrite(({ agentId, cents }: { agentId: string; cents: number }) => engine.budgets.setAgent(agentId, cents), keys),
  };
}
export const useCostBreakdown = (companyId: Id) =>
  useCompanyQuery(companyId, qk.costBreakdown(k(companyId)), async (id) => {
    const [byProvider, byProject, byAgentModel] = await Promise.all([engine.costBreakdown.byProvider(id), engine.costBreakdown.byProject(id), engine.costBreakdown.byAgentModel(id)]);
    return { byProvider, byProject, byAgentModel };
  });
export const useSecrets = (companyId: Id) => useCompanyQuery(companyId, qk.secrets(k(companyId)), (id) => engine.settings.secrets(id), { poll: false });
export function useCreateSecret(companyId: string) {
  return useWrite((b: CreateSecretBody) => engine.settings.createSecret(companyId, b), [qk.secrets(companyId)]);
}

// ---- Agent settings

export const useInstructionsFile = (companyId: Id, agentId: string, path: string | null) => useCompanyQuery(path ? companyId : null, [...qk.instructions(k(companyId), agentId), "file", path ?? ""], () => engine.agentConfig.file(agentId, path!), { poll: false });
export const useInstructionsHistory = (companyId: Id, agentId: string, path: string | null) => useCompanyQuery(path ? companyId : null, [...qk.instructions(k(companyId), agentId), "history", path ?? ""], () => engine.agentConfig.history(agentId, path!), { poll: false });
export const useInstructions = (companyId: Id, agentId: string) => useCompanyQuery(companyId, qk.instructions(k(companyId), agentId), () => engine.agentConfig.bundle(agentId), { poll: false });
export function useAgentSettingsWrites(companyId: string, agentId: string) {
  const keys = [qk.agent(companyId, agentId), qk.agents(companyId), qk.anyInstructions(companyId), qk.dashboard(companyId)];
  return {
    update: useWrite((body: Record<string, unknown>) => engine.agents.update(agentId, body as never), keys),
    permissions: useWrite((b: AgentPermissionsBody) => engine.agentConfig.permissions(agentId, b), keys),
    saveFile: useWrite(({ path, content, base }: { path: string; content: string; base: string | null }) => engine.agentConfig.saveFile(agentId, path, content, base), keys),
    setMode: useWrite((mode: "managed" | "external") => engine.agentConfig.setMode(agentId, mode), keys),
    restore: useWrite(({ path, revisionId }: { path: string; revisionId: string }) => engine.agentConfig.restore(agentId, path, revisionId), keys),
  };
}

// ---- Tasks, beyond the basics

export const useLabels = (companyId: Id) => useCompanyQuery(companyId, qk.labels(k(companyId)), (id) => engine.tasks.labels(id), { poll: false });
export const useTaskExtras = (companyId: Id, ref: string, issueId: string | null) =>
  useCompanyQuery(issueId ? companyId : null, qk.taskExtras(k(companyId), ref), async (id) => {
    const [children, attachments, workProducts, documents, approvals] = await Promise.all([
      engine.tasks.children(id, issueId!).catch(() => []),
      engine.artifacts.attachments(issueId!).catch(() => []),
      engine.artifacts.workProducts(issueId!).catch(() => []),
      engine.tasks.documents(issueId!).catch(() => []),
      engine.tasks.approvals(issueId!).catch(() => []),
    ]);
    return { children, attachments, workProducts, documents, approvals };
  });

// ---- Search

export function useSearch(companyId: Id, q: string) {
  const ready = useEngineReady();
  const needle = q.trim();
  return useQuery({ queryKey: qk.search(k(companyId), needle), queryFn: () => engine.search(companyId!, { q: needle, limit: 8 }), enabled: ready && !!companyId && needle.length >= 2, staleTime: 15_000, retry: false });
}

/** The inbox count of several organizations at once (for the rail): what needs the person, from the engine's sidebar badges. */
export function useInboxCounts(companyIds: string[]): Map<string, number> {
  const ready = useEngineReady();
  const results = useQueries({ queries: companyIds.map((id) => ({ queryKey: qk.badges(id), queryFn: () => engine.inbox.badges(id), enabled: ready, refetchInterval: 60_000, retry: false })) });
  const out = new Map<string, number>();
  results.forEach((r, i) => { const b = r.data; if (b) out.set(companyIds[i], b.inbox); });
  return out;
}
