import { Link } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { useAgentContainers } from "../../data/engine/queries.ts";
import { settingsHref } from "../../modals/useModals.ts";

/**
 * A calm note on organization pages while agent containers aren't ready: agents run only in containers, so until an
 * administrator has set them up, waking an agent fails by design. Renders nothing in the demo, while loading, or when ready.
 */
export function AgentContainersBanner() {
  const q = useAgentContainers();
  const s = q.data;
  if (!s || s.state === "ready") return null;
  return (
    <div role="status" className="mx-auto max-w-6xl px-4 pt-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface-2 px-4 py-2.5 text-[13px]">
        <ShieldAlert className="h-4 w-4 text-warning shrink-0" />
        <span className="flex-1 min-w-[220px]">Agents can't run until agent containers are set up. They never run on the host.{s.canManage ? "" : " Ask a Proxmox administrator."}</span>
        {s.canManage && <Link to={settingsHref("agent-containers")} className="text-accent hover:underline">Set up agent containers</Link>}
      </div>
    </div>
  );
}

/** True when agents can run (or when we can't tell yet, so a slow check never blocks anyone). */
export function useAgentsCanRun(): boolean {
  const s = useAgentContainers().data;
  return !s || s.state === "ready";
}
