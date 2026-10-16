import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Route } from "lucide-react";
import { clusterApi, type MigrateCheck, type MigrateResult } from "../../data/engine/clusterApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { useEngine } from "../../data/store.tsx";
import { formatBytes } from "../../lib/storage.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, Field, Input, Notice, SectionTitle, Select, Status, Toggle } from "../../ui/primitives.tsx";
import { TaskModal } from "../node/common.tsx";
import { RemoteMigrateButton } from "./ClusterTools.tsx";
import { MachineReplication } from "./ReplicationPage.tsx";
import { useOverview } from "./common.tsx";

/** Moving a machine to another node. The move is a Proxmox task on the node it leaves, followed live; machines under HA are moved by the HA manager. */
function MigrateBody({ c, onClose, onStarted }: { c: MigrateCheck; onClose: () => void; onStarted: (r: MigrateResult) => void }) {
  const firstAllowed = c.targets.find((t) => t.allowed)?.node ?? "";
  const [target, setTarget] = useState(firstAllowed);
  const [live, setLive] = useState(c.running);
  const [withDisks, setWithDisks] = useState(c.localDisks.length > 0);
  const [storage, setStorage] = useState("");
  const [bw, setBw] = useState("");
  const [force, setForce] = useState(false);
  const [typed, setTyped] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [mtype, setMtype] = useState("");
  const [mnet, setMnet] = useState("");
  const stores = useQuery({ queryKey: ["cluster", "migrate-storages", c.vmid, target], queryFn: () => clusterApi.migrateStorages(c.vmid, target), enabled: !!target && c.localDisks.length > 0 && !c.ha, retry: 0 });
  const t = c.targets.find((x) => x.node === target);
  const blockedByLocal = c.localResources.length > 0;
  const go = useMutation({
    mutationFn: () => clusterApi.migrate(c.vmid, {
      target,
      ...(c.type === "qemu" ? { online: c.running ? live : undefined, withLocalDisks: c.running && live && c.localDisks.length > 0 ? withDisks : undefined } : { online: c.running && live ? true : undefined, restart: c.running && !live ? true : undefined }),
      targetStorage: storage || undefined,
      bwlimit: bw ? Number(bw) * 1024 : undefined,
      force: force || undefined,
      confirm: force ? typed : undefined,
      migrationType: mtype || undefined,
      migrationNetwork: mnet || undefined,
    }),
    onSuccess: onStarted,
  });
  const how = c.ha ? "The HA manager moves it" : c.running ? (c.type === "qemu" ? "Moved while running, with a short pause at the end" : live ? "Moved while running (experimental)" : "Shut down, moved, and started again") : "Moved while off";
  return (
    <Modal size="md" icon={<Route className="h-5 w-5" />} title={`Migrate ${c.name}`} subtitle={`Currently on ${c.node}`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!target || !t?.allowed || (force && typed !== String(c.vmid)) || (blockedByLocal && !force)} loading={go.isPending} onClick={() => go.mutate()}>Migrate</Button></>}>
      <div className="space-y-5">
        {c.locked && <Notice tone="warning">{c.name} is locked ({c.locked}). Wait for what is using it to finish.</Notice>}
        {c.ha && <Notice tone="info" title="Managed by high availability">The HA manager does the move, so there is no task to watch here and local disk options don't apply. Follow it on the High availability screen.</Notice>}
        <Field label="Target node" htmlFor="mg-target">
          <Select id="mg-target" value={target} onChange={(e) => setTarget(e.target.value)}>
            {c.targets.map((x) => <option key={x.node} value={x.node} disabled={!x.allowed}>{x.node}{x.allowed ? "" : ` (not available)`}</option>)}
          </Select>
        </Field>
        {c.targets.filter((x) => !x.allowed && x.reasons.length).map((x) => <p key={x.node} className="text-xs text-ink-3"><span className="font-mono">{x.node}</span>: {x.reasons.join(". ")}.</p>)}
        {!firstAllowed && <Notice tone="warning">No other node can take {c.name} right now.</Notice>}
        <div>
          <div className="text-compact font-medium text-ink-2 mb-1">How</div>
          <p className="text-compact text-ink-2">{how}.</p>
          {c.running && !c.ha && c.type === "lxc" && <div className="flex items-center gap-3 mt-2"><Toggle checked={live} onChange={setLive} label="Live migration" /><span className="text-compact text-ink-2">Try live migration instead of restarting (experimental)</span></div>}
          {c.running && !c.ha && c.type === "qemu" && <div className="flex items-center gap-3 mt-2"><Toggle checked={live} onChange={setLive} label="Keep it running" /><span className="text-compact text-ink-2">Keep it running during the move</span></div>}
        </div>
        {c.localDisks.length > 0 && !c.ha && (
          <div className="space-y-3">
            <div className="text-compact font-medium text-ink-2">Local disks</div>
            <ul className="text-compact text-ink-2 space-y-0.5">{c.localDisks.map((d) => <li key={d.volid}><span className="font-mono">{d.volid}</span>{d.size ? ` · ${formatBytes(d.size)}` : ""}{d.unused ? " · detached" : ""}{d.cdrom ? " · CD/DVD" : ""}</li>)}</ul>
            <p className="text-xs text-ink-3">These live on {c.node} only, so they are copied to the target. Large disks take a while.</p>
            {c.type === "qemu" && c.running && live && <div className="flex items-center gap-3"><Toggle checked={withDisks} onChange={setWithDisks} label="Move local disks while running" /><span className="text-compact text-ink-2">Move them while it keeps running</span></div>}
            <Field label="Store them on" htmlFor="mg-store" hint="Leave on the same storage name if the target has one.">
              <Select id="mg-store" value={storage} onChange={(e) => setStorage(e.target.value)}><option value="">Same storage as now</option>{(stores.data?.storages ?? []).map((s) => <option key={s.storage} value={s.storage}>{s.storage} ({s.type}{s.avail ? `, ${formatBytes(s.avail)} free` : ""})</option>)}</Select>
            </Field>
          </div>
        )}
        {(c.localResources.length > 0 || c.mappedResources.length > 0) && (
          <Notice tone={blockedByLocal ? "warning" : "info"} title="Devices tied to this node">
            {c.localResources.length > 0 && <>{c.localResources.join(", ")} belong to {c.node} and won't follow the machine. </>}
            {c.mappedResources.length > 0 && <>Mapped: {c.mappedResources.map((m) => `${m.id}${m.liveMigration ? "" : " (not live-migratable)"}`).join(", ")}. </>}
            {blockedByLocal && <>Migrate anyway only if the machine can do without them.</>}
          </Notice>
        )}
        {blockedByLocal && !c.ha && (
          <div className="space-y-2">
            <div className="flex items-center gap-3"><Toggle checked={force} onChange={setForce} label="Migrate anyway" /><span className="text-compact text-ink-2">Migrate anyway, without those devices</span></div>
            {force && <Field label={<>Type <span className="font-mono text-ink">{c.vmid}</span> to confirm</>} htmlFor="mg-force"><Input id="mg-force" value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" autoComplete="off" /></Field>}
          </div>
        )}
        {c.dependentHa.length > 0 && <p className="text-xs text-ink-3">Also moved with it, by an HA rule: {c.dependentHa.join(", ")}.</p>}
        {!c.ha && (
          <div>
            <button type="button" className="text-compact text-ink-2 hover:text-ink underline-offset-2 hover:underline" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? "Hide" : "Show"} advanced options</button>
            {advanced && (
              <div className="grid sm:grid-cols-2 gap-4 mt-3">
                <Field label="Speed limit (MB/s)" hint="Empty uses the datacenter setting." htmlFor="mg-bw"><Input id="mg-bw" type="number" min={0} value={bw} onChange={(e) => setBw(e.target.value)} className="tabular-nums" /></Field>
                {c.type === "qemu" && <Field label="Migration traffic" htmlFor="mg-type"><Select id="mg-type" value={mtype} onChange={(e) => setMtype(e.target.value)}><option value="">Datacenter setting</option><option value="secure">Encrypted</option><option value="insecure">Unencrypted (private networks only)</option></Select></Field>}
                {c.type === "qemu" && <Field label="Migration network" hint="Like 10.10.0.0/24." htmlFor="mg-net"><Input id="mg-net" value={mnet} onChange={(e) => setMnet(e.target.value)} className="font-mono" spellCheck={false} /></Field>}
              </div>
            )}
          </div>
        )}
        {go.error && <p role="alert" className="text-compact text-critical">{errorText(go.error)}</p>}
      </div>
    </Modal>
  );
}

export function MigrateModal({ vmid, onClose }: { vmid: number; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["cluster", "migrate", vmid], queryFn: () => clusterApi.migrateCheck(vmid), retry: 0, gcTime: 0 });
  const [started, setStarted] = useState<MigrateResult | null>(null);
  const done = () => { void qc.invalidateQueries(); };
  if (started && !started.queued) return <TaskModal upid={started.task} title={`Migrating #${vmid}`} onClose={() => { done(); onClose(); }} onDone={done} />;
  if (started?.queued) {
    return (
      <Modal size="sm" title="Request sent" onClose={() => { done(); onClose(); }} footer={<Button onClick={() => { done(); onClose(); }}>Close</Button>}>
        <p className="text-compact text-ink-2">The HA manager will {started.how === "migrate" ? "migrate" : "relocate"} the machine. It starts within a few seconds; follow it on the High availability screen.</p>
      </Modal>
    );
  }
  if (q.isPending) return <Modal size="md" title="Migrate" subtitle="Checking where it can go…" onClose={onClose}><div aria-busy="true" className="h-24" /></Modal>;
  if (q.error) return <Modal size="md" title="Migrate" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}><Notice tone="critical" title="Couldn't check the machine">{errorText(q.error)}</Notice></Modal>;
  return <MigrateBody c={q.data} onClose={onClose} onStarted={setStarted} />;
}

/** The cluster card on a machine's overview: where it runs, its HA state, migrate, and its replication. Nothing on a single device. */
export function MachineCluster(p: { vmid: number; template?: boolean }) {
  const { live } = useEngine();
  return live ? <MachineClusterLive {...p} /> : null;
}

function MachineClusterLive({ vmid, template }: { vmid: number; template?: boolean }) {
  const { setup } = useEngine();
  const ov = useOverview();
  const [open, setOpen] = useState(false);
  const clustered = ov.data?.clustered === true;
  const check = useQuery({ queryKey: ["cluster", "migrate", vmid], queryFn: () => clusterApi.migrateCheck(vmid), enabled: clustered, retry: 0, staleTime: 15_000 });
  const ha = useQuery({ queryKey: ["cluster", "ha-guest", vmid], queryFn: () => clusterApi.haGuest(vmid), enabled: clustered, retry: 0 });
  if (!clustered) return null;
  const d = setup?.deviceName ?? "pve";
  return (
    <div className="lg:col-span-3 space-y-4">
      <Card className="p-5">
        <SectionTitle action={!template && check.data && <span className="flex flex-wrap justify-end gap-2"><Button size="sm" onClick={() => setOpen(true)}><Route className="h-3.5 w-3.5" />Migrate…</Button><RemoteMigrateButton vmid={vmid} /></span>}>Cluster</SectionTitle>
        <dl className="grid sm:grid-cols-3 gap-x-6 gap-y-3 text-compact">
          <div><dt className="text-xs text-ink-3">Runs on</dt><dd className="font-mono">{check.data?.node ?? (check.isPending ? "…" : "Unknown")}</dd></div>
          <div><dt className="text-xs text-ink-3">High availability</dt><dd>{ha.data?.managed ? <span className="inline-flex items-center gap-2"><Status kind={ha.data.current === "started" ? "good" : "idle"} label={ha.data.current ?? ha.data.state ?? "Managed"} /><Chip>{ha.data.sid}</Chip></span> : <span className="text-ink-2">Not managed</span>}</dd></div>
          <div><dt className="text-xs text-ink-3">Manage</dt><dd><Link className="text-accent hover:underline" to={`/${d}/datacenter/ha`}>High availability</Link></dd></div>
        </dl>
        {check.error && <p className="text-xs text-ink-3 mt-3">Migration isn't available to your account for this machine.</p>}
      </Card>
      {!template && <MachineReplication vmid={vmid} />}
      {open && <MigrateModal vmid={vmid} onClose={() => setOpen(false)} />}
    </div>
  );
}

