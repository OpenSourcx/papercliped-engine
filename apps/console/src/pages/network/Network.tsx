import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangle, Cable, Check, GitMerge, Loader2, Network as NetIcon, Pencil, Plus, RotateCcw, Split, Trash2 } from "lucide-react";
import { ApiError, type IfaceSpec, type NetIface, type SdnState } from "../../data/api.ts";
import { useEngine } from "../../data/store.tsx";
import { cn } from "../../lib/storage.ts";
import { usePinActions } from "../../pin/PinContext.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, Input, PageFrame, PageHeader, Segmented, Status, Toggle } from "../../ui/primitives.tsx";

const TYPE_LABEL: Record<string, string> = { bridge: "Linux bridge", eth: "Network card", bond: "Bond", vlan: "VLAN", OVSBridge: "OVS bridge", OVSPort: "OVS port", OVSIntPort: "OVS port", alias: "Alias", unknown: "Other" };
const q = () => new URLSearchParams(window.location.search);

/** The host's network, like System → Network in Proxmox: changes are staged, shown as a diff, then applied or reverted. */
function InterfacesView() {
  const engine = useEngine();
  const nav = useNavigate();
  const [data, setData] = useState<{ interfaces: NetIface[]; changes: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [removing, setRemoving] = useState<NetIface | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [applying, setApplying] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);

  useEffect(() => {
    let alive = true;
    engine.backend.network().then(
      (d) => alive && (setData(d), setError(null)),
      (e) => alive && setError(e instanceof ApiError ? e.message : "Couldn't read the network configuration"),
    );
    return () => {
      alive = false;
    };
  }, [engine.backend, engine.contentVersion, tick, q().get("modal")]); // eslint-disable-line react-hooks/exhaustive-deps

  usePinActions({
    context: "Network",
    items: [
      { id: "new-bridge", label: "New bridge", icon: <Plus className="h-4 w-4" />, group: "do", run: () => nav("?modal=iface&type=bridge") },
      { id: "new-vlan", label: "New VLAN", icon: <Split className="h-4 w-4" />, group: "do", run: () => nav("?modal=iface&type=vlan") },
      { id: "new-bond", label: "New bond", icon: <GitMerge className="h-4 w-4" />, group: "do", more: true, run: () => nav("?modal=iface&type=bond") },
      ...(data?.changes ? [{ id: "apply", label: "Apply changes", icon: <Check className="h-4 w-4" />, group: "do" as const, run: () => setConfirmApply(true) }] : []),
    ],
  }, 10);

  const apply = async () => {
    setApplying(true);
    try {
      const r = await engine.backend.applyNetwork();
      engine.watchTask(r.task, "Apply network changes");
      setConfirmApply(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't apply the changes");
    } finally {
      setApplying(false);
    }
  };
  const revert = async () => {
    try {
      await engine.backend.revertNetwork();
      setTick((n) => n + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't revert");
    }
  };
  const remove = async () => {
    if (!removing) return;
    try {
      await engine.backend.deleteIface(removing.iface, confirmText || undefined);
      setRemoving(null);
      setConfirmText("");
      setTick((n) => n + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't delete it");
      setRemoving(null);
    }
  };
  const mgmt = data?.interfaces.find((i) => i.gateway);

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3"><p className="text-[13px] text-ink-3">Bridges, VLANs, bonds and network cards. Changes wait here until you apply them.</p><Button size="sm" variant="primary" onClick={() => nav("?modal=iface&type=bridge")}><Plus className="h-3.5 w-3.5" />New</Button></div>
      {error && <p role="alert" className="text-[13px] text-critical mb-3">{error}</p>}

      {data?.changes && (
        <Card className="p-4 mb-4 border-warning/40">
          <div className="flex flex-wrap items-center gap-3">
            <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
            <div className="flex-1 min-w-[220px]"><div className="font-medium text-[14px]">Changes waiting to be applied</div><div className="text-[12px] text-ink-3">Nothing changes on the host until you apply them.</div></div>
            <Button size="sm" variant="ghost" onClick={() => setShowDiff((v) => !v)}>{showDiff ? "Hide" : "Show"} changes</Button>
            <Button size="sm" variant="ghost" onClick={revert}><RotateCcw className="h-3.5 w-3.5" />Revert</Button>
            <Button size="sm" variant="primary" onClick={() => setConfirmApply(true)}><Check className="h-3.5 w-3.5" />Apply</Button>
          </div>
          {showDiff && (
            <pre className="mt-3 rounded-lg bg-black/40 border border-line p-3 text-[12px] font-mono overflow-x-auto max-h-[320px]">
              {data.changes.split("\n").map((l, i) => <div key={i} className={cn(l.startsWith("+") && !l.startsWith("+++") ? "text-good" : l.startsWith("-") && !l.startsWith("---") ? "text-critical" : "text-ink-3")}>{l || " "}</div>)}
            </pre>
          )}
        </Card>
      )}

      <Card className="overflow-x-auto">
        {data === null && !error ? (
          <div className="p-8 text-center text-ink-3 text-[14px]"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Reading the network…</div>
        ) : (
          <table className="w-full text-[13px] min-w-[820px]">
            <thead>
              <tr className="border-b border-line text-ink-3 text-left">
                <th className="font-normal px-4 h-10">Name</th>
                <th className="font-normal px-3">Type</th>
                <th className="font-normal px-3">Active</th>
                <th className="font-normal px-3">Address</th>
                <th className="font-normal px-3">Gateway</th>
                <th className="font-normal px-3">Ports / members</th>
                <th className="font-normal px-3">Comment</th>
                <th className="px-3 w-[1%]"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {data?.interfaces.map((i) => {
                const editable = i.type === "bridge" || i.type === "bond" || i.type === "vlan";
                return (
                  <tr key={i.iface} className="border-b border-line last:border-0 hover:bg-surface-2/50">
                    <td className="px-4 py-2.5"><span className="inline-flex items-center gap-2 font-mono"><span className="text-ink-3">{i.type === "eth" ? <Cable className="h-4 w-4" /> : <NetIcon className="h-4 w-4" />}</span>{i.iface}</span></td>
                    <td className="px-3 whitespace-nowrap">{TYPE_LABEL[i.type] ?? i.type}{i.vlanAware && <Chip className="ml-2">VLAN aware</Chip>}</td>
                    <td className="px-3">{i.active ? <Status kind="good" label="Yes" /> : <Status kind="off" label={i.autostart ? "Pending" : "No"} />}</td>
                    <td className="px-3 font-mono text-[12.5px]">{i.cidr ?? <span className="text-ink-3">—</span>}</td>
                    <td className="px-3 font-mono text-[12.5px]">{i.gateway ?? <span className="text-ink-3">—</span>}</td>
                    <td className="px-3 font-mono text-[12.5px]">{[...i.ports, ...i.slaves].join(" ") || (i.vlanRaw ? `${i.vlanRaw} · tag ${i.vlanId}` : <span className="text-ink-3">—</span>)}</td>
                    <td className="px-3 text-ink-2 truncate max-w-[200px]">{i.comments ?? ""}</td>
                    <td className="px-3 whitespace-nowrap text-right">
                      {editable && <Button size="sm" variant="ghost" onClick={() => nav(`?modal=iface&edit=${encodeURIComponent(i.iface)}`)}><Pencil className="h-3.5 w-3.5" />Edit</Button>}
                      {i.type !== "eth" && <button onClick={() => setRemoving(i)} aria-label={`Delete ${i.iface}`} className="h-8 w-8 rounded-md inline-flex items-center justify-center text-ink-3 hover:text-critical hover:bg-critical/10"><Trash2 className="h-4 w-4" /></button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      <p className="text-[12px] text-ink-3 mt-3">Organization machines join a bridge with the firewall on. A VLAN-aware bridge lets each machine's network device pick a VLAN tag, keeping organizations off the management network.</p>

      {confirmApply && (
        <Modal size="sm" title="Apply network changes?" subtitle="The host reloads its network configuration. Machines on changed bridges may lose their connection for a moment." onClose={() => setConfirmApply(false)} footer={<><Button variant="ghost" onClick={() => setConfirmApply(false)}>Cancel</Button><Button variant="primary" onClick={apply} disabled={applying}>{applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Apply</Button></>}>
          {mgmt && <p className="text-[13px] text-warning">You reach this device through {mgmt.iface} ({mgmt.cidr}). If its address changes, open the console at the new address. The stock Proxmox UI on :8006 and the physical console still work.</p>}
        </Modal>
      )}
      {removing && (
        <Modal size="sm" title={`Delete ${removing.iface}?`} subtitle="It's removed from the staged configuration; nothing changes until you apply." onClose={() => { setRemoving(null); setConfirmText(""); }} footer={<><Button variant="ghost" onClick={() => { setRemoving(null); setConfirmText(""); }}>Cancel</Button><Button variant="danger" onClick={remove} disabled={!!removing.gateway && confirmText !== removing.iface}><Trash2 className="h-4 w-4" />Delete</Button></>}>
          {removing.gateway ? (
            <div className="rounded-lg border border-critical/30 bg-critical/5 p-3 text-[13px]">
              <p className="text-ink-2">{removing.iface} carries this host's gateway. Applying this can cut the device off the network.</p>
              <label className="block mt-3"><span className="block text-[12px] text-ink-3 mb-1.5">Type <span className="font-mono text-ink-2">{removing.iface}</span> to confirm</span><Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} spellCheck={false} /></label>
            </div>
          ) : <div />}
        </Modal>
      )}
    </div>
  );
}

const NET_TABS = [
  { id: "interfaces", label: "Interfaces" },
  { id: "dns", label: "DNS and hosts" },
  { id: "sdn", label: "Virtual networks (SDN)" },
] as const;

/** The host's network: interfaces, name resolution, and SDN virtual networks for organizations. */
export function NetworkPage() {
  const [params, setParams] = useSearchParams();
  const tab = NET_TABS.find((t) => t.id === params.get("tab"))?.id ?? "interfaces";
  return (
    <PageFrame width="6xl">
      <PageHeader title="Network" subtitle="How this device and its machines connect: interfaces, DNS, and virtual networks." />
      <div className="flex gap-1 border-b border-line mb-5 overflow-x-auto [scrollbar-width:none]" role="tablist">
        {NET_TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setParams((p) => { const n = new URLSearchParams(p); n.set("tab", t.id); return n; }, { replace: true })} className={cn("px-3.5 h-10 text-[14px] whitespace-nowrap border-b-2 -mb-px transition", tab === t.id ? "border-accent text-ink" : "border-transparent text-ink-3 hover:text-ink-2")}>{t.label}</button>)}
      </div>
      {tab === "interfaces" && <InterfacesView />}
      {tab === "dns" && <DnsHosts />}
      {tab === "sdn" && <Sdn />}
    </PageFrame>
  );
}

function DnsHosts() {
  const engine = useEngine();
  const [search, setSearch] = useState("");
  const [servers, setServers] = useState(["", "", ""]);
  const [hosts, setHosts] = useState<{ data: string; digest: string | null } | null>(null);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    engine.backend.dns().then((d) => { setSearch(d.search); setServers([d.servers[0] ?? "", d.servers[1] ?? "", d.servers[2] ?? ""]); }, (e) => setMsg({ ok: false, text: e instanceof ApiError ? e.message : "Couldn't read DNS" }));
    engine.backend.hosts().then((h) => { setHosts(h); setText(h.data); }, () => setHosts(null));
  }, [engine.backend, tick]);
  const saveDns = async () => {
    try {
      await engine.backend.setDns(search.trim(), servers.map((x) => x.trim()).filter(Boolean));
      setMsg({ ok: true, text: "DNS saved." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : "Couldn't save DNS" });
    }
  };
  const saveHosts = async () => {
    try {
      await engine.backend.setHosts(text, hosts?.digest ?? null);
      setMsg({ ok: true, text: "Hosts file saved." });
      setTick((n) => n + 1);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? `${e.message} Reload to see the current file.` : "Couldn't save the hosts file" });
    }
  };
  return (
    <div className="grid lg:grid-cols-[360px_1fr] gap-5">
      <Card className="p-5 h-fit">
        <h2 className="font-medium mb-1">DNS</h2>
        <p className="text-[12px] text-ink-3 mb-4">Where the host looks up names. Containers copy this unless they set their own.</p>
        <label className="block mb-3"><span className="block text-[13px] text-ink-2 mb-1.5">Search domain</span><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="lan" className="font-mono" /></label>
        {servers.map((v, i) => (
          <label key={i} className="block mb-3"><span className="block text-[13px] text-ink-2 mb-1.5">DNS server {i + 1}{i ? <span className="text-ink-3"> (optional)</span> : ""}</span><Input value={v} onChange={(e) => setServers(servers.map((x, j) => (j === i ? e.target.value : x)))} placeholder={i === 0 ? "192.168.1.1" : ""} className="font-mono" /></label>
        ))}
        <Button size="sm" variant="primary" onClick={saveDns} disabled={!search.trim() || !servers[0].trim()}>Save DNS</Button>
      </Card>
      <Card className="flex flex-col min-h-[420px]">
        <div className="flex items-center gap-2 px-4 h-11 border-b border-line">
          <span className="font-mono text-[13px] flex-1">/etc/hosts{hosts && text !== hosts.data && <span className="text-warning"> · unsaved</span>}</span>
          <Button size="sm" variant="ghost" onClick={() => setTick((n) => n + 1)}>Reload</Button>
          <Button size="sm" variant="primary" onClick={saveHosts} disabled={!hosts || text === hosts.data}>Save</Button>
        </div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="Hosts file" className="flex-1 w-full resize-none bg-transparent p-4 font-mono text-[13px] leading-relaxed outline-none" />
      </Card>
      {msg && <p role="status" className={cn("lg:col-span-2 text-[13px]", msg.ok ? "text-good" : "text-critical")}>{msg.text}</p>}
    </div>
  );
}

const ID_RE = /^[a-z][a-z0-9]{0,7}$/;

function Sdn() {
  const engine = useEngine();
  const [state, setState] = useState<SdnState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [form, setForm] = useState<null | { kind: "zone" } | { kind: "vnet" } | { kind: "subnet"; vnet: string }>(null);
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    engine.backend.sdn().then((s) => (setState(s), setError(null)), (e) => setError(e instanceof ApiError ? e.message : "Couldn't read SDN"));
  }, [engine.backend, engine.contentVersion, tick]);
  const act = async (path: string, body?: unknown) => {
    try {
      const r = await engine.backend.sdnPost(path, body);
      if (r.task) engine.watchTask(r.task, "Apply virtual network changes");
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Proxmox refused that");
    }
    setTick((n) => n + 1);
  };
  const pill = (s: string | null) => (s ? <Chip tone="warning">{s === "new" ? "new · not applied" : s === "deleted" ? "deleted · not applied" : "changed · not applied"}</Chip> : null);
  return (
    <div className="space-y-5">
      <p className="text-[13px] text-ink-3">Virtual networks let organizations have their own isolated network, with addresses handed out automatically and internet access through the host. A <b className="font-medium text-ink-2">zone</b> is the kind of network, a <b className="font-medium text-ink-2">VNet</b> is a network machines join like a bridge, and a <b className="font-medium text-ink-2">subnet</b> gives it addresses.</p>
      {error && <p role="alert" className="text-[13px] text-critical">{error}</p>}
      {state && state.pending > 0 && (
        <Card className="p-4 border-warning/40 flex flex-wrap items-center gap-3">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <div className="flex-1 min-w-[200px]"><div className="font-medium text-[14px]">{state.pending} change{state.pending === 1 ? "" : "s"} waiting</div><div className="text-[12px] text-ink-3">Machines can join new VNets once they're applied.</div></div>
          <Button size="sm" variant="primary" onClick={async () => { setApplying(true); await act("apply"); setApplying(false); }} disabled={applying}>{applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}Apply</Button>
        </Card>
      )}
      <div className="grid lg:grid-cols-[320px_1fr] gap-5">
        <div>
          <div className="flex items-center justify-between mb-2"><h2 className="font-medium">Zones</h2><Button size="sm" variant="ghost" onClick={() => setForm({ kind: "zone" })}><Plus className="h-3.5 w-3.5" />Zone</Button></div>
          <Card className="divide-y divide-line">
            {state?.zones.length === 0 && <p className="p-4 text-[13px] text-ink-3">No zones yet. A simple zone is the easy start: isolated networks on this host.</p>}
            {state?.zones.map((z) => (
              <div key={z.zone} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0"><div className="font-mono text-[13px]">{z.zone}</div><div className="text-[12px] text-ink-3">{z.type === "simple" ? "Simple (isolated on this host)" : `VLAN on ${z.bridge}`}{z.dhcp ? " · DHCP" : ""}</div></div>
                {pill(z.state)}
                <button onClick={() => act(`zones/${z.zone}/delete`)} aria-label={`Delete ${z.zone}`} className="h-8 w-8 rounded-md inline-flex items-center justify-center text-ink-3 hover:text-critical hover:bg-critical/10"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </Card>
        </div>
        <div>
          <div className="flex items-center justify-between mb-2"><h2 className="font-medium">VNets</h2><Button size="sm" variant="ghost" onClick={() => setForm({ kind: "vnet" })} disabled={!state?.zones.length}><Plus className="h-3.5 w-3.5" />VNet</Button></div>
          <div className="space-y-3">
            {state?.vnets.length === 0 && <Card className="p-4 text-[13px] text-ink-3">No VNets yet.</Card>}
            {state?.vnets.map((v) => (
              <Card key={v.vnet} className="p-4">
                <div className="flex items-center gap-3">
                  <NetIcon className="h-4 w-4 text-ink-3" />
                  <div className="flex-1 min-w-0"><div className="text-[14px]"><span className="font-mono">{v.vnet}</span>{v.alias && <span className="text-ink-2"> · {v.alias}</span>}</div><div className="text-[12px] text-ink-3">Zone {v.zone}{v.tag ? ` · VLAN ${v.tag}` : ""}</div></div>
                  {pill(v.state)}
                  <Button size="sm" variant="ghost" onClick={() => setForm({ kind: "subnet", vnet: v.vnet })}><Plus className="h-3.5 w-3.5" />Subnet</Button>
                  <button onClick={() => act(`vnets/${v.vnet}/delete`)} aria-label={`Delete ${v.vnet}`} className="h-8 w-8 rounded-md inline-flex items-center justify-center text-ink-3 hover:text-critical hover:bg-critical/10"><Trash2 className="h-4 w-4" /></button>
                </div>
                {v.subnets.length > 0 && (
                  <div className="mt-3 divide-y divide-line border-t border-line">
                    {v.subnets.map((sn) => (
                      <div key={sn.id} className="flex items-center gap-3 pt-2.5 mt-2.5 first:mt-0">
                        <span className="font-mono text-[13px] w-36">{sn.cidr}</span>
                        <span className="text-[12px] text-ink-3 flex-1">{sn.gateway ? `gateway ${sn.gateway}` : "no gateway"}{sn.snat ? " · internet via host (SNAT)" : ""}{sn.dhcpRange.length ? ` · DHCP ${sn.dhcpRange[0].replace("start-address=", "").replace(",end-address=", " to ")}` : ""}</span>
                        {pill(sn.state)}
                        <button onClick={() => act(`vnets/${v.vnet}/subnets/${encodeURIComponent(sn.id)}/delete`)} aria-label={`Delete ${sn.cidr}`} className="h-8 w-8 rounded-md inline-flex items-center justify-center text-ink-3 hover:text-critical hover:bg-critical/10"><Trash2 className="h-4 w-4" /></button>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            ))}
          </div>
        </div>
      </div>
      {form && <SdnForm form={form} zones={state?.zones.map((z) => z.zone) ?? []} onClose={() => setForm(null)} onSave={async (path, body) => { await act(path, body); setForm(null); }} />}
    </div>
  );
}

function SdnForm({ form, zones, onClose, onSave }: { form: { kind: "zone" } | { kind: "vnet" } | { kind: "subnet"; vnet: string }; zones: string[]; onClose: () => void; onSave: (path: string, body: unknown) => Promise<void> }) {
  const [id, setId] = useState("");
  const [type, setType] = useState<"simple" | "vlan">("simple");
  const [bridge, setBridge] = useState("vmbr0");
  const [dhcp, setDhcp] = useState(true);
  const [zone, setZone] = useState(zones[0] ?? "");
  const [alias, setAlias] = useState("");
  const [tag, setTag] = useState("");
  const [cidr, setCidr] = useState("10.20.0.0/24");
  const [gateway, setGateway] = useState("10.20.0.1");
  const [snat, setSnat] = useState(true);
  const [dhcpStart, setDhcpStart] = useState("10.20.0.100");
  const [dhcpEnd, setDhcpEnd] = useState("10.20.0.200");
  const idErr = form.kind !== "subnet" && id && !ID_RE.test(id) ? "Up to 8 lowercase letters and digits, starting with a letter." : null;
  const save = () =>
    form.kind === "zone" ? onSave("zones", { zone: id, type, bridge: type === "vlan" ? bridge : undefined, dhcp: type === "simple" && dhcp })
    : form.kind === "vnet" ? onSave("vnets", { vnet: id, zone, alias: alias || undefined, tag: tag ? Number(tag) : undefined })
    : onSave(`vnets/${form.vnet}/subnets`, { cidr, gateway: gateway || undefined, snat, dhcpStart: dhcpStart || undefined, dhcpEnd: dhcpEnd || undefined });
  return (
    <Modal icon={<NetIcon className="h-5 w-5" />} title={form.kind === "zone" ? "New zone" : form.kind === "vnet" ? "New VNet" : `New subnet on ${form.vnet}`} subtitle="Staged until you apply." onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={form.kind !== "subnet" && (!id || !!idErr)}>Create</Button></>}>
      <div className="space-y-4">
        {form.kind !== "subnet" && <label className="block"><span className="block text-[13px] text-ink-2 mb-2">Name</span><Input autoFocus value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder={form.kind === "zone" ? "orgs" : "northw"} className="font-mono" />{idErr && <span className="block text-[12px] mt-1.5 text-critical">{idErr}</span>}</label>}
        {form.kind === "zone" && (
          <>
            <Segmented value={type} onChange={setType} options={[{ value: "simple", label: "Simple" }, { value: "vlan", label: "VLAN" }]} />
            <p className="text-[12px] text-ink-3">{type === "simple" ? "Isolated networks that live on this host. The host routes them, so they can reach the internet with SNAT." : "Each VNet becomes a VLAN tag on an existing bridge, to reach other devices on your physical network."}</p>
            {type === "vlan" ? <label className="block"><span className="block text-[13px] text-ink-2 mb-2">Bridge</span><Input value={bridge} onChange={(e) => setBridge(e.target.value)} className="font-mono" /></label> : <div className="flex items-center justify-between"><span className="text-[14px]">Hand out addresses automatically (DHCP)</span><Toggle checked={dhcp} onChange={setDhcp} label="DHCP" /></div>}
          </>
        )}
        {form.kind === "vnet" && (
          <div className="grid sm:grid-cols-2 gap-4">
            <label className="block"><span className="block text-[13px] text-ink-2 mb-2">Zone</span><select value={zone} onChange={(e) => setZone(e.target.value)} className="h-10 w-full rounded-lg bg-surface-2 border border-line px-3 text-[14px]">{zones.map((z) => <option key={z}>{z}</option>)}</select></label>
            <label className="block"><span className="block text-[13px] text-ink-2 mb-2">VLAN tag <span className="text-ink-3">(VLAN zones)</span></span><Input type="number" min={1} max={4094} value={tag} onChange={(e) => setTag(e.target.value)} /></label>
            <label className="block sm:col-span-2"><span className="block text-[13px] text-ink-2 mb-2">Description</span><Input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="Northwind Labs network" /></label>
          </div>
        )}
        {form.kind === "subnet" && (
          <>
            <div className="grid sm:grid-cols-2 gap-4">
              <label className="block"><span className="block text-[13px] text-ink-2 mb-2">Network</span><Input value={cidr} onChange={(e) => setCidr(e.target.value)} className="font-mono" /></label>
              <label className="block"><span className="block text-[13px] text-ink-2 mb-2">Gateway</span><Input value={gateway} onChange={(e) => setGateway(e.target.value)} className="font-mono" /></label>
              <label className="block"><span className="block text-[13px] text-ink-2 mb-2">DHCP from</span><Input value={dhcpStart} onChange={(e) => setDhcpStart(e.target.value)} className="font-mono" /></label>
              <label className="block"><span className="block text-[13px] text-ink-2 mb-2">DHCP to</span><Input value={dhcpEnd} onChange={(e) => setDhcpEnd(e.target.value)} className="font-mono" /></label>
            </div>
            <div className="flex items-center justify-between"><div><div className="text-[14px]">Internet through the host (SNAT)</div><div className="text-[12px] text-ink-3">Machines reach out; nothing outside can reach in.</div></div><Toggle checked={snat} onChange={setSnat} label="SNAT" /></div>
          </>
        )}
      </div>
    </Modal>
  );
}

const BOND_MODES = ["active-backup", "balance-rr", "balance-xor", "broadcast", "802.3ad", "balance-tlb", "balance-alb"];

/** Create or edit a bridge, VLAN or bond. ?modal=iface&type=bridge|vlan|bond or ?modal=iface&edit=<iface> */
export function IfaceModal({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const p = q();
  const editing = p.get("edit");
  const [list, setList] = useState<NetIface[] | null>(null);
  const [type, setType] = useState<"bridge" | "vlan" | "bond">((p.get("type") as "bridge" | "vlan" | "bond") ?? "bridge");
  const [iface, setIface] = useState("");
  const [cidr, setCidr] = useState("");
  const [gateway, setGateway] = useState("");
  const [ports, setPorts] = useState("");
  const [slaves, setSlaves] = useState<string[]>([]);
  const [bondMode, setBondMode] = useState("active-backup");
  const [vlanAware, setVlanAware] = useState(true);
  const [vlanRaw, setVlanRaw] = useState("");
  const [vlanId, setVlanId] = useState("");
  const [autostart, setAutostart] = useState(true);
  const [comments, setComments] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    engine.backend.network().then((d) => {
      setList(d.interfaces);
      const cur = editing ? d.interfaces.find((i) => i.iface === editing) : null;
      if (cur) {
        setType(cur.type === "bond" ? "bond" : cur.type === "vlan" ? "vlan" : "bridge");
        setIface(cur.iface);
        setCidr(cur.cidr ?? "");
        setGateway(cur.gateway ?? "");
        setPorts(cur.ports.join(" "));
        setSlaves(cur.slaves);
        setBondMode(cur.bondMode ?? "active-backup");
        setVlanAware(cur.vlanAware);
        setVlanRaw(cur.vlanRaw ?? "");
        setVlanId(cur.vlanId ? String(cur.vlanId) : "");
        setAutostart(cur.autostart);
        setComments(cur.comments ?? "");
      } else {
        const free = (prefix: string) => {
          let n = 0;
          while (d.interfaces.some((i) => i.iface === `${prefix}${n}`)) n++;
          return `${prefix}${n}`;
        };
        setIface(type === "bond" ? free("bond") : type === "vlan" ? "" : free("vmbr"));
        setVlanRaw(d.interfaces.find((i) => i.type === "bridge")?.iface ?? "");
      }
    }, (e) => setError(e instanceof ApiError ? e.message : "Couldn't read the network"));
  }, [engine.backend]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (editing || !list) return;
    const free = (prefix: string) => {
      let n = 0;
      while (list.some((i) => i.iface === `${prefix}${n}`)) n++;
      return `${prefix}${n}`;
    };
    if (type === "bridge") setIface(free("vmbr"));
    if (type === "bond") setIface(free("bond"));
    if (type === "vlan") setIface(vlanRaw && vlanId ? `${vlanRaw}.${vlanId}` : "");
  }, [type, vlanRaw, vlanId, list, editing]);

  const nics = (list ?? []).filter((i) => i.type === "eth" || i.type === "bond");
  const save = async () => {
    setBusy(true);
    setError(null);
    const spec: IfaceSpec = { type, iface, cidr: cidr.trim() || null, gateway: gateway.trim() || null, autostart, comments: comments.trim() || null, ports: ports.split(/[\s,]+/).filter(Boolean), vlanAware, slaves, bondMode: type === "bond" ? bondMode : null, vlanRaw: type === "vlan" ? vlanRaw : null, vlanId: type === "vlan" ? Number(vlanId) : null };
    try {
      await engine.backend.saveIface(editing, spec);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save it");
    } finally {
      setBusy(false);
    }
  };
  const select = "h-10 w-full rounded-lg bg-surface-2 border border-line px-3 text-[14px] outline-none focus:border-line-strong";

  return (
    <Modal icon={<NetIcon className="h-5 w-5" />} title={editing ? `Edit ${editing}` : `New ${type === "bridge" ? "bridge" : type === "vlan" ? "VLAN" : "bond"}`} subtitle="Staged until you apply changes on the Network page." onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy || !list || !iface}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{editing ? "Save" : "Create"}</Button></>}>
      <div className="space-y-4">
        {!editing && <Segmented value={type} onChange={setType} options={[{ value: "bridge", label: "Bridge" }, { value: "vlan", label: "VLAN" }, { value: "bond", label: "Bond" }]} />}
        {type === "vlan" && !editing ? (
          <div className="grid grid-cols-2 gap-4">
            <label className="block"><span className="block text-[13px] text-ink-2 mb-2">On</span><select value={vlanRaw} onChange={(e) => setVlanRaw(e.target.value)} className={select}>{(list ?? []).filter((i) => i.type !== "vlan").map((i) => <option key={i.iface}>{i.iface}</option>)}</select></label>
            <label className="block"><span className="block text-[13px] text-ink-2 mb-2">VLAN id</span><Input type="number" min={1} max={4094} value={vlanId} onChange={(e) => setVlanId(e.target.value)} placeholder="20" /></label>
          </div>
        ) : (
          <label className="block"><span className="block text-[13px] text-ink-2 mb-2">Name</span><Input value={iface} onChange={(e) => setIface(e.target.value)} disabled={!!editing} spellCheck={false} className="font-mono" /></label>
        )}
        {type === "vlan" && !editing && iface && <p className="text-[12px] text-ink-3 -mt-2">Creates <span className="font-mono">{iface}</span>.</p>}
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block"><span className="block text-[13px] text-ink-2 mb-2">Address <span className="text-ink-3">(optional)</span></span><Input value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="10.10.0.1/24" spellCheck={false} className="font-mono" /></label>
          <label className="block"><span className="block text-[13px] text-ink-2 mb-2">Gateway <span className="text-ink-3">(optional)</span></span><Input value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder="Only one interface should have one" spellCheck={false} className="font-mono" /></label>
        </div>
        {type === "bridge" && (
          <>
            <label className="block"><span className="block text-[13px] text-ink-2 mb-2">Bridge ports</span><Input value={ports} onChange={(e) => setPorts(e.target.value)} placeholder="nic1 (empty for an internal-only bridge)" spellCheck={false} className="font-mono" /></label>
            <div className="flex items-center justify-between gap-4"><div><div className="text-[14px]">VLAN aware</div><div className="text-[12px] text-ink-3">Lets machines pick a VLAN tag on this bridge.</div></div><Toggle checked={vlanAware} onChange={setVlanAware} label="VLAN aware" /></div>
          </>
        )}
        {type === "bond" && (
          <>
            <fieldset><legend className="text-[13px] text-ink-2 mb-2">Members</legend><div className="flex flex-wrap gap-2">{nics.filter((n) => n.type === "eth").map((n) => <label key={n.iface} className={cn("inline-flex items-center gap-2 h-9 px-3 rounded-lg border text-[13px] font-mono cursor-pointer", slaves.includes(n.iface) ? "border-accent/60 bg-accent-soft" : "border-line")}><input type="checkbox" className="accent-[var(--accent)]" checked={slaves.includes(n.iface)} onChange={(e) => setSlaves(e.target.checked ? [...slaves, n.iface] : slaves.filter((x) => x !== n.iface))} />{n.iface}</label>)}</div></fieldset>
            <label className="block"><span className="block text-[13px] text-ink-2 mb-2">Mode</span><select value={bondMode} onChange={(e) => setBondMode(e.target.value)} className={select}>{BOND_MODES.map((m) => <option key={m}>{m}</option>)}</select></label>
          </>
        )}
        <label className="block"><span className="block text-[13px] text-ink-2 mb-2">Comment</span><Input value={comments} onChange={(e) => setComments(e.target.value)} maxLength={200} /></label>
        <div className="flex items-center justify-between"><span className="text-[14px]">Start at boot</span><Toggle checked={autostart} onChange={setAutostart} label="Start at boot" /></div>
        {error && <p role="alert" className="text-[13px] text-critical">{error}</p>}
      </div>
    </Modal>
  );
}
