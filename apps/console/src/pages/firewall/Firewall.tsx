import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowDown, ArrowUp, Layers, ListFilter, Loader2, Pencil, Plus, ScrollText, Shield, ShieldAlert, ShieldCheck, Tag, Trash2 } from "lucide-react";
import { ApiError, type FwRule, type FwRuleSpec } from "../../data/api.ts";
import { useEngine } from "../../data/store.tsx";
import { cn } from "../../lib/storage.ts";
import { usePinActions } from "../../pin/PinContext.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, EmptyState, Input, PageFrame, PageHeader, Segmented, Status, Toggle, selectClass } from "../../ui/primitives.tsx";

const select = selectClass;
const ACTION_STYLE: Record<string, string> = { ACCEPT: "text-good", DROP: "text-critical", REJECT: "text-warning" };

/**
 * Runs a firewall change. If the host service says it would lock this console out, asks what to do and retries with
 * the choice: add a rule that keeps the console reachable (recommended), or go ahead anyway.
 */
function useLockoutGuard() {
  const [pending, setPending] = useState<{ message: string; retry: (extra: Record<string, boolean>) => Promise<void> } | null>(null);
  const run = useCallback(async (fn: (extra: Record<string, boolean>) => Promise<unknown>, onError: (m: string) => void) => {
    try {
      await fn({});
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === "lockout") {
        setPending({ message: e.message, retry: async (extra) => void (await fn(extra)) });
        return false;
      }
      onError(e instanceof ApiError ? e.message : "Proxmox refused that");
      return false;
    }
  }, []);
  const modal = pending && (
    <LockoutModal
      message={pending.message}
      onCancel={() => setPending(null)}
      onChoose={async (extra) => {
        const p = pending;
        setPending(null);
        await p.retry(extra);
      }}
    />
  );
  return { run, modal };
}

function LockoutModal({ message, onCancel, onChoose }: { message: string; onCancel: () => void; onChoose: (extra: Record<string, boolean>) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const choose = async (extra: Record<string, boolean>) => {
    setBusy(true);
    await onChoose(extra).catch(() => undefined);
  };
  return (
    <Modal size="sm" icon={<ShieldAlert className="h-5 w-5 text-warning" />} title="This could lock you out" subtitle={message} onClose={onCancel} footer={<><Button variant="ghost" onClick={onCancel}>Cancel</Button><Button variant="danger" onClick={() => choose({ ignoreLockout: true })} disabled={busy}>Continue anyway</Button><Button variant="primary" onClick={() => choose({ keepConsole: true })} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}Keep this console reachable</Button></>}>
      <p className="text-compact text-ink-3">Proxmox keeps its own interface on :8006 and SSH reachable from the local network, but not ePaperclip. The recommended choice adds one host rule that lets the console's port in.</p>
    </Modal>
  );
}

const describeRule = (r: FwRule) => {
  if (r.type === "group") return `Security group ${r.action}`;
  const what = r.macro ? r.macro : r.proto ? `${r.proto.toUpperCase()}${r.dport ? ` ${r.dport}` : ""}` : "Everything";
  return what;
};

/** A firewall's rules, in order: top to bottom, the first match wins. */
export function RulesTable({ scope, title, note }: { scope: string; title?: string; note?: ReactNode }) {
  const engine = useEngine();
  const [rules, setRules] = useState<FwRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<FwRule | "new" | null>(null);
  const [removing, setRemoving] = useState<FwRule | null>(null);
  const guard = useLockoutGuard();
  const reload = () => setTick((n) => n + 1);

  useEffect(() => {
    let alive = true;
    engine.backend.firewallGet<{ rules: FwRule[] }>(scope, "rules").then((r) => alive && (setRules(r.rules), setError(null)), (e) => alive && setError(e instanceof ApiError ? e.message : "Couldn't read the rules"));
    return () => {
      alive = false;
    };
  }, [scope, engine.backend, tick]);

  const toggle = (r: FwRule) => guard.run((extra) => engine.backend.firewallPost(scope, `rules/${r.pos}`, { enable: !r.enable, ...extra }), setError).then(reload);
  const move = (r: FwRule, to: number) => guard.run(() => engine.backend.firewallPost(scope, `rules/${r.pos}`, { moveto: to }), setError).then(reload);
  const remove = (r: FwRule) => guard.run((extra) => engine.backend.firewallPost(scope, `rules/${r.pos}/delete`, extra), setError).then(() => { setRemoving(null); reload(); });

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-2">
        <div>{title && <h2 className="font-medium">{title}</h2>}{note && <p className="text-xs text-ink-3">{note}</p>}</div>
        <Button size="sm" variant="primary" onClick={() => setEditing("new")}><Plus className="h-3.5 w-3.5" />Add rule</Button>
      </div>
      {error && <p role="alert" className="text-compact text-critical mb-2">{error}</p>}
      <Card className="overflow-x-auto">
        {rules === null && !error ? (
          <div className="p-6 text-center text-ink-3 text-sm"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Reading rules…</div>
        ) : !rules?.length ? (
          <EmptyState icon={<ListFilter className="h-5 w-5" />} title="No rules" body="With no rules, the default policy decides. Add rules for the traffic you want to let in." action={<Button onClick={() => setEditing("new")}><Plus className="h-4 w-4" />Add rule</Button>} />
        ) : (
          <table className="w-full text-compact min-w-[760px]">
            <thead>
              <tr className="border-b border-line text-ink-3 text-left">
                <th className="font-normal px-3 h-10 w-12">On</th>
                <th className="font-normal px-3">Direction</th>
                <th className="font-normal px-3">Action</th>
                <th className="font-normal px-3">Service</th>
                <th className="font-normal px-3">From</th>
                <th className="font-normal px-3">To</th>
                <th className="font-normal px-3">Comment</th>
                <th className="px-3 w-[1%]"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r, i) => (
                <tr key={`${r.pos}-${r.comment}-${r.action}`} className={cn("border-b border-line last:border-0 hover:bg-surface-2/50", !r.enable && "opacity-50")}>
                  <td className="px-3 py-2"><Toggle checked={r.enable} onChange={() => toggle(r)} label={`${r.enable ? "Disable" : "Enable"} rule ${i + 1}`} /></td>
                  <td className="px-3 uppercase text-xs tracking-wide text-ink-2">{r.type === "group" ? "Group" : r.type}</td>
                  <td className={cn("px-3 font-medium", ACTION_STYLE[r.action] ?? "text-ink")}>{r.type === "group" ? <span className="inline-flex items-center gap-1.5"><Layers className="h-3.5 w-3.5" />{r.action}</span> : r.action}</td>
                  <td className="px-3 font-mono text-xs">{describeRule(r)}{r.log && r.log !== "nolog" ? <Chip className="ml-2">log {r.log}</Chip> : null}</td>
                  <td className="px-3 font-mono text-xs">{r.source ?? <span className="text-ink-3">anywhere</span>}</td>
                  <td className="px-3 font-mono text-xs">{r.dest ?? <span className="text-ink-3">anywhere</span>}</td>
                  <td className="px-3 text-ink-2 truncate max-w-[220px]">{r.comment ?? ""}</td>
                  <td className="px-3 whitespace-nowrap text-right">
                    <button onClick={() => move(r, r.pos - 1)} disabled={i === 0} aria-label="Move up" className="h-8 w-8 rounded-md inline-flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2 disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
                    <button onClick={() => move(r, r.pos + 1)} disabled={i === rules.length - 1} aria-label="Move down" className="h-8 w-8 rounded-md inline-flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2 disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
                    <button onClick={() => setEditing(r)} aria-label="Edit rule" className="h-8 w-8 rounded-md inline-flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2"><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => setRemoving(r)} aria-label="Delete rule" className="h-8 w-8 rounded-md inline-flex items-center justify-center text-ink-3 hover:text-critical hover:bg-critical/10"><Trash2 className="h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <p className="text-xs text-ink-3 mt-2">Rules are checked from the top; the first one that matches decides.</p>
      {editing && <RuleModal scope={scope} rule={editing === "new" ? null : editing} onClose={() => setEditing(null)} onDone={reload} />}
      {removing && (
        <Modal size="sm" title="Delete this rule?" subtitle={`${removing.type.toUpperCase()} ${removing.action} ${describeRule(removing)}${removing.comment ? ` · ${removing.comment}` : ""}`} onClose={() => setRemoving(null)} footer={<><Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button><Button variant="danger" onClick={() => remove(removing)}><Trash2 className="h-4 w-4" />Delete</Button></>}>
          <div />
        </Modal>
      )}
      {guard.modal}
    </div>
  );
}

function RuleModal({ scope, rule, onClose, onDone }: { scope: string; rule: FwRule | null; onClose: () => void; onDone: () => void }) {
  const engine = useEngine();
  const [type, setType] = useState<FwRule["type"]>(rule?.type ?? "in");
  const [action, setAction] = useState(rule?.action ?? "ACCEPT");
  const [how, setHow] = useState<"macro" | "ports" | "all">(rule?.macro ? "macro" : rule?.proto ? "ports" : rule ? "all" : "macro");
  const [macro, setMacro] = useState(rule?.macro ?? "SSH");
  const [proto, setProto] = useState(rule?.proto ?? "tcp");
  const [dport, setDport] = useState(rule?.dport ?? "");
  const [source, setSource] = useState(rule?.source ?? "");
  const [dest, setDest] = useState(rule?.dest ?? "");
  const [iface, setIface] = useState(rule?.iface ?? "");
  const [log, setLog] = useState(rule?.log ?? "nolog");
  const [comment, setComment] = useState(rule?.comment ?? "");
  const [enable, setEnable] = useState(rule?.enable ?? true);
  const [macros, setMacros] = useState<{ macro: string; descr: string }[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [refs, setRefs] = useState<{ ref: string; name: string; type: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guard = useLockoutGuard();
  const isGroupScope = scope.startsWith("group-");

  useEffect(() => {
    engine.backend.firewallGet<{ macros: { macro: string; descr: string }[] }>("datacenter", "macros").then((r) => setMacros(r.macros), () => setMacros([]));
    engine.backend.firewallGet<{ groups: { group: string }[] }>("datacenter", "groups").then((r) => setGroups(r.groups.map((g) => g.group)), () => setGroups([]));
    const refScope = scope.startsWith("guest-") ? scope : "datacenter";
    engine.backend.firewallGet<{ refs: { ref: string; name: string; type: string }[] }>(refScope, "refs").then((r) => setRefs(r.refs), () => setRefs([]));
  }, [engine.backend, scope]);

  const save = async () => {
    setBusy(true);
    setError(null);
    const spec: FwRuleSpec = { type, action: type === "group" ? action : action, enable, macro: type !== "group" && how === "macro" ? macro : null, proto: type !== "group" && how === "ports" ? proto : null, dport: type !== "group" && how === "ports" && dport.trim() ? dport.trim() : null, sport: null, source: type !== "group" && source.trim() ? source.trim() : null, dest: type !== "group" && dest.trim() ? dest.trim() : null, iface: iface.trim() || null, log: type !== "group" && log !== "nolog" ? log : null, comment: comment.trim() || null };
    const ok = await guard.run((extra) => engine.backend.firewallPost(scope, rule ? `rules/${rule.pos}` : "rules", { ...spec, ...extra }), setError);
    setBusy(false);
    if (ok) {
      onDone();
      onClose();
    }
  };
  useEffect(() => {
    if (type === "group" && !groups.includes(action)) setAction(groups[0] ?? "");
    if (type !== "group" && !["ACCEPT", "DROP", "REJECT"].includes(action)) setAction("ACCEPT");
  }, [type, groups]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal size="lg" icon={<ListFilter className="h-5 w-5" />} title={rule ? "Edit rule" : "Add a rule"} subtitle="What traffic, from where, and what happens to it." onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy || (type === "group" && !action)}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{rule ? "Save" : "Add rule"}</Button></>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented value={type} onChange={setType} options={[{ value: "in", label: "Incoming" }, { value: "out", label: "Outgoing" }, ...(isGroupScope ? [] : [{ value: "group" as const, label: "Security group" }])]} />
          {type !== "group" && <Segmented value={action} onChange={setAction} options={[{ value: "ACCEPT", label: "Allow" }, { value: "DROP", label: "Drop" }, { value: "REJECT", label: "Reject" }]} />}
        </div>
        {type === "group" ? (
          <label className="block"><span className="block text-compact text-ink-2 mb-2">Group</span>{groups.length ? <select value={action} onChange={(e) => setAction(e.target.value)} className={select}>{groups.map((g) => <option key={g}>{g}</option>)}</select> : <p className="text-compact text-ink-3">No security groups yet. Create one on the Security groups tab.</p>}</label>
        ) : (
          <>
            <fieldset>
              <legend className="text-compact text-ink-2 mb-2">Traffic</legend>
              <Segmented size="sm" value={how} onChange={setHow} options={[{ value: "macro", label: "A service" }, { value: "ports", label: "Protocol and port" }, { value: "all", label: "Everything" }]} />
              {how === "macro" && <select value={macro} onChange={(e) => setMacro(e.target.value)} className={cn(select, "mt-2")}>{(macros.length ? macros : [{ macro, descr: "" }]).map((m) => <option key={m.macro} value={m.macro}>{m.macro}{m.descr ? ` — ${m.descr}` : ""}</option>)}</select>}
              {how === "ports" && (
                <div className="grid grid-cols-[140px_1fr] gap-3 mt-2">
                  <select value={proto} onChange={(e) => setProto(e.target.value)} className={select}>{["tcp", "udp", "icmp", "icmpv6", "sctp", "gre", "esp"].map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}</select>
                  <Input value={dport} onChange={(e) => setDport(e.target.value)} placeholder={proto === "tcp" || proto === "udp" ? "Port: 443, or 80,443, or 8000:8100" : "No ports for this protocol"} disabled={proto !== "tcp" && proto !== "udp" && proto !== "sctp"} className="font-mono" />
                </div>
              )}
            </fieldset>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="block"><span className="block text-compact text-ink-2 mb-2">From</span><Input list="fw-refs" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Anywhere" className="font-mono" /></label>
              <label className="block"><span className="block text-compact text-ink-2 mb-2">To</span><Input list="fw-refs" value={dest} onChange={(e) => setDest(e.target.value)} placeholder="Anywhere" className="font-mono" /></label>
              <datalist id="fw-refs">{refs.map((r) => <option key={r.ref} value={r.ref}>{r.type === "ipset" ? "IP set" : "Alias"} {r.name}</option>)}</datalist>
            </div>
            <p className="text-xs text-ink-3 -mt-2">Addresses like 192.168.1.20, networks like 10.0.0.0/8, an alias name, or an IP set as +name.</p>
          </>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <label className="block"><span className="block text-compact text-ink-2 mb-2">Interface <span className="text-ink-3">(optional)</span></span><Input value={iface} onChange={(e) => setIface(e.target.value)} placeholder={scope.startsWith("guest-") ? "net0" : "vmbr0"} className="font-mono" /></label>
          {type !== "group" && <label className="block"><span className="block text-compact text-ink-2 mb-2">Log</span><select value={log} onChange={(e) => setLog(e.target.value)} className={select}><option value="nolog">Don't log</option><option value="info">Info</option><option value="warning">Warning</option><option value="debug">Debug</option></select></label>}
          <div className="flex items-end justify-between h-full pb-2"><span className="text-sm">On</span><Toggle checked={enable} onChange={setEnable} label="Rule on" /></div>
        </div>
        <label className="block"><span className="block text-compact text-ink-2 mb-2">Comment</span><Input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={200} placeholder="Why this rule exists" /></label>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
      {guard.modal}
    </Modal>
  );
}

/** Firewall options: on/off and policies at the datacenter, logging and protections on the host and machines. */
export function FirewallOptions({ scope }: { scope: string }) {
  const engine = useEngine();
  const [opts, setOpts] = useState<Record<string, string | number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const guard = useLockoutGuard();
  useEffect(() => {
    engine.backend.firewallGet<{ options: Record<string, string | number> }>(scope, "options").then((r) => (setOpts(r.options), setError(null)), (e) => setError(e instanceof ApiError ? e.message : "Couldn't read the options"));
  }, [scope, engine.backend, tick]);
  const set = (patch: Record<string, string | boolean>) => guard.run((extra) => engine.backend.firewallPost(scope, "options", { ...patch, ...extra }), setError).then(() => setTick((n) => n + 1));
  if (error) return <p role="alert" className="text-compact text-critical">{error}</p>;
  if (!opts) return <Card className="p-6 text-center text-ink-3 text-sm"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Reading options…</Card>;
  const on = (k: string, d = 0) => Number(opts[k] ?? d) === 1;
  const level = scope === "datacenter" ? "cluster" : scope === "host" ? "node" : "guest";
  const row = (title: string, body: string, control: ReactNode) => (
    <div className="flex items-center gap-4 py-3">
      <div className="flex-1 min-w-0"><div className="text-sm">{title}</div><div className="text-xs text-ink-3">{body}</div></div>
      {control}
    </div>
  );
  const policy = (k: string) => <select value={String(opts[k] ?? (k === "policy_in" ? "DROP" : "ACCEPT"))} onChange={(e) => set({ [k]: e.target.value })} className="h-9 rounded-lg bg-surface-2 border border-line px-2 text-compact"><option value="ACCEPT">Allow</option><option value="DROP">Drop</option><option value="REJECT">Reject</option></select>;
  const logLevel = (k: string) => <select value={String(opts[k] ?? "nolog")} onChange={(e) => set({ [k]: e.target.value })} className="h-9 rounded-lg bg-surface-2 border border-line px-2 text-compact">{["nolog", "info", "notice", "warning", "err", "debug"].map((l) => <option key={l} value={l}>{l === "nolog" ? "Don't log" : l}</option>)}</select>;
  return (
    <Card className="p-5 divide-y divide-line">
      {row(level === "cluster" ? "Firewall for the whole device" : level === "node" ? "Firewall on this host" : "Firewall for this machine", level === "cluster" ? "The master switch. Off means no machine or host rules apply." : level === "node" ? "Rules for traffic to the host itself." : "Also needs the firewall switch on the machine's network device (Hardware tab).", <Toggle checked={on("enable", level === "node" ? 1 : 0)} onChange={(v) => set({ enable: v })} label="Firewall on" />)}
      {level !== "node" && row("Incoming traffic that matches no rule", "Drop is the safe default once your rules let in what you need.", policy("policy_in"))}
      {level !== "node" && row("Outgoing traffic that matches no rule", "Allow is usual.", policy("policy_out"))}
      {level === "cluster" && row("Bridge (ebtables) filtering", "Also filters at the bridge level; leave on.", <Toggle checked={on("ebtables", 1)} onChange={(v) => set({ ebtables: v })} label="ebtables" />)}
      {level === "node" && row("Block SMURF attacks", "Drops broadcast-amplified ping floods.", <Toggle checked={on("nosmurfs", 1)} onChange={(v) => set({ nosmurfs: v })} label="Block SMURF" />)}
      {level === "node" && row("Filter illegal TCP flags", "Drops malformed packets.", <Toggle checked={on("tcpflags")} onChange={(v) => set({ tcpflags: v })} label="TCP flags" />)}
      {level === "guest" && row("Allow DHCP", "Lets the machine get an address automatically.", <Toggle checked={on("dhcp", 1)} onChange={(v) => set({ dhcp: v })} label="DHCP" />)}
      {level === "guest" && row("MAC address filter", "Stops the machine from pretending to be another device.", <Toggle checked={on("macfilter", 1)} onChange={(v) => set({ macfilter: v })} label="MAC filter" />)}
      {level === "guest" && row("IP address filter", "Only lets it use its own addresses (needs an ipfilter-net0 IP set).", <Toggle checked={on("ipfilter")} onChange={(v) => set({ ipfilter: v })} label="IP filter" />)}
      {level !== "cluster" && row("Log dropped incoming traffic", "Shows up in the firewall log.", logLevel("log_level_in"))}
      {level !== "cluster" && row("Log dropped outgoing traffic", "", logLevel("log_level_out"))}
      {guard.modal}
    </Card>
  );
}

function Aliases({ scope }: { scope: string }) {
  const engine = useEngine();
  const [list, setList] = useState<{ name: string; cidr: string; comment: string | null }[] | null>(null);
  const [form, setForm] = useState<{ old: string | null; name: string; cidr: string; comment: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    engine.backend.firewallGet<{ aliases: { name: string; cidr: string; comment: string | null }[] }>(scope, "aliases").then((r) => setList(r.aliases), (e) => setError(e instanceof ApiError ? e.message : "Couldn't read aliases"));
  }, [scope, engine.backend, tick]);
  const save = async () => {
    if (!form) return;
    try {
      await engine.backend.firewallPost(scope, form.old ? `aliases/${encodeURIComponent(form.old)}` : "aliases", { name: form.name, cidr: form.cidr, comment: form.comment });
      setForm(null);
      setTick((n) => n + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save it");
    }
  };
  return (
    <div>
      <div className="flex items-center justify-between mb-2"><p className="text-compact text-ink-3">Names for addresses and networks, to use in rules instead of numbers.</p><Button size="sm" variant="primary" onClick={() => setForm({ old: null, name: "", cidr: "", comment: "" })}><Plus className="h-3.5 w-3.5" />Add alias</Button></div>
      {error && <p role="alert" className="text-compact text-critical mb-2">{error}</p>}
      <Card className="divide-y divide-line">
        {list?.length === 0 && <p className="p-5 text-sm text-ink-3">No aliases yet.</p>}
        {list?.map((a) => (
          <div key={a.name} className="flex items-center gap-3 px-4 py-3">
            <Tag className="h-4 w-4 text-ink-3" />
            <span className="font-mono text-compact w-40 truncate">{a.name}</span>
            <span className="font-mono text-compact text-ink-2 flex-1">{a.cidr}</span>
            <span className="text-xs text-ink-3 truncate max-w-[200px]">{a.comment ?? ""}</span>
            <button onClick={() => setForm({ old: a.name, name: a.name, cidr: a.cidr, comment: a.comment ?? "" })} aria-label={`Edit ${a.name}`} className="h-8 w-8 rounded-md inline-flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2"><Pencil className="h-4 w-4" /></button>
            <button onClick={async () => { await engine.backend.firewallPost(scope, `aliases/${encodeURIComponent(a.name)}/delete`).catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't delete")); setTick((n) => n + 1); }} aria-label={`Delete ${a.name}`} className="h-8 w-8 rounded-md inline-flex items-center justify-center text-ink-3 hover:text-critical hover:bg-critical/10"><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
      </Card>
      {form && (
        <Modal size="sm" icon={<Tag className="h-5 w-5" />} title={form.old ? `Edit ${form.old}` : "Add an alias"} onClose={() => setForm(null)} footer={<><Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" onClick={save} disabled={!form.name || !form.cidr}>Save</Button></>}>
          <div className="space-y-3">
            <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Name</span><Input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="office" className="font-mono" /></label>
            <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Address or network</span><Input value={form.cidr} onChange={(e) => setForm({ ...form, cidr: e.target.value })} placeholder="192.168.1.0/24" className="font-mono" /></label>
            <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Comment</span><Input value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} /></label>
          </div>
        </Modal>
      )}
    </div>
  );
}

function IpSets({ scope }: { scope: string }) {
  const engine = useEngine();
  const [sets, setSets] = useState<{ name: string }[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [entries, setEntries] = useState<{ cidr: string; nomatch: boolean; comment: string | null }[]>([]);
  const [newSet, setNewSet] = useState("");
  const [newEntry, setNewEntry] = useState("");
  const [nomatch, setNomatch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    engine.backend.firewallGet<{ ipsets: { name: string }[] }>(scope, "ipsets").then((r) => { setSets(r.ipsets); if (!open && r.ipsets[0]) setOpen(r.ipsets[0].name); }, (e) => setError(e instanceof ApiError ? e.message : "Couldn't read IP sets"));
  }, [scope, engine.backend, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return setEntries([]);
    engine.backend.firewallGet<{ entries: { cidr: string; nomatch: boolean; comment: string | null }[] }>(scope, "ipsets", open).then((r) => setEntries(r.entries), () => setEntries([]));
  }, [open, scope, engine.backend, tick]);
  const act = async (path: string, body?: unknown) => {
    try {
      await engine.backend.firewallPost(scope, path, body);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Proxmox refused that");
    }
    setTick((n) => n + 1);
  };
  return (
    <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-4">
      <div>
        <p className="text-compact text-ink-3 mb-2">Lists of addresses to use in rules as +name.</p>
        <Card className="divide-y divide-line">
          {sets?.map((s) => (
            <button key={s.name} onClick={() => setOpen(s.name)} className={cn("w-full text-left px-4 py-2.5 font-mono text-compact flex items-center", open === s.name ? "bg-accent-soft" : "hover:bg-surface-2/60")}>
              <span className="flex-1">+{s.name}</span>
              <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); if (open === s.name) setOpen(null); void act(`ipsets/${encodeURIComponent(s.name)}/delete`); }} aria-label={`Delete ${s.name}`} className="text-ink-3 hover:text-critical"><Trash2 className="h-3.5 w-3.5" /></span>
            </button>
          ))}
          <div className="flex gap-2 p-2"><Input value={newSet} onChange={(e) => setNewSet(e.target.value)} placeholder="New set" className="h-9 font-mono" /><Button size="sm" onClick={() => { void act("ipsets", { name: newSet }); setOpen(newSet); setNewSet(""); }} disabled={!newSet}>Add</Button></div>
        </Card>
      </div>
      <div>
        {error && <p role="alert" className="text-compact text-critical mb-2">{error}</p>}
        {open ? (
          <Card className="divide-y divide-line">
            <div className="px-4 py-3 font-mono text-compact font-medium">+{open}</div>
            {entries.length === 0 && <p className="px-4 py-3 text-compact text-ink-3">Empty.</p>}
            {entries.map((e) => (
              <div key={e.cidr} className="flex items-center gap-3 px-4 py-2.5">
                <span className={cn("font-mono text-compact flex-1", e.nomatch && "line-through text-ink-3")}>{e.cidr}</span>
                {e.nomatch && <Chip>excluded</Chip>}
                <span className="text-xs text-ink-3">{e.comment ?? ""}</span>
                <button onClick={() => act(`ipsets/${encodeURIComponent(open)}/entries/${encodeURIComponent(e.cidr)}/delete`)} aria-label={`Remove ${e.cidr}`} className="h-8 w-8 rounded-md inline-flex items-center justify-center text-ink-3 hover:text-critical hover:bg-critical/10"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2 p-3">
              <Input value={newEntry} onChange={(e) => setNewEntry(e.target.value)} placeholder="10.0.0.0/24 or an alias" className="h-9 font-mono flex-1 min-w-[180px]" />
              <label className="inline-flex items-center gap-2 text-compact text-ink-2"><input type="checkbox" checked={nomatch} onChange={(e) => setNomatch(e.target.checked)} className="accent-[var(--accent)]" />Exclude</label>
              <Button size="sm" onClick={() => { void act(`ipsets/${encodeURIComponent(open)}/entries`, { cidr: newEntry, nomatch }); setNewEntry(""); setNomatch(false); }} disabled={!newEntry}>Add</Button>
            </div>
          </Card>
        ) : <Card className="p-6 text-center text-ink-3 text-sm">Pick or create an IP set.</Card>}
      </div>
    </div>
  );
}

function SecurityGroups() {
  const engine = useEngine();
  const [groups, setGroups] = useState<{ group: string; comment: string | null }[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    engine.backend.firewallGet<{ groups: { group: string; comment: string | null }[] }>("datacenter", "groups").then((r) => { setGroups(r.groups); if (!open && r.groups[0]) setOpen(r.groups[0].group); }, (e) => setError(e instanceof ApiError ? e.message : "Couldn't read groups"));
  }, [engine.backend, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (path: string, body?: unknown) => {
    try {
      await engine.backend.firewallPost("datacenter", path, body);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Proxmox refused that");
    }
    setTick((n) => n + 1);
  };
  return (
    <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4">
      <div>
        <p className="text-compact text-ink-3 mb-2">Reusable sets of rules. Add one to any firewall with a single "security group" rule.</p>
        <Card className="divide-y divide-line">
          {groups?.map((g) => (
            <button key={g.group} onClick={() => setOpen(g.group)} className={cn("w-full text-left px-4 py-2.5 flex items-center gap-2", open === g.group ? "bg-accent-soft" : "hover:bg-surface-2/60")}>
              <Layers className="h-4 w-4 text-ink-3" />
              <span className="flex-1 min-w-0"><span className="block font-mono text-compact">{g.group}</span>{g.comment && <span className="block text-xs text-ink-3 truncate">{g.comment}</span>}</span>
              <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); if (open === g.group) setOpen(null); void act(`groups/${encodeURIComponent(g.group)}/delete`); }} aria-label={`Delete ${g.group}`} className="text-ink-3 hover:text-critical"><Trash2 className="h-3.5 w-3.5" /></span>
            </button>
          ))}
          <div className="p-2 space-y-2"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New group" className="h-9 font-mono" /><Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What it's for" className="h-9" /><Button size="sm" className="w-full" onClick={() => { void act("groups", { group: name, comment }); setOpen(name); setName(""); setComment(""); }} disabled={!name}>Create group</Button></div>
        </Card>
        {error && <p role="alert" className="text-compact text-critical mt-2">{error}</p>}
      </div>
      {open ? <RulesTable key={open} scope={`group-${open}`} title={open} /> : <Card className="p-6 text-center text-ink-3 text-sm">Pick or create a group.</Card>}
    </div>
  );
}

function FirewallLog({ scope }: { scope: string }) {
  const engine = useEngine();
  const [lines, setLines] = useState<string[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    engine.backend.firewallGet<{ lines: string[] }>(scope, "log").then((r) => alive && setLines(r.lines), () => alive && setLines([]));
    const t = setTimeout(() => setTick((n) => n + 1), 5000);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [scope, engine.backend, tick]);
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-2 text-compact text-ink-3"><ScrollText className="h-4 w-4" />Newest at the bottom · refreshes every 5 seconds · only traffic from rules or policies with logging on appears</div>
      <pre className="rounded-lg bg-code border border-line p-3 text-xs font-mono text-ink-2 max-h-[420px] overflow-auto whitespace-pre-wrap break-all">{lines === null ? "…" : lines.length ? lines.join("\n") : "Nothing logged yet."}</pre>
    </Card>
  );
}

const TABS = [
  { id: "rules", label: "Rules" },
  { id: "groups", label: "Security groups" },
  { id: "aliases", label: "Aliases" },
  { id: "ipsets", label: "IP sets" },
  { id: "options", label: "Options" },
  { id: "log", label: "Log" },
] as const;

/** The firewall for the whole device and the host, like Datacenter → Firewall and Node → Firewall in Proxmox. */
export function FirewallPage() {
  const engine = useEngine();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.id === params.get("tab"))?.id ?? "rules";
  const [where, setWhere] = useState<"datacenter" | "host">("datacenter");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    engine.backend.firewallGet<{ options: Record<string, number> }>("datacenter", "options").then((r) => setEnabled(Number(r.options.enable) === 1), () => setEnabled(null));
  }, [engine.backend, tab]);
  const setTab = (t: string) => setParams((p) => { const n = new URLSearchParams(p); n.set("tab", t); return n; }, { replace: true });
  usePinActions({ context: "Firewall", items: [
    { id: "fw-rule", label: "Add rule", icon: <Plus className="h-4 w-4" />, group: "do", run: () => setTab("rules") },
    { id: "fw-options", label: enabled ? "Firewall options" : "Turn firewall on", icon: <Shield className="h-4 w-4" />, group: "do", run: () => setTab("options") },
    { id: "fw-log", label: "Firewall log", icon: <ScrollText className="h-4 w-4" />, group: "go", run: () => setTab("log") },
  ] }, 10);
  return (
    <PageFrame width="6xl">
      <PageHeader title="Firewall" subtitle="Who can reach this device and its machines. Machines also have their own firewall on their page." actions={enabled === null ? null : enabled ? <Status kind="good" label="On" /> : <Status kind="off" label="Off for the whole device" />} />
      <div className="flex gap-1 border-b border-line mb-5 overflow-x-auto [scrollbar-width:none]" role="tablist">
        {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn("px-3.5 h-10 text-sm whitespace-nowrap border-b-2 -mb-px transition", tab === t.id ? "border-accent text-ink" : "border-transparent text-ink-3 hover:text-ink-2")}>{t.label}</button>)}
      </div>
      {enabled === false && tab === "rules" && <p className="text-compact text-warning mb-3">The firewall is off for the whole device, so none of these rules apply yet. Turn it on in Options.</p>}
      {(tab === "rules" || tab === "options") && (
        <div className="mb-4"><Segmented value={where} onChange={setWhere} options={[{ value: "datacenter", label: "Whole device" }, { value: "host", label: "This host" }]} /></div>
      )}
      {tab === "rules" && <RulesTable key={where} scope={where} note={where === "datacenter" ? "Apply to every machine and the host." : "Apply to traffic for the host itself (this console, SSH, the Proxmox UI)."} />}
      {tab === "options" && <FirewallOptions key={where} scope={where} />}
      {tab === "groups" && <SecurityGroups />}
      {tab === "aliases" && <Aliases scope="datacenter" />}
      {tab === "ipsets" && <IpSets scope="datacenter" />}
      {tab === "log" && <FirewallLog scope="host" />}
    </PageFrame>
  );
}

/** A machine's own firewall: its switch and policies, its rules, and its log. */
export function MachineFirewall({ vmid }: { vmid: number }) {
  const [view, setView] = useState<"rules" | "options" | "aliases" | "ipsets" | "log">("rules");
  const scope = `guest-${vmid}`;
  return (
    <div className="space-y-4 fade-in">
      <Segmented size="sm" value={view} onChange={setView} options={[{ value: "rules", label: "Rules" }, { value: "options", label: "Options" }, { value: "aliases", label: "Aliases" }, { value: "ipsets", label: "IP sets" }, { value: "log", label: "Log" }]} />
      {view === "rules" && <RulesTable scope={scope} note="Only apply when this machine's firewall is on (Options) and its network device has the firewall switched on." />}
      {view === "options" && <FirewallOptions scope={scope} />}
      {view === "aliases" && <Aliases scope={scope} />}
      {view === "ipsets" && <IpSets scope={scope} />}
      {view === "log" && <FirewallLog scope={scope} />}
    </div>
  );
}
