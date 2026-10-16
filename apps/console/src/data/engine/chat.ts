import { useMutation, useQueryClient } from "@tanstack/react-query";
import { EngineError } from "@papercliped-engine/engine-client";
import { engine } from "./queries.ts";
import { qk } from "./keys.ts";

/** True when the engine answered that Agent chat is switched off (an experimental setting an instance admin turns on). */
export function chatDisabled(error: unknown): boolean {
  return error instanceof EngineError && error.status === 404 && /disabled/i.test(error.message);
}

/** Sends one chat message and refreshes the thread, the chat list and the activity it causes. */
export function useSendChat(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ issueId, body }: { issueId: string; body: string }) => engine.chat.send(issueId, body),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: qk.anyComments(companyId) }), qc.invalidateQueries({ queryKey: qk.chats(companyId) }), qc.invalidateQueries({ queryKey: qk.activity(companyId) })]),
  });
}

/** Why a chat thread cannot get an answer right now, in words for the person, and what they can do about it. */
export interface ChatBlock {
  code: "containers" | "error" | "paused" | "pending" | "terminated" | "run-failed" | "no-sandbox";
  /** One calm sentence: what is wrong. */
  reason: string;
  /** One sentence: what to do. */
  todo: string;
  /** Where the fix lives, when it is a screen of the console. */
  fix?: "agent-containers" | "agent";
}

export interface ChatBlockInput {
  agent: { name: string; status: string };
  /** The agent's newest run, when the engine returned one. */
  run?: { status: string; error?: string | null; errorCode?: string | null; createdAt?: string | Date | null } | null;
  /** When the conversation started; a run that failed before it is not about this thread. */
  conversationStartedAt?: string | Date | null;
  /** Whether agent containers are ready; undefined while unknown, so a slow check never blocks anyone. */
  containersReady?: boolean;
  canManageContainers?: boolean;
}

const SANDBOX = /sandbox|local execution|container|environment/i;

/** True when the run's own error says no sandbox (agent container) was available, which the engine's managed-sandbox-only policy enforces. */
export function noSandboxError(run: { error?: string | null; errorCode?: string | null } | null | undefined): boolean {
  return !!run && SANDBOX.test(`${run.error ?? ""} ${run.errorCode ?? ""}`);
}

/** Decides whether the agent can answer this thread. Returns null when it can, so the "writing" indicator is honest. */
export function chatBlock(i: ChatBlockInput): ChatBlock | null {
  const n = i.agent.name;
  const admin = i.canManageContainers;
  const containers = (code: ChatBlock["code"], reason: string): ChatBlock => ({
    code,
    reason,
    todo: admin ? "Open Agent containers to set them up, then try again." : "Ask a Proxmox administrator to set up agent containers, then try again.",
    fix: admin ? "agent-containers" : undefined,
  });
  if (i.agent.status === "terminated") return { code: "terminated", reason: `${n} was terminated.`, todo: "Terminated agents can't be brought back. Create a new agent to chat with." };
  if (i.agent.status === "paused") return { code: "paused", reason: `${n} is paused, so it won't reply.`, todo: "Resume it from its page, then try again.", fix: "agent" };
  if (i.agent.status === "pending_approval") return { code: "pending", reason: `${n} is waiting for approval to start.`, todo: "Approve it under Decisions, then try again." };
  if (i.containersReady === false) return containers("containers", `${n} can't run: no agent container is set up yet.`);
  if (i.agent.status === "error") {
    if (noSandboxError(i.run)) return containers("no-sandbox", `${n} can't run: no agent container is set up yet.`);
    return { code: "error", reason: `${n} stopped after an error${i.run?.error ? `: ${String(i.run.error).slice(0, 160)}` : "."}`, todo: "Open the agent to see the run and clear the error, then try again.", fix: "agent" };
  }
  const run = i.run;
  if (run && run.status === "failed") {
    const since = i.conversationStartedAt ? new Date(i.conversationStartedAt).getTime() : 0;
    const at = run.createdAt ? new Date(run.createdAt).getTime() : Infinity;
    if (at >= since) {
      if (noSandboxError(run)) return containers("no-sandbox", `${n} can't run: no agent container is set up yet.`);
      return { code: "run-failed", reason: `${n}'s last run failed${run.error ? `: ${String(run.error).slice(0, 160)}` : "."}`, todo: "Open the agent to read the run, fix what it says, then try again.", fix: "agent" };
    }
  }
  return null;
}
