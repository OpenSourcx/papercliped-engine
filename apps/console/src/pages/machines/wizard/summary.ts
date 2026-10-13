import { OS_GROUPS, type CtWizardSpec, type VmWizardSpec } from "@papercliped-engine/proxmox-client/wizard-schema";
import { formatBytes } from "../../../lib/storage.ts";
import type { WizardOptions } from "../../../data/engine/wizard.ts";

export interface Row {
  label: string;
  value: string[];
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const mem = (mb: number) => formatBytes(mb * 1024 ** 2);
const osLabel = (v: string) => OS_GROUPS.flatMap((g) => g.items).find((i) => i.value === v)?.label ?? v;
const baseName = (volid: string, o: WizardOptions | null) => o?.isos.find((i) => i.volid === volid)?.name ?? o?.templates.find((i) => i.volid === volid)?.name ?? volid.split("/").pop() ?? volid;

function ip4(x?: { mode: string; cidr?: string; gw?: string }): string | null {
  if (!x || x.mode === "none") return null;
  return x.mode === "static" ? `${x.cidr}${x.gw ? ` via ${x.gw}` : ""}` : x.mode === "dhcp" ? "DHCP" : "manual";
}
function ip6(x?: { mode: string; cidr?: string; gw?: string }): string | null {
  if (!x || x.mode === "none") return null;
  return x.mode === "static" ? `${x.cidr}${x.gw ? ` via ${x.gw}` : ""}` : x.mode === "auto" ? "SLAAC" : x.mode === "dhcp" ? "DHCP" : "manual";
}

/** The plain-words summary the Confirm step shows. It reads the request, so it can never hold a secret. */
export function summarize(kind: "vm" | "ct", spec: VmWizardSpec | CtWizardSpec, o: WizardOptions | null, vmid: number | null, owner: string): Row[] {
  const rows: Row[] = [];
  const g = spec.general;
  const common = (name: string): Row[] => [
    { label: kind === "vm" ? "Name" : "Hostname", value: [name] },
    { label: "Machine number", value: [vmid ? `#${vmid}` : "Next free number"] },
    { label: "Owner", value: [owner + (g.pool ? ` · resource group ${g.pool}` : "")] },
  ];
  const startup = [g.onboot ? "Starts at boot" : null, g.startup?.order !== undefined ? `start order ${g.startup.order}` : null, g.tags?.length ? `tags ${g.tags.join(", ")}` : null].filter(Boolean) as string[];
  if (kind === "vm") {
    const s = spec as VmWizardSpec;
    rows.push(...common(s.general.name));
    if (startup.length) rows.push({ label: "Startup", value: [startup.join(" · ")] });
    rows.push({ label: "Operating system", value: [osLabel(s.os.ostype)] });
    rows.push({ label: "Install media", value: [s.os.media === "iso" ? baseName(s.os.iso ?? "", o) : s.os.media === "cdrom" ? "Physical CD/DVD drive" : "None"] });
    const sys = [s.system.bios === "ovmf" ? "UEFI" : "SeaBIOS", s.system.machine === "q35" || s.system.machine?.startsWith("pc-q35") ? "q35" : "i440fx", s.system.efi ? "EFI disk" : null, s.system.tpm ? `TPM ${s.system.tpm.version.slice(1)}` : null, s.system.agent ? "guest agent" : null, s.system.vga && s.system.vga.type !== "std" ? `graphics ${s.system.vga.type}` : null].filter(Boolean) as string[];
    rows.push({ label: "System", value: [sys.join(" · ")] });
    rows.push({ label: "Disks", value: s.disks.length ? s.disks.map((d) => `${d.bus.toUpperCase()} · ${d.sizeGb} GiB on ${d.storage}${[d.format, d.cache && d.cache !== "none" ? `${d.cache} cache` : null, d.discard ? "discard" : null, d.ssd ? "SSD" : null, d.iothread ? "IO thread" : null, d.backup === false ? "not backed up" : null].filter(Boolean).map((x) => ` · ${x}`).join("")}`) : ["None"] });
    const cores = (s.cpu.sockets ?? 1) * s.cpu.cores;
    rows.push({ label: "CPU", value: [`${plural(s.cpu.sockets ?? 1, "socket")} × ${plural(s.cpu.cores, "core")} (${plural(cores, "vCPU")}) · ${s.cpu.type ?? "x86-64-v2-AES"}${s.cpu.limit ? ` · limit ${s.cpu.limit}` : ""}${s.cpu.numa ? " · NUMA" : ""}`] });
    rows.push({ label: "Memory", value: [`${mem(s.memory.mb)}${s.memory.balloonMinMb ? ` · ballooning down to ${mem(s.memory.balloonMinMb)}` : " · fixed"}`] });
    rows.push({ label: "Network", value: s.network.length ? s.network.map((n) => [n.model, `on ${n.bridge}`, n.vlan ? `VLAN ${n.vlan}` : null, n.firewall ? "firewall" : null, n.disconnected ? "disconnected" : null, n.rateMbps ? `${n.rateMbps} MB/s` : null].filter(Boolean).join(" · ")) : ["None"] });
    if (s.cloudInit) {
      rows.push({ label: "Cloud-init", value: [[s.cloudInit.user ? `user ${s.cloudInit.user}` : null, s.cloudInit.password ? "password set" : null, s.cloudInit.sshKeys ? "SSH keys set" : null, ...(s.cloudInit.ip ?? []).map((p, i) => [ip4(p.ipv4), ip6(p.ipv6)].filter(Boolean).length ? `net${i}: ${[ip4(p.ipv4), ip6(p.ipv6)].filter(Boolean).join(", ")}` : null)].filter(Boolean).join(" · ") || "Drive added"] });
    }
    const hw = s.hardware;
    const pass = [...(hw?.pci ?? []).map((p) => `PCI ${p.device ?? p.mapping}`), ...(hw?.usb ?? []).map((u) => (u.spice ? "USB via SPICE" : `USB ${u.host ?? u.mapping}`)), hw?.serial ? plural(hw.serial, "serial port") : null, hw?.audio ? "audio" : null].filter(Boolean) as string[];
    if (pass.length) rows.push({ label: "Hardware", value: pass });
  } else {
    const s = spec as CtWizardSpec;
    rows.push(...common(s.general.hostname));
    if (startup.length) rows.push({ label: "Startup", value: [startup.join(" · ")] });
    rows.push({ label: "Template", value: [baseName(s.template, o)] });
    rows.push({ label: "Privileges", value: [s.general.unprivileged === false ? "Privileged container" : "Unprivileged container"] });
    rows.push({ label: "Sign-in", value: [[s.general.password ? "root password set" : null, s.general.sshKeys ? "SSH key set" : null].filter(Boolean).join(" · ") || "No password or key"] });
    rows.push({ label: "Root disk", value: [`${s.disk.sizeGb} GiB on ${s.disk.storage}`] });
    rows.push({ label: "CPU", value: [`${plural(s.cpu.cores, "core")}${s.cpu.limit ? ` · limit ${s.cpu.limit}` : ""}`] });
    rows.push({ label: "Memory", value: [`${mem(s.memory.mb)} · swap ${s.memory.swapMb ? mem(s.memory.swapMb) : "off"}`] });
    rows.push({ label: "Network", value: s.network.length ? s.network.map((n) => [`${n.name ?? "eth"} on ${n.bridge}`, n.vlan ? `VLAN ${n.vlan}` : null, ip4(n.ipv4) ? `IPv4 ${ip4(n.ipv4)}` : null, ip6(n.ipv6) ? `IPv6 ${ip6(n.ipv6)}` : null, n.firewall ? "firewall" : null, n.rateMbps ? `${n.rateMbps} MB/s` : null].filter(Boolean).join(" · ")) : ["None"] });
    const dns = [s.dns?.nameserver?.length ? s.dns.nameserver.join(", ") : null, s.dns?.searchdomain].filter(Boolean);
    if (dns.length) rows.push({ label: "DNS", value: [dns.join(" · ")] });
    const f = [s.features?.nesting ? "nesting" : null, s.features?.keyctl ? "keyctl" : null, s.features?.fuse ? "FUSE" : null].filter(Boolean);
    if (f.length) rows.push({ label: "Features", value: [f.join(", ")] });
  }
  return rows;
}
