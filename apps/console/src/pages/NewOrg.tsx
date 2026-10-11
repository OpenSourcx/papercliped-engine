import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Database, FileText, Sparkles } from "lucide-react";
import { orgNameError, useEngine } from "../data/store.tsx";
import { formatBytes, slugify } from "../lib/storage.ts";
import { suggestSize } from "../pin/brain.ts";
import { Button, Card, Input, PageHeader, SectionTitle, Toggle } from "../ui/primitives.tsx";

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string }) {
  return (
    <label className="block">
      <div className="flex justify-between text-[13px] mb-2"><span className="text-ink-2">{label}</span><span className="tabular-nums">{format(value)}</span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
    </label>
  );
}

export function NewOrg() {
  const engine = useEngine();
  const navigate = useNavigate();
  const device = engine.setup?.deviceName ?? "pve";
  const suggested = useMemo(() => suggestSize(engine.host, engine.data), [engine.host, engine.data]);
  const [name, setName] = useState("");
  const [pinDecides, setPinDecides] = useState(true);
  const [size, setSize] = useState(suggested);
  const [memory, setMemory] = useState<"postgres" | "postgres+files">("postgres");
  const [touched, setTouched] = useState(false);
  const error = orgNameError(name, engine.data.orgs);
  const s = pinDecides ? suggested : size;
  const totalMemMb = Math.floor(engine.host.memTotal / 1024 ** 2);

  const create = () => {
    setTouched(true);
    if (error) return;
    const r = engine.createOrg(name, s, "user", memory);
    if (r.ok) navigate(`/${device}/${r.org.slug}`);
  };

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-20 sm:pt-24 pb-20">
      <PageHeader title="New organization" subtitle="An organization gets its own agents, tasks and a resource group on this device that its agents can't leave." />
      <div className="space-y-4">
        <Card className="p-5">
          <label className="text-[13px] text-ink-2 block mb-2" htmlFor="org-name">Name</label>
          <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched(true)} placeholder="e.g. Northwind Labs" autoFocus />
          <div className="text-[12px] mt-2 h-4">
            {touched && error ? <span className="text-critical">{error}</span> : name && <span className="text-ink-3">Lives at /{device}/<span className="text-ink-2">{slugify(name)}</span></span>}
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="font-medium flex items-center gap-2"><Sparkles className="h-4 w-4 text-accent" />Let Pin decide the resources</div>
              <p className="text-[13px] text-ink-3 mt-0.5">Pin sizes it from what's free on {device} and adjusts it as the org grows.</p>
            </div>
            <Toggle checked={pinDecides} onChange={(v) => { setPinDecides(v); if (!v) setSize(suggested); }} label="Let Pin decide the resources" />
          </div>
          <div className="mt-5 grid sm:grid-cols-2 gap-5">
            {pinDecides ? (
              <>
                {[["CPU", `${s.cores} cores`], ["Memory", formatBytes(s.memoryMb * 1024 ** 2)], ["Disk", `${s.diskGb} GB`], ["Containers", `Up to ${s.maxGuests}`]].map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-surface-2 border border-line px-3.5 py-2.5"><div className="text-[12px] text-ink-3">{k}</div><div className="text-[15px] font-medium tabular-nums">{v}</div></div>
                ))}
              </>
            ) : (
              <>
                <Slider label="CPU" value={size.cores} min={1} max={engine.host.cpus} step={1} onChange={(v) => setSize({ ...size, cores: v })} format={(v) => `${v} cores`} />
                <Slider label="Memory" value={size.memoryMb} min={512} max={totalMemMb} step={512} onChange={(v) => setSize({ ...size, memoryMb: v })} format={(v) => formatBytes(v * 1024 ** 2)} />
                <Slider label="Disk" value={size.diskGb} min={8} max={500} step={8} onChange={(v) => setSize({ ...size, diskGb: v })} format={(v) => `${v} GB`} />
                <Slider label="Containers" value={size.maxGuests} min={1} max={20} step={1} onChange={(v) => setSize({ ...size, maxGuests: v })} format={(v) => `Up to ${v}`} />
              </>
            )}
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle>Agent memory</SectionTitle>
          <div className="grid sm:grid-cols-2 gap-3">
            {([
              ["postgres", <Database key="d" className="h-4 w-4" />, "Postgres", "Agents remember in the org's database. Recommended."],
              ["postgres+files", <FileText key="f" className="h-4 w-4" />, "Postgres + memory files", "Also keeps readable memory files per agent, like Pin's MEMORY.md."],
            ] as const).map(([v, icon, title, body]) => (
              <button key={v} onClick={() => setMemory(v)} className={`text-left rounded-xl border p-3.5 transition ${memory === v ? "border-accent/50 bg-accent-soft" : "border-line hover:border-line-strong"}`} aria-pressed={memory === v}>
                <div className="flex items-center gap-2 font-medium text-[14px]">{icon}{title}</div>
                <p className="text-[12px] text-ink-3 mt-1">{body}</p>
              </button>
            ))}
          </div>
        </Card>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => navigate(-1)}>Cancel</Button>
          <Button variant="primary" onClick={create} disabled={!name.trim()}>Create organization</Button>
        </div>
      </div>
    </div>
  );
}
