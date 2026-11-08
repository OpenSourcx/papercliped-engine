import { useMemo, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { useAgents, useOrgs } from "../../data/engine/queries.ts";
import { fabricApi, fabricErrorText, type Requirements, useFabric, useFabricAction } from "../../data/engine/fabric.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Field, Input, Notice, Select } from "../../ui/primitives.tsx";
import { modelNames } from "./util.ts";

const TOOLS = ["git", "node", "pnpm", "python", "docker", "make"] as const;

/**
 * Where an organization's agents run: create an environment that points at the remote-worker provider, optionally pin
 * one worker and say what the worker must have. It never touches which AI model an agent uses.
 */
export function UseWorkerModal({ onClose }: { onClose: () => void }) {
  const f = useFabric().data;
  const orgs = useOrgs();
  const adopted = (f?.workers ?? []).filter((w) => w.state === "adopted");
  const [companyId, setCompanyId] = useState("");
  const [workerId, setWorkerId] = useState("");
  const [name, setName] = useState("");
  const [gpu, setGpu] = useState(false);
  const [arch, setArch] = useState("");
  const [model, setModel] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [minMem, setMinMem] = useState("");
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const company = companyId || orgs.data?.[0]?.id || "";
  const agents = useAgents(company || null);
  const models = useMemo(() => [...new Set(adopted.flatMap((w) => (w.capabilities ? modelNames(w.capabilities) : [])))].sort(), [adopted]);
  const arches = useMemo(() => [...new Set(adopted.map((w) => w.capabilities.arch))].sort(), [adopted]);
  const create = useFabricAction(fabricApi.createEnvironment);

  const requirements: Requirements = {
    ...(gpu ? { gpu: true } : {}),
    ...(arch ? { arch } : {}),
    ...(model ? { localModel: model } : {}),
    ...(tools.length ? { tools } : {}),
    ...(minMem && Number(minMem) > 0 ? { minFreeMemMb: Math.round(Number(minMem)) } : {}),
  };
  const submit = () => create.mutate({ companyId: company, name: name.trim() || undefined, workerId: workerId || undefined, requirements, assignAgents: agentIds.length ? agentIds : undefined });
  const done = create.data?.environment;

  if (done) {
    return (
      <Modal size="sm" title="Environment ready" icon={<CheckCircle2 className="h-5 w-5 text-good" aria-hidden />} onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <p className="text-compact text-ink-2"><span className="font-medium text-ink">{done.name}</span> runs {done.agents.length === 0 ? "no agents yet" : `${done.agents.length} ${done.agents.length === 1 ? "agent" : "agents"}`} on {done.workerId ? adopted.find((w) => w.id === done.workerId)?.name ?? "the chosen worker" : "any worker that matches"}. Each agent run gets its own private workspace.</p>
      </Modal>
    );
  }
  return (
    <Modal
      size="md"
      title="Run agents on a worker"
      subtitle="Creates an execution environment. It decides where commands run, not which AI model an agent uses; set that on the agent."
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={create.isPending} disabled={!company} onClick={submit}>Create environment</Button></>}
    >
      <div className="grid gap-4">
        {adopted.length === 0 && <Notice tone="warning" title="No adopted workers yet">You can still create the environment; agents wait until a matching worker is online.</Notice>}
        <Field label="Organization" htmlFor="use-org">
          <Select id="use-org" value={company} onChange={(e) => { setCompanyId(e.target.value); setAgentIds([]); }}>
            {(orgs.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </Select>
        </Field>
        <Field label="Environment name (optional)" htmlFor="use-name"><Input id="use-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="For example, GPU workers" /></Field>
        <Field label="Worker" htmlFor="use-worker" hint="Any matching worker lets the scheduler choose the least busy one. Pin one to always use it.">
          <Select id="use-worker" value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
            <option value="">Any matching worker</option>
            {adopted.map((w) => <option key={w.id} value={w.id}>{w.name}{w.online ? "" : " (offline)"}</option>)}
          </Select>
        </Field>
        <fieldset className="grid gap-3 rounded-lg border border-line p-4">
          <legend className="px-1 text-compact font-medium text-ink-2">Requirements (optional)</legend>
          <label className="flex items-center gap-3 min-h-11 text-sm"><input type="checkbox" className="h-5 w-5 accent-(--accent)" checked={gpu} onChange={(e) => setGpu(e.target.checked)} />Needs a GPU</label>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Architecture" htmlFor="use-arch"><Select id="use-arch" value={arch} onChange={(e) => setArch(e.target.value)}><option value="">Any</option>{arches.map((a) => <option key={a} value={a}>{a}</option>)}</Select></Field>
            <Field label="Local model" htmlFor="use-model" hint="The worker must have this model pulled.">
              {models.length > 0 ? <Select id="use-model" value={model} onChange={(e) => setModel(e.target.value)}><option value="">None needed</option>{models.map((m) => <option key={m} value={m}>{m}</option>)}</Select> : <Input id="use-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="None needed" className="font-mono" />}
            </Field>
          </div>
          <Field label="Minimum free memory (MB)" htmlFor="use-mem"><Input id="use-mem" type="number" inputMode="numeric" min={0} value={minMem} onChange={(e) => setMinMem(e.target.value)} placeholder="No minimum" className="font-mono" /></Field>
          <div role="group" aria-label="Required tools">
            <div className="text-compact font-medium text-ink-2 mb-1">Tools that must be installed</div>
            <div className="flex flex-wrap gap-x-5">
              {TOOLS.map((t) => <label key={t} className="flex items-center gap-2 min-h-11 text-sm font-mono"><input type="checkbox" className="h-5 w-5 accent-(--accent)" checked={tools.includes(t)} onChange={(e) => setTools(e.target.checked ? [...tools, t] : tools.filter((x) => x !== t))} />{t}</label>)}
            </div>
          </div>
        </fieldset>
        <fieldset className="grid gap-1">
          <legend className="text-compact font-medium text-ink-2 mb-1">Agents that use it (optional)</legend>
          {agents.isPending && company ? <p className="text-compact text-ink-3">Loading agents</p> : (agents.data ?? []).length === 0 ? <p className="text-compact text-ink-3">This organization has no agents yet. Assign them later from the agent.</p> : (agents.data ?? []).map((a) => (
            <label key={a.id} className="flex items-center gap-3 min-h-11 text-sm"><input type="checkbox" className="h-5 w-5 accent-(--accent)" checked={agentIds.includes(a.id)} onChange={(e) => setAgentIds(e.target.checked ? [...agentIds, a.id] : agentIds.filter((x) => x !== a.id))} />{a.name}</label>
          ))}
        </fieldset>
        {create.error && <Notice tone="critical" title="Couldn't create the environment">{fabricErrorText(create.error)}</Notice>}
      </div>
    </Modal>
  );
}
