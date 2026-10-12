import { useEffect, useState } from "react";
import { ListChecks, Loader2 } from "lucide-react";
import { ApiError, type TaskEntry } from "../../data/api.ts";
import { useEngine } from "../../data/store.tsx";
import type { Guest } from "../../data/types.ts";
import { Card, EmptyState } from "../../ui/primitives.tsx";
import { TaskTable } from "../Tasks.tsx";

/** What Proxmox has done to this one machine: starts, backups, snapshots, resizes, clones, and who asked. */
export function MachineTasks({ g }: { g: Guest }) {
  const engine = useEngine();
  const [tasks, setTasks] = useState<TaskEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    engine.backend.tasks(100, g.vmid).then((t) => alive && (setTasks(t), setError(null)), (e) => alive && setError(e instanceof ApiError ? e.message : "Couldn't read this machine's history"));
    const t = setTimeout(() => setTick((n) => n + 1), 5000);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [g.vmid, engine.backend, engine.contentVersion, tick]);
  return (
    <div className="fade-in">
      {error && <p role="alert" className="text-compact text-critical mb-3">{error}</p>}
      <Card className="overflow-x-auto">
        {tasks === null && !error ? (
          <div className="p-8 text-center text-ink-3 text-sm"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Reading history…</div>
        ) : !tasks?.length ? (
          <EmptyState icon={<ListChecks className="h-5 w-5" />} title={`Nothing yet for ${g.name}`} body="Starts, backups, snapshots and other changes to this machine show up here as Proxmox runs them." />
        ) : (
          <TaskTable tasks={tasks} />
        )}
      </Card>
    </div>
  );
}
