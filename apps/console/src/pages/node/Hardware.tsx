import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, FileText, Search, Usb } from "lucide-react";
import { dcApi, type PciDevice } from "../../data/engine/dcApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { formatBytes, formatUptime } from "../../lib/storage.ts";
import { Modal } from "../../ui/Modal.tsx";
import { BarMeter } from "../../ui/meters.tsx";
import { Button, Card, Chip, EmptyState, Input, Notice, PageFrame, PageHeader, SectionTitle, Tabs } from "../../ui/primitives.tsx";
import { Async, changedValues, LiveOnly, NodeSwitcher, SaveBar, SchemaForm, useNodeName } from "./common.tsx";
import { CopyButton, DataTable, Fact, Td } from "./dc.tsx";
import type { Values } from "../../data/engine/nodeApi.ts";

type Tab = "overview" | "devices" | "packages" | "options" | "report";

const pct = (used: number | null, total: number | null) => (used !== null && total ? (used / total) * 100 : 0);

function Overview() {
  const { node, name } = useNodeName();
  const q = useQuery({ queryKey: ["node", "hardware", name], queryFn: () => dcApi.hardware(node), retry: 1 });
  const [flags, setFlags] = useState(false);
  return (
    <Async q={q}>
      {(h) => (
        <div className="space-y-4">
          {h.statusDenied && <Notice tone="info" title="Your Proxmox account can't read this node's status">Proxmox needs Sys.Audit on the node.</Notice>}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <SectionTitle>Processor</SectionTitle>
              {h.cpu ? (
                <div className="mt-3 space-y-4">
                  <div className="font-medium">{h.cpu.model ?? "Unknown model"}</div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <Fact label="Sockets">{h.cpu.sockets ?? "–"}</Fact>
                    <Fact label="Cores">{h.cpu.cores ?? "–"}</Fact>
                    <Fact label="Threads">{h.cpu.threads ?? "–"}</Fact>
                    <Fact label="Clock">{h.cpu.mhz ? `${Math.round(h.cpu.mhz)} MHz` : "–"}</Fact>
                  </div>
                  <Fact label="Virtualization">{h.cpu.hvm === null ? "Unknown" : h.cpu.hvm ? "Supported (KVM can run virtual machines)" : "Not available: turn on VT-x or AMD-V in the firmware"}</Fact>
                  {h.cpu.usage !== null && <BarMeter label="Busy" pct={h.cpu.usage * 100} value={`${(h.cpu.usage * 100).toFixed(1)}%${h.cpu.ioWait !== null ? ` · waiting on disks ${(h.cpu.ioWait * 100).toFixed(1)}%` : ""}`} />}
                  {h.cpu.load && <Fact label="Load average (1, 5, 15 minutes)"><span className="font-mono tabular-nums">{h.cpu.load.map((x) => x.toFixed(2)).join("  ")}</span></Fact>}
                  {h.cpu.flags && (
                    <div>
                      <Button size="sm" variant="ghost" onClick={() => setFlags(!flags)} aria-expanded={flags}>{flags ? "Hide CPU flags" : "Show CPU flags"}</Button>
                      {flags && <p className="mt-2 text-xs font-mono text-ink-2 break-words">{h.cpu.flags}</p>}
                    </div>
                  )}
                </div>
              ) : <p className="text-compact text-ink-3 mt-3">Not available.</p>}
            </Card>
            <Card className="p-5">
              <SectionTitle>Memory and storage</SectionTitle>
              <div className="mt-3 space-y-4">
                {h.memory?.total ? <BarMeter label="Memory" pct={pct(h.memory.used, h.memory.total)} value={`${formatBytes(h.memory.used ?? 0)} of ${formatBytes(h.memory.total)}`} /> : null}
                {h.swap?.total ? <BarMeter label="Swap" pct={pct(h.swap.used, h.swap.total)} value={`${formatBytes(h.swap.used ?? 0)} of ${formatBytes(h.swap.total)}`} /> : <p className="text-compact text-ink-3">No swap space.</p>}
                {h.rootfs?.total ? <BarMeter label="System disk" pct={pct(h.rootfs.used, h.rootfs.total)} value={`${formatBytes(h.rootfs.used ?? 0)} of ${formatBytes(h.rootfs.total)}`} /> : null}
                {h.ksm?.shared ? <Fact label="Memory shared between machines (KSM)">{formatBytes(h.ksm.shared)}</Fact> : null}
              </div>
            </Card>
            <Card className="p-5 lg:col-span-2">
              <SectionTitle>System</SectionTitle>
              <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-4">
                <Fact label="Proxmox VE">{h.pveVersion ?? "–"}</Fact>
                <Fact label="Boot mode">{h.boot?.mode ? (h.boot.mode === "efi" ? "UEFI" : "Legacy BIOS") : "–"}{h.boot?.mode === "efi" && h.boot.secureboot !== null ? <span className="text-ink-3">{h.boot.secureboot ? " · Secure Boot on" : " · Secure Boot off"}</span> : null}</Fact>
                <Fact label="Kernel">{h.kernelRelease ?? "–"}{h.machine ? <span className="text-ink-3"> · {h.machine}</span> : null}</Fact>
                <Fact label="Up for">{h.uptime !== null ? formatUptime(h.uptime) : "–"}</Fact>
              </div>
              {h.kernel && <p className="text-xs text-ink-3 mt-3 font-mono break-words">{h.kernel}</p>}
            </Card>
          </div>
        </div>
      )}
    </Async>
  );
}

function VgpuModal({ pci, onClose }: { pci: PciDevice; onClose: () => void }) {
  const { node, name } = useNodeName();
  const q = useQuery({ queryKey: ["node", "mdev", name, pci.id], queryFn: () => dcApi.mdev(node, pci.id), retry: 0 });
  return (
    <Modal size="lg" icon={<Cpu className="h-5 w-5" />} title="Mediated device types" subtitle={`${pci.deviceName ?? pci.id} (${pci.id})`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {q.isPending ? <p className="text-compact text-ink-3">Asking the device…</p> : q.error ? <Notice tone="warning" title="No types listed">{errorText(q.error)}</Notice> : q.data.types.length === 0 ? <p className="text-compact text-ink-3">This device offers no mediated device types. A vendor driver (for example for vGPU) has to be installed first.</p> : (
        <DataTable label="Mediated device types" head={["Type", "Name", "Available", "Details"]} min={460}>
          {q.data.types.map((t) => <tr key={t.type} className="border-b border-line last:border-0"><Td mono>{t.type}</Td><Td>{t.name ?? "–"}</Td><Td mono>{t.available ?? "–"}</Td><Td className="text-ink-2 whitespace-pre-wrap">{t.description ?? ""}</Td></tr>)}
        </DataTable>
      )}
    </Modal>
  );
}

function Devices() {
  const { node, name } = useNodeName();
  const q = useQuery({ queryKey: ["node", "hardware", name], queryFn: () => dcApi.hardware(node), retry: 1 });
  const [filter, setFilter] = useState("");
  const [vgpu, setVgpu] = useState<PciDevice | null>(null);
  const f = filter.trim().toLowerCase();
  return (
    <Async q={q}>
      {(h) => {
        const pci = (h.pci ?? []).filter((d) => !f || `${d.id} ${d.vendorName} ${d.deviceName} ${d.class}`.toLowerCase().includes(f));
        const usb = (h.usb ?? []).filter((d) => !f || `${d.vendid}:${d.prodid} ${d.manufacturer} ${d.product} ${d.usbpath}`.toLowerCase().includes(f));
        return (
          <div className="space-y-4">
            <div className="relative max-w-sm">
              <Search className="h-4 w-4 text-ink-3 absolute left-3 top-3" aria-hidden />
              <Input className="pl-9" placeholder="Filter devices" aria-label="Filter devices" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <Card>
              <div className="p-5 pb-2"><SectionTitle>PCI devices</SectionTitle><p className="text-compact text-ink-3 mt-1">Devices sharing an IOMMU group can only be passed through to a machine together. Map a device in Resource mappings to pass it through by name.</p></div>
              {h.pciDenied ? <p className="px-5 pb-5 text-compact text-ink-3">Your Proxmox account can't list PCI devices (it needs Sys.Audit or Sys.Modify on the node).</p> : pci.length === 0 ? <p className="px-5 pb-5 text-compact text-ink-3">No devices match.</p> : (
                <DataTable label="PCI devices" head={["Address", "Vendor", "Device", "Class", "IOMMU group", ""]} min={760}>
                  {pci.map((d) => (
                    <tr key={d.id} className="border-b border-line last:border-0">
                      <Td mono>{d.id}</Td>
                      <Td>{d.vendorName ?? d.vendor ?? "–"}</Td>
                      <Td>{d.deviceName ?? d.device ?? "–"}{d.subsystemDeviceName ? <div className="text-xs text-ink-3">{d.subsystemVendorName} {d.subsystemDeviceName}</div> : null}</Td>
                      <Td mono>{d.class ?? "–"}</Td>
                      <Td mono>{d.iommuGroup ?? <span className="text-ink-3">none</span>}</Td>
                      <Td>{d.mdev ? <Button size="sm" variant="ghost" onClick={() => setVgpu(d)}>Mediated types</Button> : null}</Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Card>
            <Card>
              <div className="p-5 pb-2"><SectionTitle>USB devices</SectionTitle></div>
              {h.usbDenied ? <p className="px-5 pb-5 text-compact text-ink-3">Your Proxmox account can't list USB devices (it needs Sys.Modify on the node).</p> : usb.length === 0 ? <EmptyState icon={<Usb className="h-5 w-5" />} title="No USB devices" body={f ? "Nothing matches the filter." : "Nothing is plugged in, or the node has no USB ports."} /> : (
                <DataTable label="USB devices" head={["ID", "Device", "Bus and port", "Speed", "Path"]} min={640}>
                  {usb.map((d) => (
                    <tr key={`${d.busnum}-${d.devnum}-${d.usbpath}`} className="border-b border-line last:border-0">
                      <Td mono>{d.vendid}:{d.prodid}</Td>
                      <Td>{[d.manufacturer, d.product].filter(Boolean).join(" ") || "–"}{d.serial ? <div className="text-xs text-ink-3 font-mono">{d.serial}</div> : null}</Td>
                      <Td mono>{d.busnum}-{d.devnum} · port {d.port ?? "–"}</Td>
                      <Td mono>{d.speed ? `${d.speed} Mb/s` : "–"}</Td>
                      <Td mono>{d.usbpath ?? "–"}</Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Card>
            {vgpu && <VgpuModal pci={vgpu} onClose={() => setVgpu(null)} />}
          </div>
        );
      }}
    </Async>
  );
}

function Packages() {
  const { node, name } = useNodeName();
  const q = useQuery({ queryKey: ["node", "versions", name], queryFn: () => dcApi.versions(node), retry: 1 });
  const [filter, setFilter] = useState("");
  return (
    <Async q={q}>
      {(v) => {
        const f = filter.trim().toLowerCase();
        const shown = v.packages.filter((p) => !f || p.package.includes(f));
        const text = v.packages.map((p) => `${p.package}: ${p.version}`).join("\n");
        return (
          <Card>
            <div className="p-5 pb-3 flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1 basis-60"><SectionTitle>Package versions</SectionTitle><p className="text-compact text-ink-3 mt-1">{v.packages.length} Proxmox packages installed{v.manager ? ` · manager ${v.manager}` : ""}. Support asks for this list.</p></div>
              <Input className="max-w-56" placeholder="Filter packages" aria-label="Filter packages" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <CopyButton text={text} label="Copy list" />
            </div>
            <DataTable label="Package versions" head={["Package", "Version", "State"]} min={420}>
              {shown.map((p) => <tr key={p.package} className="border-b border-line last:border-0"><Td mono>{p.package}</Td><Td mono>{p.version}{p.running ? <Chip className="ml-2">running</Chip> : null}</Td><Td className="text-ink-2">{p.state ?? ""}</Td></tr>)}
            </DataTable>
          </Card>
        );
      }}
    </Async>
  );
}

const OPTION_KEYS = ["startall-onboot-delay", "wakeonlan", "ballooning-target", "location"];

function Options() {
  const { node, name } = useNodeName();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["node", "config", name], queryFn: () => dcApi.nodeConfig(node), retry: 1 });
  const [draft, setDraft] = useState<Values | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (v: Values) => dcApi.saveNodeConfig(node, v, q.data?.digest ?? null),
    onSuccess: () => {
      setSaved(true);
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ["node", "config"] });
      void qc.invalidateQueries({ queryKey: ["node", "hardware"] });
    },
  });
  return (
    <Async q={q}>
      {(c) => {
        const value = draft ?? c.values;
        const keys = ["description", ...OPTION_KEYS];
        const diff = changedValues(c.values, value, keys);
        const dirty = Object.keys(diff).length > 0;
        return (
          <Card className="p-5">
            <SectionTitle>Notes and options for {c.node}</SectionTitle>
            <p className="text-compact text-ink-3 mt-1 mb-5">The notes show on the node's page in Proxmox too. Boot delay and Wake on LAN apply to this node only.</p>
            <SchemaForm schema={c.schema} value={value} onChange={(v) => { setDraft(v); setSaved(false); }} only={keys} labels={{ description: "Notes", "startall-onboot-delay": "Start delay after boot (seconds)", wakeonlan: "Wake on LAN", "ballooning-target": "Memory ballooning target (%)" }} hints={{ wakeonlan: "Other nodes in the cluster can switch this node on with its MAC address (mac=aa:bb:cc:dd:ee:ff)." }} />
            <SaveBar dirty={dirty} busy={save.isPending} saved={saved} error={save.error ? errorText(save.error) : null} onSave={() => save.mutate(diff)} onReset={() => setDraft(null)} />
          </Card>
        );
      }}
    </Async>
  );
}

function Report() {
  const { node, name } = useNodeName();
  const [want, setWant] = useState(false);
  const q = useQuery({ queryKey: ["node", "report", name], queryFn: () => dcApi.report(node), enabled: want, retry: 0, staleTime: 0 });
  return (
    <Card className="p-5">
      <SectionTitle>System report</SectionTitle>
      <p className="text-compact text-ink-3 mt-1 mb-4">The text Proxmox support asks for: versions, network and storage layout, logs and hardware. It can take a few seconds to gather. Read it before you share it.</p>
      {!want ? <Button variant="primary" onClick={() => setWant(true)}><FileText className="h-4 w-4" />Generate report</Button> : q.isPending ? <p className="text-compact text-ink-3">Gathering the report…</p> : q.error ? <Notice tone="critical" title="Couldn't make the report">{errorText(q.error)}</Notice> : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2"><CopyButton text={q.data.report} label="Copy report" /><Button size="sm" onClick={() => void q.refetch()} loading={q.isFetching}>Run again</Button></div>
          {q.data.truncated && <Notice tone="info">The report is long; only the first part is shown.</Notice>}
          <pre aria-label="System report" className="rounded-lg bg-code border border-line p-3 text-xs leading-relaxed font-mono text-ink-2 max-h-[60vh] overflow-auto whitespace-pre-wrap break-all">{q.data.report}</pre>
        </div>
      )}
    </Card>
  );
}

export function HardwarePage() {
  const { name, multi } = useNodeName();
  const [tab, setTab] = useState<Tab>("overview");
  return (
    <PageFrame width="6xl">
      <PageHeader title="Hardware" subtitle={`What ${name} is made of, what runs on it, and its notes.`} actions={multi ? <NodeSwitcher /> : undefined} />
      <LiveOnly>
        <Tabs<Tab> value={tab} onChange={setTab} className="mb-6" tabs={[{ id: "overview", label: "Overview" }, { id: "devices", label: "PCI and USB" }, { id: "packages", label: "Package versions" }, { id: "options", label: "Notes and options" }, { id: "report", label: "System report" }]} />
        {tab === "overview" ? <Overview /> : tab === "devices" ? <Devices /> : tab === "packages" ? <Packages /> : tab === "options" ? <Options /> : <Report />}
      </LiveOnly>
    </PageFrame>
  );
}
