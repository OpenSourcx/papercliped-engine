import { Link } from "react-router-dom";
import { formatBytes } from "../../../lib/storage.ts";
import { Field, Notice, selectClass } from "../../../ui/primitives.tsx";
import { Grid, Num, Pick } from "./fields.tsx";
import type { CtForm } from "./state.ts";
import type { StepProps } from "./types.ts";

type P = StepProps<CtForm>;

export function TemplateStep({ f, set, o, err, device, onClose }: P & { device: string; onClose: () => void }) {
  return (
    <div className="space-y-4">
      {o.templates.length === 0 ? (
        <Notice tone="warning" title="No container templates yet">There are none on {device}. <Link onClick={onClose} to={`/${device}/storage`} className="text-accent hover:underline">Get one from the template catalog</Link> in Storage, then come back.</Notice>
      ) : (
        <Field label="Template" htmlFor="wz-tpl" error={err("template")} hint="The system the container starts with.">
          <select id="wz-tpl" value={f.template} onChange={(e) => set({ template: e.target.value })} className={selectClass}>
            {o.templates.map((t) => <option key={t.volid} value={t.volid}>{t.name}{t.size ? ` · ${formatBytes(t.size)}` : ""}</option>)}
          </select>
        </Field>
      )}
    </div>
  );
}

export function CtDiskStep({ f, set, o, err }: P) {
  return (
    <div className="space-y-4">
      <Grid>
        <Field label="Storage" htmlFor="wz-ctstore" error={err("disk.storage")}>
          <Pick id="wz-ctstore" value={f.storage} onChange={(storage) => set({ storage })} options={o.ctStorages.map((s) => ({ value: s.storage, label: `${s.storage}${s.avail !== null ? ` · ${formatBytes(s.avail)} free` : ""}` }))} />
        </Field>
        <Field label="Disk size" htmlFor="wz-ctsize" error={err("disk.sizeGb")} hint="The root disk. You can grow it later."><Num id="wz-ctsize" value={f.sizeGb} onChange={(sizeGb) => set({ sizeGb })} suffix="GiB" /></Field>
      </Grid>
      {o.ctStorages.length === 0 && <Notice tone="warning" title="No storage for container disks">This device has no storage that can hold container disks that you may use. Add one in Storage settings.</Notice>}
    </div>
  );
}

export function CtCpuStep({ f, set, err }: P) {
  return (
    <Grid cols={3}>
      <Field label="Cores" htmlFor="wz-ctcores" error={err("cpu.cores")}><Num id="wz-ctcores" value={f.cores} onChange={(cores) => set({ cores })} /></Field>
      <Field label="CPU limit" htmlFor="wz-ctlimit" error={err("cpu.limit")} hint="Optional. Cores' worth of time, like 1.5. Empty is unlimited."><Num id="wz-ctlimit" value={f.cpuLimit} onChange={(cpuLimit) => set({ cpuLimit })} placeholder="Unlimited" /></Field>
      <Field label="CPU weight" htmlFor="wz-ctunits" error={err("cpu.units")} hint="Optional. The usual weight is 100."><Num id="wz-ctunits" value={f.cpuUnits} onChange={(cpuUnits) => set({ cpuUnits })} placeholder="Default" /></Field>
    </Grid>
  );
}

const MEM_PRESETS = [512, 1024, 2048, 4096, 8192];

export function CtMemoryStep({ f, set, err }: P) {
  const mb = Number(f.memoryMb);
  return (
    <div className="space-y-5">
      <Grid>
        <Field label="Memory" htmlFor="wz-ctmem" error={err("memory.mb")} hint={mb >= 16 ? `${formatBytes(mb * 1024 ** 2)}.` : "In MiB."}>
          <Num id="wz-ctmem" value={f.memoryMb} onChange={(memoryMb) => set({ memoryMb })} suffix="MiB" />
        </Field>
        <Field label="Swap" htmlFor="wz-ctswap" error={err("memory.swapMb")} hint="Extra room on disk when memory runs out. 0 turns it off."><Num id="wz-ctswap" value={f.swapMb} onChange={(swapMb) => set({ swapMb })} suffix="MiB" /></Field>
      </Grid>
      <div className="flex flex-wrap gap-1.5">
        {MEM_PRESETS.map((p) => (
          <button key={p} type="button" onClick={() => set({ memoryMb: String(p) })} aria-pressed={mb === p} className={`transition-control rounded-full border px-2.5 h-7 text-xs tabular-nums ${mb === p ? "border-accent/60 bg-accent-soft text-ink" : "border-line text-ink-2 hover:border-line-strong"}`}>{p >= 1024 ? `${p / 1024} GiB` : `${p} MiB`}</button>
        ))}
      </div>
    </div>
  );
}
