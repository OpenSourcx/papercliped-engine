import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Cable, Check, GitMerge, Loader2, Network as NetIcon, Pencil, Plus, RotateCcw, Split, Trash2 } from "lucide-react";
import { ApiError, type IfaceSpec, type NetIface } from "../../data/api.ts";
import { useEngine } from "../../data/store.tsx";
import { cn } from "../../lib/storage.ts";
import { usePinActions } from "../../pin/PinContext.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, Input, PageFrame, PageHeader, Segmented, Status, Toggle } from "../../ui/primitives.tsx";

const TYPE_LABEL: Record<string, string> = { bridge: "Linux bridge", eth: "Network card", bond: "Bond", vlan: "VLAN", OVSBridge: "OVS bridge", OVSPort: "OVS port", OVSIntPort: "OVS port", alias: "Alias", unknown: "Other" };
const q = () => new URLSearchParams(window.location.search);

/** The host's network, like System → Network in Proxmox: changes are staged, shown as a diff, then applied or reverted. */
export function NetworkPage() {
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
    <PageFrame width="6xl">
      <PageHeader title="Network" subtitle="Bridges, VLANs, bonds and network cards on this device. Changes wait here until you apply them." actions={<Button variant="primary" onClick={() => nav("?modal=iface&type=bridge")}><Plus className="h-4 w-4" />New</Button>} />
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
    </PageFrame>
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
