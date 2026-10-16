import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, Monitor, Pause, Play, Power as PowerIcon, Send } from "lucide-react";
import { dcApi, type BulkAction, type ResourceRow } from "../../data/engine/dcApi.ts";
import { Button, Card, EmptyState, Field, Input, Notice, PageFrame, PageHeader, SectionTitle, Select, Status, Toggle } from "../../ui/primitives.tsx";
import { Async, LiveOnly, NodeSwitcher, TasksLink, TypedConfirm, useNodeName, useNodes, useTaskRunner } from "./common.tsx";
import { Td } from "./dc.tsx";

type Pending = { action: BulkAction; target?: string } | null;

const TITLE: Record<BulkAction, string> = { startall: "Start machines", stopall: "Shut down machines", suspendall: "Suspend machines", migrateall: "Move machines" };

function BulkBody() {
  const { node, name } = useNodeName();
  const qc = useQueryClient();
  const nodes = useNodes();
  const q = useQuery({ queryKey: ["node", "resources"], queryFn: dcApi.resources, retry: 1 });
  const runner = useTaskRunner(() => void qc.invalidateQueries({ queryKey: ["node", "resources"] }));
  const [picked, setPicked] = useState<number[] | null>(null);
  const [bootOnly, setBootOnly] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [target, setTarget] = useState("");
  const [workers, setWorkers] = useState("");
  const [timeout, setTimeoutSec] = useState("");
  const [force, setForce] = useState(true);
  const [localDisks, setLocalDisks] = useState(false);

  const guests = useMemo<ResourceRow[]>(() => (q.data?.rows ?? []).filter((r) => (r.type === "qemu" || r.type === "lxc") && !r.template && r.node === name && r.vmid !== null).sort((a, b) => (a.vmid ?? 0) - (b.vmid ?? 0)), [q.data, name]);
  const others = (nodes.data?.nodes ?? []).filter((n) => n.node !== name && n.online);
  const chosen = picked ?? guests.map((g) => g.vmid!);
  const all = chosen.length === guests.length;
  const toggle = (id: number) => setPicked(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  const workersN = workers === "" ? undefined : Number(workers);

  const run = (action: BulkAction, confirm?: string) => {
    setPending(null);
    void runner.start(TITLE[action], () => dcApi.bulk(action, node, {
      vms: bootOnly && action === "startall" ? undefined : all && action !== "startall" ? undefined : chosen,
      force: action === "startall" && !bootOnly ? true : undefined,
      forceStop: action === "stopall" ? force : undefined,
      timeout: action === "stopall" && timeout !== "" ? Number(timeout) : undefined,
      target: action === "migrateall" ? target : undefined,
      withLocalDisks: action === "migrateall" ? localDisks : undefined,
      maxWorkers: workersN,
      confirm,
    }));
  };
  const count = `${chosen.length} ${chosen.length === 1 ? "machine" : "machines"}`;

  return (
    <Async q={q}>
      {() => (
        <div className="space-y-4">
          {runner.error && <Notice tone="critical">{runner.error}</Notice>}
          <Card className="p-5">
            <SectionTitle>Machines on {name}</SectionTitle>
            {guests.length === 0 ? <div className="mt-3"><EmptyState icon={<Monitor className="h-5 w-5" />} title="No machines on this node" body="Create a machine or container, or pick another node." /></div> : (
              <div className="overflow-x-auto mt-3">
                <table className="w-full text-compact min-w-[460px]" aria-label="Machines on this node">
                  <thead><tr className="border-b border-line text-ink-3 text-left"><th scope="col" className="px-4 h-10 font-normal w-10"><input type="checkbox" aria-label="Select all machines" className="h-4 w-4 accent-(--accent)" checked={all} onChange={() => setPicked(all ? [] : guests.map((g) => g.vmid!))} /></th><th scope="col" className="px-3 font-normal">Machine</th><th scope="col" className="px-3 font-normal">Kind</th><th scope="col" className="px-3 font-normal">State</th></tr></thead>
                  <tbody>
                    {guests.map((g) => (
                      <tr key={g.id} className="border-b border-line last:border-0">
                        <Td><input type="checkbox" aria-label={`Select ${g.name ?? g.vmid}`} className="h-4 w-4 accent-(--accent)" checked={chosen.includes(g.vmid!)} onChange={() => toggle(g.vmid!)} /></Td>
                        <Td><span className="font-mono text-xs text-ink-3 mr-2">{g.vmid}</span>{g.name}</Td>
                        <Td>{g.type === "qemu" ? <span className="inline-flex items-center gap-1.5"><Monitor className="h-4 w-4 text-ink-3" aria-hidden />Virtual machine</span> : <span className="inline-flex items-center gap-1.5"><Box className="h-4 w-4 text-ink-3" aria-hidden />Container</span>}</Td>
                        <Td>{g.status === "running" ? <Status kind="good" label="Running" /> : <Status kind="off" label="Stopped" />}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card className="p-5">
            <SectionTitle>Options</SectionTitle>
            <div className="grid sm:grid-cols-3 gap-4 mt-3">
              <Field label="Parallel tasks" hint="How many run at once (1 to 64). Empty uses the datacenter setting." htmlFor="bulk-workers"><Input id="bulk-workers" type="number" min={1} max={64} inputMode="numeric" value={workers} onChange={(e) => setWorkers(e.target.value)} /></Field>
              <Field label="Shutdown timeout (seconds)" hint="Per machine, before a hard stop." htmlFor="bulk-timeout"><Input id="bulk-timeout" type="number" min={0} max={7200} inputMode="numeric" value={timeout} onChange={(e) => setTimeoutSec(e.target.value)} /></Field>
              <Field label="Move to" htmlFor="bulk-target">
                <Select id="bulk-target" value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">{others.length ? "Pick a node" : "No other node is online"}</option>
                  {others.map((n) => <option key={n.node} value={n.node}>{n.node}</option>)}
                </Select>
              </Field>
            </div>
            <div className="grid sm:grid-cols-3 gap-4 mt-4">
              <div className="flex items-start gap-3"><Toggle checked={bootOnly} onChange={setBootOnly} label="Only machines set to start on boot" /><span className="text-compact text-ink-2">Start only those with “start on boot” on, instead of the selection</span></div>
              <div className="flex items-start gap-3"><Toggle checked={force} onChange={setForce} label="Force stop after the timeout" /><span className="text-compact text-ink-2">Force stop after the timeout</span></div>
              <div className="flex items-start gap-3"><Toggle checked={localDisks} onChange={setLocalDisks} label="Move local disks too" /><span className="text-compact text-ink-2">Move local disks while moving (live storage migration)</span></div>
            </div>
          </Card>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={runner.busy} disabled={!bootOnly && chosen.length === 0} onClick={() => run("startall")}><Play className="h-4 w-4" />{bootOnly ? "Start boot machines" : `Start ${count}`}</Button>
            <Button disabled={chosen.length === 0} onClick={() => setPending({ action: "suspendall" })}><Pause className="h-4 w-4" />Suspend {count}</Button>
            <Button variant="danger" disabled={chosen.length === 0} onClick={() => setPending({ action: "stopall" })}><PowerIcon className="h-4 w-4" />Shut down {count}</Button>
            <Button disabled={chosen.length === 0 || !target} onClick={() => setPending({ action: "migrateall", target })}><Send className="h-4 w-4" />Move {count}{target ? ` to ${target}` : ""}</Button>
            <TasksLink />
          </div>
          {pending && (
            <TypedConfirm
              title={`${TITLE[pending.action]}?`}
              subtitle={pending.action === "migrateall" ? `${count} from ${name} to ${pending.target}` : `${count} on ${name}`}
              phrase={name}
              action={pending.action === "stopall" ? "Shut down" : pending.action === "suspendall" ? "Suspend" : "Move"}
              onConfirm={() => run(pending.action, name)}
              onClose={() => setPending(null)}
            >
              <p className="text-compact text-ink-2">
                {pending.action === "stopall" ? "Running machines are asked to shut down; after the timeout they are stopped hard if that option is on. Unsaved work in them can be lost." : pending.action === "suspendall" ? "Running machines are suspended to disk and need to be resumed to carry on." : "Running machines are moved live where Proxmox can. Machines that can't be moved stay where they are and are listed in the task log."}
              </p>
            </TypedConfirm>
          )}
          {runner.modal}
        </div>
      )}
    </Async>
  );
}

export function BulkPage() {
  const { name, multi } = useNodeName();
  return (
    <PageFrame width="6xl">
      <PageHeader title="All machines" subtitle={`Start, shut down, suspend or move many machines on ${name} at once.`} actions={multi ? <NodeSwitcher /> : undefined} />
      <LiveOnly><BulkBody /></LiveOnly>
    </PageFrame>
  );
}
