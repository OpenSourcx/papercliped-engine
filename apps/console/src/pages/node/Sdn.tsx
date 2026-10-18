import { useConfirm } from "../../ui/Confirm.tsx";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Network, Plus, Trash2, Undo2 } from "lucide-react";
import { dcApi, type SdnKind, type SdnObject, type SdnOverview, type SdnSubnet, type SdnVnet } from "../../data/engine/dcApi.ts";
import type { Values } from "../../data/engine/nodeApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, EmptyState, Field, Input, Notice, PageFrame, PageHeader, SectionTitle, Select, Status, Tabs, Toggle } from "../../ui/primitives.tsx";
import { Async, changedValues, LiveOnly, NodeSwitcher, ObjectModal, SaveBar, SchemaForm, TypedConfirm, useNodeName, useTaskRunner } from "./common.tsx";
import { DataTable, Td } from "./dc.tsx";

const useSdn = () => useQuery({ queryKey: ["node", "sdn"], queryFn: dcApi.sdn, retry: 1 });
const stateChip = (s: string | null) => (s === "new" ? <Chip tone="good">New</Chip> : s === "changed" ? <Chip tone="warning">Changed</Chip> : s === "deleted" ? <Chip tone="critical">Deleting</Chip> : null);

/* ── Zones, IPAM, DNS plugins and controllers: one list per kind ───────────────────── */

const KIND_TEXT: Record<SdnKind, { title: string; one: string; empty: string; nameLabel: string }> = {
  zones: { title: "Zones", one: "zone", empty: "A zone is a set of virtual networks that share how they reach the physical network.", nameLabel: "Zone name" },
  ipams: { title: "IPAM", one: "IPAM", empty: "IP address management hands out addresses for the virtual networks. Proxmox's built-in IPAM (pve) is enough for most setups.", nameLabel: "IPAM name" },
  dns: { title: "DNS", one: "DNS plugin", empty: "A DNS plugin registers the names of machines in a PowerDNS server.", nameLabel: "DNS plugin name" },
  controllers: { title: "Controllers", one: "controller", empty: "Controllers run the routing (EVPN, BGP or IS-IS) that EVPN zones rely on.", nameLabel: "Controller name" },
};

function brief(v: Values): string {
  return Object.entries(v).filter(([, x]) => x !== undefined && x !== null && x !== "" && typeof x !== "object").slice(0, 4).map(([k, x]) => `${k} ${String(x)}`).join(" · ");
}

function ObjectSection({ kind, items, ov }: { kind: SdnKind; items: SdnObject[]; ov: SdnOverview }) {
  const qc = useQueryClient();
  const text = KIND_TEXT[kind];
  const types = ov.types[kind];
  const [edit, setEdit] = useState<string | "new" | null>(null);
  const [newType, setNewType] = useState(Object.keys(types)[0]);
  const [del, setDel] = useState<SdnObject | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["node", "sdn"] });
  const remove = useMutation({ mutationFn: (o: SdnObject) => dcApi.sdnDelete(kind, o.id), onSuccess: () => { setDel(null); void refresh(); } });
  const current = edit && edit !== "new" ? items.find((o) => o.id === edit) : undefined;
  const type = current?.type ?? newType;
  const def = types[type] ?? types[Object.keys(types)[0]];
  return (
    <Card>
      <div className="p-5 pb-3 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-60"><SectionTitle>{text.title}</SectionTitle></div>
        <Button size="sm" onClick={() => setEdit("new")}><Plus className="h-4 w-4" />Add {text.one}…</Button>
      </div>
      {items.length === 0 ? <p className="px-5 pb-5 text-compact text-ink-3">{text.empty}</p> : (
        <DataTable label={text.title} head={["Name", "Type", "Settings", "State", ""]} min={640}>
          {items.map((o) => (
            <tr key={o.id} className="border-b border-line last:border-0">
              <Td mono>{o.id}</Td>
              <Td>{types[o.type]?.label ?? o.type}</Td>
              <Td className="text-ink-2 break-words">{brief(o.values)}{o.secretsSet.length ? <span className="text-ink-3"> · {o.secretsSet.join(", ")} set</span> : null}</Td>
              <Td>{stateChip(o.state)}</Td>
              <Td><div className="flex gap-1 justify-end">
                {kind === "ipams" && <Button size="sm" variant="ghost" onClick={() => setStatus(o.id)}>Addresses</Button>}
                <Button size="sm" variant="ghost" onClick={() => setEdit(o.id)}>Edit</Button>
                <Button size="sm" variant="ghost" className="text-critical" aria-label={`Delete ${o.id}`} onClick={() => setDel(o)}><Trash2 className="h-4 w-4" /></Button>
              </div></Td>
            </tr>
          ))}
        </DataTable>
      )}
      {edit && def && (
        <ObjectModal
          key={`${edit}-${type}`}
          title={current ? `Edit ${current.id}` : `Add ${text.one}`}
          subtitle={def.label}
          schema={def.schema}
          initial={current?.values ?? {}}
          name={current?.id ?? null}
          nameLabel={text.nameLabel}
          submitLabel={current ? "Save changes" : `Add ${text.one}`}
          extra={!current ? <Field label="Kind" htmlFor="sdn-kind"><Select id="sdn-kind" value={newType} onChange={(e) => setNewType(e.target.value)}>{Object.entries(types).map(([t, d]) => <option key={t} value={t}>{d.label}</option>)}</Select></Field> : undefined}
          onSubmit={async (n, values) => {
            if (current) await dcApi.sdnUpdate(kind, current.id, values, current.digest);
            else await dcApi.sdnCreate(kind, n, type, values);
            await refresh();
          }}
          onClose={() => setEdit(null)}
        />
      )}
      {del && <TypedConfirm title={`Delete ${del.id}?`} subtitle="Staged until you apply the changes." phrase={del.id} action={`Delete ${text.one}`} busy={remove.isPending} error={remove.error ? errorText(remove.error) : null} onConfirm={() => remove.mutate(del)} onClose={() => setDel(null)} />}
      {status && <IpamModal ipam={status} onClose={() => setStatus(null)} />}
    </Card>
  );
}

function IpamModal({ ipam, onClose }: { ipam: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["node", "sdn", "ipam", ipam], queryFn: () => dcApi.ipamStatus(ipam), retry: 0 });
  return (
    <Modal size="lg" title="Addresses in use" subtitle={ipam} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {q.isPending ? <p className="text-compact text-ink-3">Asking Proxmox…</p> : q.error ? <Notice tone="warning">{errorText(q.error)}</Notice> : q.data.entries.length === 0 ? <p className="text-compact text-ink-3">No addresses are handed out yet.</p> : (
        <DataTable label="Addresses" head={["Address", "Network", "MAC", "Machine", "Name"]} min={560}>
          {q.data.entries.map((e) => <tr key={`${e.ip}-${e.vnet}`} className="border-b border-line last:border-0"><Td mono>{e.ip}{e.gateway ? <Chip className="ml-2">gateway</Chip> : null}</Td><Td>{e.vnet ?? "–"}</Td><Td mono>{e.mac ?? "–"}</Td><Td mono>{e.vmid ?? "–"}</Td><Td>{e.hostname ?? ""}</Td></tr>)}
        </DataTable>
      )}
    </Modal>
  );
}

/* ── VNets and subnets ─────────────────────────────────────────────────────────────── */

function SubnetModal({ vnet, subnet, onClose, onDone }: { vnet: SdnVnet; subnet: SdnSubnet | null; onClose: () => void; onDone: () => void }) {
  const [cidr, setCidr] = useState(subnet?.cidr ?? "");
  const [gateway, setGateway] = useState(subnet?.gateway ?? "");
  const [snat, setSnat] = useState(subnet?.snat ?? false);
  const [dns, setDns] = useState(subnet?.dhcpDns ?? "");
  const [prefix, setPrefix] = useState(subnet?.dnszoneprefix ?? "");
  const [ranges, setRanges] = useState<{ start: string; end: string }[]>((subnet?.dhcpRange ?? []).map((r) => ({ start: r.match(/start-address=([^,]+)/)?.[1] ?? "", end: r.match(/end-address=([^,]+)/)?.[1] ?? "" })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const values: Values = { gateway: gateway.trim() || null, snat, "dhcp-dns-server": dns.trim() || null, dnszoneprefix: prefix.trim() || null, "dhcp-range": ranges.filter((r) => r.start && r.end).map((r) => `start-address=${r.start},end-address=${r.end}`) };
      if (subnet) await dcApi.subnetUpdate(vnet.vnet, subnet.id, values, subnet.digest);
      else await dcApi.subnetCreate(vnet.vnet, cidr.trim(), Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0))));
      onDone();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal size="lg" icon={<Network className="h-5 w-5" />} title={subnet ? `Edit ${subnet.cidr}` : "Add a subnet"} subtitle={`In ${vnet.vnet}`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!subnet && !cidr.trim()} onClick={() => void go()}>{subnet ? "Save subnet" : "Add subnet"}</Button></>}>
      <div className="space-y-5">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Network" hint="For example 10.20.0.0/24." htmlFor="sn-cidr"><Input id="sn-cidr" className="font-mono" value={cidr} disabled={!!subnet} onChange={(e) => setCidr(e.target.value)} autoFocus={!subnet} /></Field>
          <Field label="Gateway" hint="Assigned to the network on this node (routed zones)." htmlFor="sn-gw"><Input id="sn-gw" className="font-mono" value={gateway} onChange={(e) => setGateway(e.target.value)} /></Field>
        </div>
        <div className="flex items-start gap-3"><Toggle checked={snat} onChange={setSnat} label="Source NAT" /><span className="text-compact text-ink-2">Let machines in this network reach outside through this node (masquerade)</span></div>
        <div className="space-y-2">
          <SectionTitle>DHCP ranges</SectionTitle>
          {ranges.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input aria-label={`Range ${i + 1} start`} placeholder="First address" className="font-mono flex-1 basis-40" value={r.start} onChange={(e) => setRanges(ranges.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
              <Input aria-label={`Range ${i + 1} end`} placeholder="Last address" className="font-mono flex-1 basis-40" value={r.end} onChange={(e) => setRanges(ranges.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
              <Button size="sm" variant="ghost" onClick={() => setRanges(ranges.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          <Button size="sm" onClick={() => setRanges([...ranges, { start: "", end: "" }])}><Plus className="h-4 w-4" />Add a range</Button>
          <p className="text-xs text-ink-3">DHCP needs a zone with DHCP set to dnsmasq.</p>
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="DHCP DNS server" htmlFor="sn-dns"><Input id="sn-dns" className="font-mono" value={dns} onChange={(e) => setDns(e.target.value)} /></Field>
          <Field label="DNS zone prefix" hint="A name part in front of the DNS zone, for example adm." htmlFor="sn-prefix"><Input id="sn-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} /></Field>
        </div>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function FirewallModal({ vnet, onClose }: { vnet: SdnVnet; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["node", "sdn", "fw", vnet.vnet], queryFn: () => dcApi.vnetFirewall(vnet.vnet), retry: 0 });
  const [draft, setDraft] = useState<Values | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useMutation({ mutationFn: (v: Values) => dcApi.saveVnetFirewall(vnet.vnet, v, q.data?.digest ?? null), onSuccess: () => { setSaved(true); setDraft(null); void qc.invalidateQueries({ queryKey: ["node", "sdn", "fw"] }); } });
  return (
    <Modal size="lg" title="Firewall" subtitle={`VNet ${vnet.vnet}`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {q.isPending ? <p className="text-compact text-ink-3">Loading…</p> : q.error ? <Notice tone="warning">{errorText(q.error)}</Notice> : (() => {
        const d = q.data;
        const value = draft ?? d.values;
        const diff = changedValues(d.values, value, Object.keys(d.schema));
        return (
          <div className="space-y-5">
            <SchemaForm schema={d.schema} value={value} onChange={(v) => { setDraft(v); setSaved(false); }} labels={{ enable: "Firewall on", policy_forward: "Forward policy", log_level_forward: "Forward log level" }} />
            <SaveBar dirty={Object.keys(diff).length > 0} busy={save.isPending} saved={saved} error={save.error ? errorText(save.error) : null} onSave={() => save.mutate(diff)} onReset={() => setDraft(null)} />
            <div>
              <SectionTitle>Rules</SectionTitle>
              {d.rules.length === 0 ? <p className="text-compact text-ink-3 mt-1">No rules. The forward policy applies to everything.</p> : (
                <DataTable label="Firewall rules" head={["#", "Direction", "Action", "From", "To", "Service", "Note"]} min={640}>
                  {d.rules.map((r, i) => <tr key={i} className="border-b border-line last:border-0"><Td mono>{r.pos ?? i}</Td><Td>{r.type}</Td><Td>{r.action}{!r.enable && <span className="text-ink-3"> (off)</span>}</Td><Td mono>{r.source ?? "any"}</Td><Td mono>{r.dest ?? "any"}</Td><Td mono>{[r.macro, r.proto, r.dport].filter(Boolean).join(" ") || "any"}</Td><Td className="text-ink-2">{r.comment ?? ""}</Td></tr>)}
                </DataTable>
              )}
              <p className="text-xs text-ink-3 mt-2">Rules are shown as Proxmox has them. Add or change rules in Proxmox's firewall rules for this network until they are editable here.</p>
            </div>
          </div>
        );
      })()}
    </Modal>
  );
}

function VnetModal({ vnet, ov, onClose, onDone }: { vnet: SdnVnet | null; ov: SdnOverview; onClose: () => void; onDone: () => void }) {
  const [zone, setZone] = useState(vnet?.zone ?? ov.zones[0]?.id ?? "");
  return (
    <ObjectModal
      title={vnet ? `Edit ${vnet.vnet}` : "Add a VNet"}
      subtitle="A virtual network machines connect to"
      schema={ov.vnetSchema}
      only={["tag", "alias", "vlanaware", "isolate-ports"]}
      initial={vnet ? { tag: vnet.tag ?? undefined, alias: vnet.alias ?? undefined, vlanaware: vnet.vlanaware, "isolate-ports": vnet.isolatePorts } : {}}
      name={vnet?.vnet ?? null}
      nameLabel="VNet name"
      hints={{ tag: "The VLAN tag in VLAN and QinQ zones; the VXLAN network identifier in VXLAN and EVPN zones." }}
      submitLabel={vnet ? "Save VNet" : "Add VNet"}
      extra={!vnet ? <Field label="Zone" htmlFor="vn-zone"><Select id="vn-zone" value={zone} onChange={(e) => setZone(e.target.value)}>{ov.zones.length === 0 && <option value="">Add a zone first</option>}{ov.zones.map((z) => <option key={z.id} value={z.id}>{z.id} ({z.type})</option>)}</Select></Field> : undefined}
      onSubmit={async (n, values) => {
        if (vnet) await dcApi.vnetUpdate(vnet.vnet, values, vnet.digest);
        else await dcApi.vnetCreate(n, { ...values, zone });
        onDone();
      }}
      onClose={onClose}
    />
  );
}

function VnetsTab({ ov }: { ov: SdnOverview }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["node", "sdn"] });
  const [vn, setVn] = useState<SdnVnet | "new" | null>(null);
  const [sub, setSub] = useState<{ vnet: SdnVnet; subnet: SdnSubnet | null } | null>(null);
  const [fw, setFw] = useState<SdnVnet | null>(null);
  const [del, setDel] = useState<{ vnet: SdnVnet; subnet?: SdnSubnet } | null>(null);
  const remove = useMutation({ mutationFn: (d: { vnet: SdnVnet; subnet?: SdnSubnet }) => (d.subnet ? dcApi.subnetDelete(d.vnet.vnet, d.subnet.id) : dcApi.vnetDelete(d.vnet.vnet)), onSuccess: () => { setDel(null); void refresh(); } });
  return (
    <div className="space-y-4">
      <div><Button variant="primary" onClick={() => setVn("new")}><Plus className="h-4 w-4" />Add a VNet…</Button></div>
      {ov.vnets.length === 0 ? <Card><EmptyState icon={<Network className="h-5 w-5" />} title="No virtual networks" body="Add a zone, then a VNet in it. Machines connect to a VNet like to a bridge." /></Card> : ov.vnets.map((v) => (
        <Card key={v.vnet}>
          <div className="p-5 pb-3 flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1 basis-60">
              <div className="flex items-center gap-2 flex-wrap"><span className="font-mono font-medium">{v.vnet}</span>{stateChip(v.state)}{v.alias && <span className="text-compact text-ink-3">{v.alias}</span>}</div>
              <div className="text-compact text-ink-3 mt-0.5">Zone <span className="font-mono">{v.zone}</span>{v.tag !== null ? <> · tag <span className="font-mono">{v.tag}</span></> : null}{v.vlanaware ? " · VLAN aware" : ""}{v.isolatePorts ? " · ports isolated" : ""}</div>
            </div>
            <div className="flex gap-1 flex-wrap">
              <Button size="sm" onClick={() => setSub({ vnet: v, subnet: null })}><Plus className="h-4 w-4" />Subnet</Button>
              <Button size="sm" variant="ghost" onClick={() => setFw(v)}>Firewall</Button>
              <Button size="sm" variant="ghost" onClick={() => setVn(v)}>Edit</Button>
              <Button size="sm" variant="ghost" className="text-critical" aria-label={`Delete ${v.vnet}`} onClick={() => setDel({ vnet: v })}><Trash2 className="h-4 w-4" /></Button>
            </div>
          </div>
          {v.subnets.length > 0 && (
            <DataTable label={`Subnets of ${v.vnet}`} head={["Network", "Gateway", "NAT", "DHCP ranges", "State", ""]} min={680}>
              {v.subnets.map((s) => (
                <tr key={s.id} className="border-b border-line last:border-0">
                  <Td mono>{s.cidr}</Td><Td mono>{s.gateway ?? "–"}</Td><Td>{s.snat ? "On" : "Off"}</Td>
                  <Td mono className="text-ink-2">{s.dhcpRange.map((r) => r.replace("start-address=", "").replace(",end-address=", " to ")).join("; ") || "–"}</Td>
                  <Td>{stateChip(s.state)}</Td>
                  <Td><div className="flex gap-1 justify-end"><Button size="sm" variant="ghost" onClick={() => setSub({ vnet: v, subnet: s })}>Edit</Button><Button size="sm" variant="ghost" className="text-critical" aria-label={`Delete ${s.cidr}`} onClick={() => setDel({ vnet: v, subnet: s })}><Trash2 className="h-4 w-4" /></Button></div></Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Card>
      ))}
      {vn && <VnetModal vnet={vn === "new" ? null : vn} ov={ov} onClose={() => setVn(null)} onDone={() => void refresh()} />}
      {sub && <SubnetModal vnet={sub.vnet} subnet={sub.subnet} onClose={() => setSub(null)} onDone={() => void refresh()} />}
      {fw && <FirewallModal vnet={fw} onClose={() => setFw(null)} />}
      {del && <TypedConfirm title={`Delete ${del.subnet ? del.subnet.cidr : del.vnet.vnet}?`} subtitle="Staged until you apply the changes." phrase={del.subnet ? del.subnet.id : del.vnet.vnet} action="Delete" busy={remove.isPending} error={remove.error ? errorText(remove.error) : null} onConfirm={() => remove.mutate(del)} onClose={() => setDel(null)} />}
    </div>
  );
}

/* ── What the node runs ────────────────────────────────────────────────────────────── */

function StatusTab({ ov }: { ov: SdnOverview }) {
  const { node, name } = useNodeName();
  const q = useQuery({ queryKey: ["node", "sdn", "status", name], queryFn: () => dcApi.sdnStatus(node), retry: 1 });
  const [vrf, setVrf] = useState<string | null>(null);
  const evpn = new Set(ov.zones.filter((z) => z.type === "evpn").map((z) => z.id));
  return (
    <Async q={q}>
      {(s) => (
        <Card>
          <div className="p-5 pb-3"><SectionTitle>Running on {s.node}</SectionTitle><p className="text-compact text-ink-3 mt-1">What this node has applied so far. Staged changes show here after you apply them.</p></div>
          {s.denied ? <p className="px-5 pb-5 text-compact text-ink-3">Your Proxmox account can't see the SDN status of this node.</p> : s.zones.length === 0 ? <p className="px-5 pb-5 text-compact text-ink-3">{s.error ?? "No zones are applied on this node."}</p> : (
            <DataTable label="SDN status" head={["Zone", "VNet", "Status", "Message", ""]} min={620}>
              {s.zones.flatMap((z) => (z.vnets.length ? z.vnets : [{ vnet: "", status: null, statusmsg: null }]).map((v, i) => (
                <tr key={`${z.zone}-${v.vnet}-${i}`} className="border-b border-line last:border-0">
                  <Td mono>{i === 0 ? z.zone : ""}{i === 0 && z.status ? <span className="font-sans text-ink-3"> · {z.status}</span> : null}</Td>
                  <Td mono>{v.vnet || "–"}</Td>
                  <Td>{v.status === "available" ? <Status kind="good" label="Available" /> : v.status ? <Status kind="warning" label={v.status} /> : null}</Td>
                  <Td className="text-ink-2">{v.statusmsg ?? ""}</Td>
                  <Td>{v.vnet && evpn.has(z.zone) ? <Button size="sm" variant="ghost" onClick={() => setVrf(v.vnet)}>MAC and IP table</Button> : null}</Td>
                </tr>
              )))}
            </DataTable>
          )}
          {vrf && <VrfModal vnet={vrf} node={node} onClose={() => setVrf(null)} />}
        </Card>
      )}
    </Async>
  );
}

function VrfModal({ vnet, node, onClose }: { vnet: string; node: string | undefined; onClose: () => void }) {
  const q = useQuery({ queryKey: ["node", "sdn", "vrf", node, vnet], queryFn: () => dcApi.macVrf(node, vnet), retry: 0 });
  return (
    <Modal size="lg" title="MAC and IP table" subtitle={vnet} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {q.isPending ? <p className="text-compact text-ink-3">Asking the node…</p> : q.error ? <Notice tone="warning">{errorText(q.error)}</Notice> : q.data.entries.length === 0 ? <p className="text-compact text-ink-3">The table is empty.</p> : (
        <DataTable label="MAC and IP table" head={["MAC", "IP", "Next hop"]} min={420}>{q.data.entries.map((e, i) => <tr key={i} className="border-b border-line last:border-0"><Td mono>{e.mac ?? "–"}</Td><Td mono>{e.ip ?? "–"}</Td><Td mono>{e.nexthop ?? "–"}</Td></tr>)}</DataTable>
      )}
    </Modal>
  );
}

/* ── The page ──────────────────────────────────────────────────────────────────────── */

type Tab = "zones" | "vnets" | "plugins" | "status";

function SdnBody() {
  const qc = useQueryClient();
  const q = useSdn();
  const { node, name } = useNodeName();
  const [tab, setTab] = useState<Tab>("zones");
  const [preview, setPreview] = useState(false);
  const [rollback, setRollback] = useState(false);
  const runner = useTaskRunner(() => void qc.invalidateQueries({ queryKey: ["node", "sdn"] }));
  const { ask, dialog } = useConfirm();
  const roll = useMutation({ mutationFn: dcApi.sdnRollback, onSuccess: () => { setRollback(false); void qc.invalidateQueries({ queryKey: ["node", "sdn"] }); } });
  const prev = useQuery({ queryKey: ["node", "sdn", "preview", name], queryFn: () => dcApi.sdnPreview(node), enabled: preview, retry: 0, staleTime: 0 });
  return (
    <Async q={q}>
      {(ov) => (
        <div className="space-y-4">
          {dialog}
          {ov.denied && <Notice tone="info" title="Your Proxmox account can't read the SDN configuration">It needs SDN.Audit.</Notice>}
          {ov.error && <Notice tone="warning">{ov.error}</Notice>}
          {runner.error && <Notice tone="critical">{runner.error}</Notice>}
          <Card className="p-5">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1 basis-60">
                <div className="font-medium">{ov.pending === 0 ? "Everything is applied" : `${ov.pending} ${ov.pending === 1 ? "change is" : "changes are"} staged`}</div>
                <div className="text-compact text-ink-3 mt-0.5">{ov.pending === 0 ? "The running network matches the configuration." : "Nothing changes on the network until you apply. Applying reloads the network on every node."}</div>
              </div>
              <Button onClick={() => setPreview(true)} disabled={ov.pending === 0}>Preview changes</Button>
              <Button variant="danger" onClick={() => setRollback(true)} disabled={ov.pending === 0}><Undo2 className="h-4 w-4" />Discard…</Button>
              <Button variant="primary" loading={runner.busy} disabled={ov.pending === 0} onClick={() => ask({ title: "Apply the SDN configuration?", body: "The virtual network settings are rolled out and the network is reloaded on every node. Machines on them can lose connectivity for a moment.", label: "Apply", danger: true, run: () => void runner.start("Apply SDN configuration", dcApi.sdnApply) })}>Apply</Button>
            </div>
          </Card>
          <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: "zones", label: "Zones", count: ov.zones.length }, { id: "vnets", label: "VNets", count: ov.vnets.length }, { id: "plugins", label: "IPAM, DNS, controllers" }, { id: "status", label: "Status" }]} />
          {tab === "zones" ? <ObjectSection kind="zones" items={ov.zones} ov={ov} /> : tab === "vnets" ? <VnetsTab ov={ov} /> : tab === "plugins" ? (
            <div className="space-y-4"><ObjectSection kind="ipams" items={ov.ipams} ov={ov} /><ObjectSection kind="dns" items={ov.dns} ov={ov} /><ObjectSection kind="controllers" items={ov.controllers} ov={ov} /></div>
          ) : <StatusTab ov={ov} />}
          {preview && (
            <Modal size="lg" title="Staged changes" subtitle={`As ${name} would apply them`} onClose={() => setPreview(false)} footer={<Button onClick={() => setPreview(false)}>Close</Button>}>
              {prev.isPending ? <p className="text-compact text-ink-3">Asking Proxmox…</p> : prev.error ? <Notice tone="warning">{errorText(prev.error)}</Notice> : prev.data.denied ? <p className="text-compact text-ink-3">Your Proxmox account can't preview changes on this node.</p> : <pre aria-label="Preview" className="rounded-lg bg-code border border-line p-3 text-xs leading-relaxed font-mono text-ink-2 max-h-[50vh] overflow-auto whitespace-pre-wrap break-all">{prev.data.preview ?? prev.data.error ?? "(nothing to show)"}</pre>}
            </Modal>
          )}
          {rollback && <TypedConfirm title="Discard all staged changes?" subtitle="Zones, VNets, subnets and plugins go back to what is applied." phrase="rollback" action="Discard changes" busy={roll.isPending} error={roll.error ? errorText(roll.error) : null} onConfirm={() => roll.mutate()} onClose={() => setRollback(false)} />}
          {runner.modal}
        </div>
      )}
    </Async>
  );
}

export function SdnPage() {
  const { multi } = useNodeName();
  return (
    <PageFrame width="6xl">
      <PageHeader title="Virtual networks (SDN)" subtitle="Zones, VNets and subnets that span the datacenter. Changes are staged until you apply them." actions={multi ? <NodeSwitcher /> : undefined} />
      <LiveOnly><SdnBody /></LiveOnly>
    </PageFrame>
  );
}
