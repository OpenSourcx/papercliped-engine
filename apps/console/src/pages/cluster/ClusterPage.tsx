import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCopy, Cpu, LogIn, Plus, Trash2 } from "lucide-react";
import { clusterApi, type ClusterOverview, type LinkInput } from "../../data/engine/clusterApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Modal } from "../../ui/Modal.tsx";
import { QdeviceCard, NodeLifecycleGuide } from "./ClusterTools.tsx";
import { Button, Card, Chip, Field, Input, Notice, PageFrame, PageHeader, SectionTitle, Status } from "../../ui/primitives.tsx";
import { Async, LiveOnly, NodeSwitcher, TaskModal, TasksLink, TypedConfirm, useSelectedNode } from "../node/common.tsx";
import { useOverview, when } from "./common.tsx";

/* ── Links: one or more corosync network addresses ─────────────────────────────────── */

function LinkFields({ value, onChange, priority }: { value: LinkInput[]; onChange: (v: LinkInput[]) => void; priority: boolean }) {
  const set = (i: number, patch: Partial<LinkInput>) => onChange(value.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  return (
    <div className="space-y-2">
      {value.map((l, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_8rem_auto] gap-2 items-end">
          <Field label={`Link ${i} address`} htmlFor={`link-${i}`}><Input id={`link-${i}`} value={l.address} onChange={(e) => set(i, { address: e.target.value })} className="font-mono" placeholder="10.0.0.2" spellCheck={false} /></Field>
          {priority && <Field label="Priority" htmlFor={`link-pri-${i}`}><Input id={`link-pri-${i}`} type="number" min={0} max={255} value={l.priority ?? ""} onChange={(e) => set(i, { priority: e.target.value === "" ? undefined : Number(e.target.value) })} className="tabular-nums" /></Field>}
          <Button variant="ghost" aria-label={`Remove link ${i}`} onClick={() => onChange(value.filter((_, k) => k !== i))}><Trash2 className="h-4 w-4" /></Button>
        </div>
      ))}
      {value.length < 8 && <Button size="sm" onClick={() => onChange([...value, { address: "" }])}><Plus className="h-4 w-4" />Add a link</Button>}
    </div>
  );
}
const cleanLinks = (l: LinkInput[]) => l.filter((x) => x.address.trim()).map((x) => ({ address: x.address.trim(), ...(x.priority !== undefined ? { priority: x.priority } : {}) }));

/* ── Create ────────────────────────────────────────────────────────────────────────── */

function CreateModal({ local, onClose }: { local: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [links, setLinks] = useState<LinkInput[]>([]);
  const [typed, setTyped] = useState("");
  const [task, setTask] = useState<string | null>(null);
  const create = useMutation({ mutationFn: () => clusterApi.create({ name, confirm: typed, links: cleanLinks(links) }), onSuccess: (r) => setTask(r.task) });
  const valid = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,13}[A-Za-z0-9])?$/.test(name);
  if (task) return <TaskModal upid={task} title="Creating the cluster" onClose={() => { void qc.invalidateQueries(); onClose(); }} />;
  return (
    <Modal size="md" title="Create a cluster" subtitle={`${local} becomes the first node`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!valid || typed !== name} loading={create.isPending} onClick={() => create.mutate()}>Create cluster</Button></>}>
      <div className="space-y-5">
        <Notice tone="warning" title="This changes what this device is">A cluster shares its configuration between nodes. Leaving one again means reinstalling the node. Other devices join afterwards with the join information from this screen.</Notice>
        <Field label="Cluster name" hint="Letters, numbers and - (up to 15 characters). It can't be changed later." htmlFor="cl-name"><Input id="cl-name" value={name} onChange={(e) => setName(e.target.value)} className="font-mono" spellCheck={false} autoFocus /></Field>
        <div>
          <div className="text-compact font-medium text-ink-2 mb-1">Cluster network (optional)</div>
          <p className="text-xs text-ink-3 mb-2">Leave empty to use this device's address. Add a second link for a backup path.</p>
          <LinkFields value={links} onChange={setLinks} priority />
        </div>
        <Field label={<>Type <span className="font-mono text-ink">{name || "the cluster name"}</span> to confirm</>} htmlFor="cl-confirm"><Input id="cl-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" autoComplete="off" spellCheck={false} /></Field>
        {create.error && <p role="alert" className="text-compact text-critical">{errorText(create.error)}</p>}
      </div>
    </Modal>
  );
}

/* ── Join ──────────────────────────────────────────────────────────────────────────── */

function JoinModal({ local, onClose }: { local: string; onClose: () => void }) {
  const [paste, setPaste] = useState("");
  const [hostname, setHostname] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [password, setPassword] = useState("");
  const [links, setLinks] = useState<LinkInput[]>([]);
  const [typed, setTyped] = useState("");
  const [task, setTask] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const parse = useMutation({ mutationFn: () => clusterApi.parseJoinInfo(paste), onSuccess: (r) => { setHostname(r.ipAddress); setFingerprint(r.fingerprint); setNote("Filled in from the join information."); } });
  const join = useMutation({ mutationFn: () => clusterApi.join({ hostname: hostname.trim(), fingerprint: fingerprint.trim(), password, confirm: typed, links: cleanLinks(links) }), onSuccess: (r) => { setPassword(""); setTask(r.task); } });
  if (task) return <TaskModal upid={task} title="Joining the cluster" onClose={onClose} />;
  return (
    <Modal size="md" title="Join an existing cluster" subtitle={`${local} will take on that cluster's configuration`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!hostname.trim() || !fingerprint.trim() || !password || typed !== local} loading={join.isPending} onClick={() => join.mutate()}>Join cluster</Button></>}>
      <div className="space-y-5">
        <Notice tone="warning" title="This can't be undone from here">Joining replaces this device's own configuration with the cluster's, and ends your sign-in on this device. A device that already has machines can't join: back them up, join, then restore.</Notice>
        <Field label="Join information" hint="On a node in the cluster open Cluster, then Join information, and copy it here." htmlFor="join-paste">
          <div className="flex gap-2">
            <Input id="join-paste" value={paste} onChange={(e) => setPaste(e.target.value)} className="font-mono" spellCheck={false} autoComplete="off" />
            <Button disabled={!paste.trim()} loading={parse.isPending} onClick={() => parse.mutate()}>Read</Button>
          </div>
        </Field>
        {note && <p className="text-compact text-good">{note}</p>}
        {parse.error && <p role="alert" className="text-compact text-critical">{errorText(parse.error)}</p>}
        <Field label="Address of a node in the cluster" htmlFor="join-host"><Input id="join-host" value={hostname} onChange={(e) => setHostname(e.target.value)} className="font-mono" spellCheck={false} /></Field>
        <Field label="Certificate fingerprint" hint="Check it against the node's own certificate screen. It protects you from joining the wrong machine." htmlFor="join-fp"><Input id="join-fp" value={fingerprint} onChange={(e) => setFingerprint(e.target.value)} className="font-mono" spellCheck={false} /></Field>
        <Field label="Root password of that node" hint="Sent to Proxmox once. It is never stored, shown or logged." htmlFor="join-pw"><Input id="join-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" /></Field>
        <div>
          <div className="text-compact font-medium text-ink-2 mb-1">This device's cluster network (optional)</div>
          <LinkFields value={links} onChange={setLinks} priority={false} />
        </div>
        <Field label={<>Type <span className="font-mono text-ink">{local}</span> to confirm</>} htmlFor="join-confirm"><Input id="join-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" autoComplete="off" spellCheck={false} /></Field>
        {join.error && <p role="alert" className="text-compact text-critical">{errorText(join.error)}</p>}
      </div>
    </Modal>
  );
}

/* ── Join information (copy and paste) ─────────────────────────────────────────────── */

function JoinInfoModal({ onClose }: { onClose: () => void }) {
  const q = useQuery({ queryKey: ["cluster", "join-info"], queryFn: clusterApi.joinInfo, retry: 0 });
  const [copied, setCopied] = useState(false);
  return (
    <Modal size="md" title="Join information" subtitle="Paste this on the device that should join" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <Async q={q}>
        {(i) => (
          <div className="space-y-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-compact">
              <dt className="text-ink-3">Node</dt><dd className="font-mono">{i.node} ({i.ipAddress})</dd>
              <dt className="text-ink-3">Fingerprint</dt><dd className="font-mono break-all text-xs">{i.fingerprint}</dd>
            </dl>
            <Field label="Join information" htmlFor="ji"><textarea id="ji" readOnly rows={5} value={i.info} className="transition-control w-full rounded-lg bg-surface-2 border border-line text-xs font-mono text-ink p-3 break-all" onFocus={(e) => e.currentTarget.select()} /></Field>
            <Button onClick={() => { void navigator.clipboard?.writeText(i.info).then(() => setCopied(true)); }}><ClipboardCopy className="h-4 w-4" />{copied ? "Copied" : "Copy"}</Button>
            <p className="text-xs text-ink-3">It holds an address and a public fingerprint, no secrets. The joining device still needs this node's root password.</p>
          </div>
        )}
      </Async>
    </Modal>
  );
}

/* ── Remove a node ─────────────────────────────────────────────────────────────────── */

function RemoveModal({ node, onClose, onDone }: { node: string; onClose: () => void; onDone: () => void }) {
  const q = useQuery({ queryKey: ["cluster", "removal", node], queryFn: () => clusterApi.removal(node), retry: 0 });
  const remove = useMutation({ mutationFn: () => clusterApi.removeNode(node, node), onSuccess: () => { onDone(); onClose(); } });
  const g = q.data;
  return (
    <TypedConfirm title={`Remove ${node} from the cluster?`} subtitle="This takes it out of the cluster's records" phrase={node} action="Remove node" busy={remove.isPending} error={remove.error ? errorText(remove.error) : q.error ? errorText(q.error) : null} onClose={onClose} onConfirm={() => remove.mutate()}>
      {g && (
        <div className="space-y-3 text-compact">
          {g.online && <Notice tone="critical" title={`${node} is still online`}>Proxmox only removes a node that is switched off. Shut it down and keep it off first.</Notice>}
          {g.guests.length > 0 && <Notice tone="warning" title={`${g.guests.length} ${g.guests.length === 1 ? "machine is" : "machines are"} still configured on ${node}`}>{g.guests.map((x) => `${x.name} (${x.vmid})`).join(", ")}. Their files stay behind in /etc/pve/nodes/{node}; move or restore them elsewhere first if you need them.</Notice>}
          {(g.haResources.length > 0 || g.replicationJobs.length > 0) && <Notice tone="warning">{g.haResources.length > 0 && <>HA resources: {g.haResources.join(", ")}. </>}{g.replicationJobs.length > 0 && <>Replication jobs: {g.replicationJobs.join(", ")}. </>}Remove these first.</Notice>}
          <ol className="list-decimal pl-5 space-y-1 text-ink-2">{g.steps.map((s) => <li key={s}>{s}</li>)}</ol>
        </div>
      )}
    </TypedConfirm>
  );
}

/* ── The page ──────────────────────────────────────────────────────────────────────── */

function Body({ o }: { o: ClusterOverview }) {
  const qc = useQueryClient();
  const [, setNode] = useSelectedNode();
  const [dialog, setDialog] = useState<"create" | "join" | "info" | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const log = useQuery({ queryKey: ["cluster", "log"], queryFn: () => clusterApi.log(50), enabled: o.clustered, retry: 0 });
  return (
    <div className="space-y-6">
      {!o.clustered ? (
        <Card className="p-6">
          <div className="font-medium text-lead">This device is not in a cluster</div>
          <p className="text-compact text-ink-3 mt-1 max-w-prose">It runs on its own, and everything else in the console works without a cluster. Create one to start a new cluster with this device as the first node, or join an existing cluster to share machines, storage and settings with its nodes.</p>
          <div className="flex flex-wrap gap-2 mt-4">
            <Button variant="primary" onClick={() => setDialog("create")}><Plus className="h-4 w-4" />Create cluster…</Button>
            <Button onClick={() => setDialog("join")}><LogIn className="h-4 w-4" />Join a cluster…</Button>
          </div>
        </Card>
      ) : (
        <>
          <Card className="p-5">
            <dl className="grid sm:grid-cols-2 lg:grid-cols-5 gap-x-6 gap-y-3 text-compact">
              <div><dt className="text-xs text-ink-3">Cluster</dt><dd className="font-medium font-mono">{o.name}</dd></div>
              <div><dt className="text-xs text-ink-3">Quorum</dt><dd>{o.quorate ? <Status kind="good" label="Quorate" /> : <Status kind="critical" label="No quorum" />}</dd></div>
              <div><dt className="text-xs text-ink-3">Nodes online</dt><dd className="tabular-nums">{o.onlineCount} of {o.nodes.length}</dd></div>
              <div><dt className="text-xs text-ink-3">Votes</dt><dd className="tabular-nums">{o.votes}</dd></div>
              <div><dt className="text-xs text-ink-3">Proxmox VE</dt><dd className="tabular-nums">{o.pveVersion ?? "Unknown"}</dd></div>
            </dl>
            <div className="flex flex-wrap gap-2 mt-4">
              <Button onClick={() => setDialog("info")}><ClipboardCopy className="h-4 w-4" />Join information</Button>
            </div>
          </Card>
          {!o.quorate && <Notice tone="critical" title="The cluster has lost quorum">Changes to shared settings and starting machines are blocked until more than half of the votes are back online.</Notice>}
          {o.denied.config && <Notice tone="info">Your Proxmox account can't read the cluster configuration (it needs Sys.Audit), so addresses and votes are missing.</Notice>}
          <section>
            <SectionTitle>Nodes</SectionTitle>
            <Card className="overflow-x-auto edge-fade-x">
              <table className="w-full text-compact min-w-[640px]">
                <thead><tr className="border-b border-line text-ink-3 text-left"><th className="font-normal px-4 h-10">Node</th><th className="font-normal px-3">State</th><th className="font-normal px-3">ID</th><th className="font-normal px-3">Votes</th><th className="font-normal px-3">Link addresses</th><th className="font-normal px-3">Machines</th><th className="px-3"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {o.nodes.map((n) => (
                    <tr key={n.name} className="border-b border-line last:border-0">
                      <td className="px-4 py-3"><div className="flex items-center gap-2"><Cpu className="h-4 w-4 text-ink-3" aria-hidden /><span className="font-mono">{n.name}</span>{n.local && <Chip tone="accent">This device</Chip>}</div></td>
                      <td className="px-3">{n.online ? <Status kind="good" label="Online" /> : <Status kind="off" label="Offline" />}</td>
                      <td className="px-3 tabular-nums">{n.nodeid ?? "–"}</td>
                      <td className="px-3 tabular-nums">{n.votes ?? "–"}</td>
                      <td className="px-3 font-mono text-xs">{n.links.length ? n.links.map((l) => `${l.n}: ${l.address}`).join(", ") : n.ip ?? "–"}</td>
                      <td className="px-3 tabular-nums">{n.guests.running} of {n.guests.total}</td>
                      <td className="px-3"><div className="flex gap-1.5 justify-end">
                        {o.nodes.length > 1 && <Button size="sm" onClick={() => setNode(n.local ? null : n.name)}>Manage</Button>}
                        {!n.local && o.canChange && <Button size="sm" variant="ghost" className="text-critical" aria-label={`Remove ${n.name}`} onClick={() => setRemoving(n.name)}>Remove…</Button>}
                      </div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <p className="text-xs text-ink-3 mt-2">A node is removed only when it is switched off. To add a node, open this screen on that device and choose Join a cluster.</p>
          </section>
          <section className="grid md:grid-cols-2 gap-4">
            <Card className="p-5">
              <div className="font-medium mb-2">Network and quorum device</div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-compact">
                <dt className="text-ink-3">Link mode</dt><dd>{String(o.totem?.link_mode ?? "Unknown")}</dd>
                <dt className="text-ink-3">Authentication</dt><dd>{String(o.totem?.secauth ?? "Unknown")}</dd>
                <dt className="text-ink-3">Config version</dt><dd className="tabular-nums">{o.configVersion ?? "Unknown"}</dd>
                <dt className="text-ink-3">Quorum device</dt><dd>{o.qdevice?.configured ? "Set up" : "None"}</dd>
              </dl>
              <p className="text-xs text-ink-3 mt-3">Shown here as Proxmox reports them. To change them, use the guide beside this card.</p>
            </Card>
            <Card className="p-5">
              <div className="font-medium mb-2">Recent cluster log</div>
              {log.data?.entries.length ? (
                <ul className="space-y-1 max-h-48 overflow-auto text-xs font-mono text-ink-2">
                  {log.data.entries.slice(0, 20).map((e, i) => <li key={i} className="break-words"><span className="text-ink-3">{when(e.time)}</span> {e.node} {e.tag}: {e.message}</li>)}
                </ul>
              ) : <p className="text-compact text-ink-3">{log.isPending ? "Loading…" : "Nothing logged yet."}</p>}
            </Card>
          </section>
          <section className="grid md:grid-cols-2 gap-4">
            <QdeviceCard />
            <NodeLifecycleGuide />
          </section>
        </>
      )}
      {dialog === "create" && <CreateModal local={o.local} onClose={() => { setDialog(null); void qc.invalidateQueries(); }} />}
      {dialog === "join" && <JoinModal local={o.local} onClose={() => setDialog(null)} />}
      {dialog === "info" && <JoinInfoModal onClose={() => setDialog(null)} />}
      {removing && <RemoveModal node={removing} onClose={() => setRemoving(null)} onDone={() => void qc.invalidateQueries()} />}
    </div>
  );
}

export function ClusterConfigPage() {
  const q = useOverview();
  return (
    <PageFrame width="6xl">
      <PageHeader title="Cluster" subtitle="Which nodes are in this datacenter, whether it has quorum, and how nodes join or leave." actions={<><NodeSwitcher /><TasksLink /></>} />
      <LiveOnly><Async q={q}>{(o) => <Body o={o} />}</Async></LiveOnly>
    </PageFrame>
  );
}

