import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, ListChecks, Palette, Square } from "lucide-react";
import { nodeApi, type MappingGroup, type TagInfo, type TaskRow, type Values } from "../../data/engine/nodeApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { formatBytes, formatUptime } from "../../lib/storage.ts";
import { BarMeter } from "../../ui/meters.tsx";
import { Button, Card, Chip, EmptyState, Field, Input, Notice, PageFrame, PageHeader, SectionTitle, Select, Status } from "../../ui/primitives.tsx";
import { Async, changedValues, Denied, LiveOnly, NodeSwitcher, SaveBar, SchemaForm, TaskModal, TasksLink, useNodeName, useSelectedNode } from "./common.tsx";

/* ── Cluster summary ───────────────────────────────────────────────────────────────── */

function ClusterBody() {
  const q = useQuery({ queryKey: ["node", "cluster"], queryFn: nodeApi.cluster, refetchInterval: 15_000, retry: 1 });
  const [, setNode] = useSelectedNode();
  return (
    <Async q={q}>
      {(c) => (
        <div className="space-y-6">
          <Card className="p-5">
            <dl className="grid sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3 text-compact">
              <div><dt className="text-xs text-ink-3">Datacenter</dt><dd className="font-medium">{c.clustered ? c.name : "Single device"}</dd></div>
              <div><dt className="text-xs text-ink-3">Quorum</dt><dd>{!c.clustered ? <span className="text-ink-2">Not needed</span> : c.quorate ? <Status kind="good" label="Quorate" /> : <Status kind="critical" label="No quorum" />}</dd></div>
              <div><dt className="text-xs text-ink-3">Proxmox VE</dt><dd className="tabular-nums">{c.version ?? "Unknown"}</dd></div>
              <div><dt className="text-xs text-ink-3">Machines</dt><dd className="tabular-nums">{c.guests.running} running of {c.guests.total}</dd></div>
            </dl>
          </Card>
          {c.clustered && !c.quorate && <Notice tone="critical" title="The datacenter has lost quorum">Changes to shared settings and starting machines are blocked until a majority of nodes are back online.</Notice>}
          {c.statusDenied && <Denied what="the full cluster status (it needs the Sys.Audit permission)" />}
          <section>
            <SectionTitle>{c.nodes.length === 1 ? "Device" : `${c.nodes.length} nodes`}</SectionTitle>
            <div className="grid md:grid-cols-2 gap-4">
              {c.nodes.map((n) => (
                <Card key={n.name} className="p-5">
                  <div className="flex items-center gap-2 mb-1">
                    <Cpu className="h-4 w-4 text-ink-2" aria-hidden />
                    <span className="font-medium">{n.name}</span>
                    {n.local && <Chip tone="accent">This device</Chip>}
                    <span className="ml-auto">{n.online ? <Status kind="good" label="Online" /> : <Status kind="off" label="Offline" />}</span>
                  </div>
                  <div className="text-xs text-ink-3 font-mono mb-3">{n.ip ?? ""}{n.level ? ` · subscription ${n.level}` : ""}</div>
                  {n.online && n.cpu !== null ? (
                    <div className="space-y-3">
                      <BarMeter label="CPU" pct={n.cpu * 100} value={`${(n.cpu * 100).toFixed(1)}% of ${n.maxcpu ?? "?"} CPUs`} />
                      {n.mem !== null && n.maxmem ? <BarMeter label="Memory" pct={(n.mem / n.maxmem) * 100} value={`${formatBytes(n.mem)} of ${formatBytes(n.maxmem)}`} /> : null}
                      <div className="text-compact text-ink-2 tabular-nums">{n.guests.running} of {n.guests.total} machines running{n.uptime ? ` · up ${formatUptime(n.uptime)}` : ""}</div>
                    </div>
                  ) : <p className="text-compact text-ink-3">No live figures while the node is offline.</p>}
                  {c.nodes.length > 1 && <Button size="sm" className="mt-4" onClick={() => setNode(n.local ? null : n.name)}>Manage {n.name}</Button>}
                </Card>
              ))}
            </div>
          </section>
        </div>
      )}
    </Async>
  );
}

export function ClusterPage() {
  return (
    <PageFrame width="6xl">
      <PageHeader title="Datacenter" subtitle="Every node in this datacenter with its load, and whether the cluster has quorum." actions={<><NodeSwitcher /><TasksLink /></>} />
      <LiveOnly><ClusterBody /></LiveOnly>
    </PageFrame>
  );
}

/* ── Options ───────────────────────────────────────────────────────────────────────── */

const GROUPS: { title: string; keys: string[]; hint?: string }[] = [
  { title: "Defaults", keys: ["keyboard", "language", "console", "description", "location"] },
  { title: "Network", keys: ["http_proxy", "mac_prefix", "migration", "bwlimit", "replication"] },
  { title: "Machines", keys: ["next-id", "max_workers", "tag-style", "user-tag-access", "registered-tags"] },
  { title: "High availability and mail", keys: ["fencing", "ha", "crs", "email_from"] },
];
const LABELS: Record<string, string> = { keyboard: "Keyboard layout", language: "Language", console: "Console viewer", description: "Notes", location: "Location", http_proxy: "HTTP proxy", mac_prefix: "MAC address prefix", migration: "Migration", bwlimit: "Bandwidth limits (KiB/s)", replication: "Replication", "next-id": "Machine number range", max_workers: "Parallel workers per node", "tag-style": "Tag style", "user-tag-access": "Who may set tags", "registered-tags": "Protected tags", fencing: "Fencing", ha: "HA settings", crs: "Resource scheduling", email_from: "Send mail from" };

function OptionsBody() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["node", "options"], queryFn: nodeApi.options, retry: 1 });
  const [draft, setDraft] = useState<Values | null>(null);
  const [saved, setSaved] = useState(false);
  const all = GROUPS.flatMap((g) => g.keys);
  const save = useMutation({
    mutationFn: (v: Values) => nodeApi.saveOptions(changedValues(q.data!.values, v, all)),
    onSuccess: () => {
      setDraft(null);
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ["node", "options"] });
    },
  });
  return (
    <Async q={q}>
      {(o) => {
        const value = draft ?? o.values;
        const dirty = draft !== null && Object.keys(changedValues(o.values, draft, all)).length > 0;
        return (
          <div className="space-y-8">
            {GROUPS.map((g) => (
              <section key={g.title}>
                <SectionTitle>{g.title}</SectionTitle>
                <Card className="p-5"><SchemaForm schema={o.schema} value={value} only={g.keys} labels={LABELS} onChange={(v) => { setDraft(v); setSaved(false); }} /></Card>
              </section>
            ))}
            <SaveBar dirty={dirty} busy={save.isPending} error={save.error ? errorText(save.error) : null} saved={saved} onSave={() => draft && save.mutate(draft)} onReset={() => setDraft(null)} />
          </div>
        );
      }}
    </Async>
  );
}

export function OptionsPage() {
  return (
    <PageFrame width="4xl">
      <PageHeader title="Datacenter options" subtitle="Settings that apply to every node and machine. Proxmox checks each value and your permission when you save." actions={<TasksLink />} />
      <LiveOnly><OptionsBody /></LiveOnly>
    </PageFrame>
  );
}

/* ── Tags ──────────────────────────────────────────────────────────────────────────── */

const hex = (v: string) => v.replace(/^#/, "").toLowerCase();
/** The color picker needs a starting value; these are its neutral starting points, not styling. */
const rgbHex = (r: number, g: number, b: number) => `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
const PICKER_BG = rgbHex(128, 128, 128);
const PICKER_FG = rgbHex(255, 255, 255);

function TagRow({ t, onSave, busy }: { t: TagInfo; onSave: (bg: string | null, fg: string | null) => void; busy: boolean }) {
  const [bg, setBg] = useState(t.color ? `#${t.color.background}` : "");
  const [fg, setFg] = useState(t.color?.foreground ? `#${t.color.foreground}` : "");
  const changed = hex(bg) !== (t.color?.background ?? "") || hex(fg) !== (t.color?.foreground ?? "");
  return (
    <tr className="border-b border-line last:border-0">
      <td className="px-4 py-3">
        <span className="inline-flex items-center rounded-sm px-2 h-6 text-xs font-medium border border-line bg-surface-2" style={bg ? { backgroundColor: bg, color: fg || undefined } : undefined}>{t.tag}</span>
        {t.registered && <Chip className="ml-2">Protected</Chip>}
      </td>
      <td className="px-3 tabular-nums text-ink-2">{t.count}</td>
      <td className="px-3">
        <div className="flex items-center gap-2">
          <Input type="color" aria-label={`Background for ${t.tag}`} value={bg || PICKER_BG} onChange={(e) => setBg(e.target.value)} className="w-14 p-1" />
          <Input type="color" aria-label={`Text color for ${t.tag}`} value={fg || PICKER_FG} onChange={(e) => setFg(e.target.value)} className="w-14 p-1" />
        </div>
      </td>
      <td className="px-3"><div className="flex gap-1.5 justify-end"><Button size="sm" variant="primary" disabled={!changed || !bg} loading={busy} onClick={() => onSave(hex(bg), fg ? hex(fg) : null)}>Save</Button>{t.color && <Button size="sm" variant="ghost" disabled={busy} onClick={() => onSave(null, null)}>Clear</Button>}</div></td>
    </tr>
  );
}

function TagsBody() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["node", "tags"], queryFn: nodeApi.tags, retry: 1 });
  const save = useMutation({ mutationFn: nodeApi.saveTags, onSuccess: () => void qc.invalidateQueries({ queryKey: ["node", "tags"] }) });
  return (
    <Async q={q}>
      {(d) => (
        <div className="space-y-4">
          {d.denied && <Denied what="the datacenter's tag settings (they need the Sys.Audit permission)" />}
          {save.error && <Notice tone="critical" title="Proxmox didn't save that">{errorText(save.error)}</Notice>}
          <Card className="p-5 grid sm:grid-cols-2 gap-4 max-w-xl">
            <Field label="Shape in lists" htmlFor="tag-shape"><Select id="tag-shape" value={d.style.shape} onChange={(e) => save.mutate({ shape: e.target.value })}>{["full", "circle", "dense", "none"].map((s) => <option key={s} value={s}>{s}</option>)}</Select></Field>
            <Field label="Order" htmlFor="tag-order"><Select id="tag-order" value={d.style.ordering} onChange={(e) => save.mutate({ ordering: e.target.value })}><option value="alphabetical">Alphabetical</option><option value="config">As set on the machine</option></Select></Field>
          </Card>
          {d.tags.length === 0 ? <Card><EmptyState icon={<Palette className="h-5 w-5" />} title="No tags yet" body="Tags added to machines show up here, where you can give them colors." /></Card> : (
            <Card className="overflow-x-auto">
              <table className="w-full text-compact min-w-[560px]">
                <thead><tr className="border-b border-line text-ink-3 text-left"><th className="font-normal px-4 h-10">Tag</th><th className="font-normal px-3">Machines</th><th className="font-normal px-3">Colors</th><th className="px-3"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>{d.tags.map((t) => <TagRow key={`${t.tag}:${t.color?.background}:${t.color?.foreground}`} t={t} busy={save.isPending} onSave={(bg, fg) => save.mutate({ colors: { [t.tag]: bg ? { background: bg, foreground: fg } : null } })} />)}</tbody>
              </table>
            </Card>
          )}
        </div>
      )}
    </Async>
  );
}

export function TagsPage() {
  return (
    <PageFrame width="4xl">
      <PageHeader title="Tags" subtitle="Every tag in use, how many machines carry it, and the color it shows in. Colors are stored in the datacenter's tag style." />
      <LiveOnly><TagsBody /></LiveOnly>
    </PageFrame>
  );
}

/* ── Resource mappings ─────────────────────────────────────────────────────────────── */

function MappingList({ title, g }: { title: string; g: MappingGroup }) {
  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      {g.denied ? <Denied what={`${title.toLowerCase()} mappings`} /> : g.items.length === 0 ? <p className="text-compact text-ink-3">None defined.</p> : (
        <Card className="divide-y divide-line">
          {g.items.map((m) => (
            <div key={m.id} className="px-4 py-3">
              <div className="flex items-center gap-2"><span className="font-mono font-medium">{m.id}</span>{m.problems.length > 0 && <Chip tone="warning">{m.problems.length} {m.problems.length === 1 ? "problem" : "problems"}</Chip>}</div>
              {m.description && <p className="text-compact text-ink-3">{m.description}</p>}
              <ul className="mt-1.5 space-y-0.5">{m.map.map((x, i) => <li key={i} className="font-mono text-xs text-ink-2 break-all">{x}</li>)}</ul>
              {m.problems.map((p, i) => <p key={i} className="text-compact text-warning mt-1">{p}</p>)}
            </div>
          ))}
        </Card>
      )}
    </section>
  );
}

export function MappingsPage() {
  const q = useQuery({ queryKey: ["node", "mappings"], queryFn: nodeApi.mappings, retry: 1 });
  return (
    <PageFrame width="4xl">
      <PageHeader title="Resource mappings" subtitle="Hardware and folders given a name that every node can map to its own device, so machines using them can move between nodes. Defined in Proxmox." />
      <LiveOnly>
        <Async q={q}>{(m) => <div className="space-y-6"><MappingList title="PCI devices" g={m.pci} /><MappingList title="USB devices" g={m.usb} /><MappingList title="Directories" g={m.dir} /></div>}</Async>
      </LiveOnly>
    </PageFrame>
  );
}

/* ── Tasks across nodes ────────────────────────────────────────────────────────────── */

const SINCE: [string, string][] = [["", "Any time"], ["3600", "Last hour"], ["86400", "Last day"], ["604800", "Last week"]];

function statusOf(t: TaskRow) {
  if (t.status === null) return <Status kind="working" label="Running" />;
  if (t.status === "OK") return <Status kind="good" label="OK" />;
  if (t.status.startsWith("WARNINGS")) return <Status kind="warning" label={t.status} />;
  return <Status kind="critical" label={t.status.length > 40 ? `${t.status.slice(0, 40)}…` : t.status} />;
}
const took = (t: TaskRow) => {
  const s = Math.max(0, (t.end ?? Math.floor(Date.now() / 1000)) - t.start);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

function TasksBody() {
  const [params] = useSearchParams();
  const nodes = useQuery({ queryKey: ["node", "nodes"], queryFn: nodeApi.nodes, retry: 1 });
  const [node, setNode] = useState("all");
  const [type, setType] = useState(params.get("type") ?? "");
  const [user, setUser] = useState("");
  const [status, setStatus] = useState("");
  const [since, setSince] = useState("");
  const [open, setOpen] = useState<TaskRow | null>(null);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["node", "tasks", node, type, user, status, since],
    queryFn: () => nodeApi.tasks({ node, type: type || undefined, user: user || undefined, status: status || undefined, since: since ? Math.floor(Date.now() / 1000) - Number(since) : undefined, limit: 200 }),
    refetchInterval: 5000,
    retry: 1,
  });
  const stop = useMutation({ mutationFn: (t: TaskRow) => nodeApi.stopTask(t.upid), onSuccess: () => void qc.invalidateQueries({ queryKey: ["node", "tasks"] }) });
  useEffect(() => setType(params.get("type") ?? ""), [params]);
  return (
    <>
      <Card className="p-4 mb-4">
        <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <Field label="Node" htmlFor="t-node"><Select id="t-node" value={node} onChange={(e) => setNode(e.target.value)}><option value="all">All nodes</option>{(nodes.data?.nodes ?? []).map((n) => <option key={n.node} value={n.node}>{n.node}</option>)}</Select></Field>
          <Field label="Type" htmlFor="t-type"><Input id="t-type" value={type} onChange={(e) => setType(e.target.value.trim())} placeholder="vzdump" className="font-mono" /></Field>
          <Field label="User" htmlFor="t-user"><Input id="t-user" value={user} onChange={(e) => setUser(e.target.value.trim())} placeholder="sam@pve" className="font-mono" /></Field>
          <Field label="Status" htmlFor="t-status"><Select id="t-status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any</option><option value="running">Running</option><option value="ok">OK</option><option value="warning">Warnings</option><option value="error">Failed</option></Select></Field>
          <Field label="Since" htmlFor="t-since"><Select id="t-since" value={since} onChange={(e) => setSince(e.target.value)}>{SINCE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        </div>
      </Card>
      {stop.error && <Notice tone="critical" className="mb-3" title="Proxmox didn't stop that task">{errorText(stop.error)}</Notice>}
      <Async q={q}>
        {(d) => d.tasks.length === 0 ? (
          <Card><EmptyState icon={<ListChecks className="h-5 w-5" />} title="No tasks match" body="Change the filters, or wait: tasks show up here as Proxmox runs them." /></Card>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-compact min-w-[820px]">
              <thead><tr className="border-b border-line text-ink-3 text-left"><th className="font-normal px-4 h-10">Started</th><th className="font-normal px-3">Task</th><th className="font-normal px-3">Node</th><th className="font-normal px-3">User</th><th className="font-normal px-3 text-right">Took</th><th className="font-normal px-3">Status</th><th className="px-3 w-px"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {d.tasks.map((t) => (
                  <tr key={t.upid} className="border-b border-line last:border-0 hover:bg-surface-2/60">
                    <td className="px-4 py-2.5 whitespace-nowrap tabular-nums text-ink-2">{new Date(t.start * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "medium" })}</td>
                    <td className="px-3"><button className="text-left hover:underline underline-offset-2" onClick={() => setOpen(t)}><span className="font-mono">{t.type}</span>{t.id && <span className="text-ink-3 ml-2 font-mono text-xs">{t.id}</span>}</button></td>
                    <td className="px-3 font-mono text-ink-2">{t.node}</td>
                    <td className="px-3 text-ink-2">{t.user}</td>
                    <td className="px-3 text-right tabular-nums whitespace-nowrap">{took(t)}</td>
                    <td className="px-3">{statusOf(t)}</td>
                    <td className="px-3">{t.status === null && <Button size="sm" variant="ghost" aria-label={`Stop ${t.type} task`} onClick={() => stop.mutate(t)} loading={stop.isPending && stop.variables?.upid === t.upid}><Square className="h-4 w-4" />Stop</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Async>
      {open && <TaskModal upid={open.upid} title={open.type} onClose={() => setOpen(null)} />}
    </>
  );
}

export function TasksAllPage() {
  const { multi } = useNodeName();
  void multi;
  return (
    <PageFrame width="6xl">
      <PageHeader title="Tasks" subtitle="Everything Proxmox has run, on every node, under the person who started it. Open one for its log; stop one that is still running." />
      <LiveOnly><TasksBody /></LiveOnly>
    </PageFrame>
  );
}
