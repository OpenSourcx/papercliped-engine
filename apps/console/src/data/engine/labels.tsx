import { Ban, Circle, CircleCheck, CircleDashed, CircleDot, Inbox, OctagonAlert } from "lucide-react";
import type { HeartbeatRun, IssuePriority, IssueStatus } from "@papercliped-engine/engine-client";
import type { StatusKind } from "../../ui/primitives.tsx";

/** Words and icons for the engine's task (issue) and agent states. Icons always come with a label. */

export const ISSUE_LABEL: Record<IssueStatus, string> = { backlog: "Backlog", todo: "To do", in_progress: "In progress", in_review: "In review", blocked: "Blocked", done: "Done", cancelled: "Cancelled" };
export const ISSUE_ICON: Record<IssueStatus, React.ReactNode> = {
  backlog: <Inbox className="h-4 w-4 text-ink-3" />,
  todo: <Circle className="h-4 w-4 text-ink-3" />,
  in_progress: <CircleDot className="h-4 w-4 text-accent" />,
  in_review: <CircleDashed className="h-4 w-4 text-review" />,
  blocked: <OctagonAlert className="h-4 w-4 text-critical" />,
  done: <CircleCheck className="h-4 w-4 text-good" />,
  cancelled: <Ban className="h-4 w-4 text-ink-3" />,
};
export const isOpen = (s: string) => s !== "done" && s !== "cancelled";

export const PRIORITY_LABEL: Record<IssuePriority, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

export const ENGINE_AGENT_STATUS: Record<string, [StatusKind, string]> = {
  running: ["working", "Working"],
  // "active" is the engine's lifecycle word, not a promise that the runtime, model and container are ready.
  active: ["idle", "Active"],
  idle: ["idle", "Idle"],
  paused: ["paused", "Paused"],
  pending_approval: ["warning", "Waiting for approval"],
  error: ["critical", "Error"],
  terminated: ["off", "Terminated"],
};
/** A person's pause and the engine's own setup checks both read "paused"; the lifecycle tells them apart. */
const SETUP_LABEL: Record<string, string> = { preparing: "Preparing", verifying: "Verifying", resuming: "Starting" };
export const agentStatusOf = (s: string, lifecycleState?: unknown): [StatusKind, string] => {
  const setup = typeof lifecycleState === "string" ? SETUP_LABEL[lifecycleState] : undefined;
  return setup ? ["warning", setup] : ENGINE_AGENT_STATUS[s] ?? ["idle", s];
};

/**
 * An agent's status answers whether it is available; a heartbeat run answers
 * whether its most recent piece of work is still running or how it ended.
 * Keep the two separate so a healthy agent returning to Idle never looks as
 * though a successful task vanished.
 */
export const ENGINE_RUN_STATUS: Record<string, [StatusKind, string]> = {
  queued: ["working", "Queued"],
  running: ["working", "Working"],
  succeeded: ["good", "Finished"],
  failed: ["critical", "Failed"],
  cancelled: ["off", "Cancelled"],
  timed_out: ["critical", "Timed out"],
};
export const runStatusOf = (s: string): [StatusKind, string] => ENGINE_RUN_STATUS[s] ?? ["idle", s.replace(/_/g, " ")];
export const latestRunStatusOf = (run: Pick<HeartbeatRun, "status"> | null | undefined): [StatusKind, string] | null => run ? runStatusOf(run.status) : null;

export const APPROVAL_TYPE_LABEL: Record<string, string> = { hire_agent: "Hire an agent", approve_ceo_strategy: "Approve the CEO's strategy", budget_override_required: "Budget override", request_board_approval: "Board approval" };
