/**
 * The engine keeps an agent in a lifecycle (preparing, verifying, ready, ...) next to its status. While an agent is
 * being prepared or verified the engine reports its status as "paused", but Resume is refused (409 "Cannot resume an
 * agent in state verifying"): nothing was paused by a person, it is waiting for its model account and sandbox.
 */
export interface LifecycleFields { lifecycleState?: unknown; lifecycleError?: unknown; lifecycleHolds?: unknown }

const SETUP_STATES = new Set(["preparing", "verifying", "resuming"]);

/** The setup state an agent is stuck in, or null when it is in no setup state. */
export function setupState(agent: LifecycleFields): "preparing" | "verifying" | "resuming" | null {
  const s = agent.lifecycleState;
  return typeof s === "string" && SETUP_STATES.has(s) ? (s as "preparing" | "verifying" | "resuming") : null;
}

export function lifecycleError(agent: LifecycleFields): string | null {
  return typeof agent.lifecycleError === "string" && agent.lifecycleError.trim() ? agent.lifecycleError.trim() : null;
}

/** One sentence for a card or pill: why an agent in a setup state is not running. */
export function setupSummary(state: "preparing" | "verifying" | "resuming", blockers: string[]): string {
  const what = state === "preparing" ? "being prepared" : state === "verifying" ? "being verified" : "starting again";
  return blockers.length ? `This agent is ${what}, and is waiting on: ${blockers.join(" ")}` : `This agent is ${what}. It starts on its own when the engine finishes its checks.`;
}
