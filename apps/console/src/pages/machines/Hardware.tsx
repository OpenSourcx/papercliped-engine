import { useEffect, useState } from "react";
import { HardDrive, Loader2, Pencil, Settings2 } from "lucide-react";
import { ApiError, type GuestHardware } from "../../data/api.ts";
import { useGuestApi } from "../../data/engine/guestApi.ts";
import { useEngine } from "../../data/store.tsx";
import type { Guest } from "../../data/types.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, Input, SectionTitle, Toggle, selectClass } from "../../ui/primitives.tsx";
import { useLoad } from "../disks/common.tsx";
import { DisksCard } from "./HardwareDisks.tsx";
import { VmItemsCard, PassthroughCard } from "./MachineItems.tsx";
import { DnsCard, FeaturesCard, NetworkCard } from "./MachineNetwork.tsx";
import { ResourcesCard } from "./MachineResources.tsx";
import type { DevCtx } from "./MachineKit.tsx";

const select = selectClass;

/** A machine's hardware, editable like Proxmox's Hardware and Options panels, with plain words and safe defaults. */
export function Hardware({ g }: { g: Guest }) {
  const engine = useEngine();
  const guestApi = useGuestApi();
  const [hw, setHw] = useState<GuestHardware | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [grow, setGrow] = useState<{ key: string; size: number | null } | null>(null);
  const [opts, setOpts] = useState(false);
  const dev = useLoad(() => guestApi.devices(g.vmid), [guestApi, g.vmid, tick, engine.contentVersion]);

  useEffect(() => {
    let alive = true;
    engine.backend.hardware(g.vmid).then(
      (h) => {
        if (!alive) return;
        setHw(h);
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

  const running = hw.status === "running";
  const d = dev.data;
  const ctx: DevCtx | null = d ? { vmid: g.vmid, d, reload: () => setTick((n) => n + 1) } : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 fade-in">
      {ctx ? <ResourcesCard key={`res-${d!.digest}`} ctx={ctx} /> : <Card className="p-5"><SectionTitle>Processor and memory</SectionTitle>{dev.error ? <p role="alert" className="text-compact text-critical">{dev.error}</p> : <p className="text-sm text-ink-3">Reading…</p>}</Card>}

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

      <DisksCard g={g} kind={hw.type} running={running} onGrow={(key, size) => setGrow({ key, size })} version={tick} onChanged={() => setTick((n) => n + 1)} />

      {ctx && d?.vm && <VmItemsCard ctx={ctx} />}
      {ctx && <NetworkCard ctx={ctx} />}
      {ctx && d?.dns && <DnsCard ctx={ctx} />}
      {ctx && d?.features && <FeaturesCard key={`feat-${d.digest}`} ctx={ctx} />}
      {ctx && <PassthroughCard ctx={ctx} />}

      {grow && <GrowModal vmid={g.vmid} disk={grow.key} size={grow.size} onClose={() => setGrow(null)} onDone={() => setTick((n) => n + 1)} />}
      {opts && <OptionsModal g={g} hw={hw} onClose={() => setOpts(false)} onDone={() => setTick((n) => n + 1)} />}
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
