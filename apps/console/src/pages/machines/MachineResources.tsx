import { useState } from "react";
import { Cpu, Save } from "lucide-react";
import { useGuestApi } from "../../data/engine/guestApi.ts";
import { Button, Card, Field, Input, Notice, SectionTitle, Select } from "../../ui/primitives.tsx";
import { busyNotice, mib, useSave, type DevCtx } from "./MachineKit.tsx";

/** What a machine may use: cores, memory (any amount, in MiB or GiB), swap, CPU limit and weight. Replaces the fixed memory list. */

interface Amount {
  mib: number | null;
  error: string | null;
}

/** A size in MiB or GiB. Any whole number of MiB is allowed, which is what Proxmox accepts. */
export function AmountField({ id, label, value, onChange, min, max, optional, placeholder, hint }: { id: string; label: string; value: number | null; onChange: (a: Amount) => void; min: number; max: number; optional?: boolean; placeholder?: string; hint?: string }) {
  const [unit, setUnit] = useState<"MiB" | "GiB">(value !== null && value >= 1024 && value % 1024 === 0 ? "GiB" : "MiB");
  const [text, setText] = useState(value === null ? "" : String(unit === "GiB" ? value / 1024 : value));
  const [error, setError] = useState<string | null>(null);
  const emit = (t: string, u: "MiB" | "GiB") => {
    if (t.trim() === "") {
      const e = optional ? null : "Enter an amount";
      setError(e);
      return onChange({ mib: null, error: e });
    }
    const n = Number(t);
    const m = Math.round(n * (u === "GiB" ? 1024 : 1) * 1e6) / 1e6;
    const e = !Number.isFinite(n) || n < 0 ? "Enter a number" : !Number.isInteger(m) ? "That isn't a whole number of MiB. Use MiB for exact amounts." : m < min || m > max ? `Use between ${mib(min)} and ${mib(max)}` : null;
    setError(e);
    onChange({ mib: e ? null : m, error: e });
  };
  return (
    <Field label={label} htmlFor={id} error={error} hint={error ? undefined : hint}>
      <div className="flex gap-2">
        <Input id={id} type="number" inputMode="decimal" min={0} step="any" value={text} placeholder={placeholder} onChange={(e) => { setText(e.target.value); emit(e.target.value, unit); }} aria-invalid={!!error} />
        <Select aria-label={`${label} unit`} className="w-24 shrink-0" value={unit} onChange={(e) => { const u = e.target.value as "MiB" | "GiB"; const n = Number(text); if (text.trim() !== "" && Number.isFinite(n)) { const next = String(Math.round((u === "GiB" ? n / 1024 : n * 1024) * 1e6) / 1e6); setText(next); setUnit(u); return emit(next, u); } setUnit(u); }}>
          <option>MiB</option>
          <option>GiB</option>
        </Select>
      </div>
    </Field>
  );
}

export function ResourcesCard({ ctx }: { ctx: DevCtx }) {
  const { d } = ctx;
  const r = d.resources;
  const vm = d.type === "qemu";
  const api = useGuestApi();
  const save = useSave(ctx);
  const [cores, setCores] = useState(String(r.cores));
  const [sockets, setSockets] = useState(String(r.sockets ?? 1));
  const [memory, setMemory] = useState<Amount>({ mib: r.memory, error: null });
  const [swap, setSwap] = useState<Amount>({ mib: r.swap, error: null });
  const [balloon, setBalloon] = useState<Amount>({ mib: r.balloon, error: null });
  const [limit, setLimit] = useState(r.cpulimit ? String(r.cpulimit) : "");
  const [units, setUnits] = useState(r.cpuunits !== null ? String(r.cpuunits) : "");
  const busy = busyNotice(d);

  const int = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v) : NaN);
  const diff = () => {
    const body: Record<string, unknown> = {};
    const bad: Record<string, string> = {};
    const c = int(cores);
    if (!(c >= 1 && c <= (vm ? 512 : 8192))) bad.cores = `Cores go from 1 to ${vm ? 512 : 8192}`;
    else if (c !== r.cores) body.cores = c;
    if (vm) {
      const s = int(sockets);
      if (!(s >= 1 && s <= 16)) bad.sockets = "Sockets go from 1 to 16";
      else if (s !== (r.sockets ?? 1)) body.sockets = s;
    }
    if (memory.error || memory.mib === null) bad.memory = memory.error ?? "Enter an amount";
    else if (memory.mib !== r.memory) body.memory = memory.mib;
    if (!vm) {
      if (swap.error || swap.mib === null) bad.swap = swap.error ?? "Enter an amount";
      else if (swap.mib !== r.swap) body.swap = swap.mib;
    } else if (balloon.error) bad.balloon = balloon.error;
    else if (balloon.mib !== r.balloon) {
      if (balloon.mib !== null && memory.mib !== null && balloon.mib > memory.mib) bad.balloon = "The minimum can't be more than the memory";
      else body.balloon = balloon.mib;
    }
    const l = limit.trim() === "" ? null : Number(limit);
    if (l !== null && !(l > 0 && l <= (vm ? 128 : 8192))) bad.limit = `The CPU limit goes up to ${vm ? 128 : 8192} cores. Empty means no limit.`;
    else if (l !== (r.cpulimit || null)) body.cpulimit = l;
    const u = units.trim() === "" ? null : int(units);
    if (u !== null && !(u >= (vm ? 1 : 0) && u <= (vm ? 262144 : 500000))) bad.units = `CPU weight goes from ${vm ? 1 : 0} to ${vm ? 262144 : 500000}`;
    else if (u !== r.cpuunits) body.cpuunits = u;
    return { body, bad };
  };
  const { body, bad: errors } = diff();
  const dirty = Object.keys(body).length > 0;
  const submit = () => (dirty && !Object.keys(errors).length ? save.run(() => api.saveResources(ctx.vmid, { digest: d.digest, ...body })) : undefined);
  const total = vm ? Number(cores) * Number(sockets) : null;
  return (
    <Card className="p-5">
      <SectionTitle>Processor and memory</SectionTitle>
      {busy && <Notice tone="warning" className="mb-3">{busy}</Notice>}
      <div className="grid grid-cols-2 gap-4">
        <Field label={<span className="inline-flex items-center gap-2"><Cpu className="h-3.5 w-3.5" />Cores</span>} htmlFor="res-cores" error={errors.cores}><Input id="res-cores" type="number" min={1} max={vm ? 512 : 8192} value={cores} onChange={(e) => setCores(e.target.value)} /></Field>
        {vm ? (
          <Field label="Sockets" htmlFor="res-sockets" error={errors.sockets}><Input id="res-sockets" type="number" min={1} max={16} value={sockets} onChange={(e) => setSockets(e.target.value)} /></Field>
        ) : (
          <AmountField id="res-swap" label="Swap" value={r.swap} onChange={setSwap} min={0} max={1_048_576} />
        )}
        <div className="col-span-2">
          <AmountField id="res-memory" label="Memory" value={r.memory} onChange={setMemory} min={16} max={4_194_304} />
          {errors.memory && !memory.error && <p role="alert" className="text-xs text-critical mt-1.5">{errors.memory}</p>}
        </div>
        {vm && (
          <div className="col-span-2">
            <AmountField id="res-balloon" label="Minimum memory (ballooning)" value={r.balloon} onChange={setBalloon} min={0} max={4_194_304} optional placeholder="Same as memory" hint="When the host runs short, Proxmox can shrink this VM down to this amount. 0 turns ballooning off." />
            {errors.balloon && !balloon.error && <p role="alert" className="text-xs text-critical mt-1.5">{errors.balloon}</p>}
          </div>
        )}
        <Field label={<>CPU limit <span className="text-ink-3 font-normal">(cores)</span></>} htmlFor="res-limit" error={errors.limit} hint="How much processor time it may use in all. Empty means no limit."><Input id="res-limit" type="number" min={0} step="any" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="Unlimited" /></Field>
        <Field label="CPU weight" htmlFor="res-units" error={errors.units} hint="Higher gets more when the host is busy."><Input id="res-units" type="number" min={vm ? 1 : 0} value={units} onChange={(e) => setUnits(e.target.value)} placeholder="Default" /></Field>
      </div>
      <div className="flex items-center justify-between gap-3 mt-4">
        <p className="text-xs text-ink-3">{vm ? `${total && Number.isFinite(total) ? total : r.cores * (r.sockets ?? 1)} vCPU${total === 1 ? "" : "s"} in total. ` : ""}{vm && d.status === "running" ? "Most changes take effect the next time the VM starts." : d.status === "running" ? "Containers pick this up right away." : ""}</p>
        <Button size="sm" variant="primary" onClick={submit} disabled={!dirty || Object.keys(errors).length > 0 || !!d.locked} loading={save.busy}><Save className="h-3.5 w-3.5" />Save</Button>
      </div>
      {d.pendingKeys.length > 0 && <p className="text-xs text-warning mt-2">Waiting for a restart: {d.pendingKeys.join(", ")}.</p>}
      {save.error && <p role="alert" className="text-compact text-critical mt-2">{save.error}</p>}
    </Card>
  );
}
