import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ListChecks, Loader2, RefreshCw } from "lucide-react";
import { ApiError, type TaskDetail, type TaskEntry } from "../data/api.ts";
import { parseUpid, taskLabel } from "../data/backend.ts";
import { useEngine } from "../data/store.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Button, Card, EmptyState, PageFrame, PageHeader, Status } from "../ui/primitives.tsx";

const duration = (t: TaskEntry) => {
  const s = (t.end ?? Math.floor(Date.now() / 1000)) - t.start;
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

/** Proxmox's task list: when, what, who, how long, and how it ended. Click a task for its log. */
export function TaskTable({ tasks }: { tasks: TaskEntry[] }) {
  const nav = useNavigate();
  return (
  <table className="w-full text-[13px] min-w-[720px]">
    <thead>
      <tr className="border-b border-line text-ink-3 text-left">
        <th className="font-normal px-4 h-10">Started</th>
        <th className="font-normal px-3">Task</th>
        <th className="font-normal px-3">User</th>
        <th className="font-normal px-3 text-right">Duration</th>
        <th className="font-normal px-3">Status</th>
      </tr>
    </thead>
    <tbody>
      {tasks.map((t) => (
        <tr key={t.upid} onClick={() => nav(`?modal=task&upid=${encodeURIComponent(t.upid)}`)} className="border-b border-line last:border-0 hover:bg-surface-2/60 cursor-pointer">
          <td className="px-4 py-2.5 whitespace-nowrap tabular-nums text-ink-2">{new Date(t.start * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "medium" })}</td>
          <td className="px-3 py-2.5"><span className="truncate block max-w-[360px]" title={taskLabel(t)}>{taskLabel(t)}</span></td>
          <td className="px-3 text-ink-2">{t.user}</td>
          <td className="px-3 text-right tabular-nums whitespace-nowrap">{duration(t)}</td>
          <td className="px-3">{t.status === null ? <Status kind="working" label="Running" /> : t.status === "OK" ? <Status kind="good" label="OK" /> : t.status.startsWith("WARNINGS") ? <Status kind="warning" label={t.status} /> : <Status kind="critical" label={t.status.length > 48 ? `${t.status.slice(0, 48)}…` : t.status} />}</td>
        </tr>
      ))}
    </tbody>
  </table>
  );
}

/** Proxmox's task log: everything the device has done recently, with the full log of each task. */
export function TasksPage() {
  const engine = useEngine();
  const nav = useNavigate();
  const [tasks, setTasks] = useState<TaskEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    engine.backend.tasks(100).then(
      (t) => alive && (setTasks(t), setError(null)),
      (e) => alive && setError(e instanceof ApiError ? e.message : "Couldn't read the task log"),
    );
    const t = setTimeout(() => setTick((n) => n + 1), 4000);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [engine.backend, engine.contentVersion, tick]);

  return (
    <PageFrame width="6xl">
      <PageHeader title="Tasks" subtitle="What this device has been doing: downloads, uploads, starts, backups. Open one for its log." actions={<Button onClick={() => setTick((n) => n + 1)}><RefreshCw className="h-4 w-4" />Refresh</Button>} />
      {error && <p role="alert" className="text-[13px] text-critical mb-3">{error}</p>}
      <Card className="overflow-x-auto">
        {tasks === null && !error ? (
          <div className="p-8 text-center text-ink-3 text-[14px]"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Reading the task log…</div>
        ) : !tasks?.length ? (
          <EmptyState icon={<ListChecks className="h-5 w-5" />} title="No tasks yet" body="Downloads, uploads and machine actions show up here as Proxmox runs them." />
        ) : (
          <TaskTable tasks={tasks} />
        )}
      </Card>
    </PageFrame>
  );
}

/** One task's log, following it while it runs. Opened with ?modal=task&upid=... */
export function TaskLogModal({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const upid = new URLSearchParams(window.location.search).get("upid") ?? "";
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLPreElement>(null);
  const parsed = parseUpid(upid);
  const title = parsed ? taskLabel(parsed) : "Task";

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      engine.backend.task(upid).then(
        (d) => {
          if (!alive) return;
          setDetail(d);
          if (d.status === "running") timer = setTimeout(load, 1500);
        },
        (e) => alive && setError(e instanceof ApiError ? e.message : "Couldn't read this task"),
      );
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [upid, engine.backend]);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [detail?.log.length]);

  return (
    <Modal size="lg" icon={<ListChecks className="h-5 w-5" />} title={title} subtitle={detail ? (detail.status === "running" ? "Running…" : detail.exitstatus === "OK" ? "Finished" : `Ended: ${detail.exitstatus ?? "unknown"}`) : "Loading…"} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {error ? (
        <p role="alert" className="text-[13px] text-critical">{error}</p>
      ) : (
        <pre ref={box} className="rounded-lg bg-black/40 border border-line p-3 text-[12px] leading-relaxed font-mono text-ink-2 max-h-[50vh] overflow-auto whitespace-pre-wrap break-all">{detail ? detail.log.join("\n") || "(no output)" : "…"}</pre>
      )}
      <p className="text-[11px] text-ink-3 font-mono mt-2 break-all">{upid}</p>
    </Modal>
  );
}
