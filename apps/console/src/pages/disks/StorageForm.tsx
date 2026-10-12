import { useMemo, useState } from "react";
import { Database, Search } from "lucide-react";
import { CONTENT_LABELS, STORAGE_DEFS, STORAGE_ID_HINT, STORAGE_ID_RE, buildStorageParams, parseBwlimit, storageDef, type BwLimit, type PruneSettings, type StorageField, type StorageTypeDef } from "@papercliped-engine/proxmox-client/storage-schema";
import { errorText, useDisksApi, type ScanKind, type StorageDef } from "../../data/engine/disks.ts";
import { useEngine } from "../../data/store.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Field, Input, Notice, Select } from "../../ui/primitives.tsx";
import { Check } from "./common.tsx";

/** The field a scan fills in, and what to show for each result. */
const SCAN_FILLS: Record<ScanKind, { fills: string; value: (r: Record<string, string>) => string; label: (r: Record<string, string>) => string }> = {
  nfs: { fills: "export", value: (r) => r.path, label: (r) => `${r.path}${r.options ? ` (${r.options})` : ""}` },
  cifs: { fills: "share", value: (r) => r.share, label: (r) => `${r.share}${r.description ? ` · ${r.description}` : ""}` },
  pbs: { fills: "datastore", value: (r) => r.store, label: (r) => `${r.store}${r.comment ? ` · ${r.comment}` : ""}` },
  iscsi: { fills: "target", value: (r) => r.target, label: (r) => r.target },
  lvm: { fills: "vgname", value: (r) => r.vg, label: (r) => r.vg },
  lvmthin: { fills: "thinpool", value: (r) => r.lv, label: (r) => r.lv },
  zfs: { fills: "pool", value: (r) => r.pool, label: (r) => r.pool },
};

type Values = Record<string, string | boolean>;

const emptyPrune = (): PruneSettings => ({ keepAll: false, keepLast: null, keepHourly: null, keepDaily: null, keepWeekly: null, keepMonthly: null, keepYearly: null });
const PRUNE_ROWS: [keyof PruneSettings, string][] = [["keepLast", "Last"], ["keepHourly", "Hourly"], ["keepDaily", "Daily"], ["keepWeekly", "Weekly"], ["keepMonthly", "Monthly"], ["keepYearly", "Yearly"]];
const BW_ROWS: [keyof BwLimit, string, string][] = [["default", "Everything", "Applies to any operation without its own limit."], ["restore", "Restores", "Restoring backups to this storage."], ["move", "Moving disks", "Moving a disk onto or off this storage."], ["clone", "Cloning", "Cloning disks."], ["migration", "Migration", "Migrating machines, including local disks."]];
const numOrNull = (v: string): number | null => (v.trim() === "" ? null : Number(v));

/** Types as cards, like Proxmox's "Add" menu, with a sentence on what each one is for. */
function TypePicker({ onPick }: { onPick: (d: StorageTypeDef) => void }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {STORAGE_DEFS.map((d) => (
        <button key={d.type} type="button" onClick={() => onPick(d)} className="text-left">
          <Card interactive className="p-4 h-full">
            <div className="font-medium">{d.label}</div>
            <p className="text-compact text-ink-3 mt-1 text-pretty">{d.summary}</p>
          </Card>
        </button>
      ))}
    </div>
  );
}

/** Add or edit one storage definition. The fields come from the shared schema, so this is the same list Proxmox offers. */
export function StorageFormModal({ existing, onClose, onDone }: { existing: StorageDef | null; onClose: () => void; onDone: () => void }) {
  const [def, setDef] = useState<StorageTypeDef | null>(existing ? storageDef(existing.type) ?? null : null);
  if (!def) return <Modal size="lg" icon={<Database className="h-5 w-5" />} title="Add storage" subtitle="What kind of storage is it?" onClose={onClose} footer={<Button variant="ghost" onClick={onClose}>Cancel</Button>}><TypePicker onPick={setDef} /></Modal>;
  return <FormBody def={def} existing={existing} back={existing ? undefined : () => setDef(null)} onClose={onClose} onDone={onDone} />;
}

function initialValues(def: StorageTypeDef, existing: StorageDef | null): Values {
  const v: Values = {};
  for (const f of def.fields) {
    const cur = existing?.config[f.key];
    if (f.kind === "bool") v[f.key] = cur === 1 || cur === true || cur === "1";
    else v[f.key] = cur === undefined || cur === null ? "" : String(cur);
  }
  return v;
}

function FormBody({ def, existing, back, onClose, onDone }: { def: StorageTypeDef; existing: StorageDef | null; back?: () => void; onClose: () => void; onDone: () => void }) {
  const api = useDisksApi();
  const engine = useEngine();
  const creating = !existing;
  const [id, setId] = useState(existing?.id ?? "");
  const [values, setValues] = useState<Values>(() => initialValues(def, existing));
  const [content, setContent] = useState<string[]>(existing?.content ?? def.defaultContent);
  const [nodes, setNodes] = useState((existing?.nodes ?? []).join(", "));
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [shared, setShared] = useState(existing ? existing.shared : false);
  const [prune, setPrune] = useState<PruneSettings>(existing?.prune ?? emptyPrune());
  const [bw, setBw] = useState<BwLimit>(existing?.bwlimit ?? parseBwlimit(null));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);

  const input = useMemo(() => {
    const body: Record<string, unknown> = {};
    for (const f of def.fields) {
      if (f.createOnly && !creating) continue;
      const v = values[f.key];
      if (f.kind === "bool") {
        if (v === true || !creating) body[f.key] = v === true;
      } else if (v !== "" && v !== undefined) body[f.key] = f.kind === "int" ? Number(v) : v;
      else if (!creating && !f.secret) body[f.key] = "";
    }
    body.content = content;
    body.nodes = nodes.split(/[\s,;]+/).filter(Boolean);
    if (def.canShare) body.shared = shared;
    if (!enabled || !creating) body.disable = !enabled;
    if (def.prune) body["prune-backups"] = prune.keepAll || PRUNE_ROWS.some(([k]) => prune[k] !== null) ? prune : creating ? undefined : null;
    if (def.bwlimit) body.bwlimit = Object.values(bw).some((x) => x !== null) ? bw : creating ? undefined : null;
    return body;
  }, [def, values, content, nodes, shared, enabled, prune, bw, creating]);

  const check = useMemo(() => buildStorageParams(def, input, creating), [def, input, creating]);
  const issue = (key: string) => check.issues.find((i) => i.field === key)?.message;
  const idErr = creating && id && !STORAGE_ID_RE.test(id) ? STORAGE_ID_HINT : null;
  const valid = check.issues.length === 0 && (!creating || (!!id && !idErr));
  const set = (k: string, v: string | boolean) => setValues((s) => ({ ...s, [k]: v }));

  const save = async () => {
    setTried(true);
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      if (creating) await api.createStorage({ ...input, type: def.type, storage: id });
      else await api.updateStorage(existing.id, { ...input, digest: existing.digest });
      onDone();
      onClose();
    } catch (e) {
      setError(errorText(e, "Couldn't save it"));
      setBusy(false);
    }
  };

  const basic = def.fields.filter((f) => !f.advanced);
  const advanced = def.fields.filter((f) => f.advanced);
  const render = (f: StorageField) => {
    const locked = !creating && f.createOnly;
    const err = tried || values[f.key] !== "" ? issue(f.key) : undefined;
    const id = `sf-${f.key}`;
    if (f.kind === "bool") return <Check key={f.key} checked={values[f.key] === true} onChange={(v) => set(f.key, v)} label={f.label} hint={f.help} disabled={locked} />;
    const stored = f.secret && existing?.secretsSet.includes(f.key);
    const control = f.kind === "enum" ? (
      <Select id={id} value={String(values[f.key])} disabled={locked} onChange={(e) => set(f.key, e.target.value)}>
        <option value="">{f.required ? "Choose…" : "Default"}</option>
        {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    ) : (
      <Input id={id} type={f.secret ? "password" : f.kind === "int" ? "number" : "text"} value={String(values[f.key])} disabled={locked} min={f.min} max={f.max} onChange={(e) => set(f.key, e.target.value)} placeholder={stored ? "Stored. Leave empty to keep it." : f.placeholder} autoComplete={f.secret ? "new-password" : "off"} spellCheck={false} className={f.secret || f.kind !== "string" ? "" : "font-mono"} />
    );
    return (
      <div key={f.key} className="space-y-2">
        <Field label={<>{f.label}{!f.required && <span className="text-ink-3 font-normal"> (optional)</span>}</>} error={err} hint={locked ? "Fixed when the storage was created." : f.help} htmlFor={id}>{control}</Field>
        {f.scan && !locked && <ScanPicker kind={f.scan} values={values} def={def} onPick={(k, v) => set(k, v)} />}
      </div>
    );
  };

  return (
    <Modal
      size="lg"
      icon={<Database className="h-5 w-5" />}
      title={creating ? `Add ${def.label}` : `Edit ${existing.id}`}
      subtitle={creating ? def.summary : `${def.label}. Changes apply to every device that uses it.`}
      onClose={onClose}
      footer={<>{back && <Button variant="ghost" onClick={back} className="mr-auto">Change type</Button>}<Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={busy} disabled={tried && !valid}>{creating ? "Add storage" : "Save changes"}</Button></>}
    >
      <div className="space-y-5">
        {creating && (
          <Field label="Name" hint="What the storage is called in Proxmox. Can't be changed later." error={tried || id ? idErr ?? (tried && !id ? "Give the storage a name" : undefined) : undefined} htmlFor="sf-id">
            <Input id="sf-id" value={id} onChange={(e) => setId(e.target.value)} className="font-mono" autoComplete="off" placeholder="backup-nas" />
          </Field>
        )}
        {basic.map(render)}

        <fieldset>
          <legend className="text-compact font-medium text-ink-2 mb-2">What it holds</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5">
            {def.contents.map((c) => (
              <Check key={c} checked={content.includes(c)} onChange={(on) => setContent((l) => (on ? [...l, c] : l.filter((x) => x !== c)))} label={CONTENT_LABELS[c].label} hint={CONTENT_LABELS[c].help} />
            ))}
          </div>
          {(tried || content.length === 0) && issue("content") && <p role="alert" className="text-xs text-critical mt-1.5">{issue("content")}</p>}
        </fieldset>

        {def.prune && (
          <fieldset>
            <legend className="text-compact font-medium text-ink-2 mb-1">Keep backups</legend>
            <p className="text-xs text-ink-3 mb-2">Older backups beyond these are removed when the next backup runs. Leave everything empty to keep all of them.</p>
            <Check checked={prune.keepAll} onChange={(v) => setPrune({ ...emptyPrune(), keepAll: v })} label="Keep every backup" hint="Never remove backups automatically." />
            {!prune.keepAll && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3">
                {PRUNE_ROWS.map(([k, label]) => (
                  <Field key={k} label={label} htmlFor={`sf-prune-${k}`}><Input id={`sf-prune-${k}`} type="number" min={1} value={prune[k] === null ? "" : String(prune[k])} onChange={(e) => setPrune((p) => ({ ...p, [k]: numOrNull(e.target.value) }))} placeholder="None" /></Field>
                ))}
              </div>
            )}
            {issue("prune-backups") && <p role="alert" className="text-xs text-critical mt-1.5">{issue("prune-backups")}</p>}
          </fieldset>
        )}

        <div className="flex flex-wrap gap-x-8 gap-y-3">
          <Check checked={enabled} onChange={setEnabled} label="Enabled" hint="Turn off to keep the settings but stop using the storage." />
          {def.canShare && <Check checked={shared} onChange={setShared} label="Shared" hint="Every device sees the same files (set this for storage that really is shared, such as a mounted network share)." />}
          {def.alwaysShared && <span className="text-xs text-ink-3 self-center">{def.label} is shared by nature.</span>}
        </div>

        <Field label="Only on these devices" hint="Comma separated device names. Leave empty for every device." htmlFor="sf-nodes">
          <Input id="sf-nodes" value={nodes} onChange={(e) => setNodes(e.target.value)} placeholder={engine.setup?.deviceName ?? "pve"} autoComplete="off" className="font-mono" />
        </Field>
        {issue("nodes") && <p role="alert" className="text-xs text-critical -mt-3">{issue("nodes")}</p>}

        {(advanced.length > 0 || def.bwlimit) && (
          <div>
            <Button variant="ghost" size="sm" onClick={() => setMore((m) => !m)} aria-expanded={more}>{more ? "Fewer options" : "More options"}</Button>
            {more && (
              <div className="space-y-4 mt-3">
                {advanced.map(render)}
                {def.bwlimit && (
                  <fieldset>
                    <legend className="text-compact font-medium text-ink-2 mb-1">Speed limits</legend>
                    <p className="text-xs text-ink-3 mb-2">Caps how fast this storage is read or written, in MiB per second, so a big copy can't starve running machines. Empty means no limit.</p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {BW_ROWS.map(([k, label, help]) => (
                        <Field key={k} label={label} hint={help} htmlFor={`sf-bw-${k}`}>
                          <Input id={`sf-bw-${k}`} type="number" min={0} value={bw[k] === null ? "" : String(Math.round(bw[k]! / 1024))} onChange={(e) => setBw((b) => ({ ...b, [k]: e.target.value.trim() === "" ? null : Number(e.target.value) * 1024 }))} placeholder="Unlimited" />
                        </Field>
                      ))}
                    </div>
                    {issue("bwlimit") && <p role="alert" className="text-xs text-critical mt-1.5">{issue("bwlimit")}</p>}
                  </fieldset>
                )}
              </div>
            )}
          </div>
        )}
        {check.issues.filter((i) => !def.fields.some((f) => f.key === i.field) && !["content", "nodes", "prune-backups", "bwlimit"].includes(i.field)).map((i) => <p key={i.field} role="alert" className="text-xs text-critical">{i.message}</p>)}
        {error && <Notice tone="critical" title="Proxmox didn't accept that">{error}</Notice>}
      </div>
    </Modal>
  );
}

/** Asks the device what exists (shares, datastores, targets, pools) and offers the answers as a list to choose from. */
function ScanPicker({ kind, values, def, onPick }: { kind: ScanKind; values: Values; def: StorageTypeDef; onPick: (key: string, value: string) => void }) {
  const api = useDisksApi();
  const meta = SCAN_FILLS[kind];
  const [items, setItems] = useState<Record<string, string>[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = (): Record<string, unknown> | string => {
    const s = (k: string) => String(values[k] ?? "");
    if (kind === "nfs") return s("server") ? { server: s("server") } : "Enter the server's address first.";
    if (kind === "cifs") return s("server") ? { server: s("server"), username: s("username") || undefined, password: s("password") || undefined, domain: s("domain") || undefined } : "Enter the server's address first.";
    if (kind === "pbs") return s("server") && s("username") && s("password") ? { server: s("server"), username: s("username"), password: s("password"), fingerprint: s("fingerprint") || undefined, port: s("port") ? Number(s("port")) : undefined } : "Enter the server, username and password first.";
    if (kind === "iscsi") return s("portal") ? { portal: s("portal") } : "Enter the portal's address first.";
    if (kind === "lvmthin") return s("vgname") ? { vg: s("vgname") } : "Pick the volume group first.";
    return {};
  };
  const scan = async () => {
    const b = body();
    if (typeof b === "string") return setError(b);
    setBusy(true);
    setError(null);
    try {
      const r = await api.scan(kind, b);
      setItems(r);
      if (r.length === 0) setError("Nothing found.");
    } catch (e) {
      setItems(null);
      setError(errorText(e, "Couldn't scan"));
    }
    setBusy(false);
  };
  const noun = { nfs: "exports", cifs: "shares", pbs: "datastores", iscsi: "targets", lvm: "volume groups", lvmthin: "thin pools", zfs: "pools" }[kind];
  void def;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" onClick={scan} loading={busy}><Search className="h-3.5 w-3.5" />Find {noun}</Button>
      {items && items.length > 0 && (
        <Select aria-label={`Found ${noun}`} className="h-8 w-auto max-w-full" defaultValue="" onChange={(e) => e.target.value && onPick(meta.fills, e.target.value)}>
          <option value="">Pick one of {items.length}…</option>
          {items.map((r) => <option key={meta.value(r)} value={meta.value(r)}>{meta.label(r)}</option>)}
        </Select>
      )}
      {error && <span role="alert" className="text-xs text-critical">{error}</span>}
    </div>
  );
}

