import { useState } from "react";
import { Cloud, FileText, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { CI_TYPES } from "@papercliped-engine/proxmox-client/machine-extra";
import type { CloudInitState, MachineApi } from "../../data/engine/machineApi.ts";
import { useMachineApi } from "../../data/engine/machineApi.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, EmptyState, Input, Notice, SectionTitle, Segmented, Select, Textarea } from "../../ui/primitives.tsx";
import { ConfirmTypeModal, useLoad } from "../disks/common.tsx";
import { Dd, Dl, Dt, Off, SwitchRow, useRun, Warnings } from "./MachineSettingsKit.tsx";

/** Cloud-Init on an existing VM: the drive, user, password, SSH keys, DNS, addresses, upgrade, custom files, the generated files. */
export function MachineCloudInit({ vmid, name }: { vmid: number; name: string }) {
  const api = useMachineApi();
  const [tick, setTick] = useState(0);
  const st = useLoad(() => api.cloudInit(vmid), [api, vmid, tick]);
  const reload = () => setTick((n) => n + 1);
  const [modal, setModal] = useState<"edit" | "dump" | "remove" | "add" | null>(null);
  const regen = useRun(reload);
  const s = st.data;
  if (st.error) return <p role="alert" className="text-compact text-critical">{st.error}</p>;
  if (!s) return <Card className="p-8 text-center text-ink-3 text-sm"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Reading Cloud-Init…</Card>;
  const v = s.view;
  if (!v.drive) {
    return (
      <Card>
        <EmptyState icon={<Cloud className="h-5 w-5" />} title="No Cloud-Init drive" body={`Cloud-Init sets ${name}'s user, SSH keys and network address when it boots, from a small virtual drive. The guest needs the cloud-init package installed; most cloud images have it.`} action={<Button variant="primary" onClick={() => setModal("add")}><Plus className="h-4 w-4" />Add Cloud-Init drive</Button>} />
        {modal === "add" && <AddDrive vmid={vmid} api={api} s={s} reload={reload} onClose={() => setModal(null)} />}
      </Card>
    );
  }
  const unsaved = s.changed.length > 0;
  return (
    <div className="space-y-4 fade-in">
      {unsaved && (
        <Notice tone="warning" title="The image is out of date" action={<Button size="sm" disabled={regen.busy} onClick={() => regen.run(() => api.regenerateCloudInit(vmid))}>{regen.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}Regenerate image</Button>}>
          <p>{s.changed.map((c) => c.key).join(", ")} {s.changed.length === 1 ? "is" : "are"} saved but not yet on the Cloud-Init drive. Proxmox rebuilds it when the VM starts, or you can do it now.</p>
          {s.status === "running" && <p>The guest reads the drive when it boots, so a running VM sees the change after a restart (or after you run <span className="font-mono">cloud-init clean</span> inside it).</p>}
        </Notice>
      )}
      {regen.error && <p role="alert" className="text-compact text-critical">{regen.error}</p>}
      <Card className="p-5">
        <SectionTitle action={<span className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => setModal("dump")}><FileText className="h-3.5 w-3.5" />Generated files</Button><Button size="sm" variant="primary" onClick={() => setModal("edit")}><Pencil className="h-3.5 w-3.5" />Edit</Button></span>}>Cloud-Init</SectionTitle>
        <Dl>
          <Dt>Drive</Dt><Dd><span className="font-mono text-compact">{v.drive.key}</span> <span className="text-ink-3">{v.drive.volume}</span></Dd>
          <Dt>User</Dt><Dd>{v.user ? <span className="font-mono">{v.user}</span> : <Off>The image's default</Off>}</Dd>
          <Dt>Password</Dt><Dd>{v.hasPassword ? <Chip tone="good">Set (hidden)</Chip> : <Off>Not set</Off>}</Dd>
          <Dt>SSH keys</Dt><Dd>{v.sshKeys ? `${v.sshKeys.split("\n").filter(Boolean).length} key${v.sshKeys.split("\n").filter(Boolean).length === 1 ? "" : "s"}` : <Off>None</Off>}</Dd>
          <Dt>Upgrade packages</Dt><Dd>{v.upgrade ? "On first boot" : "Off"}</Dd>
          <Dt>DNS</Dt><Dd>{v.nameserver.length ? v.nameserver.join(", ") : <Off>Host's</Off>}{v.searchdomain ? ` · ${v.searchdomain}` : ""}</Dd>
          <Dt>Format</Dt><Dd>{v.type ?? <Off>Automatic</Off>}</Dd>
        </Dl>
      </Card>
      <Card className="p-5">
        <SectionTitle>Addresses</SectionTitle>
        {v.ipconfig.length === 0 ? <p className="text-sm text-ink-3">This VM has no network device. Add one under Hardware.</p> : (
          <div className="divide-y divide-line">{v.ipconfig.map((i) => (
            <div key={i.key} className="py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-compact"><span className="font-mono w-16">{i.net}</span><span className="text-ink-2">{i.ip ? (i.ip === "dhcp" ? "IPv4 by DHCP" : `${i.ip}${i.gw ? ` via ${i.gw}` : ""}`) : <span className="text-ink-3">IPv4 not set</span>}</span><span className="text-ink-2">{i.ip6 ? (["auto", "dhcp"].includes(i.ip6) ? `IPv6 ${i.ip6}` : `${i.ip6}${i.gw6 ? ` via ${i.gw6}` : ""}`) : <span className="text-ink-3">IPv6 not set</span>}</span></div>
          ))}</div>
        )}
      </Card>
      {(v.custom.user || v.custom.network || v.custom.meta || v.custom.vendor) && (
        <Card className="p-5">
          <SectionTitle>Custom files</SectionTitle>
          <Dl>{(["user", "network", "meta", "vendor"] as const).map((k) => v.custom[k] ? <><Dt key={`${k}-t`}>{k}</Dt><Dd key={`${k}-d`}><span className="font-mono text-compact">{v.custom[k]}</span></Dd></> : null)}</Dl>
        </Card>
      )}
      <div><Button variant="ghost" onClick={() => setModal("remove")}><Trash2 className="h-4 w-4" />Remove the Cloud-Init drive</Button></div>
      {modal === "edit" && <EditCloudInit vmid={vmid} api={api} s={s} reload={reload} onClose={() => setModal(null)} />}
      {modal === "dump" && <Dump vmid={vmid} api={api} onClose={() => setModal(null)} />}
      {modal === "remove" && <ConfirmTypeModal title="Remove the Cloud-Init drive?" subtitle="The VM keeps its disks. It will no longer get a user, keys or address from Cloud-Init at boot." expected={v.drive.key} actionLabel="Remove drive" onClose={() => setModal(null)} onDone={reload} onConfirm={(confirm) => api.removeCloudInitDrive(vmid, { digest: s.digest, confirm })} />}
    </div>
  );
}

type Ctx = { vmid: number; api: MachineApi; s: CloudInitState; reload: () => void; onClose: () => void };

function AddDrive({ vmid, api, s, reload, onClose }: Ctx) {
  const { run, busy, error } = useRun(reload, onClose);
  const [storage, setStorage] = useState(s.storages[0] ?? "");
  return (
    <Modal size="sm" icon={<Cloud className="h-5 w-5" />} title="Add a Cloud-Init drive" subtitle="A small virtual drive that holds the settings." onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !storage} onClick={() => run(() => api.saveCloudInit(vmid, { digest: s.digest, drive: { storage } }))}>Add drive</Button></>}>
      <div className="space-y-3">
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Storage</span><Select value={storage} onChange={(e) => setStorage(e.target.value)}>{s.storages.map((x) => <option key={x} value={x}>{x}</option>)}</Select></label>
        {s.storages.length === 0 && <p className="text-xs text-ink-3">No storage that holds VM disks is available to your account.</p>}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

type NicForm = { key: string; net: string; ip: "none" | "dhcp" | "static"; addr: string; gw: string; ip6: "none" | "auto" | "dhcp" | "static"; addr6: string; gw6: string };

function EditCloudInit({ vmid, api, s, reload, onClose }: Ctx) {
  const v = s.view;
  const { run, busy, error, warnings } = useRun(reload);
  const [user, setUser] = useState(v.user ?? "");
  const [password, setPassword] = useState("");
  const [clearPw, setClearPw] = useState(false);
  const [keys, setKeys] = useState(v.sshKeys);
  const [upgrade, setUpgrade] = useState(v.upgrade);
  const [type, setType] = useState(v.type ?? "");
  const [ns, setNs] = useState(v.nameserver.join(" "));
  const [sd, setSd] = useState(v.searchdomain ?? "");
  const [custom, setCustom] = useState({ user: v.custom.user ?? "", network: v.custom.network ?? "", meta: v.custom.meta ?? "", vendor: v.custom.vendor ?? "" });
  const [nics, setNics] = useState<NicForm[]>(v.ipconfig.map((i) => ({ key: i.key, net: i.net, ip: !i.ip ? "none" : i.ip === "dhcp" ? "dhcp" : "static", addr: i.ip && i.ip !== "dhcp" ? i.ip : "", gw: i.gw ?? "", ip6: !i.ip6 ? "none" : i.ip6 === "auto" ? "auto" : i.ip6 === "dhcp" ? "dhcp" : "static", addr6: i.ip6 && !["auto", "dhcp"].includes(i.ip6) ? i.ip6 : "", gw6: i.gw6 ?? "" })));
  const setNic = (i: number, p: Partial<NicForm>) => setNics((l) => l.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const save = async () => {
    const ipconfig = Object.fromEntries(nics.map((n) => [n.key, n.ip === "none" && n.ip6 === "none" ? null : { ip: n.ip === "none" ? "" : n.ip === "dhcp" ? "dhcp" : n.addr.trim(), gw: n.ip === "static" ? n.gw.trim() : "", ip6: n.ip6 === "none" ? "" : n.ip6 === "static" ? n.addr6.trim() : n.ip6, gw6: n.ip6 === "static" ? n.gw6.trim() : "" }]));
    const body: Record<string, unknown> = { digest: s.digest, user: user.trim() || null, sshKeys: keys.trim() || null, upgrade, type: type || null, nameserver: ns.trim() ? ns.trim().split(/[\s,]+/) : null, searchdomain: sd.trim() || null, ipconfig, custom: { user: custom.user || null, network: custom.network || null, meta: custom.meta || null, vendor: custom.vendor || null } };
    if (password) body.password = password;
    else if (clearPw) body.clearPassword = true;
    const r = await run(() => api.saveCloudInit(vmid, body));
    if (r && !r.warnings.length) onClose();
  };
  return (
    <Modal size="lg" icon={<Cloud className="h-5 w-5" />} title="Edit Cloud-Init" subtitle="Applied the next time the VM boots with a regenerated drive." onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{warnings.length ? "Close" : "Cancel"}</Button><Button variant="primary" onClick={save} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Save</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">User</span><Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="The image's default" className="font-mono" autoComplete="off" /></label>
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Password</span><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={v.hasPassword ? "Set. Type to replace" : "Not set"} autoComplete="new-password" /><span className="block text-xs text-ink-3 mt-1.5">Write-only: it is sent to Proxmox and never shown again.</span></label>
        </div>
        {v.hasPassword && !password && <SwitchRow label="Remove the password" checked={clearPw} onChange={setClearPw} />}
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">SSH public keys (one per line)</span><Textarea value={keys} onChange={(e) => setKeys(e.target.value)} rows={3} className="font-mono text-compact" placeholder="ssh-ed25519 AAAA… me@laptop" spellCheck={false} /></label>
        <SwitchRow label="Upgrade packages on first boot" hint="Installs available updates before the machine is ready." checked={upgrade} onChange={setUpgrade} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">DNS servers</span><Input value={ns} onChange={(e) => setNs(e.target.value)} placeholder="Host's, or 1.1.1.1 9.9.9.9" className="font-mono" /></label>
          <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Search domain</span><Input value={sd} onChange={(e) => setSd(e.target.value)} placeholder="Host's, or example.lan" /></label>
        </div>
        {nics.map((n, i) => (
          <div key={n.key} className="rounded-lg border border-line p-3 space-y-3">
            <div className="text-compact font-medium font-mono">{n.net}</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="block"><span className="block text-xs text-ink-3 mb-1">IPv4</span><Select value={n.ip} onChange={(e) => setNic(i, { ip: e.target.value as NicForm["ip"] })}><option value="none">Not set</option><option value="dhcp">DHCP</option><option value="static">Static</option></Select></label>
              {n.ip === "static" && <><label className="block"><span className="block text-xs text-ink-3 mb-1">Address with prefix</span><Input value={n.addr} onChange={(e) => setNic(i, { addr: e.target.value })} placeholder="192.168.1.50/24" className="font-mono" /></label><label className="block"><span className="block text-xs text-ink-3 mb-1">Gateway</span><Input value={n.gw} onChange={(e) => setNic(i, { gw: e.target.value })} placeholder="192.168.1.1" className="font-mono" /></label></>}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="block"><span className="block text-xs text-ink-3 mb-1">IPv6</span><Select value={n.ip6} onChange={(e) => setNic(i, { ip6: e.target.value as NicForm["ip6"] })}><option value="none">Not set</option><option value="auto">Automatic (SLAAC)</option><option value="dhcp">DHCP</option><option value="static">Static</option></Select></label>
              {n.ip6 === "static" && <><label className="block"><span className="block text-xs text-ink-3 mb-1">Address with prefix</span><Input value={n.addr6} onChange={(e) => setNic(i, { addr6: e.target.value })} placeholder="fd00::50/64" className="font-mono" /></label><label className="block"><span className="block text-xs text-ink-3 mb-1">Gateway</span><Input value={n.gw6} onChange={(e) => setNic(i, { gw6: e.target.value })} placeholder="fd00::1" className="font-mono" /></label></>}
            </div>
          </div>
        ))}
        <details>
          <summary className="cursor-pointer text-compact text-ink-2">Advanced: format and custom files</summary>
          <div className="space-y-3 mt-3">
            <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Format</span><Select value={type} onChange={(e) => setType(e.target.value)}><option value="">Automatic</option>{CI_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></label>
            {(["user", "network", "meta", "vendor"] as const).map((k) => (
              <label key={k} className="block"><span className="block text-compact text-ink-2 mb-1.5">Custom {k} file</span><Select value={custom[k]} onChange={(e) => setCustom((c) => ({ ...c, [k]: e.target.value }))}><option value="">Generated by Proxmox</option>{s.snippets.map((x) => <option key={x} value={x}>{x}</option>)}{custom[k] && !s.snippets.includes(custom[k]) && <option value={custom[k]}>{custom[k]}</option>}</Select></label>
            ))}
            <p className="text-xs text-ink-3">A custom file replaces what Proxmox generates for that part, so the matching fields above are then ignored. Snippets live on a storage with the Snippets content type.</p>
          </div>
        </details>
        <Warnings list={warnings} />
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function Dump({ vmid, api, onClose }: { vmid: number; api: MachineApi; onClose: () => void }) {
  const [type, setType] = useState<"user" | "network" | "meta">("user");
  const d = useLoad(() => api.dumpCloudInit(vmid, type), [api, vmid, type]);
  return (
    <Modal size="lg" icon={<FileText className="h-5 w-5" />} title="Generated files" subtitle="What the guest will read from the Cloud-Init drive. Password hashes are hidden." onClose={onClose}>
      <div className="space-y-3">
        <Segmented size="sm" value={type} onChange={setType} options={[{ value: "user", label: "User" }, { value: "network", label: "Network" }, { value: "meta", label: "Meta" }]} />
        {d.error && <p role="alert" className="text-compact text-critical">{d.error}</p>}
        <pre className="rounded-lg bg-surface-2 border border-line p-3 text-compact font-mono overflow-x-auto max-h-96 whitespace-pre-wrap">{d.data?.type === type ? d.data.text : "Reading…"}</pre>
      </div>
    </Modal>
  );
}
