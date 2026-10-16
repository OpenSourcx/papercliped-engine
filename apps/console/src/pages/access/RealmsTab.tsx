import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Plus, RefreshCw, Trash2 } from "lucide-react";
import { access, type Realm, type RealmField } from "../../data/engine/access.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Chip, EmptyState, Field, Input, Notice, SectionTitle, Select, Toggle } from "../../ui/primitives.tsx";
import { SyncJobs } from "./SyncJobs.tsx";
import { QueryState, ReadOnlyNote, Table, Td, Th } from "./shared.tsx";

const KEY = ["access", "realms"] as const;
const TYPE_LABEL: Record<string, string> = { pam: "Linux PAM", pve: "Proxmox", ldap: "LDAP", ad: "Active Directory", openid: "OpenID Connect" };
const GROUP_LABEL: Record<RealmField["group"], string> = { connection: "Connection", login: "Sign-in", sync: "Users and groups", general: "General" };

type Values = Record<string, string | boolean>;

const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";
const initialValues = (fields: RealmField[], cfg: Record<string, unknown> | null): Values => {
  const out: Values = {};
  for (const f of fields) {
    const v = cfg?.[f.name];
    out[f.name] = f.secret ? "" : f.kind === "boolean" ? (v === undefined ? (f.default as boolean | undefined) ?? false : truthy(v)) : v === undefined || v === null ? "" : String(v);
  }
  return out;
};

/** One field of the form, drawn from its schema entry. */
function FieldInput({ f, value, error, onChange, editing }: { f: RealmField; value: string | boolean; error?: string; onChange: (v: string | boolean) => void; editing: boolean }) {
  const hint = f.createOnly && editing ? "Can only be set when the realm is created." : f.secret && editing ? `${f.help ?? ""} Leave empty to keep what Proxmox has.`.trim() : f.help;
  if (f.kind === "boolean") {
    return (
      <div className="flex items-start gap-3 sm:col-span-2">
        <Toggle checked={value === true} onChange={onChange} label={f.label} />
        <div><div className="text-sm">{f.label}</div>{hint && <p className="text-xs text-ink-3">{hint}</p>}</div>
      </div>
    );
  }
  return (
    <Field label={<>{f.label}{f.required && <span className="text-critical"> *</span>}</>} hint={hint} error={error} htmlFor={`realm-${f.name}`}>
      {f.kind === "enum" ? (
        <Select id={`realm-${f.name}`} value={String(value)} onChange={(e) => onChange(e.target.value)}>{!f.required && <option value="">Default{f.default ? ` (${f.default})` : ""}</option>}{f.options!.map((o) => <option key={o} value={o}>{o}</option>)}</Select>
      ) : (
        <Input id={`realm-${f.name}`} type={f.secret ? "password" : f.kind === "integer" ? "number" : "text"} value={String(value)} onChange={(e) => onChange(e.target.value)} autoComplete={f.secret ? "new-password" : "off"} spellCheck={false} disabled={editing && f.createOnly} placeholder={f.default !== undefined && !f.secret ? String(f.default) : undefined} />
      )}
    </Field>
  );
}

function validate(fields: RealmField[], v: Values, creating: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const x = v[f.name];
    if (f.kind === "boolean") continue;
    const s = String(x ?? "").trim();
    if (!s) {
      if (creating && f.required) errors[f.name] = `${f.label} is required`;
      continue;
    }
    if (f.kind === "integer" && (!/^\d+$/.test(s) || Number(s) < (f.min ?? 0) || Number(s) > 65535)) errors[f.name] = `Use a whole number from ${f.min ?? 0} to 65535`;
    else if (f.pattern && f.kind !== "secret" && !new RegExp(f.pattern).test(s)) errors[f.name] = "That isn't in the expected form";
    else if (f.max && s.length > f.max) errors[f.name] = `Use at most ${f.max} characters`;
  }
  return errors;
}

function RealmModal({ realm, type, schema, canManage, onClose }: { realm: Realm | null; type: string; schema: RealmField[]; canManage: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const creating = !realm;
  const [id, setId] = useState("");
  const [values, setValues] = useState<Values>(() => initialValues(schema, realm?.config ?? null));
  const [removeSecret, setRemoveSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const errors = validate(schema, values, creating);
  const idOk = !creating || /^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(id);
  const done = () => {
    qc.invalidateQueries({ queryKey: KEY });
    onClose();
  };
  const body = () => {
    const out: Record<string, unknown> = {};
    const clear: string[] = [];
    for (const f of schema) {
      const v = values[f.name];
      const was = realm?.config?.[f.name];
      if (f.kind === "boolean") {
        if (creating ? v !== (f.default ?? false) : v !== truthy(was)) out[f.name] = v;
      } else if (String(v).trim() !== "") {
        if (!realm || f.secret || String(v).trim() !== String(was ?? "")) out[f.name] = f.kind === "integer" ? Number(v) : f.secret ? String(v) : String(v).trim();
      } else if (!creating && !f.secret && was !== undefined && !f.required) clear.push(f.name);
    }
    if (!creating && removeSecret) for (const f of schema) if (f.secret) clear.push(f.name);
    if (clear.length) out.clear = clear;
    return out;
  };
  const save = useMutation({
    mutationFn: () => (creating ? access.realms.create({ realm: id, type, ...body() }) : access.realms.update(realm.realm, body())),
    onSuccess: done,
    onError: (e) => setError(errorText(e)),
  });
  const remove = useMutation({ mutationFn: () => access.realms.remove(realm!.realm), onSuccess: done, onError: (e) => setError(errorText(e)) });
  const groups = (["connection", "login", "sync", "general"] as const).map((g) => [g, schema.filter((f) => f.group === g)] as const).filter(([, l]) => l.length);
  const hasSecret = schema.some((f) => f.secret);
  return (
    <Modal
      size="lg"
      icon={<Globe className="h-5 w-5" />}
      title={creating ? `New ${TYPE_LABEL[type]} realm` : `${realm.realm} · ${TYPE_LABEL[type] ?? type}`}
      subtitle={creating ? "A realm is where people sign in from. Proxmox checks their password there." : type === "pam" ? "Accounts of the host's operating system. Proxmox stores their permissions only; the passwords live in the OS." : undefined}
      onClose={onClose}
      footer={
        <>
          {!creating && canManage && !["pam", "pve"].includes(type) && !confirm && <Button variant="ghost" className="mr-auto text-critical" onClick={() => setConfirm(true)}><Trash2 className="h-4 w-4" />Delete realm</Button>}
          <Button variant="ghost" onClick={onClose}>{canManage ? "Cancel" : "Close"}</Button>
          {canManage && <Button variant="primary" loading={save.isPending} disabled={!idOk || Object.keys(errors).length > 0} onClick={() => save.mutate()}>{creating ? "Create realm" : "Save realm"}</Button>}
        </>
      }
    >
      <div className="space-y-6">
        {creating && <Field label="Realm name" hint="Shown on the sign-in screen and after the @ in user names." htmlFor="realm-id"><Input id="realm-id" value={id} onChange={(e) => setId(e.target.value)} className="font-mono" autoFocus spellCheck={false} /></Field>}
        {groups.map(([g, list]) => (
          <fieldset key={g}>
            <legend className="text-xs font-semibold uppercase tracking-label text-ink-3 mb-2">{GROUP_LABEL[g]}</legend>
            <div className="grid sm:grid-cols-2 gap-4">
              {list.map((f) => <FieldInput key={f.name} f={f} value={values[f.name]} error={errors[f.name]} onChange={(v) => setValues({ ...values, [f.name]: v })} editing={!creating} />)}
            </div>
          </fieldset>
        ))}
        {!creating && hasSecret && (
          <label className="flex items-center gap-2 text-compact text-ink-2"><input type="checkbox" className="h-4 w-4 accent-(--accent)" checked={removeSecret} onChange={(e) => setRemoveSecret(e.target.checked)} />Remove the stored password or secret</label>
        )}
        {confirm && realm && (
          <Notice tone="critical" title={`Delete ${realm.realm}?`} action={<Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Delete realm</Button>}>People who sign in through it can't any more. Their Proxmox users stay until you delete them.</Notice>
        )}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

const SCOPES = [["both", "Users and groups"], ["users", "Users only"], ["groups", "Groups only"]] as const;

function SyncModal({ realm, onClose }: { realm: Realm; onClose: () => void }) {
  const [scope, setScope] = useState<"users" | "groups" | "both">("both");
  const [dryRun, setDryRun] = useState(true);
  const [enableNew, setEnableNew] = useState(true);
  const [vanished, setVanished] = useState<string[]>([]);
  const [task, setTask] = useState<{ upid: string; dryRun: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = useMutation({ mutationFn: (dry: boolean) => access.realms.sync(realm.realm, { scope, dryRun: dry, enableNew, removeVanished: vanished }), onSuccess: (r) => setTask({ upid: r.task, dryRun: r.dryRun }), onError: (e) => setError(errorText(e)) });
  const log = useQuery({
    queryKey: ["access", "sync", task?.upid],
    queryFn: () => access.realms.task(task!.upid),
    enabled: !!task,
    refetchInterval: (q) => (q.state.data?.status === "stopped" ? false : 1500),
    retry: 1,
  });
  const finished = log.data?.status === "stopped";
  const ok = finished && (log.data?.exitstatus === "OK" || log.data?.exitstatus?.startsWith("WARNINGS"));
  const toggleV = (v: string) => setVanished((l) => (l.includes(v) ? l.filter((x) => x !== v) : [...l, v]));
  return (
    <Modal size="lg" icon={<RefreshCw className="h-5 w-5" />} title={`Sync ${realm.realm}`} subtitle="Copies users and groups from the directory into Proxmox. A dry run shows what would change and writes nothing." onClose={onClose}
      footer={task ? <>{finished && task.dryRun && ok && <Button variant="primary" onClick={() => { setTask(null); start.mutate(false); }}>Run it for real</Button>}<Button variant={finished && task.dryRun && ok ? "ghost" : "primary"} onClick={onClose}>Close</Button></>
        : <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={start.isPending} onClick={() => start.mutate(dryRun)}>{dryRun ? "Start dry run" : "Start sync"}</Button></>}>
      {!task ? (
        <div className="space-y-4">
          <Field label="What to sync"><Select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>{SCOPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          <div className="flex items-start gap-3"><Toggle checked={dryRun} onChange={setDryRun} label="Dry run" /><div><div className="text-sm">Dry run</div><p className="text-xs text-ink-3">Only report what would change.</p></div></div>
          <div className="flex items-start gap-3"><Toggle checked={enableNew} onChange={setEnableNew} label="Enable new users" /><div><div className="text-sm">Enable new users</div><p className="text-xs text-ink-3">New users can sign in straight away.</p></div></div>
          <fieldset>
            <legend className="text-compact font-medium text-ink-2 mb-1.5">When something has vanished from the directory</legend>
            {[["entry", "Delete the user or group in Proxmox"], ["properties", "Clear its properties (name, email)"], ["acl", "Remove its permissions"]].map(([v, l]) => (
              <label key={v} className="flex items-center gap-2 text-sm py-1"><input type="checkbox" className="h-4 w-4 accent-(--accent)" checked={vanished.includes(v)} onChange={() => toggleV(v)} />{l}</label>
            ))}
            <p className="text-xs text-ink-3 mt-1">Leave all off to keep everything and only add and update.</p>
          </fieldset>
          {error && <p role="alert" className="text-compact text-critical">{error}</p>}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-compact text-ink-2">{finished ? (ok ? (task.dryRun ? "Dry run finished. Nothing was changed." : "Sync finished.") : `It didn't finish: ${log.data?.exitstatus}`) : "Working…"}</p>
          {log.error && <p role="alert" className="text-compact text-critical">{errorText(log.error)}</p>}
          <pre aria-label="Sync log" className="rounded-lg bg-code border border-line p-3 text-xs font-mono whitespace-pre-wrap max-h-80 overflow-y-auto">{(log.data?.log ?? []).join("\n") || "Waiting for the first lines…"}</pre>
        </div>
      )}
    </Modal>
  );
}

export function RealmsTab() {
  const q = useQuery({ queryKey: KEY, queryFn: access.realms.list, retry: 1 });
  const [editing, setEditing] = useState<Realm | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<Realm | null>(null);
  const [pickType, setPickType] = useState(false);
  return (
    <QueryState query={q}>
      {q.data && (
        <>
          <SectionTitle action={q.data.canManage ? <Button variant="primary" onClick={() => setPickType(true)}><Plus className="h-4 w-4" />Add realm</Button> : undefined}>Realms</SectionTitle>
          {!q.data.canManage && <ReadOnlyNote what="change realms" />}
          {q.data.realms.length === 0 ? <EmptyState icon={<Globe className="h-5 w-5" />} title="No realms" body="Proxmox lists none for your account." /> : (
            <Table min="min-w-[760px]">
              <thead><tr className="border-b border-line"><Th>Realm</Th><Th>Type</Th><Th>Server</Th><Th>Two-factor</Th><Th /></tr></thead>
              <tbody>
                {q.data.realms.map((r) => (
                  <tr key={r.realm} className="border-b border-line last:border-0 hover:bg-surface-2/50">
                    <Td><button className="font-medium text-left hover:underline" onClick={() => setEditing(r)}>{r.realm}</button> {r.default && <Chip tone="accent">Default</Chip>}{r.comment && <div className="text-xs text-ink-3">{r.comment}</div>}</Td>
                    <Td>{TYPE_LABEL[r.type] ?? r.type}</Td>
                    <Td className="font-mono text-compact text-ink-2">{String(r.config.server1 ?? r.config["issuer-url"] ?? "")}</Td>
                    <Td>{r.tfa ? <Chip tone="good">Required: {r.tfa.replace(/^type=/, "").split(",")[0]}</Chip> : <span className="text-compact text-ink-3">Optional</span>}</Td>
                    <Td className="text-right whitespace-nowrap">{r.canSync && q.data.canManage && <Button size="sm" variant="ghost" onClick={() => setSyncing(r)}><RefreshCw className="h-4 w-4" />Sync</Button>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <p className="text-xs text-ink-3 mt-3">“Two-factor: Required” is Proxmox's realm-wide setting. Everyone signing in through that realm needs a second factor, on every Proxmox sign-in.</p>
          {pickType && (
            <Modal size="sm" title="Add a realm" subtitle="Where should people sign in from?" onClose={() => setPickType(false)}>
              <div className="space-y-2">
                {q.data.creatable.map((t) => <Button key={t} className="w-full justify-start" onClick={() => { setPickType(false); setAdding(t); }}>{TYPE_LABEL[t] ?? t}</Button>)}
              </div>
            </Modal>
          )}
          {adding && <RealmModal realm={null} type={adding} schema={q.data.schema[adding]} canManage onClose={() => setAdding(null)} />}
          {editing && <RealmModal realm={editing} type={editing.type} schema={q.data.schema[editing.type] ?? []} canManage={q.data.canManage} onClose={() => setEditing(null)} />}
          {syncing && <SyncModal realm={syncing} onClose={() => setSyncing(null)} />}
          {q.data.canManage && <SyncJobs syncableRealms={q.data.realms.filter((r) => r.canSync).map((r) => r.realm)} />}
        </>
      )}
    </QueryState>
  );
}
