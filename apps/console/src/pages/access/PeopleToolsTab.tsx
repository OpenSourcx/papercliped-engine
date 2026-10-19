import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, Plus, Trash2, Upload } from "lucide-react";
import { accessAdmin, type GroupMapping, type ImportOptions, type ImportPreview, type ImportResult, type MapOp, type Plan, type Template } from "../../data/engine/accessAdmin.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Chip, Input, Notice, SectionTitle, Segmented, Select, Textarea, Toggle } from "../../ui/primitives.tsx";
import { ChangeList, PlanView } from "./ChangePreview.tsx";
import { QueryState, SecretOnce, Table, Td, Th, plural, useIac, AField as Field } from "./shared.tsx";

const SAMPLE = "username,password,firstname,lastname,email,groups,devicerole,orgs\nann,,Ann,Lee,ann@example.org,ops,viewer,Northwind:operator\nben@pve,,Ben,Ray,ben@example.org,,operator,\n";
const ORG_ROLES = ["viewer", "operator", "admin", "owner"];

// ---------------------------------------------------------------- CSV import

function Import() {
  const qc = useQueryClient();
  const tplQ = useQuery({ queryKey: ["access", "templates"], queryFn: accessAdmin.templates.list, retry: 0 });
  const [csv, setCsv] = useState("");
  const [opt, setOpt] = useState<ImportOptions>({ existing: "skip", createGroups: false, defaultRealm: "pve", template: null, generatePasswords: true });
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const check = useMutation({ mutationFn: () => accessAdmin.import.preview(csv, opt), onSuccess: (r) => { setPreview(r); setError(null); }, onError: (e) => { setPreview(null); setError(errorText(e)); } });
  const apply = useMutation({
    mutationFn: () => accessAdmin.import.apply(csv, opt),
    onSuccess: (r) => {
      setResult(r);
      setPreview(null);
      setShowPw(r.results.some((x) => x.password));
      qc.invalidateQueries({ queryKey: ["iac"] });
      qc.invalidateQueries({ queryKey: ["access"] });
    },
    onError: (e) => setError(errorText(e)),
  });
  const passwords = result?.results.filter((r) => r.password) ?? [];
  const passwordCsv = ["username,password", ...passwords.map((p) => `${p.userid},${p.password}`)].join("\n");
  const change = (patch: Partial<ImportOptions>) => {
    setOpt({ ...opt, ...patch });
    setPreview(null);
  };
  return (
    <section aria-label="Import people">
      <p className="text-compact text-ink-2 mb-4 max-w-2xl">Create many people at once from a spreadsheet. Each person becomes a Proxmox user and gets their ePaperclip account, with groups, device role and organization roles as listed. You see exactly what will happen before anything changes.</p>
      <div className="flex flex-wrap gap-2 mb-3">
        <Button onClick={() => file.current?.click()}><FileUp className="h-4 w-4" />Choose a CSV file</Button>
        <input ref={file} type="file" accept=".csv,text/csv,text/plain" hidden aria-label="CSV file" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setCsv(await f.text()); setPreview(null); setResult(null); } e.target.value = ""; }} />
        <Button variant="ghost" onClick={() => { setCsv(SAMPLE); setPreview(null); }}>Use an example</Button>
      </div>
      <Field label="CSV" hint={<>Columns: username (or name@realm), password, firstname, lastname, email, comment, groups (separate with ;), enable, expire (2027-06-30), devicerole, orgs (Name:role; Name:role), template. Up to 500 people.</>}>
        <Textarea value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null); }} rows={7} className="font-mono text-compact" spellCheck={false} placeholder={SAMPLE} />
      </Field>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-4 items-end">
        <Field label="Realm for bare names"><Input value={opt.defaultRealm} onChange={(e) => change({ defaultRealm: e.target.value.trim() })} className="font-mono" /></Field>
        <Field label="People who already exist"><Select value={opt.existing} onChange={(e) => change({ existing: e.target.value as "skip" | "update" })}><option value="skip">Leave unchanged</option><option value="update">Update from the file</option></Select></Field>
        <Field label="Template for everyone"><Select value={opt.template ?? ""} onChange={(e) => change({ template: e.target.value || null })}><option value="">None</option>{(tplQ.data?.templates ?? []).map((t) => <option key={t.id}>{t.name}</option>)}</Select></Field>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-compact"><Toggle checked={opt.createGroups} onChange={(v) => change({ createGroups: v })} label="Create missing groups" />Create missing groups</label>
          <label className="flex items-center gap-2 text-compact"><Toggle checked={opt.generatePasswords} onChange={(v) => change({ generatePasswords: v })} label="Make passwords" />Make a password where none is given</label>
        </div>
      </div>
      <div className="flex gap-2 mt-4">
        <Button variant="primary" loading={check.isPending} disabled={!csv.trim()} onClick={() => { setResult(null); check.mutate(); }}>Preview</Button>
      </div>
      {error && <p role="alert" className="text-compact text-critical mt-3">{error}</p>}
      {preview && (
        <div className="mt-6 space-y-4" aria-label="Import preview">
          <div className="flex flex-wrap gap-2 text-compact">
            <Chip tone="good">{plural(preview.counts.create, "person", "people")} to create</Chip>
            {preview.counts.update > 0 && <Chip tone="accent">{preview.counts.update} to update</Chip>}
            {preview.counts.skip > 0 && <Chip>{preview.counts.skip} already exist</Chip>}
            {preview.counts.error > 0 && <Chip tone="critical">{plural(preview.counts.error, "row")} with errors</Chip>}
            {preview.newGroups.length > 0 && <Chip tone="accent">New groups: {preview.newGroups.join(", ")}</Chip>}
          </div>
          {preview.problems.length > 0 && <ul className="text-compact text-warning list-disc pl-5">{preview.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          <Table min="min-w-[860px]">
            <thead><tr className="border-b border-line"><Th>Line</Th><Th>User</Th><Th>What happens</Th><Th>Access</Th><Th>Notes</Th></tr></thead>
            <tbody>
              {preview.rows.map((r) => (
                <tr key={r.line} className="border-b border-line last:border-0 align-top">
                  <Td className="text-ink-3 tabular-nums">{r.line}</Td>
                  <Td><div className="font-mono text-compact">{r.userid || "—"}</div><div className="text-xs text-ink-3">{r.summary.name}{r.summary.email ? ` · ${r.summary.email}` : ""}</div></Td>
                  <Td><Chip tone={r.action === "create" ? "good" : r.action === "update" ? "accent" : r.action === "error" ? "critical" : "neutral"}>{{ create: "Create", update: "Update", skip: "Leave", error: "Error" }[r.action]}</Chip></Td>
                  <Td className="text-compact text-ink-2">{[r.summary.deviceRole && `Device: ${r.summary.deviceRole}`, ...r.summary.orgs.map((o) => `${o.org}: ${o.role}`), r.summary.groups.length ? `Groups: ${r.summary.groups.join(", ")}` : ""].filter(Boolean).join(" · ") || "—"}</Td>
                  <Td className="text-compact">{r.errors.map((e) => <div key={e} className="text-critical">{e}</div>)}{r.warnings.map((w) => <div key={w} className="text-ink-3">{w}</div>)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <details className="text-compact"><summary className="cursor-pointer text-ink-2">Permissions this will add in Proxmox</summary>
            <div className="mt-2 space-y-3">{preview.rows.filter((r) => r.changes?.length).map((r) => <div key={r.line}><div className="font-mono text-compact mb-1">{r.userid}</div><ChangeList changes={r.changes!} /></div>)}</div>
          </details>
          <Button variant="primary" loading={apply.isPending} disabled={preview.counts.error > 0 || preview.counts.create + preview.counts.update === 0} onClick={() => apply.mutate()}><Upload className="h-4 w-4" />Import {plural(preview.counts.create + preview.counts.update, "person", "people")}</Button>
          {preview.counts.error > 0 && <p className="text-xs text-ink-3">Fix the rows with errors in the file, then preview again.</p>}
        </div>
      )}
      {result && (
        <div className="mt-6 space-y-3" aria-label="Import result">
          <Notice tone={result.counts.failed ? "warning" : "good"} title={`${result.counts.created} created, ${result.counts.updated} updated, ${result.counts.skipped} left alone${result.counts.failed ? `, ${result.counts.failed} failed` : ""}`}>
            {passwords.length > 0 ? "Passwords made for new people are shown once." : "Everyone is in."}
          </Notice>
          <ul className="text-compact space-y-1">
            {result.results.filter((r) => r.error || r.warnings.length).map((r) => <li key={r.line}><span className="font-mono">{r.userid}</span>: {r.error ? <span className="text-critical">{r.error}</span> : <span className="text-ink-2">{r.warnings.join(" ")}</span>}</li>)}
          </ul>
        </div>
      )}
      {showPw && (
        <SecretOnce title="Passwords for the new people" subtitle="Shown once and not kept. Hand each person theirs, and ask them to change it from My security." secrets={[{ label: "username,password", value: passwordCsv }]} onClose={() => setShowPw(false)} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------- templates

function TemplateModal({ template, orgs, groups, onClose }: { template: Template | null; orgs: { companyId: string; name: string }[]; groups: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [deviceRole, setDeviceRole] = useState<string>(template?.deviceRole ?? "");
  const [tGroups, setTGroups] = useState<string[]>(template?.groups ?? []);
  const [roles, setRoles] = useState<Record<string, string>>(Object.fromEntries((template?.orgs ?? []).map((o) => [o.companyId, o.role])));
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), description: description.trim() || undefined, ...(deviceRole ? { deviceRole: deviceRole as Template["deviceRole"] } : {}), groups: tGroups, orgs: Object.entries(roles).filter(([, r]) => r).map(([companyId, role]) => ({ companyId, role })) };
      return template ? accessAdmin.templates.update(template.id, body) : accessAdmin.templates.create(body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["access", "templates"] }); onClose(); },
    onError: (e) => setError(errorText(e)),
  });
  const rows = [{ companyId: "*", name: "Every organization" }, ...orgs];
  return (
    <Modal size="md" title={template ? `Template ${template.name}` : "New template"} subtitle="A reusable set of access to give people." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>{template ? "Save template" : "Create template"}</Button></>}>
      <div className="space-y-4">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus /></Field>
        <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={256} /></Field>
        <Field label="Device access" hint="Leave as 'Don't change' to leave device roles alone."><Select value={deviceRole} onChange={(e) => setDeviceRole(e.target.value)}><option value="">Don't change</option><option value="admin">Administrator</option><option value="operator">Operator</option><option value="viewer">Viewer</option></Select></Field>
        <fieldset>
          <legend className="text-compact font-medium text-ink-2 mb-1.5">Organization roles</legend>
          <div className="rounded-lg border border-line divide-y divide-line">
            {rows.map((o) => (
              <div key={o.companyId} className="flex items-center gap-3 px-3 py-2"><span className="flex-1 text-sm truncate">{o.name}</span>
                <Select className="!w-40" aria-label={`Role in ${o.name}`} value={roles[o.companyId] ?? ""} onChange={(e) => setRoles({ ...roles, [o.companyId]: e.target.value })}><option value="">No change</option>{ORG_ROLES.map((r) => <option key={r}>{r}</option>)}</Select></div>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-compact font-medium text-ink-2 mb-1.5">Groups to join</legend>
          <div className="flex flex-wrap gap-3">{groups.length ? groups.map((g) => <label key={g} className="flex items-center gap-1.5 text-compact"><input type="checkbox" className="h-4 w-4 accent-(--accent)" checked={tGroups.includes(g)} onChange={(e) => setTGroups(e.target.checked ? [...tGroups, g] : tGroups.filter((x) => x !== g))} />{g}</label>) : <span className="text-compact text-ink-3">No groups yet.</span>}</div>
        </fieldset>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function ApplyTemplate({ template, onClose }: { template: Template; onClose: () => void }) {
  const qc = useQueryClient();
  const iacQ = useIac();
  const [picked, setPicked] = useState<string[]>([]);
  const [plans, setPlans] = useState<(Plan & { userid: string; error?: string; applied?: boolean })[] | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: (dryRun: boolean) => accessAdmin.templates.apply(template.id, picked, dryRun),
    onSuccess: (r) => {
      setPlans(r.results);
      setDone(!r.dryRun);
      setError(null);
      if (!r.dryRun) { qc.invalidateQueries({ queryKey: ["iac"] }); qc.invalidateQueries({ queryKey: ["access"] }); }
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal size="lg" title={`Apply ${template.name}`} subtitle="Adds the template's access to the people you pick. Nothing they already have is taken away." onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{done ? "Close" : "Cancel"}</Button>
        {!done && <Button disabled={!picked.length} loading={run.isPending && run.variables === true} onClick={() => run.mutate(true)}>Preview</Button>}
        {!done && <Button variant="primary" disabled={!picked.length || !plans} loading={run.isPending && run.variables === false} onClick={() => run.mutate(false)}>Apply to {plural(picked.length, "person", "people")}</Button>}
      </>}>
      <div className="space-y-4">
        {!done && <div className="max-h-48 overflow-y-auto overflow-x-hidden rounded-lg border border-line divide-y divide-line">
          {(iacQ.data?.users ?? []).map((u) => <label key={u.userid} className="flex items-center gap-3 px-3 py-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-(--accent)" checked={picked.includes(u.userid)} onChange={(e) => { setPicked(e.target.checked ? [...picked, u.userid] : picked.filter((x) => x !== u.userid)); setPlans(null); }} /><span className="font-mono">{u.userid}</span><span className="text-ink-3">{u.name}</span></label>)}
        </div>}
        {plans && plans.map((p) => (
          <div key={p.userid}>
            <div className="flex items-center gap-2 mb-1"><span className="font-mono text-compact">{p.userid}</span>{p.applied && <Chip tone="good">Done</Chip>}{p.error && <Chip tone="critical">{p.error}</Chip>}</div>
            <PlanView plan={p} />
          </div>
        ))}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function Templates() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["access", "templates"], queryFn: accessAdmin.templates.list, retry: 0 });
  const iacQ = useIac();
  const [editing, setEditing] = useState<Template | "new" | null>(null);
  const [applying, setApplying] = useState<Template | null>(null);
  const remove = useMutation({ mutationFn: (id: string) => accessAdmin.templates.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["access", "templates"] }) });
  const orgName = (id: string) => (id === "*" ? "every organization" : (iacQ.data?.orgs.find((o) => o.companyId === id)?.name ?? id));
  return (
    <section aria-label="Organization-role templates">
      <SectionTitle action={iacQ.data?.canManageUsers ? <Button variant="primary" onClick={() => setEditing("new")}><Plus className="h-4 w-4" />New template</Button> : undefined}>Templates</SectionTitle>
      <p className="text-compact text-ink-2 mb-3 max-w-2xl">A named bundle of access, such as "Contractor: viewer on the device, operator in every organization". Apply it to people instead of setting each role by hand; you see the Proxmox changes first.</p>
      <QueryState query={q}>
        {q.data && (q.data.templates.length === 0 ? <p className="text-compact text-ink-3">No templates yet.</p> : (
          <ul className="rounded-xl border border-line divide-y divide-line bg-surface">
            {q.data.templates.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{t.name}</div>
                  <div className="text-xs text-ink-3">{[t.deviceRole && `Device: ${t.deviceRole}`, ...t.orgs.map((o) => `${orgName(o.companyId)}: ${o.role}`), t.groups.length ? `Groups: ${t.groups.join(", ")}` : ""].filter(Boolean).join(" · ")}{t.description ? ` — ${t.description}` : ""}</div>
                </div>
                <Button size="sm" onClick={() => setApplying(t)}>Apply…</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>Edit</Button>
                <Button size="sm" variant="ghost" aria-label={`Delete ${t.name}`} onClick={() => remove.mutate(t.id)}><Trash2 className="h-4 w-4" /></Button>
              </li>
            ))}
          </ul>
        ))}
      </QueryState>
      {editing && iacQ.data && <TemplateModal template={editing === "new" ? null : editing} orgs={iacQ.data.orgs} groups={iacQ.data.groups.map((g) => g.groupid)} onClose={() => setEditing(null)} />}
      {applying && <ApplyTemplate template={applying} onClose={() => setApplying(null)} />}
    </section>
  );
}

// ---------------------------------------------------------------- group mapping

function GroupMap() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["access", "group-map"], queryFn: accessAdmin.groupMap.get, retry: 0 });
  const [rows, setRows] = useState<GroupMapping[] | null>(null);
  const [ops, setOps] = useState<MapOp[] | null>(null);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = rows ?? q.data?.mappings ?? [];
  const save = useMutation({ mutationFn: () => accessAdmin.groupMap.save(current), onSuccess: () => { setRows(null); setOps(null); qc.invalidateQueries({ queryKey: ["access", "group-map"] }); }, onError: (e) => setError(errorText(e)) });
  const sync = useMutation({
    mutationFn: (dry: boolean) => accessAdmin.groupMap.sync(dry),
    onSuccess: (r) => { setOps(r.operations); setApplied(!r.dryRun); setError(null); if (!r.dryRun) qc.invalidateQueries({ queryKey: ["iac"] }); },
    onError: (e) => setError(errorText(e)),
  });
  const set = (i: number, patch: Partial<GroupMapping>) => setRows(current.map((m, j) => (i === j ? { ...m, ...patch } : m)));
  const dirty = rows !== null;
  return (
    <section aria-label="Group to organization mapping">
      <p className="text-compact text-ink-2 mb-3 max-w-2xl">Give everyone in a Proxmox group a role in an organization. Works well with directory groups: sync the realm, then sync here. People are added or raised when they join a mapped group, and a role mapping gave is taken back when they leave it. Roles given by hand are never lowered or removed.</p>
      <QueryState query={q}>
        {q.data && (
          <>
            <div className="space-y-2 max-w-3xl">
              {current.length === 0 && <p className="text-compact text-ink-3">No mappings yet.</p>}
              {current.map((m, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Select aria-label="Group" className="!w-44" value={m.group} onChange={(e) => set(i, { group: e.target.value })}>{q.data.groups.map((g) => <option key={g}>{g}</option>)}</Select>
                  <span className="text-compact text-ink-3">gets</span>
                  <Select aria-label="Role" className="!w-36" value={m.role} onChange={(e) => set(i, { role: e.target.value })}>{q.data.roles.map((r) => <option key={r}>{r}</option>)}</Select>
                  <span className="text-compact text-ink-3">in</span>
                  <Select aria-label="Organization" className="!w-48" value={m.companyId} onChange={(e) => set(i, { companyId: e.target.value })}>{q.data.orgs.map((o) => <option key={o.companyId} value={o.companyId}>{o.name}</option>)}</Select>
                  <Button size="sm" variant="ghost" aria-label="Remove mapping" onClick={() => setRows(current.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2 mt-3">
              <Button disabled={!q.data.groups.length || !q.data.orgs.length} onClick={() => setRows([...current, { group: q.data.groups[0], companyId: q.data.orgs[0].companyId, role: "viewer" }])}><Plus className="h-4 w-4" />Add mapping</Button>
              <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>Save mappings</Button>
              <Button disabled={dirty || current.length === 0} loading={sync.isPending && sync.variables === true} onClick={() => sync.mutate(true)}>Preview a sync</Button>
            </div>
          </>
        )}
      </QueryState>
      {error && <p role="alert" className="text-compact text-critical mt-3">{error}</p>}
      {ops && (
        <div className="mt-5" aria-label="Sync preview">
          {ops.length === 0 ? <p className="text-compact text-ink-3">Everyone already has what the mappings give.</p> : (
            <>
              <Table min="min-w-[560px]"><thead><tr className="border-b border-line"><Th>Person</Th><Th>Organization</Th><Th>Change</Th><Th>Why</Th></tr></thead>
                <tbody>{ops.map((o) => <tr key={`${o.userid}${o.companyId}`} className="border-b border-line last:border-0"><Td className="font-mono text-compact">{o.userid}</Td><Td>{o.org}</Td><Td>{o.op === "revoke" ? `Removed (was ${o.from})` : o.op === "raise" ? `${o.from} → ${o.to}` : `Joins as ${o.to}`}{o.applied && <Chip tone="good" className="ml-2">Done</Chip>}{o.error && <span className="text-critical ml-2">{o.error}</span>}</Td><Td className="text-ink-2">{o.because}</Td></tr>)}</tbody></Table>
              {!applied && <Button className="mt-3" variant="primary" loading={sync.isPending && sync.variables === false} onClick={() => sync.mutate(false)}>Apply {plural(ops.length, "change")}</Button>}
            </>
          )}
        </div>
      )}
    </section>
  );
}

type View = "import" | "templates" | "groups";

/** Tools for many people at once: CSV import, templates and group-to-organization mapping. */
export function PeopleToolsTab() {
  const [view, setView] = useState<View>("import");
  const iacQ = useIac();
  return (
    <div>
      <div className="mb-5"><Segmented<View> label="People tools" value={view} onChange={setView} options={[{ value: "import", label: "Import from CSV" }, { value: "templates", label: "Templates" }, { value: "groups", label: "Group mapping" }]} /></div>
      {iacQ.data && !iacQ.data.canManageUsers && <Notice tone="info" title="Read-only">Your Proxmox account can't manage users, so Proxmox will refuse changes made here.</Notice>}
      {view === "import" && <Import />}
      {view === "templates" && <Templates />}
      {view === "groups" && <GroupMap />}
    </div>
  );
}
