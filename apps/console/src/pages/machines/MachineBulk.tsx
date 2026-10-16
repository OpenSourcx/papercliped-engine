import { useState } from "react";
import { ListChecks, Loader2, Play, Power, Pause, Route } from "lucide-react";
import { errorText } from "../../data/engine/guestApi.ts";
import { useMachineApi } from "../../data/engine/machineApi.ts";
import { useEngine } from "../../data/store.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Input, Select } from "../../ui/primitives.tsx";
import { SwitchRow } from "./MachineSettingsKit.tsx";

type Action = "start" | "shutdown" | "suspend" | "migrate";
const LABEL: Record<Action, string> = { start: "Start", shutdown: "Shut down", suspend: "Suspend", migrate: "Migrate" };

/** The bar that appears when machines are selected in the list: act on all of them at once, as Proxmox's bulk actions do. */
export function BulkBar({ ids, names, nodes, onDone, onClear }: { ids: number[]; names: string[]; nodes: string[]; onDone: () => void; onClear: () => void }) {
  const [action, setAction] = useState<Action | null>(null);
  return (
    <div className="sticky top-16 z-(--z-raised) mb-4 rounded-xl border border-line-strong bg-surface-2 px-4 py-3 flex flex-wrap items-center gap-2" role="region" aria-label="Actions for the selected machines">
      <span className="text-sm font-medium mr-2">{ids.length} selected</span>
      <Button size="sm" onClick={() => setAction("start")}><Play className="h-3.5 w-3.5" />Start</Button>
      <Button size="sm" onClick={() => setAction("shutdown")}><Power className="h-3.5 w-3.5" />Shut down</Button>
      <Button size="sm" onClick={() => setAction("suspend")}><Pause className="h-3.5 w-3.5" />Suspend</Button>
      <Button size="sm" onClick={() => setAction("migrate")} disabled={nodes.length < 2} title={nodes.length < 2 ? "Needs a cluster with another node" : undefined}><Route className="h-3.5 w-3.5" />Migrate</Button>
      <Button size="sm" variant="ghost" onClick={onClear}>Clear</Button>
      {action && <BulkModal action={action} ids={ids} names={names} nodes={nodes} onClose={() => setAction(null)} onDone={() => { setAction(null); onDone(); }} />}
    </div>
  );
}

function BulkModal({ action, ids, names, nodes, onClose, onDone }: { action: Action; ids: number[]; names: string[]; nodes: string[]; onClose: () => void; onDone: () => void }) {
  const api = useMachineApi();
  const engine = useEngine();
  const [typed, setTyped] = useState("");
  const [timeout, setTimeoutS] = useState("");
  const [force, setForce] = useState(true);
  const [toDisk, setToDisk] = useState(false);
  const [target, setTarget] = useState(nodes.find((n) => n !== engine.setup?.deviceName) ?? nodes[0] ?? "");
  const [online, setOnline] = useState(true);
  const [local, setLocal] = useState(true);
  const [workers, setWorkers] = useState("");
  const [nodeOnly, setNodeOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsConfirm = action !== "start";
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { action, vms: ids, ...(workers.trim() ? { maxWorkers: Number(workers) } : {}), ...(needsConfirm ? { confirm: typed } : {}) };
      if ((action === "shutdown" || action === "start") && timeout.trim()) body.timeout = Number(timeout);
      if (action === "shutdown") body.forceStop = force;
      if (action === "suspend") body.toDisk = toDisk;
      if (action === "migrate") Object.assign(body, { target, online, withLocalDisks: local });
      const r = await api.bulk(nodeOnly ? "node" : "guests", body);
      engine.notify({ kind: "info", title: `${LABEL[action]}: ${ids.length} machine${ids.length === 1 ? "" : "s"}`, body: engine.live ? "Proxmox runs this as one task and works through them a few at a time." : "Demo: nothing changes on a real device." });
      if (r.task && r.task !== "demo") engine.watchTask(r.task, `${LABEL[action]} ${ids.length} machines`);
      onDone();
    } catch (e) {
      setError(errorText(e, "Proxmox refused that"));
      setBusy(false);
    }
  };
  return (
    <Modal size="sm" icon={<ListChecks className="h-5 w-5" />} title={`${LABEL[action]} ${ids.length} machine${ids.length === 1 ? "" : "s"}?`} subtitle={names.slice(0, 5).join(", ") + (names.length > 5 ? `, and ${names.length - 5} more` : "")} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={action === "shutdown" ? "danger" : "primary"} onClick={go} disabled={busy || (needsConfirm && typed !== String(ids.length)) || (action === "migrate" && !target)}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{LABEL[action]}</Button></>}>
      <div className="space-y-4">
        {(action === "start" || action === "shutdown") && <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Wait up to (seconds) for each</span><Input type="number" min={0} value={timeout} onChange={(e) => setTimeoutS(e.target.value)} placeholder={action === "shutdown" ? "180" : "Proxmox's default"} /></label>}
        {action === "shutdown" && <SwitchRow label="Stop machines that don't shut down in time" checked={force} onChange={setForce} />}
        {action === "suspend" && <SwitchRow label="Hibernate to disk" hint="Saves memory to disk and stops the VM, instead of pausing it in RAM." checked={toDisk} onChange={setToDisk} />}
        {action === "migrate" && (
          <>
            <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Move to node</span><Select value={target} onChange={(e) => setTarget(e.target.value)}>{nodes.map((n) => <option key={n} value={n}>{n}</option>)}</Select></label>
            <SwitchRow label="Keep running while moving" hint="Live migration. Off shuts a machine down first." checked={online} onChange={setOnline} />
            <SwitchRow label="Move local disks too" checked={local} onChange={setLocal} />
          </>
        )}
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Machines at once</span><Input type="number" min={1} max={64} value={workers} onChange={(e) => setWorkers(e.target.value)} placeholder={action === "migrate" ? "1" : "4"} /></label>
        {engine.live && <SwitchRow label="Only machines on this node" hint="Uses the node's own start all, stop all, suspend all or migrate all." checked={nodeOnly} onChange={setNodeOnly} />}
        {needsConfirm && <label className="block"><span className="block text-xs text-ink-3 mb-1.5">Type <span className="font-mono text-ink-2">{ids.length}</span> to confirm</span><Input value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" /></label>}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}
