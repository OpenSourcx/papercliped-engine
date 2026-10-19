import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ShieldCheck } from "lucide-react";
import { clusterApi, type HaGroup, type HaInfo, type HaNode, type HaResource, type HaRule } from "../../data/engine/clusterApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, EmptyState, Field, Input, Notice, PageFrame, PageHeader, Select, Status, Tabs, Toggle } from "../../ui/primitives.tsx";
import { Async, NodeSwitcher, TypedConfirm } from "../node/common.tsx";
import { ClusterOnly } from "./common.tsx";

type Tab = "resources" | "placement" | "status";

const STATE_LABEL: Record<string, string> = { started: "Keep running", stopped: "Keep stopped", disabled: "Disabled", ignored: "Ignored", enabled: "Enabled" };
const stateKind = (s: string | null) => (s === "started" ? "good" : s === "error" || s === "fence" ? "critical" : s === "stopped" || s === "disabled" ? "off" : "idle") as "good" | "critical" | "off" | "idle";

/* ── Node list editor (priorities) ─────────────────────────────────────────────────── */

function NodePicker({ info, value, onChange }: { info: HaInfo; value: HaNode[]; onChange: (v: HaNode[]) => void }) {
  const chosen = new Map(value.map((n) => [n.node, n]));
  return (
    <div className="space-y-2">
      {info.nodes.map((n) => {
        const on = chosen.has(n.node);
        return (
          <div key={n.node} className="flex items-center gap-3">
            <Toggle checked={on} label={`Use ${n.node}`} onChange={(v) => onChange(v ? [...value, { node: n.node }] : value.filter((x) => x.node !== n.node))} />
            <span className="font-mono flex-1">{n.node}{!n.online && <span className="text-ink-3 font-sans"> (offline)</span>}</span>
            <Input aria-label={`Priority for ${n.node}`} type="number" min={0} max={1000} disabled={!on} placeholder="Priority" className="w-28 tabular-nums" value={chosen.get(n.node)?.priority ?? ""} onChange={(e) => onChange(value.map((x) => (x.node === n.node ? { ...x, priority: e.target.value === "" ? undefined : Number(e.target.value) } : x)))} />
          </div>
        );
      })}
      <p className="text-xs text-ink-3">A higher priority is preferred. Without priorities all chosen nodes are equal.</p>
    </div>
  );
}

/* ── Resource ──────────────────────────────────────────────────────────────────────── */

function ResourceModal({ info, edit, guests, onClose, onDone }: { info: HaInfo; edit: HaResource | null; guests: { sid: string; label: string }[]; onClose: () => void; onDone: () => void }) {
  const [sid, setSid] = useState(edit?.sid ?? guests[0]?.sid ?? "");
  const [state, setState] = useState(edit?.state ?? "started");
  const [group, setGroup] = useState(edit?.group ?? "");
  const [maxRestart, setMaxRestart] = useState(String(edit?.maxRestart ?? 1));
  const [maxRelocate, setMaxRelocate] = useState(String(edit?.maxRelocate ?? 1));
  const [failback, setFailback] = useState(edit?.failback ?? true);
  const [comment, setComment] = useState(edit?.comment ?? "");
  const save = useMutation({
    mutationFn: () => {
      const b = { state, maxRestart: Number(maxRestart), maxRelocate: Number(maxRelocate), group: info.groups.length || edit?.group ? group || null : undefined, failback: info.rulesSupported ? failback : undefined, comment: comment || (edit ? null : undefined) };
      return edit ? clusterApi.saveHaResource(edit.sid, { ...b, digest: edit.digest }) : clusterApi.addHaResource({ ...b, sid, group: group || undefined });
    },
    onSuccess: () => { onDone(); onClose(); },
  });
  return (
    <Modal title={edit ? `Edit ${edit.sid}` : "Add a machine to high availability"} subtitle="The HA manager restarts it, or moves it to another node, when its node fails." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!sid} loading={save.isPending} onClick={() => save.mutate()}>{edit ? "Save resource" : "Add resource"}</Button></>}>
      <div className="space-y-5">
        {!edit && <Field label="Machine" htmlFor="ha-sid"><Select id="ha-sid" value={sid} onChange={(e) => setSid(e.target.value)}>{guests.map((g) => <option key={g.sid} value={g.sid}>{g.label}</option>)}</Select></Field>}
        <Field label="Requested state" htmlFor="ha-state"><Select id="ha-state" value={state} onChange={(e) => setState(e.target.value)}>{["started", "stopped", "disabled", "ignored"].map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</Select></Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Restart attempts" hint="On the same node, before relocating." htmlFor="ha-mr"><Input id="ha-mr" type="number" min={0} value={maxRestart} onChange={(e) => setMaxRestart(e.target.value)} className="tabular-nums" /></Field>
          <Field label="Relocate attempts" hint="To other nodes, before giving up." htmlFor="ha-ml"><Input id="ha-ml" type="number" min={0} value={maxRelocate} onChange={(e) => setMaxRelocate(e.target.value)} className="tabular-nums" /></Field>
        </div>
        {info.groups.length > 0 && <Field label="Group" hint={info.rulesSupported ? "Groups are deprecated; prefer a placement rule." : undefined} htmlFor="ha-group"><Select id="ha-group" value={group} onChange={(e) => setGroup(e.target.value)}><option value="">No group</option>{info.groups.map((g) => <option key={g.group} value={g.group}>{g.group}</option>)}</Select></Field>}
        {info.rulesSupported && <div className="flex items-start gap-3"><Toggle checked={failback} onChange={setFailback} label="Move back to the preferred node" /><div><div className="text-compact font-medium text-ink-2">Move back to the preferred node</div><p className="text-xs text-ink-3">When a node with a higher priority in its placement rule returns.</p></div></div>}
        <Field label="Note" htmlFor="ha-comment"><Input id="ha-comment" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        {save.error && <p role="alert" className="text-compact text-critical">{errorText(save.error)}</p>}
      </div>
    </Modal>
  );
}

function MoveModal({ info, r, onClose, onDone }: { info: HaInfo; r: HaResource; onClose: () => void; onDone: () => void }) {
  const targets = info.nodes.filter((n) => n.online && n.node !== r.node);
  const [node, setNode] = useState(targets[0]?.node ?? "");
  const [how, setHow] = useState<"migrate" | "relocate">("migrate");
  const move = useMutation({ mutationFn: () => clusterApi.moveHaResource(r.sid, how, node), onSuccess: () => { onDone(); onClose(); } });
  return (
    <Modal size="sm" title={`Move ${r.name ?? r.sid}`} subtitle="The HA manager does this; it may take a moment to start." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!node} loading={move.isPending} onClick={() => move.mutate()}>Move</Button></>}>
      <div className="space-y-4">
        <Field label="To node" htmlFor="mv-node"><Select id="mv-node" value={node} onChange={(e) => setNode(e.target.value)}>{targets.map((n) => <option key={n.node}>{n.node}</option>)}</Select></Field>
        <Field label="How" htmlFor="mv-how"><Select id="mv-how" value={how} onChange={(e) => setHow(e.target.value as "migrate" | "relocate")}><option value="migrate">Migrate: keep it running</option><option value="relocate">Relocate: stop it here, start it there</option></Select></Field>
        {move.error && <p role="alert" className="text-compact text-critical">{errorText(move.error)}</p>}
      </div>
    </Modal>
  );
}

/* ── Groups and rules ──────────────────────────────────────────────────────────────── */

function GroupModal({ info, edit, onClose, onDone }: { info: HaInfo; edit: HaGroup | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(edit?.group ?? "");
  const [nodes, setNodes] = useState<HaNode[]>(edit?.nodes ?? []);
  const [restricted, setRestricted] = useState(edit?.restricted ?? false);
  const [nofailback, setNofailback] = useState(edit?.nofailback ?? false);
  const save = useMutation({ mutationFn: () => (edit ? clusterApi.saveHaGroup(edit.group, { nodes, restricted, nofailback, digest: edit.digest }) : clusterApi.addHaGroup({ group: name, nodes, restricted, nofailback })), onSuccess: () => { onDone(); onClose(); } });
  return (
    <Modal title={edit ? `Edit ${edit.group}` : "Add a group"} subtitle="Which nodes machines in this group may run on." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!nodes.length || !/^[A-Za-z][A-Za-z0-9_-]+$/.test(name)} loading={save.isPending} onClick={() => save.mutate()}>{edit ? "Save group" : "Add group"}</Button></>}>
      <div className="space-y-5">
        {!edit && <Field label="Group name" hint="Letters, numbers, - and _." htmlFor="g-name"><Input id="g-name" value={name} onChange={(e) => setName(e.target.value)} className="font-mono" autoFocus /></Field>}
        <NodePicker info={info} value={nodes} onChange={setNodes} />
        <div className="flex items-start gap-3"><Toggle checked={restricted} onChange={setRestricted} label="Restricted" /><div><div className="text-compact font-medium text-ink-2">Restricted</div><p className="text-xs text-ink-3">Machines may only run on the nodes above. If none is up they stay stopped.</p></div></div>
        <div className="flex items-start gap-3"><Toggle checked={nofailback} onChange={setNofailback} label="Don't move back" /><div><div className="text-compact font-medium text-ink-2">Don't move back</div><p className="text-xs text-ink-3">Leave a machine where it is when a preferred node comes back.</p></div></div>
        {save.error && <p role="alert" className="text-compact text-critical">{errorText(save.error)}</p>}
      </div>
    </Modal>
  );
}

function RuleModal({ info, edit, onClose, onDone }: { info: HaInfo; edit: HaRule | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(edit?.rule ?? "");
  const [type, setType] = useState<string>(edit?.type ?? "node-affinity");
  const [resources, setResources] = useState<string[]>(edit?.resources ?? []);
  const [nodes, setNodes] = useState<HaNode[]>(edit?.nodes ?? []);
  const [strict, setStrict] = useState(edit?.strict ?? false);
  const [affinity, setAffinity] = useState(edit?.affinity ?? (type === "node-affinity" ? "positive" : "negative"));
  const [disabled, setDisabled] = useState(edit?.disabled ?? false);
  const [comment, setComment] = useState(edit?.comment ?? "");
  const node = type === "node-affinity";
  const save = useMutation({
    mutationFn: () => {
      const b = { resources, ...(node ? { nodes, strict } : {}), affinity, disable: disabled, comment: comment || (edit ? null : undefined) };
      return edit ? clusterApi.saveHaRule(edit.rule, { ...b, digest: edit.digest }) : clusterApi.addHaRule({ ...b, rule: name, type });
    },
    onSuccess: () => { onDone(); onClose(); },
  });
  return (
    <Modal size="lg" title={edit ? `Edit ${edit.rule}` : "Add a placement rule"} subtitle="Tells the HA manager where machines belong." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!resources.length || (node && !nodes.length) || (!edit && !/^[A-Za-z][A-Za-z0-9_-]+$/.test(name))} loading={save.isPending} onClick={() => save.mutate()}>{edit ? "Save rule" : "Add rule"}</Button></>}>
      <div className="space-y-5">
        {!edit && <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Rule name" htmlFor="r-name"><Input id="r-name" value={name} onChange={(e) => setName(e.target.value)} className="font-mono" autoFocus /></Field>
          <Field label="Kind" htmlFor="r-type"><Select id="r-type" value={type} onChange={(e) => { setType(e.target.value); setAffinity(e.target.value === "node-affinity" ? "positive" : "negative"); }}><option value="node-affinity">Node affinity: run on chosen nodes</option><option value="resource-affinity">Resource affinity: keep together or apart</option></Select></Field>
        </div>}
        <Field label="Machines" hint={node ? undefined : "Pick at least two."} htmlFor="r-res">
          <div id="r-res" className="flex flex-wrap gap-2">
            {info.resources.map((r) => { const on = resources.includes(r.sid); return <button key={r.sid} type="button" aria-pressed={on} onClick={() => setResources(on ? resources.filter((x) => x !== r.sid) : [...resources, r.sid])} className={`transition-control h-8 px-3 rounded-lg text-compact border ${on ? "bg-accent-soft border-accent text-ink" : "border-line text-ink-2 hover:bg-surface-2"}`}>{r.name ?? r.sid} <span className="font-mono text-ink-3">{r.sid}</span></button>; })}
            {!info.resources.length && <p className="text-compact text-ink-3">Add machines to high availability first.</p>}
          </div>
        </Field>
        {node && <NodePicker info={info} value={nodes} onChange={setNodes} />}
        <Field label="Affinity" htmlFor="r-aff"><Select id="r-aff" value={affinity} onChange={(e) => setAffinity(e.target.value)}><option value="positive">{node ? "Prefer these nodes" : "Keep on the same node"}</option><option value="negative">{node ? "Avoid these nodes" : "Keep on separate nodes"}</option></Select></Field>
        {node && <div className="flex items-start gap-3"><Toggle checked={strict} onChange={setStrict} label="Strict" /><div><div className="text-compact font-medium text-ink-2">Strict</div><p className="text-xs text-ink-3">Only run on these nodes. If none is up the machine is stopped, instead of moving elsewhere.</p></div></div>}
        <div className="flex items-start gap-3"><Toggle checked={disabled} onChange={setDisabled} label="Disabled" /><div className="text-compact font-medium text-ink-2">Disabled</div></div>
        <Field label="Note" htmlFor="r-comment"><Input id="r-comment" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        {save.error && <p role="alert" className="text-compact text-critical">{errorText(save.error)}</p>}
      </div>
    </Modal>
  );
}

const nodeText = (n: HaNode[]) => n.map((x) => (x.priority !== undefined ? `${x.node} (${x.priority})` : x.node)).join(", ");

/* ── The page ──────────────────────────────────────────────────────────────────────── */

function Body({ info }: { info: HaInfo }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["cluster", "ha"] });
  const [tab, setTab] = useState<Tab>("resources");
  const [res, setRes] = useState<{ edit: HaResource | null } | null>(null);
  const [move, setMove] = useState<HaResource | null>(null);
  const [group, setGroup] = useState<{ edit: HaGroup | null } | null>(null);
  const [rule, setRule] = useState<{ edit: HaRule | null } | null>(null);
  const [del, setDel] = useState<{ kind: "resource" | "group" | "rule"; id: string } | null>(null);
  const [disarm, setDisarm] = useState(false);
  const [mode, setMode] = useState<"freeze" | "ignore">("freeze");
  const guests = useQuery({ queryKey: ["cluster", "ha-guests"], queryFn: () => clusterApi.replication(), retry: 0 });
  const free = (guests.data?.guests ?? []).filter((g) => !info.resources.some((r) => r.vmid === g.vmid)).map((g) => ({ sid: `${g.type === "lxc" ? "ct" : "vm"}:${g.vmid}`, label: `${g.name} (${g.vmid}) on ${g.node}` }));
  const remove = useMutation({
    mutationFn: (d: NonNullable<typeof del>) => (d.kind === "resource" ? clusterApi.removeHaResource(d.id) : d.kind === "group" ? clusterApi.removeHaGroup(d.id) : clusterApi.removeHaRule(d.id)),
    onSuccess: () => { setDel(null); void refresh(); },
  });
  const arm = useMutation({ mutationFn: (b: Parameters<typeof clusterApi.armHa>[0]) => clusterApi.armHa(b), onSuccess: () => { setDisarm(false); void refresh(); } });
  const legacyGroups = info.groups.length > 0;
  const placement = info.rulesSupported ? info.rules.length + info.groups.length : info.groups.length;
  return (
    <div className="space-y-5">
      {info.denied && <Notice tone="info">Your Proxmox account can't read the HA configuration (it needs Sys.Audit).</Notice>}
      {info.status.quorate === false && <Notice tone="critical" title="The cluster has no quorum">The HA manager does nothing until quorum returns.</Notice>}
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: "resources", label: "Resources", count: info.resources.length }, { id: "placement", label: info.rulesSupported ? "Rules" : "Groups", count: placement }, { id: "status", label: "Status and fencing" }]} />

      {tab === "resources" && (
        <>
          <div><Button variant="primary" disabled={!free.length} onClick={() => setRes({ edit: null })}><Plus className="h-4 w-4" />Add machine…</Button></div>
          <Card className="overflow-x-auto edge-fade-x">
            {!info.resources.length ? <EmptyState icon={<ShieldCheck className="h-5 w-5" />} title="No machines under high availability" body="Add a machine and the HA manager restarts it, or starts it on another node, when its node fails. Machines should be on shared storage or replicated." /> : (
              <table className="w-full text-compact min-w-[720px]">
                <thead><tr className="border-b border-line text-ink-3 text-left"><th className="font-normal px-4 h-10">Machine</th><th className="font-normal px-3">Node</th><th className="font-normal px-3">Requested</th><th className="font-normal px-3">Now</th><th className="font-normal px-3">{info.rulesSupported ? "Placement" : "Group"}</th><th className="px-3"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {info.resources.map((r) => (
                    <tr key={r.sid} className="border-b border-line last:border-0">
                      <td className="px-4 py-3"><span>{r.name ?? "Unknown"}</span> <span className="font-mono text-xs text-ink-3">{r.sid}</span>{r.comment && <span className="block text-xs text-ink-3">{r.comment}</span>}</td>
                      <td className="px-3 font-mono">{r.node ?? "–"}</td>
                      <td className="px-3">{STATE_LABEL[r.state] ?? r.state}</td>
                      <td className="px-3"><Status kind={stateKind(r.current)} label={r.current ?? "Unknown"} /></td>
                      <td className="px-3">{r.group ? <Chip>{r.group}</Chip> : info.rulesSupported ? <span className="text-ink-3">{info.rules.filter((x) => x.resources.includes(r.sid)).map((x) => x.rule).join(", ") || "None"}</span> : <span className="text-ink-3">None</span>}</td>
                      <td className="px-3"><div className="flex gap-1.5 justify-end"><Button size="sm" onClick={() => setMove(r)}>Move…</Button><Button size="sm" variant="ghost" onClick={() => setRes({ edit: r })}>Edit</Button><Button size="sm" variant="ghost" className="text-critical" onClick={() => setDel({ kind: "resource", id: r.sid })}>Remove</Button></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}

      {tab === "placement" && (
        <>
          {!info.rulesSupported && <Notice tone="info">This Proxmox places HA machines with groups. Newer versions replace groups with placement rules, and move existing groups across when upgraded.</Notice>}
          {info.rulesSupported && legacyGroups && <Notice tone="warning" title="Groups are deprecated">These groups still work. Proxmox converts them to rules when you next upgrade.</Notice>}
          <div className="flex flex-wrap gap-2">
            {info.rulesSupported && <Button variant="primary" onClick={() => setRule({ edit: null })}><Plus className="h-4 w-4" />Add rule…</Button>}
            {(!info.rulesSupported || legacyGroups) && <Button variant={info.rulesSupported ? "secondary" : "primary"} onClick={() => setGroup({ edit: null })}><Plus className="h-4 w-4" />Add group…</Button>}
          </div>
          {info.rulesSupported && (
            <Card className="overflow-x-auto edge-fade-x">
              {!info.rules.length ? <EmptyState icon={<ShieldCheck className="h-5 w-5" />} title="No placement rules" body="Without a rule the HA manager may start a machine on any node. Add one to prefer or avoid nodes, or to keep machines together or apart." /> : (
                <table className="w-full text-compact min-w-[640px]">
                  <thead><tr className="border-b border-line text-ink-3 text-left"><th className="font-normal px-4 h-10">Rule</th><th className="font-normal px-3">Kind</th><th className="font-normal px-3">Machines</th><th className="font-normal px-3">Nodes</th><th className="px-3"><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>{info.rules.map((r) => (
                    <tr key={r.rule} className="border-b border-line last:border-0">
                      <td className="px-4 py-3"><span className="font-mono">{r.rule}</span>{r.disabled && <Chip className="ml-2">Disabled</Chip>}</td>
                      <td className="px-3">{r.type === "node-affinity" ? `${r.affinity === "negative" ? "Avoid" : "Prefer"} nodes${r.strict ? " (strict)" : ""}` : r.affinity === "negative" ? "Keep apart" : "Keep together"}</td>
                      <td className="px-3 font-mono text-xs">{r.resources.join(", ")}</td>
                      <td className="px-3 text-xs">{nodeText(r.nodes) || "–"}</td>
                      <td className="px-3"><div className="flex gap-1.5 justify-end"><Button size="sm" variant="ghost" onClick={() => setRule({ edit: r })}>Edit</Button><Button size="sm" variant="ghost" className="text-critical" onClick={() => setDel({ kind: "rule", id: r.rule })}>Remove</Button></div></td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </Card>
          )}
          {(!info.rulesSupported || legacyGroups) && (
            <Card className="overflow-x-auto edge-fade-x">
              {!info.groups.length ? <EmptyState icon={<ShieldCheck className="h-5 w-5" />} title="No groups" body="A group lists the nodes a machine may run on, with priorities. Add one, then pick it when you add a machine." /> : (
                <table className="w-full text-compact min-w-[560px]">
                  <thead><tr className="border-b border-line text-ink-3 text-left"><th className="font-normal px-4 h-10">Group</th><th className="font-normal px-3">Nodes</th><th className="font-normal px-3">Options</th><th className="px-3"><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>{info.groups.map((g) => (
                    <tr key={g.group} className="border-b border-line last:border-0">
                      <td className="px-4 py-3 font-mono">{g.group}</td>
                      <td className="px-3 text-xs">{nodeText(g.nodes)}</td>
                      <td className="px-3 text-xs">{[g.restricted && "Restricted", g.nofailback && "Don't move back"].filter(Boolean).join(", ") || "–"}</td>
                      <td className="px-3"><div className="flex gap-1.5 justify-end"><Button size="sm" variant="ghost" onClick={() => setGroup({ edit: g })}>Edit</Button><Button size="sm" variant="ghost" className="text-critical" onClick={() => setDel({ kind: "group", id: g.group })}>Remove…</Button></div></td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </Card>
          )}
        </>
      )}

      {tab === "status" && (
        <div className="grid md:grid-cols-2 gap-4">
          <Card className="p-5">
            <div className="font-medium mb-3">Manager</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-compact">
              <dt className="text-ink-3">Quorum</dt><dd>{info.status.quorate === null ? "Unknown" : info.status.quorate ? <Status kind="good" label="Quorate" /> : <Status kind="critical" label="No quorum" />}</dd>
              <dt className="text-ink-3">Current manager</dt><dd className="font-mono">{info.status.master?.node ?? info.status.managerNode ?? "None"}</dd>
            </dl>
            <ul className="mt-4 divide-y divide-line">
              {info.status.lrms.map((l) => <li key={l.node} className="py-2 flex items-center gap-3"><span className="font-mono flex-1">{l.node}</span><span className="text-xs text-ink-3 text-right">{l.status.replace(/^\S+ /, "")}</span></li>)}
              {!info.status.lrms.length && <li className="py-2 text-compact text-ink-3">No local managers reported.</li>}
            </ul>
          </Card>
          <Card className="p-5">
            <div className="font-medium mb-1">Fencing</div>
            <p className="text-compact text-ink-3">When a node stops answering, the cluster waits for it to fence itself before restarting its machines elsewhere. That keeps one machine from running twice.</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-compact mt-3">
              <dt className="text-ink-3">Method</dt><dd>{{ watchdog: "Watchdog (software or hardware timer)", hardware: "Hardware fence devices", both: "Hardware devices, then watchdog" }[info.fencing.mode] ?? info.fencing.mode}</dd>
              {info.fencing.canArm && <><dt className="text-ink-3">HA is</dt><dd>{info.fencing.armed === "armed" ? <Status kind="good" label="Armed" /> : <Status kind="paused" label={info.fencing.armed ?? "Unknown"} />}</dd></>}
            </dl>
            <p className="text-xs text-ink-3 mt-3">The method is set in Datacenter options. Hardware fence devices are configured in Proxmox's fence.cfg, which has no API.</p>
            {info.fencing.canArm && <div className="mt-4">{info.fencing.armed === "armed" ? <Button variant="danger" onClick={() => setDisarm(true)}>Disarm HA…</Button> : <Button loading={arm.isPending} onClick={() => arm.mutate({ action: "arm" })}>Arm HA</Button>}{arm.error && <p role="alert" className="text-compact text-critical mt-2">{errorText(arm.error)}</p>}</div>}
          </Card>
        </div>
      )}

      {res && <ResourceModal info={info} edit={res.edit} guests={free} onClose={() => setRes(null)} onDone={() => void refresh()} />}
      {move && <MoveModal info={info} r={move} onClose={() => setMove(null)} onDone={() => void refresh()} />}
      {group && <GroupModal info={info} edit={group.edit} onClose={() => setGroup(null)} onDone={() => void refresh()} />}
      {rule && <RuleModal info={info} edit={rule.edit} onClose={() => setRule(null)} onDone={() => void refresh()} />}
      {del && del.kind === "group" && <TypedConfirm title={`Remove the group ${del.id}?`} phrase={del.id} action="Remove group" busy={remove.isPending} error={remove.error ? errorText(remove.error) : null} onClose={() => setDel(null)} onConfirm={() => remove.mutate(del)} />}
      {del && del.kind !== "group" && (
        <Modal size="sm" title={del.kind === "resource" ? `Take ${del.id} out of high availability?` : `Remove the rule ${del.id}?`} onClose={() => setDel(null)} footer={<><Button variant="ghost" onClick={() => setDel(null)}>Cancel</Button><Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate(del)}>{del.kind === "resource" ? "Remove from HA" : "Remove rule"}</Button></>}>
          <p className="text-compact text-ink-2">{del.kind === "resource" ? "The machine keeps running as it is. It just won't be restarted or moved automatically any more." : "Machines keep their current node. The HA manager stops applying this rule."}</p>
          {remove.error && <p role="alert" className="text-compact text-critical mt-2">{errorText(remove.error)}</p>}
        </Modal>
      )}
      {disarm && (
        <TypedConfirm title="Disarm high availability?" subtitle="Releases the watchdogs on every node" phrase="disarm" action="Disarm HA" busy={arm.isPending} error={arm.error ? errorText(arm.error) : null} onClose={() => setDisarm(false)} onConfirm={() => arm.mutate({ action: "disarm", resourceMode: mode, confirm: "disarm" })}>
          <Notice tone="warning">While disarmed, a failed node's machines are not restarted elsewhere. Use this for maintenance such as updating the whole cluster.</Notice>
          <Field label="Machines while disarmed" htmlFor="dm"><Select id="dm" value={mode} onChange={(e) => setMode(e.target.value as "freeze" | "ignore")}><option value="freeze">Freeze: leave them as they are, ignore new commands</option><option value="ignore">Ignore: treat them as not managed</option></Select></Field>
        </TypedConfirm>
      )}
    </div>
  );
}

export function HaPage() {
  const q = useQuery({ queryKey: ["cluster", "ha"], queryFn: clusterApi.ha, refetchInterval: 10_000, retry: 1 });
  return (
    <PageFrame width="6xl">
      <PageHeader title="High availability" subtitle="Machines the cluster keeps running: restarted, or started on another node, when their node fails." actions={<NodeSwitcher />} />
      <ClusterOnly what="High availability">{() => <Async q={q}>{(info) => <Body info={info} />}</Async>}</ClusterOnly>
    </PageFrame>
  );
}
