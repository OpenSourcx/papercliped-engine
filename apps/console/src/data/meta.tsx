import { CircleCheck, CircleDot, Circle, CircleDashed, OctagonAlert } from "lucide-react";
import type { TaskStatus } from "./types.ts";

export const TASK_LABEL: Record<TaskStatus, string> = { todo: "To do", in_progress: "In progress", in_review: "In review", done: "Done", blocked: "Blocked" };
export const TASK_ICON: Record<TaskStatus, React.ReactNode> = {
  todo: <Circle className="h-4 w-4 text-ink-3" />,
  in_progress: <CircleDot className="h-4 w-4 text-accent" />,
  in_review: <CircleDashed className="h-4 w-4 text-[#9474f0]" />,
  done: <CircleCheck className="h-4 w-4 text-good" />,
  blocked: <OctagonAlert className="h-4 w-4 text-critical" />,
};
