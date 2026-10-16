import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, FolderTree, Plus, Trash2, Usb } from "lucide-react";
import { dcApi, type Mapping, type MappingEntry, type MappingKind } from "../../data/engine/dcApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, EmptyState, Field, Input, Notice, PageFrame, PageHeader, Select, Tabs, Toggle } from "../../ui/primitives.tsx";
import { Async, LiveOnly, TypedConfirm, useNodes } from "./common.tsx";
import { DataTable, Td } from "./dc.tsx";

const TEXT: Record<MappingKind, { title: string; one: string; icon: typeof Cpu; empty: string }> = {
  pci: { title: "PCI devices", one: "PCI mapping", icon: Cpu, empty: "Name a graphics card or other PCI device once, point each node at its own copy, and give the name to a machine. The machine can then move between nodes." },
  usb: { title: "USB devices", one: "USB mapping", icon: Usb, empty: "Name a USB device (a key, a dongle) so machines can use it by name on whichever node it is plugged into." },
  dir: { title: "Directories", one: "directory mapping", icon: FolderTree, empty: "Share a folder from each node with machines through VirtIO-FS under one name." },
};

const hex = (v: string | null) => (v ?? "").replace(/^0x/, "");
const blank = (node: string): Partial<MappingEntry> => ({ node, path: "", id: "", subsystemId: "", description: "" });

/** One node's device: pick it from what the node reports, or type the path by hand. */
function EntryRow({ kind, entry, nodes, onChange, onRemove, removable }: { kind: MappingKind; entry: Partial<MappingEntry>; nodes: string[]; onChange: (e: Partial<MappingEntry>) => void; onRemove: () => void; removable: boolean }) {
  const hw = useQuery({ queryKey: ["node", "hardware", entry.node], queryFn: () => dcApi.hardware(entry.node), enabled: kind !== "dir" && !!entry.node, retry: 0, staleTime: 30_000 });
  const options = kind === "pci"
    ? (hw.data?.pci ?? []).map((d) => ({ key: d.id, label: `${d.id} ${d.vendorName ?? ""} ${d.deviceName ?? ""}${d.iommuGroup !== null ? ` (group ${d.iommuGroup})` : ""}`, fill: { path: d.id.replace(/\.\d$/, ""), id: `${hex(d.vendor)}:${hex(d.device)}`, subsystemId: d.subsystemVendor && d.subsystemDevice ? `${hex(d.subsystemVendor)}:${hex(d.subsystemDevice)}` : "", iommugroup: d.iommuGroup } }))
    : (hw.data?.usb ?? []).map((d) => ({ key: `${d.usbpath}`, label: `${d.vendid}:${d.prodid} ${[d.manufacturer, d.product].filter(Boolean).join(" ")} (${d.usbpath})`, fill: { path: d.usbpath ?? "", id: `${d.vendid}:${d.prodid}`, subsystemId: "", iommugroup: null } }));
  const idLabel = (n: string) => `${n} ${entry.node}`;
  return (
    <div className="rounded-lg border border-line p-3 space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Node" htmlFor={`mp-node-${entry.node}`} className="basis-40"><Select id={`mp-node-${entry.node}`} aria-label="Node" value={entry.node ?? ""} onChange={(e) => onChange({ ...entry, node: e.target.value })}>{nodes.map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field>
        {kind !== "dir" && (
          <Field label="Device on this node" className="flex-1 basis-60">
            <Select aria-label={idLabel("Device on")} value="" onChange={(e) => { const o = options.find((x) => x.key === e.target.value); if (o) onChange({ ...entry, ...o.fill }); }}>
              <option value="">{hw.isPending ? "Reading devices…" : hw.data && options.length === 0 ? "No devices found (or not permitted)" : "Pick a device"}</option>
              {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </Select>
          </Field>
        )}
        {removable && <Button size="sm" variant="ghost" onClick={onRemove}>Remove node</Button>}
      </div>
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label={kind === "dir" ? "Folder path" : kind === "usb" ? "USB path" : "PCI address"} hint={kind === "pci" ? "Leave off the function to pass all of them." : undefined}><Input aria-label={idLabel("Path on")} className="font-mono" value={entry.path ?? ""} onChange={(e) => onChange({ ...entry, path: e.target.value })} /></Field>
        {kind !== "dir" && <Field label="Vendor and device ID" hint="Like 10de:2204"><Input aria-label={idLabel("Device ID on")} className="font-mono" value={entry.id ?? ""} onChange={(e) => onChange({ ...entry, id: e.target.value })} /></Field>}
        {kind === "pci" && <Field label="Subsystem ID" hint="Optional"><Input aria-label={idLabel("Subsystem ID on")} className="font-mono" value={entry.subsystemId ?? ""} onChange={(e) => onChange({ ...entry, subsystemId: e.target.value })} /></Field>}
      </div>
    </div>
  );
}

function MappingModal({ kind, mapping, onClose, onDone }: { kind: MappingKind; mapping: Mapping | null; onClose: () => void; onDone: () => void }) {
  const nodes = useNodes();
  const names = (nodes.data?.nodes ?? []).map((n) => n.node);
  const local = nodes.data?.local ?? "";
  const [id, setId] = useState(mapping?.id ?? "");
  const [description, setDescription] = useState(mapping?.description ?? "");
  const [mdev, setMdev] = useState(mapping?.mdev ?? false);
  const [live, setLive] = useState(mapping?.liveMigration ?? false);
  const [rows, setRows] = useState<Partial<MappingEntry>[]>(mapping ? mapping.map : [blank(local)]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const free = names.filter((n) => !rows.some((r) => r.node === n));
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { description: description.trim(), ...(kind === "pci" ? { mdev, liveMigration: live } : {}), map: rows.map((r) => ({ node: r.node, path: r.path, ...(kind !== "dir" ? { id: r.id } : {}), ...(kind === "pci" && r.subsystemId ? { subsystemId: r.subsystemId } : {}), ...(kind === "pci" && typeof r.iommugroup === "number" ? { iommugroup: r.iommugroup } : {}) })) };
      if (mapping) await dcApi.updateMapping(kind, mapping.id, { ...body, digest: mapping.digest });
      else await dcApi.createMapping(kind, { ...body, id: id.trim() });
      onDone();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal size="lg" icon={<Cpu className="h-5 w-5" />} title={mapping ? `Edit ${mapping.id}` : `Add a ${TEXT[kind].one}`} subtitle="One name, one device per node" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={(!mapping && !/^[A-Za-z][A-Za-z0-9_-]+$/.test(id)) || rows.length === 0 || rows.some((r) => !r.path || (kind !== "dir" && !r.id))} onClick={() => void go()}>{mapping ? "Save mapping" : "Add mapping"}</Button></>}>
      <div className="space-y-5">
        {!mapping && <Field label="Name" hint="Letters, numbers, - and _. Machines refer to this name." htmlFor="mp-id"><Input id="mp-id" className="font-mono" value={id} onChange={(e) => setId(e.target.value)} autoFocus /></Field>}
        <Field label="Description" htmlFor="mp-desc"><Input id="mp-desc" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        {kind === "pci" && (
          <div className="flex flex-wrap gap-6">
            <div className="flex items-center gap-3"><Toggle checked={mdev} onChange={setMdev} label="Mediated devices" /><span className="text-compact text-ink-2">Can provide mediated devices (vGPU)</span></div>
            <div className="flex items-center gap-3"><Toggle checked={live} onChange={setLive} label="Live migration" /><span className="text-compact text-ink-2">Machines can be live-migrated (experimental)</span></div>
          </div>
        )}
        <div className="space-y-3">
          {rows.map((r, i) => <EntryRow key={`${r.node}-${i}`} kind={kind} entry={r} nodes={names.length ? names : [local]} onChange={(e) => setRows(rows.map((x, j) => (j === i ? e : x)))} onRemove={() => setRows(rows.filter((_, j) => j !== i))} removable={rows.length > 1} />)}
          {(kind === "usb" || free.length > 0) && <Button size="sm" onClick={() => setRows([...rows, blank(free[0] ?? local)])}><Plus className="h-4 w-4" />Add a node</Button>}
        </div>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function List({ kind, items }: { kind: MappingKind; items: Mapping[] }) {
  const qc = useQueryClient();
  const T = TEXT[kind];
  const [edit, setEdit] = useState<Mapping | "new" | null>(null);
  const [del, setDel] = useState<Mapping | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["node", "mappings"] });
  const remove = useMutation({ mutationFn: (m: Mapping) => dcApi.deleteMapping(kind, m.id), onSuccess: () => { setDel(null); void refresh(); } });
  return (
    <div className="space-y-4">
      <div><Button variant="primary" onClick={() => setEdit("new")}><Plus className="h-4 w-4" />Add {T.one}…</Button></div>
      <Card>
        {items.length === 0 ? <EmptyState icon={<T.icon className="h-5 w-5" />} title={`No ${T.title.toLowerCase()} mapped`} body={T.empty} /> : (
          <DataTable label={T.title} head={["Name", "Devices", "Checks", ""]} min={640}>
            {items.map((m) => (
              <tr key={m.id} className="border-b border-line last:border-0">
                <Td><div className="font-mono">{m.id}</div>{m.description && <div className="text-xs text-ink-3">{m.description}</div>}<div className="flex gap-1 mt-1">{m.mdev && <Chip>vGPU</Chip>}{m.liveMigration && <Chip>live migration</Chip>}</div></Td>
                <Td>{m.map.map((e) => <div key={`${e.node}-${e.path}`} className="font-mono text-xs"><span className="text-ink-3">{e.node}</span> {e.path}{e.id ? ` · ${e.id}` : ""}{e.iommugroup !== null ? ` · group ${e.iommugroup}` : ""}</div>)}</Td>
                <Td>{m.checks.length === 0 ? <span className="text-ink-3">No problems</span> : m.checks.map((c, i) => <p key={i} className={c.severity === "error" ? "text-compact text-critical" : "text-compact text-warning"}>{c.message}</p>)}</Td>
                <Td><div className="flex gap-1 justify-end"><Button size="sm" variant="ghost" onClick={() => setEdit(m)}>Edit</Button><Button size="sm" variant="ghost" className="text-critical" aria-label={`Delete ${m.id}`} onClick={() => setDel(m)}><Trash2 className="h-4 w-4" /></Button></div></Td>
              </tr>
            ))}
          </DataTable>
        )}
      </Card>
      {edit && <MappingModal key={edit === "new" ? "new" : edit.id} kind={kind} mapping={edit === "new" ? null : edit} onClose={() => setEdit(null)} onDone={() => void refresh()} />}
      {del && <TypedConfirm title={`Delete ${del.id}?`} phrase={del.id} action="Delete mapping" busy={remove.isPending} error={remove.error ? errorText(remove.error) : null} onConfirm={() => remove.mutate(del)} onClose={() => setDel(null)}><p className="text-compact text-ink-2">Machines that use this name will no longer start until they are pointed at a device.</p></TypedConfirm>}
    </div>
  );
}

export function MappingsManagePage() {
  const q = useQuery({ queryKey: ["node", "mappings"], queryFn: dcApi.mappings, retry: 1 });
  const [tab, setTab] = useState<MappingKind>("pci");
  return (
    <PageFrame width="6xl">
      <PageHeader title="Resource mappings" subtitle="Hardware and folders given a cluster-wide name, so machines that use them can move between nodes." />
      <LiveOnly>
        <Async q={q}>
          {(m) => (
            <>
              {m.denied && <Notice tone="info" title="Your Proxmox account can't read mappings" className="mb-4">It needs Mapping.Audit.</Notice>}
              <Tabs<MappingKind> value={tab} onChange={setTab} className="mb-6" tabs={[{ id: "pci", label: "PCI devices", count: m.pci.length }, { id: "usb", label: "USB devices", count: m.usb.length }, { id: "dir", label: "Directories", count: m.dir.length }]} />
              <List key={tab} kind={tab} items={m[tab]} />
            </>
          )}
        </Async>
      </LiveOnly>
    </PageFrame>
  );
}
