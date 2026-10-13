import { useEffect, useMemo, useRef, useState } from "react";
import { KeyRound, Plus, Square, Trash2 } from "lucide-react";
import type { Agent, HeartbeatRun } from "@papercliped-engine/engine-client";
import { AGENT_ROLES, type AgentRole } from "@papercliped-engine/engine-client";
import { engine, useAdapterModels, useAdapters, useAgents, useEngineReady } from "../../../data/engine/queries.ts";
import { tapEvents } from "../../../data/engine/events.ts";
import { AGENT_ROLE_LABEL, ago, dollars } from "../../../data/engine/map.ts";
import { useAgentSettingsWrites, useAgentSkills, useBudgetWrites, useCreateSecret, useInstructions, useInstructionsFile, useInstructionsHistory, useSecrets, useSkills, useSkillWrites } from "../../../data/engine/more.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "../../../data/engine/keys.ts";
import { BarMeter } from "../../../ui/meters.tsx";
import { Modal } from "../../../ui/Modal.tsx";
import { Button, Card, Chip, EmptyState, Field, IconButton, Input, Notice, Select, Status, Textarea, Toggle, type StatusKind } from "../../../ui/primitives.tsx";
import { ActionError, LoadError, Loading, useLiveOrg } from "./common.tsx";

/** The tabs of an agent's page that go beyond the overview: configuration, instructions, skills, runs and budget. */

type EnvRow = { key: string; kind: "plain" | "secret"; value: string; secretId: string };

function readEnv(config: Record<string, unknown> | undefined): EnvRow[] {
  const env = (config?.env ?? {}) as Record<string, unknown>;
  return Object.entries(env).map(([key, v]) => {
    if (typeof v === "string") return { key, kind: "plain", value: v, secretId: "" };
    const b = v as { type?: string; value?: string; secretId?: string };
    if (b?.type === "secret_ref" && b.secretId) return { key, kind: "secret", value: "", secretId: b.secretId };
    return { key, kind: "plain", value: b?.value ?? "", secretId: "" };
  });
}

// ---- Configuration

export function AgentConfigTab({ agent }: { agent: Agent }) {
  const { companyId } = useLiveOrg();
  const w = useAgentSettingsWrites(companyId, agent.id);
  const adapters = useAdapters();
  const agents = useAgents(companyId);
  const secrets = useSecrets(companyId);
  const cfg = agent.adapterConfig as Record<string, unknown>;
  const [name, setName] = useState(agent.name);
  const [title, setTitle] = useState(agent.title ?? "");
  const [role, setRole] = useState<AgentRole>(agent.role);
  const [reportsTo, setReportsTo] = useState(agent.reportsTo ?? "");
  const [capabilities, setCapabilities] = useState(agent.capabilities ?? "");
  const [adapter, setAdapter] = useState(agent.adapterType);
  const [model, setModel] = useState(typeof cfg.model === "string" ? cfg.model : "");
  const [command, setCommand] = useState(typeof cfg.command === "string" ? cfg.command : "");
  const [env, setEnv] = useState<EnvRow[]>(() => readEnv(cfg));
  const [creating, setCreating] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const info = (adapters.data ?? []).find((a) => a.type === adapter);
  const models = useAdapterModels(companyId, info && info.modelsCount > 0 ? adapter : null);
  const secretList = secrets.data ?? [];
  const secretName = (id: string) => secretList.find((s) => s.id === id)?.name ?? "Unknown secret";
  const setRow = (i: number, patch: Partial<EnvRow>) => setEnv(env.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const badKey = env.some((r) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.key.trim()));
  const incomplete = env.some((r) => (r.kind === "secret" ? !r.secretId : false));

  const save = () => {
    const nextEnv: Record<string, unknown> = {};
    for (const r of env) nextEnv[r.key.trim()] = r.kind === "secret" ? { type: "secret_ref", secretId: r.secretId, version: "latest" } : { type: "plain", value: r.value };
    const adapterConfig: Record<string, unknown> = { ...cfg };
    if (model) adapterConfig.model = model; else delete adapterConfig.model;
    if (adapter === "process") { if (command) adapterConfig.command = command; else delete adapterConfig.command; }
    if (env.length) adapterConfig.env = nextEnv; else delete adapterConfig.env;
    setSaved(false);
    w.update.mutate({ name: name.trim(), title: title.trim() || null, role, reportsTo: reportsTo || null, capabilities: capabilities.trim() || null, adapterType: adapter, adapterConfig }, { onSuccess: () => setSaved(true) });
  };

  return (
    <div className="space-y-6">
      <Card className="p-5 space-y-4">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Name" htmlFor="ag-name"><Input id="ag-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Title" htmlFor="ag-title" hint="Optional"><Input id="ag-title" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="Role" htmlFor="ag-role"><Select id="ag-role" value={role} onChange={(e) => setRole(e.target.value as AgentRole)}>{AGENT_ROLES.map((r) => <option key={r} value={r}>{AGENT_ROLE_LABEL[r]}</option>)}</Select></Field>
          <Field label="Reports to" htmlFor="ag-reports"><Select id="ag-reports" value={reportsTo} onChange={(e) => setReportsTo(e.target.value)}><option value="">You</option>{(agents.data ?? []).filter((a) => a.id !== agent.id && a.status !== "terminated").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        </div>
        <Field label="Capabilities" htmlFor="ag-cap" hint="What this agent is good at, so others know when to hand it work."><Textarea id="ag-cap" rows={3} value={capabilities} onChange={(e) => setCapabilities(e.target.value)} /></Field>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Runs with" htmlFor="ag-adapter"><Select id="ag-adapter" value={adapter} onChange={(e) => { setAdapter(e.target.value); setModel(""); }}>{(adapters.data ?? []).filter((a) => !a.disabled).map((a) => <option key={a.type} value={a.type}>{a.label || a.type}</option>)}{!(adapters.data ?? []).some((a) => a.type === adapter) && <option value={adapter}>{adapter}</option>}</Select></Field>
          {info && info.modelsCount > 0 ? (
            <Field label="Model" htmlFor="ag-model"><Select id="ag-model" value={model} onChange={(e) => setModel(e.target.value)}><option value="">Default</option>{model && !(models.data ?? []).some((m) => m.id === model) && <option value={model}>{model}</option>}{(models.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}</Select></Field>
          ) : adapter === "process" ? (
            <Field label="Command" htmlFor="ag-command"><Input id="ag-command" className="font-mono" value={command} onChange={(e) => setCommand(e.target.value)} /></Field>
          ) : null}
        </div>
        <p className="text-xs text-ink-3">Agents run in containers, not on the host. Changing how an agent runs takes effect on its next run.</p>
      </Card>

      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between gap-3"><h3 className="text-compact font-semibold uppercase tracking-label text-ink-3">Environment</h3><Button size="sm" variant="ghost" onClick={() => setEnv([...env, { key: "", kind: "secret", value: "", secretId: "" }])}><Plus className="h-3.5 w-3.5" />Add variable</Button></div>
        <p className="text-compact text-ink-3">Credentials belong in secrets. A variable can point at a secret; its value is never shown here.</p>
        {env.length === 0 && <p className="text-sm text-ink-3">No environment variables.</p>}
        {env.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <div className="w-44"><Input aria-label="Variable name" className="font-mono" placeholder="API_KEY" value={r.key} onChange={(e) => setRow(i, { key: e.target.value })} /></div>
            <div className="w-32"><Select aria-label={`Kind of ${r.key || "variable"}`} value={r.kind} onChange={(e) => setRow(i, { kind: e.target.value as "plain" | "secret" })}><option value="secret">Secret</option><option value="plain">Plain text</option></Select></div>
            {r.kind === "secret" ? (
              <>
                <div className="flex-1 min-w-40"><Select aria-label={`Secret for ${r.key || "variable"}`} value={r.secretId} onChange={(e) => (e.target.value === "__new" ? setCreating(i) : setRow(i, { secretId: e.target.value }))}>
                  <option value="">Choose a secret</option>
                  {r.secretId && !secretList.some((s) => s.id === r.secretId) && <option value={r.secretId}>{secretName(r.secretId)}</option>}
                  {secretList.filter((s) => s.status === "active").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  <option value="__new">Create a secret</option>
                </Select></div>
                <Chip tone="good"><KeyRound className="h-3 w-3" />Secret</Chip>
              </>
            ) : (
              <div className="flex-1 min-w-40"><Input aria-label={`Value of ${r.key || "variable"}`} placeholder="Value" value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} /></div>
            )}
            <IconButton label={`Remove ${r.key || "variable"}`} size="sm" onClick={() => setEnv(env.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></IconButton>
          </div>
        ))}
        {env.some((r) => r.kind === "plain") && <Notice tone="warning">Plain text values are stored as typed. Use a secret for anything sensitive.</Notice>}
      </Card>

      <PermissionsCard agent={agent} />

      <div className="flex items-center justify-end gap-3">
        {saved && !w.update.isPending && <span className="text-compact text-good">Saved</span>}
        <ActionError error={w.update.error} />
        <Button variant="primary" loading={w.update.isPending} disabled={!name.trim() || badKey || incomplete} onClick={save}>Save configuration</Button>
      </div>
      {creating !== null && <CreateSecretModal onClose={() => setCreating(null)} onCreated={(id) => { setRow(creating, { secretId: id }); setCreating(null); }} />}
    </div>
  );
}

/** Makes a secret in the engine's own store. The value goes straight there and is never kept or shown by the console. */
function CreateSecretModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { companyId } = useLiveOrg();
  const create = useCreateSecret(companyId);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const save = () => create.mutate({ name: name.trim(), value }, { onSuccess: (s) => onCreated(s.id) });
  return (
    <Modal title="Create a secret" subtitle="Stored encrypted by the engine" size="sm" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={create.isPending} disabled={!name.trim() || !value} onClick={save}>Create secret</Button></>}>
      <div className="space-y-3">
        <Field label="Name" htmlFor="sec-name"><Input id="sec-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. GitHub token" /></Field>
        <Field label="Value" htmlFor="sec-value" hint="You won't be able to read it again."><Input id="sec-value" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
        <ActionError error={create.error} />
      </div>
    </Modal>
  );
}

function PermissionsCard({ agent }: { agent: Agent }) {
  const { companyId } = useLiveOrg();
  const w = useAgentSettingsWrites(companyId, agent.id);
  const p = agent.permissions as { canCreateAgents?: boolean; canCreateSkills?: boolean } | null;
  return (
    <Card className="p-5 space-y-3">
      <h3 className="text-compact font-semibold uppercase tracking-label text-ink-3">Permissions</h3>
      <div className="flex items-center gap-3"><div className="flex-1"><div className="text-sm font-medium">Hire other agents</div><div className="text-xs text-ink-3">Lets this agent create agents, which may need your approval.</div></div><Toggle label="Allow hiring agents" checked={!!p?.canCreateAgents} onChange={(v) => w.permissions.mutate({ canCreateAgents: v })} /></div>
      <div className="flex items-center gap-3"><div className="flex-1"><div className="text-sm font-medium">Create skills</div><div className="text-xs text-ink-3">Lets this agent write new skills for the organization.</div></div><Toggle label="Allow creating skills" checked={!!p?.canCreateSkills} onChange={(v) => w.permissions.mutate({ canCreateSkills: v })} /></div>
      <ActionError error={w.permissions.error} />
    </Card>
  );
}

// ---- Instructions

export function AgentInstructionsTab({ agent }: { agent: Agent }) {
  const { companyId } = useLiveOrg();
  const bundle = useInstructions(companyId, agent.id);
  const w = useAgentSettingsWrites(companyId, agent.id);
  const b = bundle.data;
  const files = useMemo(() => (b ? (b.files.length ? b.files.map((f) => f.path) : b.mode ? [b.entryFile] : []) : []), [b]);
  const [path, setPath] = useState<string | null>(null);
  const current = path ?? files.find((f) => f === b?.entryFile) ?? files[0] ?? null;
  if (bundle.isPending) return <Card><Loading label="Loading instructions" /></Card>;
  if (bundle.error) return <Card><LoadError error={bundle.error} retry={() => void bundle.refetch()} /></Card>;
  if (!b?.mode) {
    return (
      <Card><EmptyState icon={<KeyRound className="h-5 w-5" />} title="No instructions file yet" body="Instructions tell an agent how to work: its role, rules and tone. Set them up and the engine keeps them as files with a history of every change." action={<Button variant="primary" loading={w.setMode.isPending} onClick={() => w.setMode.mutate("managed")}>Set up instructions</Button>} /><ActionError error={w.setMode.error} /></Card>
    );
  }
  return (
    <div className="grid md:grid-cols-[14rem_1fr] gap-4">
      <Card className="divide-y divide-line h-fit">
        {files.map((f) => <button key={f} onClick={() => setPath(f)} className={`w-full text-left px-4 py-2.5 text-compact font-mono truncate ${f === current ? "bg-surface-3" : "hover:bg-surface-2/40"}`}>{f}</button>)}
        {files.length === 0 && <p className="px-4 py-3 text-sm text-ink-3">No files.</p>}
      </Card>
      {current ? <InstructionsEditor key={current} agentId={agent.id} path={current} editable={b.editable} /> : null}
    </div>
  );
}

function InstructionsEditor({ agentId, path, editable }: { agentId: string; path: string; editable: boolean }) {
  const { companyId } = useLiveOrg();
  const file = useInstructionsFile(companyId, agentId, path);
  const history = useInstructionsHistory(companyId, agentId, path);
  const w = useAgentSettingsWrites(companyId, agentId);
  const [draft, setDraft] = useState<string | null>(null);
  const [view, setView] = useState<string | null>(null);
  const text = draft ?? file.data?.content ?? "";
  const dirty = draft !== null && draft !== file.data?.content;
  const revisions = history.data?.revisions ?? [];
  return (
    <div className="space-y-4 min-w-0">
      <Card className="p-4 space-y-3">
        {file.isPending && <Loading />}
        {file.error && <LoadError error={file.error} retry={() => void file.refetch()} />}
        {file.data && (
          <>
            <Textarea aria-label={`Contents of ${path}`} rows={14} className="font-mono text-compact" value={text} readOnly={!editable} onChange={(e) => setDraft(e.target.value)} />
            <div className="flex items-center justify-end gap-3">
              <ActionError error={w.saveFile.error} />
              {dirty && <Button variant="ghost" onClick={() => setDraft(null)}>Discard</Button>}
              <Button variant="primary" disabled={!editable || !dirty} loading={w.saveFile.isPending} onClick={() => w.saveFile.mutate({ path, content: text, base: file.data?.revision?.id ?? null }, { onSuccess: () => { setDraft(null); void file.refetch(); void history.refetch(); } })}>Save instructions</Button>
            </div>
            {!editable && <p className="text-xs text-ink-3">These instructions live outside the engine's own folder, so they can't be edited here.</p>}
          </>
        )}
      </Card>
      <Card>
        <div className="px-5 pt-4 pb-2 text-compact font-semibold uppercase tracking-label text-ink-3">Revisions</div>
        {history.isPending && <Loading />}
        {history.data && revisions.length === 0 && <p className="px-5 pb-4 text-sm text-ink-3">No saved revisions yet.</p>}
        <div className="divide-y divide-line">
          {revisions.map((r, i) => (
            <div key={r.id} className="px-5 py-2.5">
              <div className="flex items-center gap-3 text-compact"><span className="flex-1">{i === 0 ? "Current" : `Revision from ${ago(r.createdAt)}`}<span className="text-ink-3"> · {r.source ?? "api"}{r.byteLength !== undefined ? ` · ${r.byteLength} bytes` : ""}</span></span>
                <Button size="sm" variant="ghost" onClick={() => setView(view === r.id ? null : r.id)}>{view === r.id ? "Hide" : "View"}</Button>
                {i > 0 && <Button size="sm" variant="ghost" loading={w.restore.isPending && w.restore.variables?.revisionId === r.id} onClick={() => w.restore.mutate({ path, revisionId: r.id }, { onSuccess: () => { setDraft(null); void file.refetch(); void history.refetch(); } })}>Restore</Button>}
              </div>
              {view === r.id && <RevisionText agentId={agentId} revisionId={r.id} />}
            </div>
          ))}
        </div>
        <ActionError error={w.restore.error} />
      </Card>
    </div>
  );
}

function RevisionText({ agentId, revisionId }: { agentId: string; revisionId: string }) {
  const ready = useEngineReady();
  const q = useQuery({ queryKey: ["engine", "instructions-revision", agentId, revisionId], queryFn: () => engine.agentConfig.revision(agentId, revisionId), enabled: ready });
  if (q.isPending) return <Loading />;
  if (q.error) return <LoadError error={q.error} />;
  const content = (q.data as { content?: string } | undefined)?.content;
  return <pre className="mt-2 font-mono text-compact text-ink-2 bg-code rounded-lg p-3 overflow-auto max-h-64 whitespace-pre-wrap break-words">{content ?? "This revision has no text."}</pre>;
}

// ---- Skills

export function AgentSkillsTab({ agent }: { agent: Agent }) {
  const { companyId } = useLiveOrg();
  const snap = useAgentSkills(companyId, agent.id);
  const skills = useSkills(companyId);
  const w = useSkillWrites(companyId);
  const s = snap.data;
  if (snap.isPending) return <Card><Loading label="Loading skills" /></Card>;
  if (snap.error) return <Card><LoadError error={snap.error} retry={() => void snap.refetch()} /></Card>;
  if (!s?.supported) return <Card><EmptyState icon={<KeyRound className="h-5 w-5" />} title="Skills aren't available for this agent" body={s?.warnings?.[0] ?? "This agent's adapter can't take skills."} /></Card>;
  const on = new Set(s.desiredSkills);
  const list = skills.data ?? [];
  return (
    <Card className="divide-y divide-line">
      {list.length === 0 && <p className="px-5 py-4 text-sm text-ink-3">No skills are installed in this organization. Install some in Skills.</p>}
      {list.map((k) => (
        <div key={k.id} className="flex items-center gap-3 px-5 py-3">
          <div className="flex-1 min-w-0"><div className="text-sm font-medium">{k.name}</div><div className="text-xs text-ink-3 line-clamp-1">{k.description}</div></div>
          <Toggle label={`${on.has(k.key) ? "Remove" : "Add"} ${k.name} for ${agent.name}`} checked={on.has(k.key)} disabled={w.syncAgent.isPending} onChange={(v) => w.syncAgent.mutate({ agentId: agent.id, mode: v ? "add" : "remove", desired: [k.key] })} />
        </div>
      ))}
      <ActionError error={w.syncAgent.error} />
    </Card>
  );
}

// ---- Runs

const RUN_STATUS: Record<string, [StatusKind, string]> = { queued: ["working", "Queued"], running: ["working", "Running"], succeeded: ["good", "Finished"], failed: ["critical", "Failed"], cancelled: ["off", "Cancelled"], timed_out: ["critical", "Timed out"] };

/** NDJSON log text (one {chunk} per line) as the plain text the agent printed. */
export function logText(ndjson: string): string {
  return ndjson.split("\n").map((line) => {
    if (!line.trim()) return "";
    try { const o = JSON.parse(line) as { chunk?: string }; return typeof o.chunk === "string" ? o.chunk : ""; } catch { return line; }
  }).join("");
}

export function AgentRunsTab({ agent }: { agent: Agent }) {
  const { companyId } = useLiveOrg();
  const ready = useEngineReady();
  const runs = useQuery({ queryKey: qk.runs(companyId, `${agent.id}:tab`), queryFn: () => engine.agents.runs(companyId, agent.id, 30), enabled: ready, refetchInterval: 15_000 });
  const [open, setOpen] = useState<string | null>(null);
  const list = runs.data ?? [];
  const sel = list.find((r) => r.id === open) ?? null;
  return (
    <div className="space-y-4">
      <Card className="divide-y divide-line">
        {runs.isPending && <Loading label="Loading runs" />}
        {runs.error && <LoadError error={runs.error} retry={() => void runs.refetch()} />}
        {runs.data && list.length === 0 && <p className="px-5 py-4 text-sm text-ink-3">No runs yet.</p>}
        {list.map((r) => {
          const [kind, label] = RUN_STATUS[r.status] ?? ["idle", r.status];
          return (
            <button key={r.id} onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id} className="w-full text-left flex flex-wrap items-center gap-3 px-5 py-2.5 text-compact hover:bg-surface-2/40">
              <Status kind={kind} label={label} />
              <span className="flex-1 text-ink-2">{String(r.invocationSource).replace(/_/g, " ")}{r.error ? <span className="text-critical"> · {r.error}</span> : null}</span>
              <span className="text-ink-3">{ago(r.startedAt ?? r.createdAt)}</span>
            </button>
          );
        })}
      </Card>
      {sel && <RunLog key={sel.id} run={sel} />}
    </div>
  );
}

/** One run's output: what was written so far, then new lines as the engine reports them, until the run ends. */
export function RunLog({ run }: { run: HeartbeatRun }) {
  const { companyId } = useLiveOrg();
  const ready = useEngineReady();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(false);
  const seen = useRef(new Set<number>());
  const box = useRef<HTMLPreElement>(null);
  const live = run.status === "running" || run.status === "queued";
  useEffect(() => {
    if (!ready) return;
    let on = true;
    setText(""); setLoaded(false); seen.current = new Set();
    // Lines that arrive while the first read is in flight are held and merged by sequence number.
    const held: { seq: number; chunk: string }[] = [];
    const off = tapEvents(companyId, (e) => {
      const p = e.payload as { runId?: string; seq?: number; chunk?: string } | null | undefined;
      if (e.type !== "heartbeat.run.log" || p?.runId !== run.id || typeof p.chunk !== "string") return;
      held.push({ seq: p.seq ?? -1, chunk: p.chunk });
      if (loadedRef.current) flush();
    });
    const loadedRef = { current: false };
    const flush = () => {
      const add = held.splice(0).filter((h) => h.seq < 0 || !seen.current.has(h.seq));
      for (const h of add) if (h.seq >= 0) seen.current.add(h.seq);
      if (add.length && on) setText((t) => t + add.map((h) => h.chunk).join(""));
    };
    engine.runs.log(run.id, 0, 262144).then((r) => {
      if (!on) return;
      let lines = "";
      for (const line of String(r.content ?? "").split("\n")) {
        if (!line.trim()) continue;
        try { const o = JSON.parse(line) as { seq?: number; chunk?: string }; if (typeof o.seq === "number") seen.current.add(o.seq); lines += o.chunk ?? ""; } catch { lines += `${line}\n`; }
      }
      setText(lines);
      loadedRef.current = true;
      setLoaded(true);
      flush();
    }).catch((e) => on && setError(e));
    return () => { on = false; off(); };
  }, [run.id, ready, companyId]);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [text]);
  const cancel = async () => { try { await engine.runs.cancel(run.id); void qc.invalidateQueries({ queryKey: qk.runs(companyId) }); } catch (e) { setError(e); } };
  return (
    <Card className="p-4 space-y-2">
      <div className="flex items-center gap-3"><h3 className="text-compact font-semibold uppercase tracking-label text-ink-3 flex-1">Run output{live ? " (live)" : ""}</h3>{live && <Button size="sm" variant="ghost" onClick={() => void cancel()}><Square className="h-3.5 w-3.5" />Stop run</Button>}</div>
      {!loaded && !error && <Loading label="Loading output" />}
      {error ? <LoadError error={error} /> : null}
      {loaded && <pre ref={box} aria-label="Run output" className="font-mono text-compact text-ink-2 bg-code rounded-lg p-3 overflow-auto max-h-80 whitespace-pre-wrap break-words">{text || "This run printed nothing."}</pre>}
    </Card>
  );
}

// ---- Budget

export function AgentBudgetTab({ agent }: { agent: Agent }) {
  const { companyId } = useLiveOrg();
  const bw = useBudgetWrites(companyId);
  const [value, setValue] = useState(agent.budgetMonthlyCents ? String(agent.budgetMonthlyCents / 100) : "");
  const n = Number(value.replace(/[$,\s]/g, ""));
  const cents = value.trim() === "" ? 0 : Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
  return (
    <Card className="p-5 space-y-4">
      <BarMeter label="This month" pct={agent.budgetMonthlyCents ? (agent.spentMonthlyCents / agent.budgetMonthlyCents) * 100 : 0} value={agent.budgetMonthlyCents ? `${dollars(agent.spentMonthlyCents)} of ${dollars(agent.budgetMonthlyCents)}` : `${dollars(agent.spentMonthlyCents)}, no limit`} />
      {agent.pauseReason && <Notice tone="warning">Paused: {String(agent.pauseReason).replace(/_/g, " ")}. Resolve it in Costs.</Notice>}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Monthly budget (US dollars)" htmlFor="ab-budget" hint="Empty means no limit. At the limit the agent pauses."><div className="w-48"><Input id="ab-budget" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} /></div></Field>
        <Button disabled={cents === null || cents === agent.budgetMonthlyCents} loading={bw.agent.isPending} onClick={() => cents !== null && bw.agent.mutate({ agentId: agent.id, cents })}>Save budget</Button>
      </div>
      <ActionError error={bw.agent.error} />
    </Card>
  );
}
