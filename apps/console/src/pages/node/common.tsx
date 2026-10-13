import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { getSelectedNode, setSelectedNode, subscribeSelectedNode } from "../../lib/selectedNode.ts";
import { ListChecks, Loader2, Lock, Server, Square } from "lucide-react";
import { useEngine } from "../../data/store.tsx";
import { nodeApi, type FieldSchema, type Schema, type Values } from "../../data/engine/nodeApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { cn } from "../../lib/storage.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, EmptyState, Field, Input, Notice, Select, Skeleton, Textarea, Toggle } from "../../ui/primitives.tsx";

/* ── Live only ─────────────────────────────────────────────────────────────────────── */

/** These screens operate on a real device; the demo has none behind it. */
export function LiveOnly({ children }: { children: ReactNode }) {
  const { live } = useEngine();
  if (live) return <>{children}</>;
  return <EmptyState icon={<Server className="h-5 w-5" />} title="This works on a connected device" body="Sign in to a Proxmox device to manage its services, updates, certificates and datacenter settings. The demo has no device behind it." />;
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return <div className="space-y-3" aria-busy="true">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>;
}

/** A query's loading and error states; `children` renders once there is data. */
export function Async<T>({ q, children }: { q: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (q.isPending) return <Loading />;
  if (q.error) return <Notice tone="critical" title="Couldn't read this from the device">{errorText(q.error)}</Notice>;
  return <>{children(q.data as T)}</>;
}

export function Denied({ what }: { what: string }) {
  return <p className="text-compact text-ink-3 flex items-center gap-2"><Lock className="h-4 w-4" aria-hidden />Your Proxmox account can't see {what}.</p>;
}

/* ── The selected node ─────────────────────────────────────────────────────────────── */

/** The node the node screens work on. null means the device you signed in to. Changing it refetches everything. */
export function useSelectedNode(): [string | null, (n: string | null) => void] {
  const node = useSyncExternalStore(subscribeSelectedNode, getSelectedNode, () => null);
  const qc = useQueryClient();
  const set = useCallback((n: string | null) => {
    if (n === getSelectedNode()) return;
    setSelectedNode(n);
    void qc.invalidateQueries();
  }, [qc]);
  return [node, set];
}

export function useNodes() {
  const { live } = useEngine();
  return useQuery({ queryKey: ["node", "nodes"], queryFn: nodeApi.nodes, enabled: live, refetchInterval: 30_000, retry: 1 });
}

/** Shown in a page's header when the datacenter has more than one node. */
export function NodeSwitcher({ className }: { className?: string }) {
  const q = useNodes();
  const [node, setNode] = useSelectedNode();
  const nodes = q.data?.nodes ?? [];
  if (nodes.length < 2) return null;
  const current = node && nodes.some((n) => n.node === node) ? node : q.data!.local;
  return (
    <label className={cn("inline-flex items-center gap-2 text-compact text-ink-2", className)}>
      <Server className="h-4 w-4 text-ink-3" aria-hidden />
      <span className="sr-only">Node</span>
      <Select value={current} onChange={(e) => setNode(e.target.value === q.data!.local ? null : e.target.value)} className="w-44" aria-label="Node">
        {nodes.map((n) => <option key={n.node} value={n.node}>{n.node}{n.online ? "" : " (offline)"}</option>)}
      </Select>
    </label>
  );
}

/** The node name to pass to the host service (undefined for the device you signed in to) and the name to show. */
export function useNodeName() {
  const q = useNodes();
  const [node] = useSelectedNode();
  const { setup } = useEngine();
  const local = q.data?.local ?? setup?.deviceName ?? "pve";
  const current = node && q.data?.nodes.some((n) => n.node === node) ? node : local;
  return { node: current === local ? undefined : current, name: current, local, multi: (q.data?.nodes.length ?? 0) > 1 };
}

/* ── Tasks ─────────────────────────────────────────────────────────────────────────── */

export function TasksLink({ type, label = "Tasks" }: { type?: string; label?: string }) {
  const { setup } = useEngine();
  return (
    <Link to={`/${setup?.deviceName ?? "pve"}/tasks/all${type ? `?type=${encodeURIComponent(type)}` : ""}`} className="transition-control inline-flex items-center gap-2 h-10 px-3 rounded-lg text-compact text-ink-2 hover:text-ink hover:bg-surface-2">
      <ListChecks className="h-4 w-4" aria-hidden />{label}
    </Link>
  );
}

const taskTitle = (upid: string) => {
  const t = upid.split(":")[5] ?? "task";
  return t.replace(/^(.)/, (c) => c.toUpperCase());
};

/** One Proxmox task, followed while it runs. The log is read from where we got to, so it never re-downloads. */
export function TaskModal({ upid, title, onClose, onDone }: { upid: string; title?: string; onClose: () => void; onDone?: (exit: string | null) => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<{ running: boolean; exit: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const box = useRef<HTMLPreElement>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let next = 0;
    const load = async () => {
      try {
        const d = await nodeApi.task(upid, next);
        if (!alive) return;
        if (d.lines.length) setLines((l) => [...l, ...d.lines]);
        next = d.next;
        const running = d.status === "running";
        setStatus({ running, exit: d.exitstatus });
        if (running) timer = setTimeout(load, 1500);
        else done.current?.(d.exitstatus);
      } catch (e) {
        if (alive) setError(errorText(e));
      }
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [upid]);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines.length]);

  const stop = async () => {
    setStopping(true);
    try {
      await nodeApi.stopTask(upid);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStopping(false);
    }
  };
  const subtitle = !status ? "Loading…" : status.running ? "Running…" : status.exit === "OK" ? "Finished" : `Ended: ${status.exit ?? "unknown"}`;
  return (
    <Modal size="lg" icon={<ListChecks className="h-5 w-5" />} title={title ?? taskTitle(upid)} subtitle={subtitle} onClose={onClose}
      footer={<>{status?.running && <Button variant="danger" className="mr-auto" loading={stopping} onClick={stop}><Square className="h-4 w-4" />Stop task</Button>}<Button onClick={onClose}>Close</Button></>}>
      {error && <p role="alert" className="text-compact text-critical mb-2">{error}</p>}
      <pre ref={box} aria-label="Task log" className="rounded-lg bg-code border border-line p-3 text-xs leading-relaxed font-mono text-ink-2 max-h-[50vh] overflow-auto whitespace-pre-wrap break-all">{lines.length ? lines.join("\n") : status ? "(no output)" : "…"}</pre>
      <p className="text-micro text-ink-3 font-mono mt-2 break-all">{upid}</p>
    </Modal>
  );
}

/** Starts a task and shows it. `run` is what the page does (it returns the task id); `after` runs once the task ends. */
export function useTaskRunner(after?: (exit: string | null) => void) {
  const [open, setOpen] = useState<{ upid: string; title: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = useCallback(async (title: string, run: () => Promise<{ task: string }>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await run();
      setOpen({ upid: r.task, title });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, []);
  const modal = open ? <TaskModal upid={open.upid} title={open.title} onClose={() => setOpen(null)} onDone={after} /> : null;
  return { start, modal, error, busy, clearError: () => setError(null) };
}

/* ── Typed confirmation ────────────────────────────────────────────────────────────── */

/** Anything that interrupts or removes something: the person types the phrase before the button works. */
export function TypedConfirm({ title, subtitle, children, phrase, action, onConfirm, onClose, busy, error }: { title: string; subtitle?: string; children?: ReactNode; phrase: string; action: string; onConfirm: () => void; onClose: () => void; busy?: boolean; error?: string | null }) {
  const [typed, setTyped] = useState("");
  return (
    <Modal size="md" title={title} subtitle={subtitle} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={typed !== phrase} loading={busy} onClick={onConfirm}>{action}</Button></>}>
      <div className="space-y-4">
        {children}
        <Field label={<>Type <span className="font-mono text-ink">{phrase}</span> to confirm</>}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" spellCheck={false} autoComplete="off" autoFocus />
        </Field>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

/* ── Forms from Proxmox's parameter definitions ────────────────────────────────────── */

export const humanize = (key: string) => {
  const s = key.replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const MULTILINE = new Set(["description", "body"]);

function Leaf({ name, field, value, onChange, disabled, id }: { name: string; field: FieldSchema; value: unknown; onChange: (v: unknown) => void; disabled?: boolean; id: string }) {
  if (field.type === "boolean") return <Toggle checked={value === true} onChange={onChange} label={humanize(name)} disabled={disabled} />;
  if (field.enum) {
    return (
      <Select id={id} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} disabled={disabled}>
        <option value="">{field.default !== undefined ? `Default (${String(field.default)})` : "Not set"}</option>
        {field.enum.map((o) => <option key={o} value={o}>{o}</option>)}
      </Select>
    );
  }
  if (field.type === "integer" || field.type === "number") {
    return <Input id={id} type="number" inputMode="numeric" min={field.min} max={field.max} value={typeof value === "number" ? value : ""} placeholder={field.default !== undefined ? String(field.default) : undefined} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} disabled={disabled} className="tabular-nums" />;
  }
  if (field.type === "array") {
    const list = Array.isArray(value) ? (value as string[]) : [];
    return <Textarea id={id} value={list.join("\n")} rows={3} onChange={(e) => onChange(e.target.value.split("\n").map((x) => x.trim()).filter(Boolean))} disabled={disabled} className="font-mono" spellCheck={false} />;
  }
  if (MULTILINE.has(name)) return <Textarea id={id} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} disabled={disabled} />;
  return <Input id={id} type={field.secret ? "password" : "text"} autoComplete={field.secret ? "new-password" : "off"} value={typeof value === "string" ? value : ""} placeholder={field.secret ? "Leave blank to keep what is set" : field.default !== undefined ? String(field.default) : undefined} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} disabled={disabled} className={field.format || field.maxLength ? "font-mono" : undefined} spellCheck={false} />;
}

/**
 * Renders settings from the definitions Proxmox publishes for them: toggles for flags, lists for choices, number
 * boxes with their limits, and a group of boxes for settings that Proxmox stores as one comma-separated string.
 */
export function SchemaForm({ schema, value, onChange, only, labels, hints, disabled }: { schema: Schema; value: Values; onChange: (v: Values) => void; only?: string[]; labels?: Record<string, string>; hints?: Record<string, string>; disabled?: boolean }) {
  const keys = (only ?? Object.keys(schema)).filter((k) => schema[k]);
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  return (
    <div className="space-y-5">
      {keys.map((k) => {
        const f = schema[k];
        const id = `sf-${k}`;
        const label = labels?.[k] ?? humanize(k);
        const hint = hints?.[k] ?? f.description;
        if (f.type === "boolean") {
          return (
            <div key={k} className="flex items-start gap-3">
              <Toggle checked={value[k] === true} onChange={(v) => set(k, v)} label={label} disabled={disabled} />
              <div className="min-w-0"><div className="text-compact font-medium text-ink-2">{label}</div>{hint && <p className="text-xs text-ink-3 mt-0.5">{hint}</p>}</div>
            </div>
          );
        }
        if (f.props) {
          const obj = (value[k] && typeof value[k] === "object" ? value[k] : {}) as Values;
          const setSub = (sk: string, sv: unknown) => {
            const next = { ...obj, [sk]: sv };
            for (const x of Object.keys(next)) if (next[x] === undefined || next[x] === "") delete next[x];
            set(k, Object.keys(next).length ? next : undefined);
          };
          return (
            <fieldset key={k} className="rounded-lg border border-line p-4 min-w-0">
              <legend className="px-1 text-compact font-medium text-ink-2">{label}</legend>
              {hint && <p className="text-xs text-ink-3 mb-3">{hint}</p>}
              <div className="grid sm:grid-cols-2 gap-4">
                {Object.entries(f.props).map(([sk, sf]) => (
                  <Field key={sk} label={humanize(sk)} hint={sf.description} htmlFor={`${id}-${sk}`}>
                    {sf.type === "boolean" ? <Toggle checked={obj[sk] === true} onChange={(v) => setSub(sk, v)} label={humanize(sk)} disabled={disabled} /> : <Leaf id={`${id}-${sk}`} name={sk} field={sf} value={obj[sk]} onChange={(v) => setSub(sk, v)} disabled={disabled} />}
                  </Field>
                ))}
              </div>
            </fieldset>
          );
        }
        return (
          <Field key={k} label={f.required ? <>{label} <span className="text-ink-3 font-normal">(required)</span></> : label} hint={f.type === "array" ? `${hint} One per line.` : hint} htmlFor={id}>
            <Leaf id={id} name={k} field={f} value={value[k]} onChange={(v) => set(k, v)} disabled={disabled} />
          </Field>
        );
      })}
    </div>
  );
}

/** What changed between the values read and the values edited, as the host service wants it: cleared settings are null. */
export function changedValues(before: Values, after: Values, keys: string[]): Values {
  const out: Values = {};
  for (const k of keys) {
    const a = JSON.stringify(before[k] ?? null);
    const b = JSON.stringify(after[k] ?? null);
    if (a !== b) out[k] = after[k] === undefined || after[k] === "" || (Array.isArray(after[k]) && (after[k] as unknown[]).length === 0) ? null : after[k];
  }
  return out;
}

export function SaveBar({ dirty, busy, onSave, onReset, error, saved }: { dirty: boolean; busy: boolean; onSave: () => void; onReset: () => void; error: string | null; saved: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3 mt-6">
      <Button variant="primary" disabled={!dirty} loading={busy} onClick={onSave}>Save changes</Button>
      <Button variant="ghost" disabled={!dirty || busy} onClick={onReset}>Discard changes</Button>
      {saved && !dirty && <span className="text-compact text-good">Saved</span>}
      {error && <p role="alert" className="text-compact text-critical">{error}</p>}
    </div>
  );
}

export const Spin = () => <Loader2 className="h-4 w-4 animate-spin" aria-hidden />;

/**
 * Create or edit one named object (a notification target, a matcher, a metric server) from its definition.
 * On edit only what changed is sent, and settings that hold secrets stay blank unless something is typed.
 */
export function ObjectModal({ title, subtitle, schema, only, initial, nameLabel, name: fixedName, hints, extra, onSubmit, onClose, submitLabel }: { title: string; subtitle?: string; schema: Schema; only?: string[]; initial: Values; nameLabel: string; name: string | null; hints?: Record<string, string>; extra?: ReactNode; onSubmit: (name: string, values: Values) => Promise<unknown>; onClose: () => void; submitLabel: string }) {
  const creating = fixedName === null;
  const [name, setName] = useState(fixedName ?? "");
  const [value, setValue] = useState<Values>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = (only ?? Object.keys(schema)).filter((k) => schema[k]);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name, creating ? Object.fromEntries(keys.filter((k) => value[k] !== undefined && value[k] !== "").map((k) => [k, value[k]])) : changedValues(initial, value, keys));
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal size="lg" title={title} subtitle={subtitle} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={creating && !/^[A-Za-z][A-Za-z0-9_-]+$/.test(name)} onClick={() => void go()}>{submitLabel}</Button></>}>
      <div className="space-y-5">
        {creating && <Field label={nameLabel} hint="Letters, numbers, - and _. It can't be changed later." htmlFor="obj-name"><Input id="obj-name" value={name} onChange={(e) => setName(e.target.value)} className="font-mono" autoFocus /></Field>}
        {extra}
        <SchemaForm schema={schema} value={value} onChange={setValue} only={keys} hints={hints} />
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}
