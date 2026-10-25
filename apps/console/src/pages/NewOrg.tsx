import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Database, FileText } from "lucide-react";
import { EngineError } from "@papercliped-engine/engine-client";
import { orgNameError, useEngine } from "../data/store.tsx";
import { orgSlug } from "../data/engine/map.ts";
import { errorText, useCanCreateOrgs, useCreateOrg, useEngineStatus, type CreateOrgResult } from "../data/engine/queries.ts";
import { EngineUnavailable, Loading, textareaClass } from "./org/live/common.tsx";
import { slugify } from "../lib/storage.ts";
import { suggestSize } from "../pin/brain.ts";
import { Button, Card, Input, SectionTitle } from "../ui/primitives.tsx";
import { SizeChoice } from "./start/SizeChoice.tsx";
import { Modal } from "../ui/Modal.tsx";

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
  const canCreate = useCanCreateOrgs();
  const [description, setDescription] = useState("");
  const [created, setCreated] = useState<CreateOrgResult | null>(null);
  // Live, the engine picks the address (from the task prefix it assigns), so only the name itself is checked here.
  const error = live ? (!name.trim() ? "Give it a name." : engine.data.orgs.some((o) => o.name.toLowerCase() === name.trim().toLowerCase()) ? "An organization with that name already exists." : null) : orgNameError(name, engine.data.orgs);
  const s = pinDecides ? suggested : size;

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
          <div className="text-sm text-ink-2 space-y-2">
            <p>{name.trim()} exists, but its resource group couldn't be set up, so its agents have nowhere on this device to run containers yet.</p>
            <p className="text-ink-3">The host service said: {created.resourceGroupError}</p>
            <p>You can create the resource group from the organization's dashboard.</p>
          </div>
        </div>
      </Modal>
    );
  }
  if (live && gate.state === "ready" && canCreate === false) {
    return (
      <Modal size="md" title="Create an organization" onClose={onClose} footer={<Button variant="ghost" onClick={onClose}>Close</Button>}>
        <div className="text-sm text-ink-2 space-y-2">
          <p>Organizations on this device are created by a Proxmox administrator, who can then invite you.</p>
          <p className="text-ink-3">Ask someone with administrator rights on {device} to create one and add you. It shows up here as soon as they do.</p>
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
          <label className="text-compact text-ink-2 block mb-2" htmlFor="org-name">Name</label>
          <Input id="org-name" value={name} onKeyDown={(e) => e.key === "Enter" && create()} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched(true)} placeholder="e.g. Northwind Labs" autoFocus />
          <div className="text-xs mt-2 h-4">
            {touched && error ? <span className="text-critical">{error}</span> : name && !live && <span className="text-ink-3">Lives at /{device}/<span className="text-ink-2">{slugify(name)}</span></span>}
          </div>
          {live && (
            <>
              <label className="text-compact text-ink-2 block mb-2 mt-2" htmlFor="org-description">Description <span className="text-ink-3">(optional)</span></label>
              <textarea id="org-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className={textareaClass} placeholder="What this organization does" />
            </>
          )}
        </Card>

        <SizeChoice device={device} host={engine.host} suggested={suggested} pinDecides={pinDecides} onPinDecides={setPinDecides} size={size} onSize={setSize} />

        {!live && <Card className="p-5">
          <SectionTitle>Agent memory</SectionTitle>
          <div className="grid sm:grid-cols-2 gap-3">
            {([
              ["postgres", <Database key="d" className="h-4 w-4" />, "Postgres", "Agents remember in the org's database. Recommended."],
              ["postgres+files", <FileText key="f" className="h-4 w-4" />, "Postgres + memory files", "Also keeps readable memory files per agent, like Pin's MEMORY.md."],
            ] as const).map(([v, icon, title, body]) => (
              <button key={v} onClick={() => setMemory(v)} className={`text-left rounded-xl border p-3.5 transition ${memory === v ? "border-accent/50 bg-accent-soft" : "border-line hover:border-line-strong"}`} aria-pressed={memory === v}>
                <div className="flex items-center gap-2 font-medium text-sm">{icon}{title}</div>
                <p className="text-xs text-ink-3 mt-1">{body}</p>
              </button>
            ))}
          </div>
        </Card>}
        {liveError && <p className="text-compact text-critical" role="alert">{liveError}</p>}
      </div>
    </Modal>
  );
}
