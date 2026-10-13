import { Link } from "react-router-dom";
import { BIOS, CACHE_MODES, CPU_TYPE_HINTS, DISK_BUSES, OS_GROUPS, SCSI_CONTROLLERS, VGA_TYPES, BUS_MAX, osDefaults, type OsType } from "@papercliped-engine/proxmox-client/wizard-schema";
import { formatBytes } from "../../../lib/storage.ts";
import { Field, Notice, Segmented, selectClass } from "../../../ui/primitives.tsx";
import { AddButton, Grid, ListItem, Num, Pick, Section, SwitchRow, patch, without } from "./fields.tsx";
import { applyOsDefaults, defaultDisk, nextKey, storageById, type DiskForm, type VmForm } from "./state.ts";
import type { StepProps } from "./types.ts";

type P = StepProps<VmForm>;

const SCSI_LABELS: Record<string, string> = {
  "virtio-scsi-single": "VirtIO SCSI single (recommended)",
  "virtio-scsi-pci": "VirtIO SCSI",
  lsi: "LSI 53C895A",
  lsi53c810: "LSI 53C810",
  megasas: "MegaRAID SAS 8708EM2",
  pvscsi: "VMware PVSCSI",
};
const VGA_LABELS: Record<string, string> = {
  std: "Default (std)",
  cirrus: "Cirrus Logic GD 5446",
  vmware: "VMware compatible",
  qxl: "SPICE (qxl)",
  qxl2: "SPICE, 2 displays",
  qxl3: "SPICE, 3 displays",
  qxl4: "SPICE, 4 displays",
  virtio: "VirtIO-GPU",
  "virtio-gl": "VirtIO-GPU with 3D (VirGL)",
  serial0: "Serial terminal 0",
  serial1: "Serial terminal 1",
  serial2: "Serial terminal 2",
  serial3: "Serial terminal 3",
  none: "None",
};
const BUS_LABELS = { scsi: "SCSI", virtio: "VirtIO block", sata: "SATA", ide: "IDE" } as const;

/** An ISO's file name is a good hint at the operating system. */
const guessOs = (name: string): OsType | null => (/win(dows)?[-_ .]?11|win11|server[-_ ]?20(22|25)/i.test(name) ? "win11" : /win(dows)?[-_ .]?10|win10|server[-_ ]?201[69]/i.test(name) ? "win10" : null);

export function OsStep({ f, set, o, err, device, onClose }: P & { device: string; onClose: () => void }) {
  const d = osDefaults(f.ostype);
  return (
    <div className="space-y-6">
      <Field label="Install media" error={err("os.media")}>
        <Segmented value={f.media} onChange={(media) => set({ media })} label="Install media" options={[{ value: "iso", label: "ISO image" }, { value: "cdrom", label: "Physical drive" }, { value: "none", label: "No media" }]} />
      </Field>
      {f.media === "iso" && (
        <Field label="ISO image" htmlFor="wz-iso" error={err("os.iso")} hint={o.isos.length === 0 ? undefined : "From the device's storage."}>
          {o.isos.length === 0 ? (
            <p className="text-compact text-ink-2">No ISO images on {device} yet. <Link onClick={onClose} to={`/${device}/storage`} className="text-accent hover:underline">Upload one or download it from a URL</Link> in Storage.</p>
          ) : (
            <select id="wz-iso" value={f.iso} onChange={(e) => set(osForIso(f, e.target.value, o.isos.find((t) => t.volid === e.target.value)?.name ?? ""))} className={selectClass}>
              <option value="">Choose an image…</option>
              {o.isos.map((t) => <option key={t.volid} value={t.volid}>{t.name}{t.size ? ` · ${formatBytes(t.size)}` : ""}</option>)}
            </select>
          )}
        </Field>
      )}
      {f.media === "cdrom" && <Notice>The machine gets the device's own CD or DVD drive. Boot from it to install.</Notice>}
      {f.media === "none" && <Notice>No install media. The machine boots from its disk or the network.</Notice>}
      <Field label="Guest operating system" htmlFor="wz-os" error={err("os.ostype")} hint="Sets the recommended hardware for it; you can change every choice in the next steps.">
        <select id="wz-os" value={f.ostype} onChange={(e) => set(applyOsDefaults(f, e.target.value as OsType))} className={selectClass}>
          {OS_GROUPS.map((g) => <optgroup key={g.group} label={g.group}>{g.items.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}</optgroup>)}
        </select>
      </Field>
      {d.note && <Notice tone="info" title="Recommended for this system">{d.note}</Notice>}
    </div>
  );
}

/** When the chosen ISO names Windows, move to Windows' hardware once, unless the person already chose another system. */
export const osForIso = (f: VmForm, iso: string, name: string): VmForm => {
  const guess = guessOs(name);
  const next = { ...f, iso };
  return guess && f.ostype === "l26" ? applyOsDefaults(next, guess) : next;
};

export function SystemStep({ f, set, o, err }: P) {
  const q35 = f.machine === "q35" || f.machine.startsWith("pc-q35-");
  const vgaMem = !(f.vgaType.startsWith("serial") || f.vgaType === "none");
  const stores = o.vmStorages.map((s) => ({ value: s.storage, label: s.storage }));
  return (
    <div className="space-y-6">
      <Grid>
        <Field label="Graphic card" htmlFor="wz-vga" error={err("system.vga.type")}>
          <Pick id="wz-vga" value={f.vgaType} onChange={(v) => set({ vgaType: v, vgaMemory: "" })} options={VGA_TYPES.map((v) => ({ value: v, label: VGA_LABELS[v] }))} />
        </Field>
        {vgaMem && (
          <Field label="Video memory" htmlFor="wz-vgamem" error={err("system.vga.memory")} hint="Optional. Leave empty for the default.">
            <Num id="wz-vgamem" value={f.vgaMemory} onChange={(v) => set({ vgaMemory: v })} placeholder="Default" suffix="MiB" />
          </Field>
        )}
        <Field label="Machine type" htmlFor="wz-machine" error={err("system.machine")} hint={q35 ? "q35 is a newer chipset with PCIe, needed for PCIe passthrough." : "The classic chipset. The most compatible."}>
          <Pick id="wz-machine" value={f.machine} onChange={(v) => set({ machine: v })} options={[{ value: "pc", label: "Default (i440fx)" }, { value: "q35", label: "q35" }, ...o.machines.map((m) => ({ value: m, label: m }))]} />
        </Field>
        <Field label="BIOS" error={err("system.bios")} hint={f.bios === "ovmf" ? "UEFI. Needed for Windows 11 and Secure Boot." : "SeaBIOS. The classic BIOS."}>
          <Segmented value={f.bios} onChange={(bios) => set({ bios })} label="BIOS" options={BIOS.map((b) => ({ value: b, label: b === "ovmf" ? "UEFI (OVMF)" : "SeaBIOS" }))} />
        </Field>
        <Field label="SCSI controller" htmlFor="wz-scsi" error={err("system.scsihw")}>
          <Pick id="wz-scsi" value={f.scsihw} onChange={(v) => set({ scsihw: v, disks: f.disks.map((d) => cleanDisk(d, v)) })} options={SCSI_CONTROLLERS.map((c) => ({ value: c, label: SCSI_LABELS[c] }))} />
        </Field>
      </Grid>
      <SwitchRow label="QEMU guest agent" hint="Lets the device see the machine's address and shut it down cleanly. Install the agent inside the machine too." checked={f.agent} onChange={(agent) => set({ agent })} />
      {f.bios === "ovmf" && (
        <Section title="EFI disk" hint="Keeps UEFI settings and boot entries between restarts.">
          <SwitchRow label="Add an EFI disk" checked={f.efi} onChange={(efi) => set({ efi })} />
          {f.efi && (
            <Grid>
              <Field label="EFI storage" htmlFor="wz-efistore" error={err("system.efi.storage")}><Pick id="wz-efistore" value={f.efiStorage} onChange={(v) => set({ efiStorage: v })} options={stores} /></Field>
              <SwitchRow label="Pre-enroll keys" hint="Includes the Microsoft and distribution Secure Boot keys. Turn off to use your own." checked={f.preEnrolled} onChange={(preEnrolled) => set({ preEnrolled })} />
            </Grid>
          )}
        </Section>
      )}
      <Section title="TPM" hint="A virtual TPM. Windows 11 needs version 2.0.">
        <SwitchRow label="Add a TPM" checked={f.tpm} onChange={(tpm) => set({ tpm })} />
        {f.tpm && (
          <Grid>
            <Field label="TPM storage" htmlFor="wz-tpmstore" error={err("system.tpm.storage")}><Pick id="wz-tpmstore" value={f.tpmStorage} onChange={(v) => set({ tpmStorage: v })} options={stores} /></Field>
            <Field label="Version" htmlFor="wz-tpmver"><Pick id="wz-tpmver" value={f.tpmVersion} onChange={(v) => set({ tpmVersion: v })} options={[{ value: "v2.0", label: "2.0" }, { value: "v1.2", label: "1.2" }]} /></Field>
          </Grid>
        )}
      </Section>
    </div>
  );
}

/** A disk's options that its bus or the controller can't do are switched off, so the form never holds an invalid mix. */
export function cleanDisk(d: DiskForm, scsihw: string): DiskForm {
  const iothreadOk = d.bus === "virtio" || (d.bus === "scsi" && scsihw === "virtio-scsi-single");
  return { ...d, ssd: d.bus === "virtio" ? false : d.ssd, iothread: iothreadOk ? d.iothread : false };
}

export function DisksStep({ f, set, o, err }: P) {
  const setDisk = (id: number, p: Partial<DiskForm>) => set({ disks: f.disks.map((d) => (d.id === id ? cleanDisk({ ...d, ...p }, f.scsihw) : d)) });
  const count = (bus: string) => f.disks.filter((d) => d.bus === bus).length;
  return (
    <div className="space-y-4">
      {f.disks.length === 0 && <Notice>No disks. The machine can boot from install media or the network, and you can add disks later.</Notice>}
      {f.disks.map((d, i) => {
        const store = storageById(o.vmStorages, d.storage);
        const formats = store?.formats ?? ["raw"];
        const iothreadOk = d.bus === "virtio" || (d.bus === "scsi" && f.scsihw === "virtio-scsi-single");
        const e = (k: string) => err(`disks.${i}.${k}`);
        return (
          <ListItem key={d.id} title={<>Disk {i + 1} <span className="font-mono text-xs text-ink-3 ml-1">{d.bus}</span></>} removeLabel={`Remove disk ${i + 1}`} onRemove={() => set({ disks: without(f.disks, d.id) })}>
            <Grid cols={3}>
              <Field label="Bus" htmlFor={`wz-bus-${d.id}`} error={e("bus")}>
                <Pick id={`wz-bus-${d.id}`} value={d.bus} onChange={(bus) => setDisk(d.id, { bus })} options={DISK_BUSES.map((b) => ({ value: b, label: BUS_LABELS[b], disabled: count(b) >= BUS_MAX[b] && d.bus !== b }))} />
              </Field>
              <Field label="Storage" htmlFor={`wz-store-${d.id}`} error={e("storage")}>
                <Pick id={`wz-store-${d.id}`} value={d.storage} onChange={(storage) => setDisk(d.id, { storage, format: storageById(o.vmStorages, storage)?.formats.includes(d.format) ? d.format : "" })} options={o.vmStorages.map((s) => ({ value: s.storage, label: `${s.storage}${s.avail !== null ? ` · ${formatBytes(s.avail)} free` : ""}` }))} />
              </Field>
              <Field label="Disk size" htmlFor={`wz-size-${d.id}`} error={e("sizeGb")}>
                <Num id={`wz-size-${d.id}`} value={d.sizeGb} onChange={(sizeGb) => setDisk(d.id, { sizeGb })} suffix="GiB" />
              </Field>
              {formats.length > 1 && (
                <Field label="Format" htmlFor={`wz-fmt-${d.id}`} error={e("format")}>
                  <Pick id={`wz-fmt-${d.id}`} value={d.format} onChange={(format) => setDisk(d.id, { format })} options={[{ value: "", label: "Default" }, ...formats.map((x) => ({ value: x, label: x === "raw" ? "Raw" : x === "qcow2" ? "QCOW2" : "VMDK" }))]} />
                </Field>
              )}
              <Field label="Cache" htmlFor={`wz-cache-${d.id}`} error={e("cache")}>
                <Pick id={`wz-cache-${d.id}`} value={d.cache} onChange={(cache) => setDisk(d.id, { cache })} options={[{ value: "", label: "Default (no cache)" }, ...CACHE_MODES.filter((c) => c !== "none").map((c) => ({ value: c, label: c === "directsync" ? "Direct sync" : c === "writethrough" ? "Write through" : c === "writeback" ? "Write back" : "Write back (unsafe)" }))]} />
              </Field>
            </Grid>
            <Grid cols={2} className="gap-y-2">
              <SwitchRow label="Discard" hint="Frees space on the storage when the machine deletes files." checked={d.discard} onChange={(discard) => setDisk(d.id, { discard })} />
              <SwitchRow label="SSD emulation" hint={d.bus === "virtio" ? "Not available on a VirtIO block disk." : "Tells the machine this is an SSD."} checked={d.ssd} disabled={d.bus === "virtio"} onChange={(ssd) => setDisk(d.id, { ssd })} />
              <SwitchRow label="IO thread" hint={iothreadOk ? "Gives the disk its own thread for better speed." : "Needs a VirtIO block disk, or SCSI with the VirtIO SCSI single controller."} checked={d.iothread} disabled={!iothreadOk} onChange={(iothread) => setDisk(d.id, { iothread })} />
              <SwitchRow label="Include in backups" checked={d.backup} onChange={(backup) => setDisk(d.id, { backup })} />
            </Grid>
          </ListItem>
        );
      })}
      <AddButton onClick={() => set({ disks: [...f.disks, cleanDisk(defaultDisk(o, f.disks.at(-1)?.bus ?? "scsi", 32, { id: nextKey(), storage: f.disks.at(-1)?.storage ?? o.vmStorages[0]?.storage ?? "", iothread: f.disks.at(-1)?.iothread, discard: f.disks.at(-1)?.discard }), f.scsihw)] })} disabled={f.disks.length >= 30}>Add disk</AddButton>
      {o.vmStorages.length === 0 && <Notice tone="warning" title="No storage for disks">This device has no storage that can hold virtual disks that you may use. Add one in Storage settings.</Notice>}
    </div>
  );
}

export function CpuStep({ f, set, o, err }: P) {
  const total = (Number(f.sockets) || 0) * (Number(f.cores) || 0);
  const known = new Set(o.cpuTypes.common);
  const more = o.cpuTypes.host.map((h) => h.name).filter((nm) => !known.has(nm) && !o.cpuTypes.custom.includes(nm));
  return (
    <div className="space-y-6">
      <Grid cols={3}>
        <Field label="Sockets" htmlFor="wz-sockets" error={err("cpu.sockets")}><Num id="wz-sockets" value={f.sockets} onChange={(v) => set({ sockets: v })} /></Field>
        <Field label="Cores" htmlFor="wz-cores" error={err("cpu.cores")} hint={total > 0 ? `${total} virtual CPU${total === 1 ? "" : "s"} in total.` : undefined}><Num id="wz-cores" value={f.cores} onChange={(v) => set({ cores: v })} /></Field>
        <Field label="Active CPUs" htmlFor="wz-vcpus" error={err("cpu.vcpus")} hint="Optional. Start with fewer than the total.">
          <Num id="wz-vcpus" value={f.vcpus} onChange={(v) => set({ vcpus: v })} placeholder={total ? String(total) : ""} />
        </Field>
      </Grid>
      <Field label="CPU type" htmlFor="wz-cpu" error={err("cpu.type")} hint={CPU_TYPE_HINTS[f.cpuType]}>
        <select id="wz-cpu" value={f.cpuType} onChange={(e) => set({ cpuType: e.target.value })} className={selectClass}>
          <optgroup label="Common">{o.cpuTypes.common.map((c) => <option key={c} value={c}>{c}</option>)}</optgroup>
          {o.cpuTypes.custom.length > 0 && <optgroup label="Custom models">{o.cpuTypes.custom.map((c) => <option key={c} value={c}>{c}</option>)}</optgroup>}
          {more.length > 0 && <optgroup label="Other models on this device">{more.map((c) => <option key={c} value={c}>{c}</option>)}</optgroup>}
        </select>
      </Field>
      <Grid cols={2}>
        <Field label="CPU limit" htmlFor="wz-limit" error={err("cpu.limit")} hint="Optional. Cores' worth of time the machine may use, like 2.5. Empty is unlimited."><Num id="wz-limit" value={f.cpuLimit} onChange={(v) => set({ cpuLimit: v })} placeholder="Unlimited" /></Field>
        <Field label="CPU weight" htmlFor="wz-units" error={err("cpu.units")} hint="Optional. Higher gets more time when the device is busy. The usual weight is 100."><Num id="wz-units" value={f.cpuUnits} onChange={(v) => set({ cpuUnits: v })} placeholder="Default" /></Field>
      </Grid>
      <SwitchRow label="NUMA" hint="Lets the machine see the device's memory layout. Helps with many cores and memory hot-plug." checked={f.numa} onChange={(numa) => set({ numa })} />
    </div>
  );
}

const MEM_PRESETS = [1024, 2048, 4096, 8192, 16384];

export function MemoryStep({ f, set, err }: P) {
  const mb = Number(f.memoryMb);
  return (
    <div className="space-y-6">
      <Field label="Memory" htmlFor="wz-mem" error={err("memory.mb")} hint={mb >= 16 ? `${formatBytes(mb * 1024 ** 2)}.` : "In MiB."}>
        <Num id="wz-mem" value={f.memoryMb} onChange={(v) => set({ memoryMb: v })} suffix="MiB" />
        <div className="flex flex-wrap gap-1.5 mt-2">
          {MEM_PRESETS.map((p) => (
            <button key={p} type="button" onClick={() => set({ memoryMb: String(p) })} aria-pressed={mb === p} className={`transition-control rounded-full border px-2.5 h-7 text-xs tabular-nums ${mb === p ? "border-accent/60 bg-accent-soft text-ink" : "border-line text-ink-2 hover:border-line-strong"}`}>{p / 1024} GiB</button>
          ))}
        </div>
      </Field>
      <SwitchRow label="Ballooning" hint="The device can take unused memory back from the machine when it is short. Memory then runs between the minimum and the amount above." checked={f.balloon} onChange={(balloon) => set({ balloon, balloonMin: balloon && !f.balloonMin ? String(Math.max(16, Math.floor(mb / 2))) : f.balloonMin })} />
      {f.balloon && (
        <Grid>
          <Field label="Minimum memory" htmlFor="wz-balloon" error={err("memory.balloonMinMb")} hint="The least the machine keeps."><Num id="wz-balloon" value={f.balloonMin} onChange={(v) => set({ balloonMin: v })} suffix="MiB" /></Field>
          <Field label="Memory shares" htmlFor="wz-shares" error={err("memory.shares")} hint="Optional. Higher gets more when memory is short."><Num id="wz-shares" value={f.shares} onChange={(v) => set({ shares: v })} placeholder="Default" /></Field>
        </Grid>
      )}
      {!f.balloon && <p className="text-xs text-ink-3">Fixed memory: the machine always has the full amount.</p>}
    </div>
  );
}

