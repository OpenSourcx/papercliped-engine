import { Ban, Circle, CircleCheck, CircleDashed, CircleDot, Inbox, OctagonAlert } from "lucide-react";
import type { IssuePriority, IssueStatus } from "@papercliped-engine/engine-client";
import type { StatusKind } from "../../ui/primitives.tsx";

/** Words and icons for the engine's task (issue) and agent states. Icons always come with a label. */

export const ISSUE_LABEL: Record<IssueStatus, string> = { backlog: "Backlog", todo: "To do", in_progress: "In progress", in_review: "In review", blocked: "Blocked", done: "Done", cancelled: "Cancelled" };
export const ISSUE_ICON: Record<IssueStatus, React.ReactNode> = {
  backlog: <Inbox className="h-4 w-4 text-ink-3" />,
  todo: <Circle className="h-4 w-4 text-ink-3" />,
  in_progress: <CircleDot className="h-4 w-4 text-accent" />,
  in_review: <CircleDashed className="h-4 w-4 text-[#9474f0]" />,
  blocked: <OctagonAlert className="h-4 w-4 text-critical" />,
  done: <CircleCheck className="h-4 w-4 text-good" />,
  cancelled: <Ban className="h-4 w-4 text-ink-3" />,
};
export const isOpen = (s: string) => s !== "done" && s !== "cancelled";

export const PRIORITY_LABEL: Record<IssuePriority, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

export const ENGINE_AGENT_STATUS: Record<string, [StatusKind, string]> = {
  running: ["working", "Working"],
  active: ["idle", "Ready"],
  idle: ["idle", "Idle"],
  paused: ["paused", "Paused"],
  pending_approval: ["warning", "Waiting for approval"],
  error: ["critical", "Error"],
  terminated: ["off", "Terminated"],
};
export const agentStatusOf = (s: string): [StatusKind, string] => ENGINE_AGENT_STATUS[s] ?? ["idle", s];

export const APPROVAL_TYPE_LABEL: Record<string, string> = { hire_agent: "Hire an agent", approve_ceo_strategy: "Approve the CEO's strategy", budget_override_required: "Budget override", request_board_approval: "Board approval" };
