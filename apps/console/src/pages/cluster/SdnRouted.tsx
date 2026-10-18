import { useConfirm } from "../../ui/Confirm.tsx";
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Waypoints } from "lucide-react";
import { clusterMoreApi, type SdnOverview } from "../../data/engine/w3Api.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, Field, Input, Notice, PageFrame, PageHeader, Select, Tabs, Toggle } from "../../ui/primitives.tsx";
import { useEngine } from "../../data/store.tsx";
import { Async, LiveOnly, TypedConfirm, useNodes, useTaskRunner } from "../node/common.tsx";
import { numOrUndef } from "../disks/w3Common.tsx";

type Tab = "controllers" | "zones" | "fabrics" | "prefix" | "routemaps";
type Row = Record<string, unknown>;
const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));

function useChange<T>(fn: (v: T) => Promise<unknown>, onDone: () => void) {
  return useMutation({ mutationFn: fn, onSuccess: onDone });
}

function FormModal({ title, subtitle, onClose, onSubmit, busy, error, disabled, children, action = "Create" }: { title: string; subtitle?: string; onClose: () => void; onSubmit: () => void; busy: boolean; error: unknown; disabled?: boolean; children: ReactNode; action?: string }) {
  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={disabled} onClick={onSubmit}>{action}</Button></>}>
      <div className="space-y-4">{children}{error ? <p role="alert" className="text-compact text-critical">{errorText(error)}</p> : null}</div>
    </Modal>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  if (rows.length === 0) return <p className="text-compact text-ink-3 px-1">{empty}</p>;
  return (
    <Card className="overflow-x-auto"><table className="w-full text-compact min-w-[560px]">
      <thead><tr className="border-b border-line text-ink-3 text-left">{head.map((h, i) => <th key={i} className="font-normal px-4 h-10">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i} className="border-b border-line last:border-0 align-top">{r.map((c, j) => <td key={j} className="px-4 py-2.5">{c}</td>)}</tr>)}</tbody>
    </table></Card>
  );
}

function Controllers({ d, refresh }: { d: SdnOverview; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [del, setDel] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [asn, setAsn] = useState("65000");
  const [peers, setPeers] = useState("");
  const create = useChange(() => clusterMoreApi.createController({ type: "evpn", controller: name, asn: Number(asn), peers }), () => { setOpen(false); refresh(); });
  const remove = useChange((id: string) => clusterMoreApi.deleteController(id), () => { setDel(null); refresh(); });
  return (
    <div className="space-y-3">
      <div><Button variant="primary" onClick={() => setOpen(true)}><Plus className="h-4 w-4" />New EVPN controller…</Button></div>
      <Table head={["Controller", "Type", "AS number", "Peers", ""]} empty="No controllers yet." rows={d.controllers.map((c) => [<span className="font-mono">{s(c.controller)}</span>, <Chip>{s(c.type)}</Chip>, <span className="tabular-nums">{s(c.asn)}</span>, <span className="font-mono text-xs">{s(c.peers) || s(c.fabric)}</span>, <Button size="sm" variant="ghost" onClick={() => setDel(s(c.controller))}>Delete…</Button>])} />
      {open && (
        <FormModal title="New EVPN controller" subtitle="Tells the nodes how to share routes for EVPN zones" onClose={() => setOpen(false)} onSubmit={() => create.mutate(undefined)} busy={create.isPending} error={create.error} disabled={!name || !asn || !peers}>
          <Field label="Name" htmlFor="ct-name"><Input id="ct-name" value={name} onChange={(e) => setName(e.target.value)} className="font-mono" spellCheck={false} /></Field>
          <Field label="AS number" hint="A private number such as 65000" htmlFor="ct-asn"><Input id="ct-asn" type="number" value={asn} onChange={(e) => setAsn(e.target.value)} className="tabular-nums" /></Field>
          <Field label="Peers" hint="The addresses of the nodes (or of the gateways they peer with), separated by commas" htmlFor="ct-peers"><Input id="ct-peers" value={peers} onChange={(e) => setPeers(e.target.value)} className="font-mono" spellCheck={false} /></Field>
        </FormModal>
      )}
      {del && <TypedConfirm title={`Delete the controller ${del}?`} phrase={del} action="Delete" busy={remove.isPending} error={remove.error ? errorText(remove.error) : null} onClose={() => setDel(null)} onConfirm={() => remove.mutate(del)}><Notice tone="warning">Refused while a zone still uses it.</Notice></TypedConfirm>}
    </div>
  );
}

function Zones({ d, refresh }: { d: SdnOverview; refresh: () => void }) {
  const nodes = useNodes();
  const [open, setOpen] = useState(false);
  const [del, setDel] = useState<string | null>(null);
  const [zone, setZone] = useState("");
  const [controller, setController] = useState(s(d.controllers.find((c) => c.type === "evpn")?.controller));
  const [vrf, setVrf] = useState("");
  const [exits, setExits] = useState<string[]>([]);
  const [adv, setAdv] = useState(false);
  const create = useChange(() => clusterMoreApi.createEvpnZone({ zone, controller, "vrf-vxlan": Number(vrf), ...(exits.length ? { exitnodes: exits, "exitnodes-primary": exits[0] } : {}), "advertise-subnets": adv || undefined }), () => { setOpen(false); refresh(); });
  const remove = useChange((id: string) => clusterMoreApi.deleteEvpnZone(id), () => { setDel(null); refresh(); });
  return (
    <div className="space-y-3">
      <div><Button variant="primary" onClick={() => setOpen(true)} disabled={d.controllers.length === 0}><Plus className="h-4 w-4" />New EVPN zone…</Button>{d.controllers.length === 0 && <span className="text-compact text-ink-3 ml-3">Create a controller first.</span>}</div>
      <Table head={["Zone", "Controller", "VRF VXLAN", "Exit nodes", ""]} empty="No EVPN zones yet." rows={d.evpnZones.map((z) => [<span className="font-mono">{s(z.zone)}</span>, s(z.controller), <span className="tabular-nums">{s(z["vrf-vxlan"])}</span>, <span className="font-mono text-xs">{s(z.exitnodes)}</span>, <Button size="sm" variant="ghost" onClick={() => setDel(s(z.zone))}>Delete…</Button>])} />
      <p className="text-xs text-ink-3">Simple, VLAN, QinQ and VXLAN zones, VNets and subnets are under Network. VNets of an EVPN zone are made there too.</p>
      {open && (
        <FormModal title="New EVPN zone" onClose={() => setOpen(false)} onSubmit={() => create.mutate(undefined)} busy={create.isPending} error={create.error} disabled={!zone || !controller || !vrf}>
          <Field label="Name" hint="Up to 8 lowercase letters and numbers" htmlFor="ez-name"><Input id="ez-name" value={zone} onChange={(e) => setZone(e.target.value)} className="font-mono" spellCheck={false} /></Field>
          <Field label="Controller" htmlFor="ez-ctl"><Select id="ez-ctl" value={controller} onChange={(e) => setController(e.target.value)}>{d.controllers.filter((c) => c.type === "evpn").map((c) => <option key={s(c.controller)} value={s(c.controller)}>{s(c.controller)}</option>)}</Select></Field>
          <Field label="VRF VXLAN number" hint="1 to 16777215, unique in the cluster" htmlFor="ez-vrf"><Input id="ez-vrf" type="number" value={vrf} onChange={(e) => setVrf(e.target.value)} className="tabular-nums" /></Field>
          <fieldset><legend className="text-compact text-ink-2 mb-1">Exit nodes (optional)</legend><div className="flex gap-3 flex-wrap">{(nodes.data?.nodes ?? []).map((n) => <label key={n.node} className="flex items-center gap-2 text-compact"><input type="checkbox" checked={exits.includes(n.node)} onChange={(e) => setExits(e.target.checked ? [...exits, n.node] : exits.filter((x) => x !== n.node))} />{n.node}</label>)}</div></fieldset>
          <div className="flex items-center gap-3"><Toggle checked={adv} onChange={setAdv} label="Advertise subnets" /><span className="text-compact">Advertise subnets instead of single addresses</span></div>
        </FormModal>
      )}
      {del && <TypedConfirm title={`Delete the zone ${del}?`} phrase={del} action="Delete" busy={remove.isPending} error={remove.error ? errorText(remove.error) : null} onClose={() => setDel(null)} onConfirm={() => remove.mutate(del)}><Notice tone="warning">Refused while it still has VNets.</Notice></TypedConfirm>}
    </div>
  );
}

function Fabrics({ d, refresh }: { d: SdnOverview; refresh: () => void }) {
  const nodes = useNodes();
  const [open, setOpen] = useState(false);
  const [nodeFor, setNodeFor] = useState<string | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const [id, setId] = useState("");
  const [protocol, setProtocol] = useState("openfabric");
  const [prefix, setPrefix] = useState("");
  const [area, setArea] = useState("0");
  const [node, setNode] = useState("");
  const [ip, setIp] = useState("");
  const [ifaces, setIfaces] = useState("");
  const create = useChange(() => clusterMoreApi.createFabric({ id, protocol, ip_prefix: prefix, ...(protocol === "ospf" ? { area } : {}) }), () => { setOpen(false); refresh(); });
  const addNode = useChange(() => clusterMoreApi.addFabricNode(nodeFor!, node, { ip, interfaces: ifaces.split(",").map((x) => x.trim()).filter(Boolean).map((name) => ({ name })) }), () => { setNodeFor(null); refresh(); });
  const remove = useChange((x: string) => clusterMoreApi.deleteFabric(x), () => { setDel(null); refresh(); });
  if (!d.supported.fabrics) return <Notice tone="info">This Proxmox doesn't have fabrics yet (they arrived with version 9). EVPN controllers and zones still work.</Notice>;
  return (
    <div className="space-y-3">
      <div><Button variant="primary" onClick={() => setOpen(true)}><Plus className="h-4 w-4" />New fabric…</Button></div>
      <Table head={["Fabric", "Protocol", "Range", "Nodes", ""]} empty="No fabrics yet." rows={d.fabrics.map((f) => [<span className="font-mono">{s(f.id)}</span>, <Chip>{s(f.protocol)}</Chip>, <span className="font-mono text-xs">{s(f.ip_prefix) || s(f.ip6_prefix)}</span>, d.fabricNodes.filter((n) => n.fabric_id === f.id).map((n) => s(n.node_id)).join(", ") || "none", <span className="flex gap-1.5"><Button size="sm" onClick={() => { setNodeFor(s(f.id)); setNode(nodes.data?.nodes[0]?.node ?? ""); }}>Add node…</Button><Button size="sm" variant="ghost" onClick={() => setDel(s(f.id))}>Delete…</Button></span>])} />
      <p className="text-xs text-ink-3">OpenFabric, OSPF and BGP fabrics are managed here. WireGuard fabrics are shown but not edited. Remember to Apply the SDN changes afterwards.</p>
      {open && (
        <FormModal title="New fabric" subtitle="A routed underlay between the nodes" onClose={() => setOpen(false)} onSubmit={() => create.mutate(undefined)} busy={create.isPending} error={create.error} disabled={!id || !prefix}>
          <Field label="Name" hint="Up to 8 characters" htmlFor="fb-id"><Input id="fb-id" value={id} onChange={(e) => setId(e.target.value)} className="font-mono" spellCheck={false} /></Field>
          <Field label="Protocol" htmlFor="fb-proto"><Select id="fb-proto" value={protocol} onChange={(e) => setProtocol(e.target.value)}>{d.protocols.map((p) => <option key={p} value={p}>{p}</option>)}</Select></Field>
          <Field label="Address range for nodes" hint="Like 10.10.0.0/24" htmlFor="fb-pre"><Input id="fb-pre" value={prefix} onChange={(e) => setPrefix(e.target.value)} className="font-mono" spellCheck={false} /></Field>
          {protocol === "ospf" && <Field label="Area" hint="A number or an IPv4 address" htmlFor="fb-area"><Input id="fb-area" value={area} onChange={(e) => setArea(e.target.value)} className="font-mono w-40" /></Field>}
        </FormModal>
      )}
      {nodeFor && (
        <FormModal title={`Add a node to ${nodeFor}`} onClose={() => setNodeFor(null)} onSubmit={() => addNode.mutate(undefined)} busy={addNode.isPending} error={addNode.error} disabled={!node || !ip || !ifaces} action="Add node">
          <Field label="Node" htmlFor="fn-node"><Select id="fn-node" value={node} onChange={(e) => setNode(e.target.value)}>{(nodes.data?.nodes ?? []).map((n) => <option key={n.node} value={n.node}>{n.node}</option>)}</Select></Field>
          <Field label="Its address in the fabric" hint="An IPv4 address inside the range" htmlFor="fn-ip"><Input id="fn-ip" value={ip} onChange={(e) => setIp(e.target.value)} className="font-mono" spellCheck={false} /></Field>
          <Field label="Interfaces" hint="Names of the network interfaces facing the other nodes, separated by commas" htmlFor="fn-if"><Input id="fn-if" value={ifaces} onChange={(e) => setIfaces(e.target.value)} className="font-mono" spellCheck={false} /></Field>
        </FormModal>
      )}
      {del && <TypedConfirm title={`Delete the fabric ${del}?`} phrase={del} action="Delete" busy={remove.isPending} error={remove.error ? errorText(remove.error) : null} onClose={() => setDel(null)} onConfirm={() => remove.mutate(del)}><Notice tone="warning">All its nodes go with it. Refused while a controller or zone uses it.</Notice></TypedConfirm>}
    </div>
  );
}

function PrefixLists({ d, refresh }: { d: SdnOverview; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [del, setDel] = useState<string | null>(null);
  const [id, setId] = useState("");
  const [action, setAction] = useState("permit");
  const [prefix, setPrefix] = useState("");
  const [le, setLe] = useState("");
  const create = useChange(() => clusterMoreApi.createPrefixList({ id, entries: prefix ? [{ action, prefix, le: numOrUndef(le), seq: 10 }] : [] }), () => { setOpen(false); refresh(); });
  const remove = useChange((x: string) => clusterMoreApi.deletePrefixList(x), () => { setDel(null); refresh(); });
  if (!d.supported.prefixLists) return <Notice tone="info">This Proxmox doesn't have prefix lists yet.</Notice>;
  return (
    <div className="space-y-3">
      <div><Button variant="primary" onClick={() => setOpen(true)}><Plus className="h-4 w-4" />New prefix list…</Button></div>
      <Table head={["Prefix list", "Entries", ""]} empty="No prefix lists yet." rows={d.prefixLists.map((p) => [<span className="font-mono">{s(p.id)}</span>, <ul className="font-mono text-xs space-y-0.5">{((p.entries as Row[] | undefined) ?? []).map((e, i) => <li key={i}>{s(e.seq)} {s(e.action)} {s(e.prefix)}{e.le ? ` le ${s(e.le)}` : ""}{e.ge ? ` ge ${s(e.ge)}` : ""}</li>)}</ul>, <Button size="sm" variant="ghost" onClick={() => setDel(s(p.id))}>Delete…</Button>])} />
      {open && (
        <FormModal title="New prefix list" subtitle="Which routes are allowed or refused" onClose={() => setOpen(false)} onSubmit={() => create.mutate(undefined)} busy={create.isPending} error={create.error} disabled={!id}>
          <Field label="Name" htmlFor="pl-id"><Input id="pl-id" value={id} onChange={(e) => setId(e.target.value)} className="font-mono" spellCheck={false} /></Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="First entry" htmlFor="pl-act"><Select id="pl-act" value={action} onChange={(e) => setAction(e.target.value)}><option value="permit">Permit</option><option value="deny">Deny</option></Select></Field>
            <Field label="Prefix" htmlFor="pl-pre"><Input id="pl-pre" value={prefix} onChange={(e) => setPrefix(e.target.value)} className="font-mono" placeholder="10.0.0.0/8" /></Field>
            <Field label="Up to length" htmlFor="pl-le"><Input id="pl-le" type="number" value={le} onChange={(e) => setLe(e.target.value)} className="tabular-nums" /></Field>
          </div>
        </FormModal>
      )}
      {del && <TypedConfirm title={`Delete ${del}?`} phrase={del} action="Delete" busy={remove.isPending} error={remove.error ? errorText(remove.error) : null} onClose={() => setDel(null)} onConfirm={() => remove.mutate(del)}><Notice tone="warning">Refused while a fabric filters routes with it.</Notice></TypedConfirm>}
    </div>
  );
}

function RouteMaps({ d, refresh }: { d: SdnOverview; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [del, setDel] = useState<{ id: string; order: number } | null>(null);
  const [id, setId] = useState("");
  const [order, setOrder] = useState("10");
  const [action, setAction] = useState("permit");
  const [mk, setMk] = useState("");
  const [mv, setMv] = useState("");
  const [sk, setSk] = useState("");
  const [sv, setSv] = useState("");
  const create = useChange(() => clusterMoreApi.addRouteEntry(id, { order: Number(order), action, ...(mk ? { match: [{ key: mk, value: mv || undefined }] } : {}), ...(sk ? { set: [{ key: sk, value: sv || undefined }] } : {}) }), () => { setOpen(false); refresh(); });
  const remove = useChange((x: { id: string; order: number }) => clusterMoreApi.deleteRouteEntry(x.id, x.order), () => { setDel(null); refresh(); });
  if (!d.supported.routeMaps) return <Notice tone="info">This Proxmox doesn't have route maps yet.</Notice>;
  return (
    <div className="space-y-3">
      <div><Button variant="primary" onClick={() => setOpen(true)}><Plus className="h-4 w-4" />New route map entry…</Button></div>
      <Table head={["Route map", "Order", "Action", "Match and set", ""]} empty="No route maps yet." rows={d.routeMaps.map((e) => [<span className="font-mono">{s(e["route-map-id"])}</span>, <span className="tabular-nums">{s(e.order)}</span>, <Chip tone={e.action === "deny" ? "critical" : "good"}>{s(e.action)}</Chip>, <span className="font-mono text-xs">{[...((e.match as string[] | undefined) ?? []), ...((e.set as string[] | undefined) ?? []).map((x) => `set ${x}`)].join("; ")}</span>, <Button size="sm" variant="ghost" onClick={() => setDel({ id: s(e["route-map-id"]), order: Number(e.order) })}>Delete…</Button>])} />
      {open && (
        <FormModal title="Route map entry" subtitle="Entries run in order; the first that matches decides" onClose={() => setOpen(false)} onSubmit={() => create.mutate(undefined)} busy={create.isPending} error={create.error} disabled={!id || !order}>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Route map" hint="Name; a new name makes a new map" htmlFor="rm-id"><Input id="rm-id" value={id} onChange={(e) => setId(e.target.value)} className="font-mono" spellCheck={false} /></Field>
            <Field label="Order" htmlFor="rm-ord"><Input id="rm-ord" type="number" value={order} onChange={(e) => setOrder(e.target.value)} className="tabular-nums" /></Field>
            <Field label="Action" htmlFor="rm-act"><Select id="rm-act" value={action} onChange={(e) => setAction(e.target.value)}><option value="permit">Permit</option><option value="deny">Deny</option></Select></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Match" htmlFor="rm-mk"><Select id="rm-mk" value={mk} onChange={(e) => setMk(e.target.value)}><option value="">Everything</option>{d.matchKeys.map((k) => <option key={k} value={k}>{k}</option>)}</Select></Field>
            <Field label="Matching value" htmlFor="rm-mv"><Input id="rm-mv" value={mv} onChange={(e) => setMv(e.target.value)} className="font-mono" /></Field>
            <Field label="Then set" htmlFor="rm-sk"><Select id="rm-sk" value={sk} onChange={(e) => setSk(e.target.value)}><option value="">Nothing</option>{d.setKeys.map((k) => <option key={k} value={k}>{k}</option>)}</Select></Field>
            <Field label="To" htmlFor="rm-sv"><Input id="rm-sv" value={sv} onChange={(e) => setSv(e.target.value)} className="font-mono" /></Field>
          </div>
        </FormModal>
      )}
      {del && <TypedConfirm title={`Delete entry ${del.order} of ${del.id}?`} phrase={`${del.id}:${del.order}`} action="Delete" busy={remove.isPending} error={remove.error ? errorText(remove.error) : null} onClose={() => setDel(null)} onConfirm={() => remove.mutate(del)}><Notice tone="warning">Removing the last entry removes the route map; that is refused while a controller or fabric uses it.</Notice></TypedConfirm>}
    </div>
  );
}

function Apply() {
  const run = useTaskRunner();
  const { ask, dialog } = useConfirm();
  return (
    <div className="flex items-center gap-3 flex-wrap">
      {dialog}
      <Button onClick={() => ask({ title: "Apply the SDN changes?", body: "They are rolled out to every node and the network is reloaded there. Machines on these networks can lose connectivity for a moment.", label: "Apply", danger: true, run: () => void run.start("Apply SDN changes", () => clusterMoreApi.applySdn()) })} loading={run.busy}>Apply SDN changes</Button>
      <span className="text-compact text-ink-3">Changes here wait until applied; applying rolls them out to every node.</span>
      {run.error && <p role="alert" className="text-compact text-critical w-full">{run.error}</p>}
      {run.modal}
    </div>
  );
}

export function SdnRoutedPage() {
  const { live } = useEngine();
  const qc = useQueryClient();
  const q = useQuery({ enabled: live, queryKey: ["cluster", "sdn-routed"], queryFn: clusterMoreApi.sdn, retry: 1 });
  const [tab, setTab] = useState<Tab>("controllers");
  const refresh = () => void qc.invalidateQueries({ queryKey: ["cluster", "sdn-routed"] });
  return (
    <PageFrame width="6xl">
      <PageHeader title="Routed networks" subtitle="EVPN controllers and zones, fabrics, prefix lists and route maps for networks that span nodes." eyebrow={<Waypoints className="h-4 w-4" />} actions={<Apply />} />
      <LiveOnly>
        <Async q={q}>
          {(d) => d.denied ? <Notice tone="info">Your Proxmox account can't read the SDN configuration (it needs SDN.Audit).</Notice> : (
            <div className="space-y-5">
              <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: "controllers", label: "Controllers", count: d.controllers.length }, { id: "zones", label: "EVPN zones", count: d.evpnZones.length }, { id: "fabrics", label: "Fabrics", count: d.fabrics.length }, { id: "prefix", label: "Prefix lists", count: d.prefixLists.length }, { id: "routemaps", label: "Route maps" }]} />
              {tab === "controllers" && <Controllers d={d} refresh={refresh} />}
              {tab === "zones" && <Zones d={d} refresh={refresh} />}
              {tab === "fabrics" && <Fabrics d={d} refresh={refresh} />}
              {tab === "prefix" && <PrefixLists d={d} refresh={refresh} />}
              {tab === "routemaps" && <RouteMaps d={d} refresh={refresh} />}
            </div>
          )}
        </Async>
      </LiveOnly>
    </PageFrame>
  );
}
