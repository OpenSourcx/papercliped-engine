import { useEffect, useState } from "react";
import { Cable, Cpu, Disc3, HardDrive, Loader2, MemoryStick, Pencil, Plus, Save, Settings2, Trash2 } from "lucide-react";
import { ApiError, type GuestHardware, type NetIface, type Nic } from "../../data/api.ts";
import { useEngine } from "../../data/store.tsx";
import type { Guest } from "../../data/types.ts";
import { formatBytes } from "../../lib/storage.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, Input, SectionTitle, Toggle, selectClass } from "../../ui/primitives.tsx";
import { volName } from "../storage/content.ts";

const select = selectClass;
const MEMORY = [512, 1024, 2048, 4096, 8192, 12288, 16384, 24576, 32768, 65536];

/** A machine's hardware, editable like Proxmox's Hardware and Options panels, with plain words and safe defaults. */
export function Hardware({ g }: { g: Guest }) {
  const engine = useEngine();
  const [hw, setHw] = useState<GuestHardware | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [cores, setCores] = useState(1);
  const [sockets, setSockets] = useState(1);
  const [memory, setMemory] = useState(1024);
  const [swap, setSwap] = useState(512);
  const [saving, setSaving] = useState(false);
  const [grow, setGrow] = useState<{ key: string; size: number | null } | null>(null);
  const [nic, setNic] = useState<Nic | "new" | null>(null);
  const [removeNic, setRemoveNic] = useState<Nic | null>(null);
  const [opts, setOpts] = useState(false);

  useEffect(() => {
    let alive = true;
    engine.backend.hardware(g.vmid).then(
      (h) => {
        if (!alive) return;
        setHw(h);
        setCores(h.cores);
        setSockets(h.sockets);
        setMemory(h.memoryMb);
        setSwap(h.swapMb ?? 0);
        setError(null);
      },
      (e) => alive && setError(e instanceof ApiError ? e.message : "Couldn't read this machine's hardware"),
    );
    return () => {
      alive = false;
    };
  }, [g.vmid, engine.backend, engine.contentVersion, tick]);

  if (error) return <p role="alert" className="text-compact text-critical">{error}</p>;
  if (!hw) return <Card className="p-8 text-center text-ink-3 text-sm"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Reading hardware…</Card>;

  const dirty = cores !== hw.cores || sockets !== hw.sockets || memory !== hw.memoryMb || (hw.type === "lxc" && swap !== hw.swapMb);
  const save = async () => {
    setSaving(true);
    const r = await engine.changeHardware(g.vmid, { ...(cores !== hw.cores ? { cores } : {}), ...(sockets !== hw.sockets ? { sockets } : {}), ...(memory !== hw.memoryMb ? { memoryMb: memory } : {}), ...(hw.type === "lxc" && swap !== hw.swapMb ? { swapMb: swap } : {}) });
    setSaving(false);
    if (!r.ok) return setError(r.error);
    setTick((n) => n + 1);
  };
  const running = hw.status === "running";
  const later = hw.type === "qemu" && running;

  return (
    <div className="grid lg:grid-cols-2 gap-5 fade-in">
      <Card className="p-5">
        <SectionTitle>Processor and memory</SectionTitle>
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="flex items-center gap-2 text-compact text-ink-2 mb-2"><Cpu className="h-3.5 w-3.5" />Cores</span>
            <Input type="number" min={1} max={512} value={cores} onChange={(e) => setCores(Math.max(1, Math.min(512, Number(e.target.value) || 1)))} />
          </label>
          {hw.type === "qemu" ? (
            <label className="block">
              <span className="block text-compact text-ink-2 mb-2">Sockets</span>
              <Input type="number" min={1} max={16} value={sockets} onChange={(e) => setSockets(Math.max(1, Math.min(16, Number(e.target.value) || 1)))} />
            </label>
          ) : (
            <label className="block">
              <span className="block text-compact text-ink-2 mb-2">Swap</span>
              <select value={swap} onChange={(e) => setSwap(Number(e.target.value))} className={select}>{[0, 256, 512, 1024, 2048, 4096].concat(swap && ![0, 256, 512, 1024, 2048, 4096].includes(swap) ? [swap] : []).map((m) => <option key={m} value={m}>{m ? formatBytes(m * 1024 ** 2) : "None"}</option>)}</select>
            </label>
          )}
          <label className="block col-span-2">
            <span className="flex items-center gap-2 text-compact text-ink-2 mb-2"><MemoryStick className="h-3.5 w-3.5" />Memory</span>
            <select value={memory} onChange={(e) => setMemory(Number(e.target.value))} className={select}>{[...new Set([...MEMORY, hw.memoryMb])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{formatBytes(m * 1024 ** 2)}</option>)}</select>
          </label>
        </div>
        <div className="flex items-center justify-between gap-3 mt-4">
          <p className="text-xs text-ink-3">{hw.type === "qemu" ? `${cores * sockets} vCPU${cores * sockets === 1 ? "" : "s"} in total. ` : ""}{later ? "Takes effect the next time the VM starts." : running ? "Containers pick this up right away." : ""}</p>
          <Button size="sm" variant="primary" onClick={save} disabled={!dirty || saving}>{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}Save</Button>
        </div>
        {hw.pending.length > 0 && <p className="text-xs text-warning mt-2">Waiting for a restart: {hw.pending.join(", ")}.</p>}
      </Card>

      <Card className="p-5">
        <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => setOpts(true)}><Pencil className="h-3.5 w-3.5" />Edit</Button>}>Options</SectionTitle>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-ink-3">Name</dt><dd className="font-mono text-compact">{hw.name}</dd>
          <dt className="text-ink-3">Start at boot</dt><dd>{hw.onboot ? "Yes" : "No"}</dd>
          <dt className="text-ink-3">Tags</dt><dd className="flex flex-wrap gap-1">{hw.tags.length ? hw.tags.map((t) => <Chip key={t}>{t}</Chip>) : <span className="text-ink-3">None</span>}</dd>
          <dt className="text-ink-3">Protection</dt><dd>{hw.protection ? "On" : "Off"}</dd>
          <dt className="text-ink-3">Start order</dt><dd>{hw.startup.order !== null ? `${hw.startup.order}${hw.startup.up ? `, then wait ${hw.startup.up}s` : ""}` : <span className="text-ink-3">Any</span>}</dd>
          {hw.boot && <><dt className="text-ink-3">Boot order</dt><dd className="font-mono text-compact">{hw.boot.join(" → ")}</dd></>}
          {hw.agent !== null && <><dt className="text-ink-3">Guest agent</dt><dd>{hw.agent ? "On" : "Off"}</dd></>}
          <dt className="text-ink-3">Type</dt><dd>{hw.type === "lxc" ? `Container · ${hw.ostype ?? "Linux"}` : `VM · ${hw.ostype === "win11" ? "Windows 11" : hw.ostype === "l26" ? "Linux" : hw.ostype ?? "Other"}`}</dd>
          {hw.description && <><dt className="text-ink-3">Notes</dt><dd className="text-ink-2 whitespace-pre-wrap line-clamp-4">{hw.description}</dd></>}
        </dl>
      </Card>

      <Card className="p-5">
        <SectionTitle>Disks</SectionTitle>
        <div className="divide-y divide-line">
          {hw.disks.map((d) => (
            <div key={d.key} className="flex items-center gap-3 py-3">
              <HardDrive className="h-4 w-4 text-ink-3 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm"><span className="font-mono">{d.key}</span>{d.mount && <span className="text-ink-3"> · mounted at {d.mount}</span>}</div>
                <div className="text-xs text-ink-3 truncate font-mono" title={d.volume}>{d.storage ?? ""} · {volName(d.volume)}</div>
              </div>
              <span className="text-sm tabular-nums">{d.sizeGb !== null ? `${d.sizeGb} GB` : "—"}</span>
              <Button size="sm" variant="ghost" onClick={() => setGrow({ key: d.key, size: d.sizeGb })}>Grow</Button>
            </div>
          ))}
          {hw.cdrom !== undefined && hw.type === "qemu" && (
            <div className="flex items-center gap-3 py-3">
              <Disc3 className="h-4 w-4 text-ink-3" />
              <div className="flex-1 min-w-0 text-sm">CD drive <span className="text-ink-3 font-mono text-xs">{hw.cdrom ? volName(hw.cdrom) : "empty"}</span></div>
            </div>
          )}
        </div>
        <p className="text-xs text-ink-3 mt-2">Disks can grow but not shrink. The filesystem inside {hw.type === "lxc" ? "grows with it" : "may need extending from inside the VM"}.</p>
      </Card>

      <Card className="p-5">
        <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => setNic("new")}><Plus className="h-3.5 w-3.5" />Add</Button>}>Network devices</SectionTitle>
        {hw.nics.length === 0 ? <p className="text-sm text-ink-3">No network devices. This machine is offline.</p> : (
          <div className="divide-y divide-line">
            {hw.nics.map((n) => (
              <div key={n.key} className="flex items-center gap-3 py-3">
                <Cable className="h-4 w-4 text-ink-3 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm"><span className="font-mono">{n.name ?? n.key}</span> <span className="text-ink-3">on</span> <span className="font-mono">{n.bridge}</span>{n.tag ? <span className="text-ink-3"> · VLAN {n.tag}</span> : null}</div>
                  <div className="text-xs text-ink-3 font-mono truncate">{[n.model, n.ip, n.gw && `gw ${n.gw}`, n.mac, n.firewall ? "firewall" : "no firewall", n.rate && `${n.rate} MB/s`].filter(Boolean).join(" · ")}</div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setNic(n)}><Pencil className="h-3.5 w-3.5" />Edit</Button>
                <button onClick={() => setRemoveNic(n)} aria-label={`Remove ${n.key}`} className="h-8 w-8 rounded-md inline-flex items-center justify-center text-ink-3 hover:text-critical hover:bg-critical/10"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {grow && <GrowModal vmid={g.vmid} disk={grow.key} size={grow.size} onClose={() => setGrow(null)} onDone={() => setTick((n) => n + 1)} />}
      {nic && <NicModal vmid={g.vmid} type={hw.type} nic={nic === "new" ? null : nic} onClose={() => setNic(null)} onDone={() => setTick((n) => n + 1)} />}
      {opts && <OptionsModal g={g} hw={hw} onClose={() => setOpts(false)} onDone={() => setTick((n) => n + 1)} />}
      {removeNic && (
        <Modal size="sm" title={`Remove ${removeNic.name ?? removeNic.key}?`} subtitle={hw.nics.length === 1 ? "It's this machine's only network device; it will be offline." : `The machine loses its connection on ${removeNic.bridge}.`} onClose={() => setRemoveNic(null)} footer={<><Button variant="ghost" onClick={() => setRemoveNic(null)}>Cancel</Button><Button variant="danger" onClick={async () => { try { await engine.backend.deleteNic(g.vmid, removeNic.key); } catch (e) { setError(e instanceof ApiError ? e.message : "Couldn't remove it"); } setRemoveNic(null); setTick((n) => n + 1); }}><Trash2 className="h-4 w-4" />Remove</Button></>}>
          <div />
        </Modal>
      )}
    </div>
  );
}

function GrowModal({ vmid, disk, size, onClose, onDone }: { vmid: number; disk: string; size: number | null; onClose: () => void; onDone: () => void }) {
  const engine = useEngine();
  const [by, setBy] = useState(8);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    try {
      const r = await engine.backend.resizeDisk(vmid, disk, by);
      engine.watchTask(r.task, `Grow ${disk} by ${by} GB`);
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't grow the disk");
      setBusy(false);
    }
  };
  return (
    <Modal size="sm" icon={<HardDrive className="h-5 w-5" />} title={`Grow ${disk}`} subtitle="Adds space to the disk. Disks can't be made smaller again." onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={go} disabled={busy || by < 1}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Grow by {by} GB</Button></>}>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">{[4, 8, 16, 32, 64].map((n) => <Button key={n} size="sm" variant={by === n ? "primary" : "secondary"} onClick={() => setBy(n)}>+{n} GB</Button>)}</div>
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Or add</span><Input type="number" min={1} max={65536} value={by} onChange={(e) => setBy(Math.max(0, Math.floor(Number(e.target.value) || 0)))} /></label>
        {size !== null && <p className="text-compact text-ink-2">{size} GB → <span className="text-ink">{size + by} GB</span></p>}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function NicModal({ vmid, type, nic, onClose, onDone }: { vmid: number; type: "lxc" | "qemu"; nic: Nic | null; onClose: () => void; onDone: () => void }) {
  const engine = useEngine();
  const [bridges, setBridges] = useState<NetIface[]>([]);
  const [bridge, setBridge] = useState(nic?.bridge ?? "vmbr0");
  const [model, setModel] = useState(nic?.model ?? "virtio");
  const [tag, setTag] = useState(nic?.tag ? String(nic.tag) : "");
  const [firewall, setFirewall] = useState(nic?.firewall ?? true);
  const [mode, setMode] = useState<"dhcp" | "static" | "manual">(nic?.ip && nic.ip !== "dhcp" && nic.ip !== "manual" ? "static" : (nic?.ip as "dhcp" | "manual") ?? "dhcp");
  const [ip, setIp] = useState(nic?.ip && nic.ip.includes("/") ? nic.ip : "");
  const [gw, setGw] = useState(nic?.gw ?? "");
  const [rate, setRate] = useState(nic?.rate ? String(nic.rate) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    engine.backend.network().then((d) => setBridges(d.interfaces.filter((i) => i.type === "bridge" || i.type === "OVSBridge")), () => setBridges([]));
  }, [engine.backend]);
  const vlanAware = bridges.find((b) => b.iface === bridge)?.vlanAware;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await engine.backend.saveNic(vmid, { key: nic?.key ?? null, bridge, model: type === "qemu" ? model : undefined, tag: tag ? Number(tag) : null, firewall, ip: type === "lxc" ? (mode === "static" ? ip.trim() : mode) : undefined, gw: type === "lxc" && mode === "static" ? gw.trim() || null : null, rate: rate ? Number(rate) : null });
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save it");
      setBusy(false);
    }
  };
  return (
    <Modal icon={<Cable className="h-5 w-5" />} title={nic ? `Edit ${nic.name ?? nic.key}` : "Add a network device"} subtitle={nic?.mac ? `Keeps its MAC address ${nic.mac}.` : "Joins the machine to a bridge on this device."} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy || !bridge || (mode === "static" && type === "lxc" && !ip)}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{nic ? "Save" : "Add"}</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <label className="block"><span className="block text-compact text-ink-2 mb-2">Bridge</span><select value={bridge} onChange={(e) => setBridge(e.target.value)} className={select}>{(bridges.length ? bridges.map((b) => b.iface) : [bridge]).map((b) => <option key={b}>{b}</option>)}</select></label>
          <label className="block"><span className="block text-compact text-ink-2 mb-2">VLAN tag <span className="text-ink-3">(optional)</span></span><Input type="number" min={1} max={4094} value={tag} onChange={(e) => setTag(e.target.value)} placeholder={vlanAware === false ? "Bridge isn't VLAN aware" : "None"} /></label>
        </div>
        {type === "qemu" && (
          <label className="block"><span className="block text-compact text-ink-2 mb-2">Model</span><select value={model} onChange={(e) => setModel(e.target.value)} className={select}><option value="virtio">VirtIO (fastest; Linux, or Windows with drivers)</option><option value="e1000e">Intel E1000E (works everywhere)</option><option value="e1000">Intel E1000</option><option value="vmxnet3">VMware vmxnet3</option><option value="rtl8139">Realtek RTL8139</option></select></label>
        )}
        {type === "lxc" && (
          <div className="space-y-3">
            <div className="flex gap-2">{(["dhcp", "static", "manual"] as const).map((m) => <Button key={m} size="sm" variant={mode === m ? "primary" : "secondary"} onClick={() => setMode(m)}>{m === "dhcp" ? "DHCP" : m === "static" ? "Static" : "None"}</Button>)}</div>
            {mode === "static" && (
              <div className="grid grid-cols-2 gap-4">
                <label className="block"><span className="block text-compact text-ink-2 mb-2">Address</span><Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.50/24" className="font-mono" /></label>
                <label className="block"><span className="block text-compact text-ink-2 mb-2">Gateway</span><Input value={gw} onChange={(e) => setGw(e.target.value)} placeholder="192.168.1.1" className="font-mono" /></label>
              </div>
            )}
          </div>
        )}
        <div className="grid grid-cols-2 gap-4 items-end">
          <label className="block"><span className="block text-compact text-ink-2 mb-2">Rate limit <span className="text-ink-3">(MB/s)</span></span><Input type="number" min={0} value={rate} onChange={(e) => setRate(e.target.value)} placeholder="Unlimited" /></label>
          <div className="flex items-center justify-between h-10"><span className="text-sm">Firewall</span><Toggle checked={firewall} onChange={setFirewall} label="Firewall" /></div>
        </div>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

const OS_LABELS: Record<string, string> = { l26: "Linux (2.6 kernel or newer)", l24: "Linux (2.4 kernel)", win11: "Windows 11 / Server 2022 / 2025", win10: "Windows 10 / Server 2016 / 2019", win8: "Windows 8 / Server 2012", win7: "Windows 7 / Server 2008 R2", w2k22: "Windows Server 2022", w2k19: "Windows Server 2019", w2k16: "Windows Server 2016", solaris: "Solaris", other: "Other" };
const secs = (v: number | null) => (v === null ? "" : String(v));
const num = (v: string): number | null => (v.trim() === "" ? null : Math.max(0, Math.floor(Number(v) || 0)));

function OptionsModal({ g, hw, onClose, onDone }: { g: Guest; hw: GuestHardware; onClose: () => void; onDone: () => void }) {
  const engine = useEngine();
  const [name, setName] = useState(hw.name ?? g.name);
  const [onboot, setOnboot] = useState(hw.onboot);
  const [protection, setProtection] = useState(hw.protection);
  const [order, setOrder] = useState(secs(hw.startup.order));
  const [up, setUp] = useState(secs(hw.startup.up));
  const [down, setDown] = useState(secs(hw.startup.down));
  const [boot, setBoot] = useState<string[]>(hw.boot ?? []);
  const [agent, setAgent] = useState(hw.agent ?? false);
  const [ostype, setOstype] = useState(hw.ostype ?? "other");
  const [tags, setTags] = useState(hw.tags.join(" "));
  const [description, setDescription] = useState(hw.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameErr = !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ? "Lowercase letters, digits and hyphens." : null;
  const vm = hw.type === "qemu";
  const unused = hw.bootDevices.filter((d) => !boot.includes(d));
  const move = (i: number, by: number) => setBoot((b) => { const n = [...b]; const [x] = n.splice(i, 1); n.splice(i + by, 0, x); return n; });
  const label = (d: string) => (d.startsWith("net") ? `Network ${d}` : d === hw.disks.find((x) => x.key === d)?.key ? `Disk ${d}` : d === "ide2" ? "CD drive ide2" : d);
  const save = async () => {
    setBusy(true);
    const tagList = tags.split(/[\s,;]+/).filter(Boolean);
    const startupChanged = num(order) !== hw.startup.order || num(up) !== hw.startup.up || num(down) !== hw.startup.down;
    const r = await engine.changeHardware(g.vmid, {
      ...(name !== hw.name ? { name } : {}),
      ...(onboot !== hw.onboot ? { onboot } : {}),
      ...(protection !== hw.protection ? { protection } : {}),
      ...(startupChanged ? { startup: { order: num(order), up: num(up), down: num(down) } } : {}),
      ...(vm && boot.join(";") !== (hw.boot ?? []).join(";") ? { boot } : {}),
      ...(vm && hw.agent !== null && agent !== hw.agent ? { agent } : {}),
      ...(vm && ostype !== hw.ostype ? { ostype } : {}),
      ...(tagList.join(";") !== hw.tags.join(";") ? { tags: tagList } : {}),
      ...(description !== hw.description ? { description } : {}),
    });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onDone();
    onClose();
  };
  const section = (t: string) => <h3 className="text-micro font-semibold uppercase tracking-label text-ink-3 pt-1">{t}</h3>;
  return (
    <Modal size="lg" icon={<Settings2 className="h-5 w-5" />} title="Options" subtitle={`${g.name} #${g.vmid}`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy || !!nameErr}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Save</Button></>}>
      <div className="space-y-4">
        {section("General")}
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block"><span className="block text-compact text-ink-2 mb-2">{hw.type === "lxc" ? "Hostname" : "Name"}</span><Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} className="font-mono" />{nameErr && <span className="block text-xs mt-1.5 text-critical">{nameErr}</span>}</label>
          <label className="block"><span className="block text-compact text-ink-2 mb-2">Tags</span><Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="web prod" /></label>
          {vm && (
            <label className="block sm:col-span-2"><span className="block text-compact text-ink-2 mb-2">Operating system</span><select value={ostype} onChange={(e) => setOstype(e.target.value)} className={select}>{Object.entries(OS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          )}
          <label className="block sm:col-span-2"><span className="block text-compact text-ink-2 mb-2">Notes</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="w-full rounded-lg bg-surface-2 border border-line px-3 py-2 text-sm outline-none focus:border-line-strong" /></label>
        </div>

        {section("Starting and stopping")}
        <div className="flex items-center justify-between gap-4"><div><div className="text-sm">Start when the device boots</div></div><Toggle checked={onboot} onChange={setOnboot} label="Start at boot" /></div>
        <div className="grid grid-cols-3 gap-4">
          <label className="block"><span className="block text-compact text-ink-2 mb-2">Start order</span><Input type="number" min={0} max={9999} value={order} onChange={(e) => setOrder(e.target.value)} placeholder="Any" /></label>
          <label className="block"><span className="block text-compact text-ink-2 mb-2">Wait after start <span className="text-ink-3">(s)</span></span><Input type="number" min={0} max={3600} value={up} onChange={(e) => setUp(e.target.value)} placeholder="Default" /></label>
          <label className="block"><span className="block text-compact text-ink-2 mb-2">Shutdown timeout <span className="text-ink-3">(s)</span></span><Input type="number" min={0} max={3600} value={down} onChange={(e) => setDown(e.target.value)} placeholder="Default" /></label>
        </div>
        <p className="text-xs text-ink-3 -mt-2">Machines start in order, lowest first, waiting the delay before the next. They stop in the reverse order. Only applies to machines that start at boot.</p>

        {vm && (
          <>
            {section("Boot order")}
            <div className="rounded-lg border border-line divide-y divide-line">
              {boot.length === 0 && <p className="px-3 py-2.5 text-compact text-ink-3">Proxmox picks the order.</p>}
              {boot.map((d, i) => (
                <div key={d} className="flex items-center gap-2 px-3 h-10 text-compact"><span className="text-ink-3 tabular-nums w-5">{i + 1}</span><span className="flex-1 font-mono">{label(d)}</span>
                  <button onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${d} up`} className="h-7 w-7 rounded-md hover:bg-surface-2 disabled:opacity-30">↑</button>
                  <button onClick={() => move(i, 1)} disabled={i === boot.length - 1} aria-label={`Move ${d} down`} className="h-7 w-7 rounded-md hover:bg-surface-2 disabled:opacity-30">↓</button>
                  <button onClick={() => setBoot(boot.filter((x) => x !== d))} aria-label={`Don't boot from ${d}`} className="h-7 px-2 rounded-md hover:bg-surface-2 text-ink-3">Remove</button>
                </div>
              ))}
              {unused.map((d) => (
                <div key={d} className="flex items-center gap-2 px-3 h-10 text-compact text-ink-3"><span className="w-5" /><span className="flex-1 font-mono">{label(d)}</span><button onClick={() => setBoot([...boot, d])} aria-label={`Boot from ${d}`} className="h-7 px-2 rounded-md hover:bg-surface-2 text-ink-2">Add</button></div>
              ))}
            </div>
            {hw.agent !== null && (
              <div className="flex items-center justify-between gap-4"><div><div className="text-sm">QEMU guest agent</div><div className="text-xs text-ink-3">Lets Proxmox see the VM's addresses and shut it down cleanly. The agent must be installed inside.</div></div><Toggle checked={agent} onChange={setAgent} label="QEMU guest agent" /></div>
            )}
          </>
        )}

        {section("Safety")}
        <div className="flex items-center justify-between gap-4"><div><div className="text-sm">Protection</div><div className="text-xs text-ink-3">Stops this machine and its disks from being deleted by accident. Turn it off to delete.</div></div><Toggle checked={protection} onChange={setProtection} label="Protection" /></div>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}
