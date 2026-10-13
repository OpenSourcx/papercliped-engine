import { NIC_MODELS } from "@papercliped-engine/proxmox-client/wizard-schema";
import { Field, Input, Notice, Textarea } from "../../../ui/primitives.tsx";
import { AddButton, Grid, ListItem, Num, Pick, Section, SwitchRow, patch, without } from "./fields.tsx";
import { defaultCtNic, defaultVmNic, emptyIp, type CtForm, type CtNicForm, type IpForm, type VmForm, type VmNicForm } from "./state.ts";
import type { StepProps } from "./types.ts";
import type { WizardOptions } from "../../../data/engine/wizard.ts";

const MODEL_LABELS: Record<string, string> = {
  virtio: "VirtIO (paravirtualized)",
  e1000: "Intel E1000",
  e1000e: "Intel E1000E",
  "e1000-82540em": "Intel E1000 82540EM",
  "e1000-82544gc": "Intel E1000 82544GC",
  "e1000-82545em": "Intel E1000 82545EM",
  i82551: "Intel i82551",
  i82557b: "Intel i82557B",
  i82559er: "Intel i82559ER",
  ne2k_isa: "NE2000 ISA",
  ne2k_pci: "NE2000 PCI",
  pcnet: "AMD PCnet",
  rtl8139: "Realtek RTL8139",
  vmxnet3: "VMware vmxnet3",
};

/** The bridge list from the node, or a text box when the node couldn't say. */
export function BridgeField({ value, onChange, o, id, error }: { value: string; onChange: (v: string) => void; o: WizardOptions; id: string; error: string | null }) {
  return (
    <Field label="Bridge" htmlFor={id} error={error}>
      {o.bridges.length ? (
        <Pick id={id} value={value} onChange={onChange} options={o.bridges.map((b) => ({ value: b.id, label: b.kind === "vnet" ? `${b.id} (SDN)` : b.id }))} />
      ) : (
        <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} className="font-mono" />
      )}
    </Field>
  );
}

const V4_LABEL = { dhcp: "DHCP", static: "Static", manual: "Manual", none: "Not set" } as const;
const V6_LABEL = { auto: "SLAAC", dhcp: "DHCP", static: "Static", manual: "Manual", none: "Not set" } as const;

/** IPv4 and IPv6 for one network device. Cloud-init has no "manual" mode; containers do. */
export function IpFields({ v, onChange, e4, e6, manual, idp }: { v: IpForm; onChange: (p: Partial<IpForm>) => void; e4: string | null; e6: string | null; manual: boolean; idp: string }) {
  const v4: IpForm["v4"][] = manual ? ["dhcp", "static", "manual", "none"] : ["dhcp", "static", "none"];
  const v6: IpForm["v6"][] = manual ? ["none", "auto", "dhcp", "static", "manual"] : ["none", "auto", "dhcp", "static"];
  return (
    <div className="space-y-4">
      <Grid cols={3}>
        <Field label="IPv4" htmlFor={`${idp}-v4`} error={e4}><Pick id={`${idp}-v4`} value={v.v4} onChange={(m) => onChange({ v4: m })} options={v4.map((m) => ({ value: m, label: V4_LABEL[m] }))} /></Field>
        {v.v4 === "static" && (
          <>
            <Field label="IPv4 address" htmlFor={`${idp}-v4c`} hint="With its prefix, like 192.168.1.50/24."><Input id={`${idp}-v4c`} value={v.v4cidr} onChange={(e) => onChange({ v4cidr: e.target.value })} spellCheck={false} className="font-mono" placeholder="192.168.1.50/24" /></Field>
            <Field label="IPv4 gateway" htmlFor={`${idp}-v4g`}><Input id={`${idp}-v4g`} value={v.v4gw} onChange={(e) => onChange({ v4gw: e.target.value })} spellCheck={false} className="font-mono" placeholder="192.168.1.1" /></Field>
          </>
        )}
      </Grid>
      <Grid cols={3}>
        <Field label="IPv6" htmlFor={`${idp}-v6`} error={e6}><Pick id={`${idp}-v6`} value={v.v6} onChange={(m) => onChange({ v6: m })} options={v6.map((m) => ({ value: m, label: V6_LABEL[m] }))} /></Field>
        {v.v6 === "static" && (
          <>
            <Field label="IPv6 address" htmlFor={`${idp}-v6c`} hint="With its prefix, like 2001:db8::10/64."><Input id={`${idp}-v6c`} value={v.v6cidr} onChange={(e) => onChange({ v6cidr: e.target.value })} spellCheck={false} className="font-mono" placeholder="2001:db8::10/64" /></Field>
            <Field label="IPv6 gateway" htmlFor={`${idp}-v6g`}><Input id={`${idp}-v6g`} value={v.v6gw} onChange={(e) => onChange({ v6gw: e.target.value })} spellCheck={false} className="font-mono" placeholder="2001:db8::1" /></Field>
          </>
        )}
      </Grid>
    </div>
  );
}

function NicCommon({ n, set, o, err, idp }: { n: { bridge: string; vlan: string; mac: string; firewall: boolean; disconnected: boolean; rate: string; mtu: string }; set: (p: Partial<typeof n>) => void; o: WizardOptions; err: (k: string) => string | null; idp: string }) {
  return (
    <>
      <BridgeField value={n.bridge} onChange={(bridge) => set({ bridge })} o={o} id={`${idp}-br`} error={err("bridge")} />
      <Field label="VLAN tag" htmlFor={`${idp}-vlan`} error={err("vlan")} hint="Optional. 1 to 4094."><Num id={`${idp}-vlan`} value={n.vlan} onChange={(vlan) => set({ vlan })} placeholder="None" /></Field>
      <Field label="MAC address" htmlFor={`${idp}-mac`} error={err("mac")} hint="Optional. Empty picks one."><Input id={`${idp}-mac`} value={n.mac} onChange={(e) => set({ mac: e.target.value.trim() })} spellCheck={false} className="font-mono" placeholder="Automatic" /></Field>
      <Field label="Rate limit" htmlFor={`${idp}-rate`} error={err("rateMbps")} hint="Optional. Empty is unlimited."><Num id={`${idp}-rate`} value={n.rate} onChange={(rate) => set({ rate })} placeholder="Unlimited" suffix="MB/s" /></Field>
    </>
  );
}

export function VmNetworkStep({ f, set, o, err }: StepProps<VmForm>) {
  const setNic = (id: number, p: Partial<VmNicForm>) => set({ nics: patch(f.nics, id, p) });
  return (
    <div className="space-y-4">
      {f.nics.length === 0 && <Notice>No network device. The machine won't be reachable over the network.</Notice>}
      {f.nics.map((n, i) => {
        const e = (k: string) => err(`network.${i}.${k}`);
        const virtio = n.model === "virtio";
        return (
          <ListItem key={n.id} title={<>Network device {i + 1} <span className="font-mono text-xs text-ink-3 ml-1">net{i}</span></>} removeLabel={`Remove network device ${i + 1}`} onRemove={() => set({ nics: without(f.nics, n.id), ciIp: f.ciIp.filter((_, k) => k !== i) })}>
            <Grid cols={2}>
              <NicCommon n={n} set={(p) => setNic(n.id, p)} o={o} err={e} idp={`wz-nic-${n.id}`} />
              <Field label="Model" htmlFor={`wz-nic-${n.id}-model`} error={e("model")}>
                <Pick id={`wz-nic-${n.id}-model`} value={n.model} onChange={(model) => setNic(n.id, { model, mtu: model === "virtio" ? n.mtu : "", queues: model === "virtio" ? n.queues : "" })} options={NIC_MODELS.map((m) => ({ value: m, label: MODEL_LABELS[m] }))} />
              </Field>
              {virtio && (
                <>
                  <Field label="MTU" htmlFor={`wz-nic-${n.id}-mtu`} error={e("mtu")} hint="Optional. 1 uses the bridge's MTU."><Num id={`wz-nic-${n.id}-mtu`} value={n.mtu} onChange={(mtu) => setNic(n.id, { mtu })} placeholder="Default" /></Field>
                  <Field label="Multiqueue" htmlFor={`wz-nic-${n.id}-q`} error={e("queues")} hint="Optional. Usually the number of cores."><Num id={`wz-nic-${n.id}-q`} value={n.queues} onChange={(queues) => setNic(n.id, { queues })} placeholder="Default" /></Field>
                </>
              )}
            </Grid>
            <Grid cols={2} className="gap-y-2">
              <SwitchRow label="Firewall" hint="Apply the device's firewall to this network device." checked={n.firewall} onChange={(firewall) => setNic(n.id, { firewall })} />
              <SwitchRow label="Disconnected" hint="Present, but not plugged in." checked={n.disconnected} onChange={(disconnected) => setNic(n.id, { disconnected })} />
            </Grid>
          </ListItem>
        );
      })}
      <AddButton onClick={() => set({ nics: [...f.nics, { ...defaultVmNic(o, f.nics.at(-1)?.model), bridge: f.nics.at(-1)?.bridge ?? o.bridges[0]?.id ?? "vmbr0" }] })} disabled={f.nics.length >= 32}>Add network device</AddButton>
    </div>
  );
}

export function CtNetworkStep({ f, set, o, err }: StepProps<CtForm>) {
  const setNic = (id: number, p: Partial<CtNicForm>) => set({ nics: patch(f.nics, id, p) });
  return (
    <div className="space-y-4">
      {f.nics.length === 0 && <Notice>No network device. The container won't be reachable over the network.</Notice>}
      {f.nics.map((n, i) => {
        const e = (k: string) => err(`network.${i}.${k}`);
        return (
          <ListItem key={n.id} title={<>Network device {i + 1} <span className="font-mono text-xs text-ink-3 ml-1">net{i}</span></>} removeLabel={`Remove network device ${i + 1}`} onRemove={() => set({ nics: without(f.nics, n.id) })}>
            <Grid cols={2}>
              <Field label="Name" htmlFor={`wz-nic-${n.id}-name`} error={e("name")} hint="The interface inside the container."><Input id={`wz-nic-${n.id}-name`} value={n.name} onChange={(ev) => setNic(n.id, { name: ev.target.value })} spellCheck={false} className="font-mono" /></Field>
              <NicCommon n={n} set={(p) => setNic(n.id, p)} o={o} err={e} idp={`wz-nic-${n.id}`} />
              <Field label="MTU" htmlFor={`wz-nic-${n.id}-mtu`} error={e("mtu")} hint="Optional. 1 uses the bridge's MTU."><Num id={`wz-nic-${n.id}-mtu`} value={n.mtu} onChange={(mtu) => setNic(n.id, { mtu })} placeholder="Default" /></Field>
            </Grid>
            <IpFields v={n} onChange={(p) => setNic(n.id, p)} e4={e("ipv4")} e6={e("ipv6")} manual idp={`wz-nic-${n.id}`} />
            <Grid cols={2} className="gap-y-2">
              <SwitchRow label="Firewall" hint="Apply the device's firewall to this network device." checked={n.firewall} onChange={(firewall) => setNic(n.id, { firewall })} />
              <SwitchRow label="Disconnected" hint="Present, but not plugged in." checked={n.disconnected} onChange={(disconnected) => setNic(n.id, { disconnected })} />
            </Grid>
          </ListItem>
        );
      })}
      <AddButton onClick={() => set({ nics: [...f.nics, { ...defaultCtNic(o, f.nics.length), bridge: f.nics.at(-1)?.bridge ?? o.bridges[0]?.id ?? "vmbr0" }] })} disabled={f.nics.length >= 32}>Add network device</AddButton>
    </div>
  );
}

export function CtDnsStep({ f, set, err }: StepProps<CtForm>) {
  return (
    <div className="space-y-6">
      <Section title="DNS" hint="Leave both empty to use the device's own settings.">
        <Grid>
          <Field label="DNS servers" htmlFor="wz-ns" error={err("dns.nameserver")} hint="IP addresses, separated by spaces or commas."><Input id="wz-ns" value={f.nameserver} onChange={(e) => set({ nameserver: e.target.value })} spellCheck={false} className="font-mono" placeholder="1.1.1.1 9.9.9.9" /></Field>
          <Field label="DNS domain" htmlFor="wz-sd" error={err("dns.searchdomain")} hint="Searched for short names, like lab.example."><Input id="wz-sd" value={f.searchdomain} onChange={(e) => set({ searchdomain: e.target.value })} spellCheck={false} className="font-mono" /></Field>
        </Grid>
      </Section>
      <Section title="Features" hint="What the container may do. Each one loosens its isolation a little.">
        <SwitchRow label="Nesting" hint="Lets the container run containers of its own, such as Docker." checked={f.nesting} onChange={(nesting) => set({ nesting })} />
        <SwitchRow label="keyctl" hint="Needed by some container tools. Unprivileged containers only." checked={f.keyctl && f.unprivileged} disabled={!f.unprivileged} onChange={(keyctl) => set({ keyctl })} />
        <SwitchRow label="FUSE" hint="Lets the container mount FUSE file systems." checked={f.fuse} onChange={(fuse) => set({ fuse })} />
      </Section>
    </div>
  );
}

export function CloudInitStep({ f, set, o, err }: StepProps<VmForm>) {
  const ip = (i: number): IpForm => f.ciIp[i] ?? emptyIp();
  const setIp = (i: number, p: Partial<IpForm>) => set({ ciIp: f.nics.map((_, k) => (k === i ? { ...ip(k), ...p } : ip(k))) });
  return (
    <div className="space-y-6">
      <SwitchRow label="Add a cloud-init drive" hint="For images that set themselves up on first boot: a user, a password or key and a network address, without opening the console." checked={f.ci} onChange={(ci) => set({ ci })} />
      {f.ci && (
        <>
          <Notice tone="info">Needs an image that has cloud-init installed, such as a distribution's cloud image. A regular installer ISO ignores it.</Notice>
          <Grid>
            <Field label="Storage" htmlFor="wz-ci-store" error={err("cloudInit.storage")}><Pick id="wz-ci-store" value={f.ciStorage} onChange={(v) => set({ ciStorage: v })} options={o.vmStorages.map((s) => ({ value: s.storage, label: s.storage }))} /></Field>
            <Field label="Format" htmlFor="wz-ci-type" error={err("cloudInit.type")} hint="Automatic suits most images. Windows images using Cloudbase-Init want ConfigDrive2.">
              <Pick id="wz-ci-type" value={f.ciType} onChange={(v) => set({ ciType: v })} options={[{ value: "", label: "Automatic" }, { value: "nocloud", label: "NoCloud" }, { value: "configdrive2", label: "ConfigDrive2" }]} />
            </Field>
            <Field label="User" htmlFor="wz-ci-user" error={err("cloudInit.user")} hint="Optional. Empty keeps the image's default user."><Input id="wz-ci-user" value={f.ciUser} onChange={(e) => set({ ciUser: e.target.value })} spellCheck={false} autoCapitalize="none" className="font-mono" /></Field>
            <Field label="Password" htmlFor="wz-ci-pw" error={err("cloudInit.password")} hint="Optional. Write-only: sent to Proxmox and never shown again."><Input id="wz-ci-pw" type="password" autoComplete="new-password" value={f.ciPassword} onChange={(e) => set({ ciPassword: e.target.value })} /></Field>
          </Grid>
          <Field label="SSH public keys" htmlFor="wz-ci-keys" error={err("cloudInit.sshKeys")} hint="Optional. One key per line. Write-only."><Textarea id="wz-ci-keys" value={f.ciKeys} onChange={(e) => set({ ciKeys: e.target.value })} rows={3} spellCheck={false} className="font-mono" placeholder="ssh-ed25519 AAAA…" /></Field>
          <SwitchRow label="Upgrade packages on first boot" checked={f.ciUpgrade} onChange={(ciUpgrade) => set({ ciUpgrade })} />
          <Grid>
            <Field label="DNS servers" htmlFor="wz-ci-ns" error={err("cloudInit.nameserver")} hint="Optional."><Input id="wz-ci-ns" value={f.ciNameserver} onChange={(e) => set({ ciNameserver: e.target.value })} spellCheck={false} className="font-mono" /></Field>
            <Field label="DNS domain" htmlFor="wz-ci-sd" error={err("cloudInit.searchdomain")} hint="Optional."><Input id="wz-ci-sd" value={f.ciSearch} onChange={(e) => set({ ciSearch: e.target.value })} spellCheck={false} className="font-mono" /></Field>
          </Grid>
          {f.nics.length === 0 ? (
            <Notice>Add a network device to set its address.</Notice>
          ) : (
            f.nics.map((n, i) => (
              <Section key={n.id} title={`Network device ${i + 1} address`} hint={`ipconfig${i}`}>
                <IpFields v={ip(i)} onChange={(p) => setIp(i, p)} e4={err(`cloudInit.ip.${i}.ipv4`)} e6={err(`cloudInit.ip.${i}.ipv6`)} manual={false} idp={`wz-ci-ip-${n.id}`} />
              </Section>
            ))
          )}
        </>
      )}
    </div>
  );
}

