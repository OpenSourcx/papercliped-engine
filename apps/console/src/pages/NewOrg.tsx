import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Database, FileText, Sparkles } from "lucide-react";
import { EngineError } from "@papercliped-engine/engine-client";
import { orgNameError, useEngine } from "../data/store.tsx";
import { orgSlug } from "../data/engine/map.ts";
import { errorText, useCreateOrg, useEngineStatus, type CreateOrgResult } from "../data/engine/queries.ts";
import { EngineUnavailable, Loading, textareaClass } from "./org/live/common.tsx";
import { formatBytes, slugify } from "../lib/storage.ts";
import { suggestSize } from "../pin/brain.ts";
import { Button, Card, Input, SectionTitle, Toggle } from "../ui/primitives.tsx";
import { Modal } from "../ui/Modal.tsx";

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string }) {
  return (
    <label className="block">
      <div className="flex justify-between text-[13px] mb-2"><span className="text-ink-2">{label}</span><span className="tabular-nums">{format(value)}</span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
    </label>
  );
}

export function NewOrgModal({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const navigate = useNavigate();
  const device = engine.setup?.deviceName ?? "pve";
  const suggested = useMemo(() => suggestSize(engine.host, engine.data), [engine.host, engine.data]);
  const [name, setName] = useState("");
  const [pinDecides, setPinDecides] = useState(true);
  const [size, setSize] = useState(suggested);
  const [memory, setMemory] = useState<"postgres" | "postgres+files">("postgres");
  const [touched, setTouched] = useState(false);
  const live = engine.live;
  const gate = useEngineStatus();
  const createLive = useCreateOrg();
  const [description, setDescription] = useState("");
  const [created, setCreated] = useState<CreateOrgResult | null>(null);
  // Live, the engine picks the address (from the task prefix it assigns), so only the name itself is checked here.
  const error = live ? (!name.trim() ? "Give it a name." : engine.data.orgs.some((o) => o.name.toLowerCase() === name.trim().toLowerCase()) ? "An organization with that name already exists." : null) : orgNameError(name, engine.data.orgs);
  const s = pinDecides ? suggested : size;
  const totalMemMb = Math.floor(engine.host.memTotal / 1024 ** 2);

  const create = () => {
    setTouched(true);
    if (error) return;
    if (live) {
      if (gate.state !== "ready" || createLive.isPending) return;
      createLive.mutate({ name, description, size: s }, {
        onSuccess: (r) => {
          if (r.resourceGroupError) return setCreated(r);
          onClose();
          navigate(`/${device}/${orgSlug(r.slugSource)}`);
        },
      });
      return;
    }
    const r = engine.createOrg(name, s, "user", memory);
    if (r.ok) {
      onClose();
      navigate(`/${device}/${r.org.slug}`);
    }
  };

  if (live && created) {
    const to = `/${device}/${orgSlug(created.slugSource)}`;
    return (
      <Modal size="md" title="Organization created" onClose={onClose} footer={<Button variant="primary" onClick={() => { onClose(); navigate(to); }}>Open {name.trim()}</Button>}>
        <div className="flex gap-3">
          <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
          <div className="text-[14px] text-ink-2 space-y-2">
            <p>{name.trim()} exists, but its resource group couldn't be set up, so its agents have nowhere on this device to run containers yet.</p>
            <p className="text-ink-3">The host service said: {created.resourceGroupError}</p>
            <p>You can create the resource group from the organization's dashboard.</p>
          </div>
        </div>
      </Modal>
    );
  }
  if (live && gate.state !== "ready") {
    return (
      <Modal size="md" title="Create an organization" onClose={onClose} footer={<Button variant="ghost" onClick={onClose}>Close</Button>}>
        {gate.state === "checking" || gate.state === "demo" ? <Loading label="Checking the engine" /> : <EngineUnavailable gate={gate} compact />}
      </Modal>
    );
  }
  const liveError = createLive.error instanceof EngineError && createLive.error.status === 403
    ? `${createLive.error.message}. Your account can't create organizations on this engine; someone with admin rights on this device can create one and add you.`
    : createLive.error ? errorText(createLive.error) : null;

  return (
    <Modal
      size="lg"
      title="Create an organization"
      subtitle="It gets its own agents, tasks and a resource group on this device that its agents can't leave."
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={create} disabled={!name.trim() || createLive.isPending}>{createLive.isPending ? "Creating…" : "Create organization"}</Button></>}
    >
      <div className="space-y-4">
        <Card className="p-5">
          <label className="text-[13px] text-ink-2 block mb-2" htmlFor="org-name">Name</label>
          <Input id="org-name" value={name} onKeyDown={(e) => e.key === "Enter" && create()} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched(true)} placeholder="e.g. Northwind Labs" autoFocus />
          <div className="text-[12px] mt-2 h-4">
            {touched && error ? <span className="text-critical">{error}</span> : name && !live && <span className="text-ink-3">Lives at /{device}/<span className="text-ink-2">{slugify(name)}</span></span>}
          </div>
          {live && (
            <>
              <label className="text-[13px] text-ink-2 block mb-2 mt-2" htmlFor="org-description">Description <span className="text-ink-3">(optional)</span></label>
              <textarea id="org-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className={textareaClass} placeholder="What this organization does" />
            </>
          )}
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
                {[["CPU", `${s.cores} core${s.cores === 1 ? "" : "s"}`], ["Memory", formatBytes(s.memoryMb * 1024 ** 2)], ["Disk", `${s.diskGb} GB`], ["Containers", `Up to ${s.maxGuests}`]].map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-surface-2 border border-line px-3.5 py-2.5"><div className="text-[12px] text-ink-3">{k}</div><div className="text-[15px] font-medium tabular-nums">{v}</div></div>
                ))}
              </>
            ) : (
              <>
                <Slider label="CPU" value={size.cores} min={1} max={engine.host.cpus} step={1} onChange={(v) => setSize({ ...size, cores: v })} format={(v) => `${v} core${v === 1 ? "" : "s"}`} />
                <Slider label="Memory" value={size.memoryMb} min={512} max={totalMemMb} step={512} onChange={(v) => setSize({ ...size, memoryMb: v })} format={(v) => formatBytes(v * 1024 ** 2)} />
                <Slider label="Disk" value={size.diskGb} min={8} max={500} step={8} onChange={(v) => setSize({ ...size, diskGb: v })} format={(v) => `${v} GB`} />
                <Slider label="Containers" value={size.maxGuests} min={1} max={20} step={1} onChange={(v) => setSize({ ...size, maxGuests: v })} format={(v) => `Up to ${v}`} />
              </>
            )}
          </div>
        </Card>

        {!live && <Card className="p-5">
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
        </Card>}
        {liveError && <p className="text-[13px] text-critical" role="alert">{liveError}</p>}
      </div>
    </Modal>
  );
}
