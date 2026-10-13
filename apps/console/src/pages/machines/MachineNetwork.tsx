import { useState } from "react";
import { Cable, Globe, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useGuestApi, type GuestDevices, type GuestFeatures, type GuestNic } from "../../data/engine/guestApi.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, Field, Input, Notice, SectionTitle, Segmented, Select, Toggle } from "../../ui/primitives.tsx";
import { Check, ConfirmTypeModal } from "../disks/common.tsx";
import { busyNotice, PendingChip, Row, useSave, type DevCtx } from "./MachineKit.tsx";

/** A machine's network devices (VM and container), a container's DNS and features. Every change carries the page's digest. */

const MODELS: [string, string][] = [
  ["virtio", "VirtIO (paravirtualized): fastest, needs a driver in Windows"],
  ["e1000e", "Intel E1000E: works almost everywhere"],
  ["e1000", "Intel E1000"],
  ["vmxnet3", "VMware vmxnet3"],
  ["rtl8139", "Realtek RTL8139: old systems"],
  ["e1000-82540em", "Intel E1000 82540EM"],
  ["e1000-82544gc", "Intel E1000 82544GC"],
  ["e1000-82545em", "Intel E1000 82545EM"],
  ["i82551", "Intel i82551"],
  ["i82557b", "Intel i82557B"],
  ["i82559er", "Intel i82559ER"],
  ["ne2k_pci", "NE2000 PCI"],
  ["ne2k_isa", "NE2000 ISA"],
  ["pcnet", "AMD PCnet"],
];

function nicSummary(n: GuestNic, vm: boolean) {
  return [
    vm ? n.model : n.ip === "dhcp" ? "DHCP" : n.ip === "manual" || !n.ip ? "No IPv4" : n.ip,
    !vm && n.gw ? `gateway ${n.gw}` : null,
    !vm && n.ip6 ? (n.ip6 === "auto" ? "IPv6 automatic" : n.ip6 === "dhcp" ? "IPv6 DHCP" : n.ip6 === "manual" ? null : n.ip6) : null,
    n.mac,
    n.mtu ? `MTU ${n.mtu}` : null,
    n.queues ? `${n.queues} queues` : null,
    n.rate ? `${n.rate} MB/s` : null,
  ].filter(Boolean).join(" · ");
}

export function NetworkCard({ ctx }: { ctx: DevCtx }) {
  const { d } = ctx;
  const api = useGuestApi();
  const vm = d.type === "qemu";
  const [edit, setEdit] = useState<GuestNic | "new" | null>(null);
  const [remove, setRemove] = useState<GuestNic | null>(null);
  const busy = busyNotice(d);
  return (
    <Card className="p-5 lg:col-span-2">
      <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => setEdit("new")} disabled={!!d.locked}><Plus className="h-3.5 w-3.5" />Add</Button>}>Network devices</SectionTitle>
      {busy && <Notice tone="warning" className="mb-3">{busy}</Notice>}
      {d.nics.length === 0 ? <p className="text-sm text-ink-3">No network devices. This machine is offline.</p> : (
        <div className="divide-y divide-line">
          {d.nics.map((n) => (
            <Row key={n.key}>
              <Cable className="h-4 w-4 text-ink-3 shrink-0" />
              <div className="flex-1 min-w-0 basis-56">
                <div className="text-sm flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-mono">{n.name ?? n.key}</span><span className="text-ink-3">on</span><span className="font-mono">{n.bridge}</span>
                  {n.tag ? <span className="text-ink-3">· VLAN {n.tag}</span> : null}
                  {n.trunks ? <span className="text-ink-3">· trunks {n.trunks}</span> : null}
                  {n.firewall && <Chip><ShieldCheck className="h-3 w-3" />Firewall</Chip>}
                  {n.linkDown && <Chip tone="warning">Disconnected</Chip>}
                  {n.pending && <PendingChip />}
                </div>
                <div className="text-xs text-ink-3 font-mono truncate" title={nicSummary(n, vm)}>{nicSummary(n, vm)}</div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setEdit(n)} disabled={!!d.locked} aria-label={`Edit ${n.name ?? n.key}`}><Pencil className="h-3.5 w-3.5" />Edit</Button>
              <button onClick={() => setRemove(n)} disabled={!!d.locked} aria-label={`Remove ${n.name ?? n.key}`} className="h-8 w-8 rounded-md inline-flex items-center justify-center text-ink-3 hover:text-critical hover:bg-critical/10 disabled:opacity-40"><Trash2 className="h-4 w-4" /></button>
            </Row>
          ))}
        </div>
      )}
      {edit && <NicModal ctx={ctx} nic={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
      {remove && (
        <ConfirmTypeModal
          title={`Remove ${remove.name ?? remove.key}?`}
          subtitle={d.nics.length === 1 ? "It's this machine's only network device, so the machine will be offline." : `The machine loses its connection on ${remove.bridge}.`}
          expected={remove.key}
          actionLabel="Remove device"
          warning={d.status === "running" ? "The machine is running. Removing a network device can cut off whoever is connected to it." : undefined}
          onConfirm={(typed) => api.removeNic(ctx.vmid, remove.key, { digest: d.digest ?? "", confirm: typed })}
          onClose={() => setRemove(null)}
          onDone={ctx.reload}
        />
      )}
    </Card>
  );
}

type V4 = "dhcp" | "static" | "manual";
type V6 = "auto" | "dhcp" | "static" | "manual";

function NicModal({ ctx, nic, onClose }: { ctx: DevCtx; nic: GuestNic | null; onClose: () => void }) {
  const { d } = ctx;
  const api = useGuestApi();
  const vm = d.type === "qemu";
  const save = useSave(ctx, onClose);
  const nextName = `eth${[...Array(32).keys()].find((i) => !d.nics.some((n) => n.name === `eth${i}`)) ?? 0}`;
  const [name, setName] = useState(nic?.name ?? nextName);
  const [bridge, setBridge] = useState(nic?.bridge ?? d.bridges[0] ?? "vmbr0");
  const [model, setModel] = useState(nic?.model ?? "virtio");
  const [tag, setTag] = useState(nic?.tag ? String(nic.tag) : "");
  const [trunks, setTrunks] = useState(nic?.trunks ?? "");
  const [mac, setMac] = useState("");
  const [firewall, setFirewall] = useState(nic?.firewall ?? true);
  const [linkDown, setLinkDown] = useState(nic?.linkDown ?? false);
  const [rate, setRate] = useState(nic?.rate ? String(nic.rate) : "");
  const [mtu, setMtu] = useState(nic?.mtu ? String(nic.mtu) : "");
  const [queues, setQueues] = useState(nic?.queues ? String(nic.queues) : "");
  const [v4, setV4] = useState<V4>(nic?.ip === "dhcp" || !nic ? "dhcp" : nic.ip?.includes("/") ? "static" : "manual");
  const [ip, setIp] = useState(nic?.ip?.includes("/") ? nic.ip : "");
  const [gw, setGw] = useState(nic?.gw ?? "");
  const [v6, setV6] = useState<V6>(!nic ? "auto" : nic.ip6 === "auto" || nic.ip6 === "dhcp" ? nic.ip6 : nic.ip6?.includes("/") ? "static" : "manual");
  const [ip6, setIp6] = useState(nic?.ip6?.includes("/") ? nic.ip6 : "");
  const [gw6, setGw6] = useState(nic?.gw6 ?? "");
  const [more, setMore] = useState(!!(nic?.trunks || nic?.mtu || nic?.queues));
  const bridges = [...new Set([...d.bridges, bridge].filter(Boolean))];
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const virtio = model === "virtio";
  const submit = () =>
    save.run(() => api.saveNic(ctx.vmid, {
      digest: d.digest,
      key: nic?.key,
      bridge,
      tag: num(tag),
      trunks: trunks.trim() || null,
      mac: mac.trim() || null,
      firewall,
      linkDown,
      rate: num(rate),
      mtu: num(mtu),
      ...(vm ? { model, queues: num(queues) } : { name, ip: v4 === "static" ? ip.trim() : v4, gw: v4 === "static" ? gw.trim() || null : null, ip6: v6 === "static" ? ip6.trim() : v6, gw6: v6 === "static" ? gw6.trim() || null : null }),
    }));
  const incomplete = !bridge || (!vm && (!name || (v4 === "static" && !ip.trim()) || (v6 === "static" && !ip6.trim())));
  return (
    <Modal
      size="lg"
      icon={<Cable className="h-5 w-5" />}
      title={nic ? `Edit ${nic.name ?? nic.key}` : "Add a network device"}
      subtitle={nic?.mac ? `Keeps its MAC address ${nic.mac} unless you enter another.` : "Joins the machine to a bridge on this device."}
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} disabled={incomplete} loading={save.busy}>{nic ? "Save" : "Add device"}</Button></>}
    >
      <div className="space-y-4">
        {d.status === "running" && <Notice>The machine is running. {vm ? "Proxmox applies a network device change to a running VM when it can, otherwise at the next start." : "A container picks this up the next time it starts."}</Notice>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {!vm && <Field label="Name inside the container" htmlFor="nic-name"><Input id="nic-name" value={name} onChange={(e) => setName(e.target.value)} className="font-mono" /></Field>}
          {vm && (
            <Field label="Model" htmlFor="nic-model">
              <Select id="nic-model" value={model} onChange={(e) => setModel(e.target.value)}>{MODELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            </Field>
          )}
          <Field label="Bridge" htmlFor="nic-bridge" hint={d.bridges.length ? undefined : "This account can't list bridges. Type the name."}>
            {d.bridges.length ? <Select id="nic-bridge" value={bridge} onChange={(e) => setBridge(e.target.value)}>{bridges.map((b) => <option key={b}>{b}</option>)}</Select> : <Input id="nic-bridge" value={bridge} onChange={(e) => setBridge(e.target.value)} className="font-mono" />}
          </Field>
          <Field label={<>VLAN tag <span className="text-ink-3 font-normal">(optional)</span></>} htmlFor="nic-tag"><Input id="nic-tag" type="number" min={1} max={4094} value={tag} onChange={(e) => setTag(e.target.value)} placeholder="None" /></Field>
        </div>

        {!vm && (
          <div className="space-y-3">
            <div>
              <div className="text-compact font-medium text-ink-2 mb-1.5">IPv4</div>
              <Segmented size="sm" label="IPv4" value={v4} onChange={setV4} options={[{ value: "dhcp", label: "DHCP" }, { value: "static", label: "Static" }, { value: "manual", label: "None" }]} />
              {v4 === "static" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
                  <Field label="Address" htmlFor="nic-ip"><Input id="nic-ip" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.50/24" className="font-mono" /></Field>
                  <Field label="Gateway" htmlFor="nic-gw"><Input id="nic-gw" value={gw} onChange={(e) => setGw(e.target.value)} placeholder="192.168.1.1" className="font-mono" /></Field>
                </div>
              )}
            </div>
            <div>
              <div className="text-compact font-medium text-ink-2 mb-1.5">IPv6</div>
              <Segmented size="sm" label="IPv6" value={v6} onChange={setV6} options={[{ value: "auto", label: "Automatic" }, { value: "dhcp", label: "DHCP" }, { value: "static", label: "Static" }, { value: "manual", label: "None" }]} />
              {v6 === "static" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
                  <Field label="Address" htmlFor="nic-ip6"><Input id="nic-ip6" value={ip6} onChange={(e) => setIp6(e.target.value)} placeholder="fd00::50/64" className="font-mono" /></Field>
                  <Field label="Gateway" htmlFor="nic-gw6"><Input id="nic-gw6" value={gw6} onChange={(e) => setGw6(e.target.value)} placeholder="fd00::1" className="font-mono" /></Field>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
          <Field label={<>Rate limit <span className="text-ink-3 font-normal">(MB/s)</span></>} htmlFor="nic-rate"><Input id="nic-rate" type="number" min={0} step="any" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="Unlimited" /></Field>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 h-5"><span className="text-sm">Firewall</span><Toggle checked={firewall} onChange={setFirewall} label="Firewall" /></div>
            <div className="flex items-center justify-between gap-3 h-5"><span className="text-sm">Disconnected</span><Toggle checked={linkDown} onChange={setLinkDown} label="Disconnected" /></div>
          </div>
        </div>

        <div>
          <button type="button" onClick={() => setMore(!more)} aria-expanded={more} className="text-compact text-ink-2 hover:text-ink">{more ? "Hide" : "Show"} advanced settings</button>
          {more && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
              <Field label="MAC address" htmlFor="nic-mac" hint={nic?.mac ? `Now ${nic.mac}. Leave empty to keep it.` : "Leave empty and Proxmox picks one."}><Input id="nic-mac" value={mac} onChange={(e) => setMac(e.target.value)} placeholder="BC:24:11:AA:BB:CC" className="font-mono" /></Field>
              <Field label="VLAN trunks" htmlFor="nic-trunks" hint={vm ? "Ids and ranges, like 10;20-30." : "Ids, like 10;20."}><Input id="nic-trunks" value={trunks} onChange={(e) => setTrunks(e.target.value)} placeholder="None" className="font-mono" /></Field>
              <Field label="MTU" htmlFor="nic-mtu" hint={vm ? "VirtIO only. 1 uses the bridge's MTU." : "Empty uses the bridge's MTU."}><Input id="nic-mtu" type="number" min={1} max={65535} value={mtu} onChange={(e) => setMtu(e.target.value)} disabled={vm && !virtio} placeholder="Bridge default" /></Field>
              {vm && <Field label="Queues" htmlFor="nic-queues" hint="VirtIO only. More queues spread network work over more cores."><Input id="nic-queues" type="number" min={0} max={64} value={queues} onChange={(e) => setQueues(e.target.value)} disabled={!virtio} placeholder="Default" /></Field>}
            </div>
          )}
        </div>
        {save.error && <p role="alert" className="text-compact text-critical">{save.error}</p>}
      </div>
    </Modal>
  );
}

export function DnsCard({ ctx }: { ctx: DevCtx }) {
  const { d } = ctx;
  const [open, setOpen] = useState(false);
  if (!d.dns) return null;
  return (
    <Card className="p-5">
      <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => setOpen(true)} disabled={!!d.locked}><Pencil className="h-3.5 w-3.5" />Edit</Button>}>DNS</SectionTitle>
      {d.dns.fromHost ? (
        <p className="text-sm text-ink-2">Uses this device's DNS settings.</p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-ink-3">Servers</dt><dd className="font-mono text-compact">{d.dns.nameserver.length ? d.dns.nameserver.join(", ") : <span className="font-sans text-ink-3">The host's</span>}</dd>
          <dt className="text-ink-3">Search domains</dt><dd className="font-mono text-compact">{d.dns.searchdomain.length ? d.dns.searchdomain.join(", ") : <span className="font-sans text-ink-3">The host's</span>}</dd>
        </dl>
      )}
      {open && <DnsModal ctx={ctx} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function DnsModal({ ctx, onClose }: { ctx: DevCtx; onClose: () => void }) {
  const dns = ctx.d.dns!;
  const api = useGuestApi();
  const save = useSave(ctx, onClose);
  const [useHost, setUseHost] = useState<"host" | "custom">(dns.fromHost ? "host" : "custom");
  const [servers, setServers] = useState([0, 1, 2].map((i) => dns.nameserver[i] ?? ""));
  const [domains, setDomains] = useState(dns.searchdomain.join(", "));
  return (
    <Modal
      size="sm"
      icon={<Globe className="h-5 w-5" />}
      title="DNS"
      subtitle="Which name servers and search domains the container uses."
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.busy} onClick={() => save.run(() => api.saveDns(ctx.vmid, { digest: ctx.d.digest ?? "", nameserver: useHost === "host" ? [] : servers.map((s) => s.trim()).filter(Boolean), searchdomain: useHost === "host" ? [] : domains.split(/[\s,;]+/).filter(Boolean) }))}>Save</Button></>}
    >
      <div className="space-y-4">
        <Segmented size="sm" label="DNS source" value={useHost} onChange={setUseHost} options={[{ value: "host", label: "Use the host's" }, { value: "custom", label: "Set my own" }]} />
        {useHost === "custom" && (
          <>
            <div className="space-y-3">
              {servers.map((s, i) => (
                <Field key={i} label={`DNS server ${i + 1}`} htmlFor={`dns-${i}`}><Input id={`dns-${i}`} value={s} onChange={(e) => setServers(servers.map((x, j) => (j === i ? e.target.value : x)))} placeholder={i === 0 ? "1.1.1.1" : "Optional"} className="font-mono" /></Field>
              ))}
            </div>
            <Field label="Search domains" htmlFor="dns-domains" hint="Separate with commas or spaces, like lan, corp.example."><Input id="dns-domains" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="lan" className="font-mono" /></Field>
            <p className="text-xs text-ink-3">Set both, or the container may fall back to the host for the one you leave empty.</p>
          </>
        )}
        {save.error && <p role="alert" className="text-compact text-critical">{save.error}</p>}
      </div>
    </Modal>
  );
}

const MOUNTABLE = ["nfs", "cifs"];

export function FeaturesCard({ ctx }: { ctx: DevCtx }) {
  const { d } = ctx;
  const f = d.features;
  const api = useGuestApi();
  const save = useSave(ctx);
  const [draft, setDraft] = useState<GuestFeatures | null>(null);
  const [custom, setCustom] = useState("");
  if (!f) return null;
  const cur = draft ?? f;
  const set = (patch: Partial<GuestFeatures>) => setDraft({ ...cur, ...patch });
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(f);
  const rows: { key: keyof Omit<GuestFeatures, "mount">; label: string; hint: string }[] = [
    { key: "nesting", label: "Nesting", hint: "Lets the container run containers of its own (Docker, Podman, LXC)." },
    { key: "keyctl", label: "keyctl", hint: "Needed by Docker and systemd inside an unprivileged container." },
    { key: "fuse", label: "FUSE", hint: "Lets the container mount FUSE file systems." },
    { key: "mknod", label: "Create device nodes (mknod)", hint: "Experimental. Lets the container create device files." },
    { key: "forceRwSys", label: "Writable /sys", hint: "Mounts /sys read-write. Some network tools need it." },
  ];
  const extra = cur.mount.filter((m) => !MOUNTABLE.includes(m));
  return (
    <Card className="p-5">
      <SectionTitle action={dirty && <div className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Discard</Button><Button size="sm" variant="primary" loading={save.busy} onClick={async () => { const r = await save.run(() => api.saveFeatures(ctx.vmid, { digest: d.digest, ...cur })); if (r) setDraft(null); }}>Save</Button></div>}>Features</SectionTitle>
      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.key} className="flex items-start justify-between gap-4">
            <div className="min-w-0"><div className="text-sm">{r.label}</div><div className="text-xs text-ink-3">{r.hint}</div></div>
            <Toggle checked={cur[r.key]} onChange={(v) => set({ [r.key]: v })} label={r.label} disabled={!!d.locked} />
          </div>
        ))}
        <div>
          <div className="text-sm mb-1.5">Allowed to mount</div>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {MOUNTABLE.map((m) => <Check key={m} label={m.toUpperCase()} checked={cur.mount.includes(m)} onChange={(on) => set({ mount: on ? [...cur.mount, m] : cur.mount.filter((x) => x !== m) })} />)}
            {extra.map((m) => <Check key={m} label={m} checked onChange={() => set({ mount: cur.mount.filter((x) => x !== m) })} />)}
          </div>
          <form className="flex gap-2 mt-2" onSubmit={(e) => { e.preventDefault(); const t = custom.trim().toLowerCase(); if (t && !cur.mount.includes(t)) set({ mount: [...cur.mount, t] }); setCustom(""); }}>
            <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Another file system, like ext4" className="font-mono" aria-label="Another file system type" />
            <Button type="submit" size="md" disabled={!custom.trim()}>Add</Button>
          </form>
        </div>
      </div>
      <p className="text-xs text-ink-3 mt-3">{d.unprivileged ? "This is an unprivileged container." : "This is a privileged container."} Features apply the next time it starts. Proxmox lets only some accounts change them; it tells you if yours can't.</p>
      {save.error && <p role="alert" className="text-compact text-critical mt-2">{save.error}</p>}
    </Card>
  );
}

export type { GuestDevices };
