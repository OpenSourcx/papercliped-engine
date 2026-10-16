import { useEffect, useState, type ReactNode } from "react";
import { AudioLines, Cpu, HardDrive, Monitor, Pencil, Plus, ShieldCheck, SquareTerminal, Trash2 } from "lucide-react";
import type { MachineOptions } from "../../data/api.ts";
import { useGuestApi, type ItemName } from "../../data/engine/guestApi.ts";
import { useEngine } from "../../data/store.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Field, Input, Notice, SectionTitle, Segmented, Select } from "../../ui/primitives.tsx";
import { Check, ConfirmTypeModal } from "../disks/common.tsx";
import { busyNotice, PendingChip, Row, useSave, type DevCtx } from "./MachineKit.tsx";

/** A VM's firmware and extra devices (BIOS, display, serial ports, audio, EFI disk, TPM), and the host devices handed to a machine. */

const VGA: [string, string][] = [
  ["std", "Standard VGA (default)"],
  ["virtio", "VirtIO-GPU"],
  ["virtio-gl", "VirtIO-GPU with 3D (VirGL)"],
  ["qxl", "SPICE (QXL)"],
  ["vmware", "VMware compatible"],
  ["cirrus", "Cirrus (old; not recommended)"],
  ["qxl2", "SPICE, 2 monitors"],
  ["qxl3", "SPICE, 3 monitors"],
  ["qxl4", "SPICE, 4 monitors"],
  ["serial0", "Serial terminal 0"],
  ["serial1", "Serial terminal 1"],
  ["serial2", "Serial terminal 2"],
  ["serial3", "Serial terminal 3"],
  ["none", "None (no display)"],
];
const vgaLabel = (t: string) => VGA.find(([v]) => v === t)?.[1] ?? t;
const AUDIO: [string, string][] = [["ich9-intel-hda", "Intel HD Audio (ICH9)"], ["intel-hda", "Intel HD Audio"], ["AC97", "AC97"]];

function useStorages() {
  const engine = useEngine();
  const [opts, setOpts] = useState<MachineOptions | null>(null);
  useEffect(() => {
    let alive = true;
    engine.backend.machineOptions().then((o) => alive && setOpts(o), () => alive && setOpts(null));
    return () => {
      alive = false;
    };
  }, [engine.backend]);
  return opts?.vmStorages ?? [];
}

type Dialog = "bios" | "display" | "audio" | "efi" | "tpm" | { remove: "efi" | "tpm" };

export function VmItemsCard({ ctx }: { ctx: DevCtx }) {
  const { d } = ctx;
  const vm = d.vm;
  const api = useGuestApi();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const save = useSave(ctx);
  if (!vm) return null;
  const locked = !!d.locked;
  const item = (name: ItemName, body: Record<string, unknown>) => save.run(() => api.item(ctx.vmid, name, { digest: d.digest, ...body }));
  const row = (icon: ReactNode, label: string, value: ReactNode, actions: ReactNode, key: string) => (
    <Row key={key}>
      <span className="text-ink-3 shrink-0">{icon}</span>
      <div className="flex-1 min-w-0 basis-44"><div className="text-sm">{label}</div><div className="text-xs text-ink-3 truncate">{value}</div></div>
      <div className="flex items-center gap-1">{actions}</div>
    </Row>
  );
  const pend = (key: string) => (d.pendingKeys.includes(key) ? <PendingChip /> : null);
  const free = [0, 1, 2, 3].map((i) => `serial${i}`).filter((k) => !vm.serial.some((x) => x.key === k));
  const busy = busyNotice(d);
  return (
    <Card className="p-5">
      <SectionTitle>Firmware and devices</SectionTitle>
      {busy && <Notice tone="warning" className="mb-3">{busy}</Notice>}
      <div className="divide-y divide-line">
        {row(<Cpu className="h-4 w-4" />, "BIOS", <>{vm.bios === "ovmf" ? "UEFI (OVMF)" : "SeaBIOS"} {pend("bios")}</>, <Button size="sm" variant="ghost" onClick={() => setDialog("bios")} disabled={locked}><Pencil className="h-3.5 w-3.5" />Change</Button>, "bios")}
        {row(<Monitor className="h-4 w-4" />, "Display", <>{vgaLabel(vm.display.type)}{vm.display.memory ? ` · ${vm.display.memory} MiB` : ""}{vm.display.clipboard ? " · VNC clipboard" : ""} {pend("vga")}</>, <Button size="sm" variant="ghost" onClick={() => setDialog("display")} disabled={locked}><Pencil className="h-3.5 w-3.5" />Edit</Button>, "display")}
        {row(
          <SquareTerminal className="h-4 w-4" />,
          "Serial ports",
          vm.serial.length ? <span className="font-mono">{vm.serial.map((s) => `${s.key}: ${s.value}`).join(" · ")}</span> : "None. The serial console needs one.",
          <>
            {vm.serial.map((s) => <button key={s.key} onClick={() => item("serial", { action: "remove", key: s.key })} disabled={locked || save.busy} aria-label={`Remove ${s.key}`} className="h-8 px-2 rounded-md text-xs text-ink-3 hover:text-critical hover:bg-critical/10 disabled:opacity-40 inline-flex items-center gap-1"><Trash2 className="h-3.5 w-3.5" />{s.key}</button>)}
            {free.length > 0 && <Button size="sm" variant="ghost" loading={save.busy} onClick={() => item("serial", { action: "add" })} disabled={locked}><Plus className="h-3.5 w-3.5" />Add port</Button>}
          </>,
          "serial",
        )}
        {row(<AudioLines className="h-4 w-4" />, "Audio", vm.audio ? `${AUDIO.find(([v]) => v === vm.audio!.device)?.[1] ?? vm.audio.device} · ${vm.audio.driver === "spice" ? "SPICE" : "no output"}` : "None", <Button size="sm" variant="ghost" onClick={() => setDialog("audio")} disabled={locked}>{vm.audio ? <><Pencil className="h-3.5 w-3.5" />Edit</> : <><Plus className="h-3.5 w-3.5" />Add</>}</Button>, "audio")}
        {row(<HardDrive className="h-4 w-4" />, "EFI disk", vm.efi ? <span className="font-mono">{vm.efi.volume} · {vm.efi.efitype}{vm.efi.preEnrolledKeys ? " · Secure Boot keys" : ""}</span> : vm.bios === "ovmf" ? "None. UEFI has nowhere to keep its settings." : "None. Only UEFI needs one.", vm.efi ? <button onClick={() => setDialog({ remove: "efi" })} disabled={locked} aria-label="Remove the EFI disk" className="h-8 w-8 rounded-md inline-flex items-center justify-center text-ink-3 hover:text-critical hover:bg-critical/10 disabled:opacity-40"><Trash2 className="h-4 w-4" /></button> : <Button size="sm" variant="ghost" onClick={() => setDialog("efi")} disabled={locked}><Plus className="h-3.5 w-3.5" />Add</Button>, "efi")}
        {row(<ShieldCheck className="h-4 w-4" />, "TPM", vm.tpm ? <span className="font-mono">{vm.tpm.volume} · {vm.tpm.version}</span> : "None. Windows 11 needs one.", vm.tpm ? <button onClick={() => setDialog({ remove: "tpm" })} disabled={locked} aria-label="Remove the TPM" className="h-8 w-8 rounded-md inline-flex items-center justify-center text-ink-3 hover:text-critical hover:bg-critical/10 disabled:opacity-40"><Trash2 className="h-4 w-4" /></button> : <Button size="sm" variant="ghost" onClick={() => setDialog("tpm")} disabled={locked}><Plus className="h-3.5 w-3.5" />Add</Button>, "tpm")}
      </div>
      {save.error && <p role="alert" className="text-compact text-critical mt-2">{save.error}</p>}
      {dialog === "bios" && <BiosModal ctx={ctx} onClose={() => setDialog(null)} />}
      {dialog === "display" && <DisplayModal ctx={ctx} onClose={() => setDialog(null)} />}
      {dialog === "audio" && <AudioModal ctx={ctx} onClose={() => setDialog(null)} />}
      {dialog === "efi" && <EfiModal ctx={ctx} onClose={() => setDialog(null)} />}
      {dialog === "tpm" && <TpmModal ctx={ctx} onClose={() => setDialog(null)} />}
      {typeof dialog === "object" && dialog && (
        <ConfirmTypeModal
          title={dialog.remove === "efi" ? "Remove the EFI disk?" : "Remove the TPM?"}
          subtitle={dialog.remove === "efi" ? "UEFI settings and Secure Boot keys are kept on it." : "Disk encryption keys (BitLocker, for example) are kept in it."}
          expected={dialog.remove === "efi" ? "efidisk0" : "tpmstate0"}
          actionLabel={dialog.remove === "efi" ? "Remove EFI disk" : "Remove TPM"}
          warning={dialog.remove === "efi" ? "Without it a UEFI machine may not start. The disk is kept as an unused disk you can attach again." : "A machine whose disk is encrypted with this TPM can't be unlocked without it. The state is kept as an unused disk you can attach again."}
          onConfirm={(typed) => api.item(ctx.vmid, dialog.remove, { digest: d.digest, action: "remove", confirm: typed })}
          onClose={() => setDialog(null)}
          onDone={ctx.reload}
        />
      )}
    </Card>
  );
}

function BiosModal({ ctx, onClose }: { ctx: DevCtx; onClose: () => void }) {
  const api = useGuestApi();
  const save = useSave(ctx, onClose);
  const vm = ctx.d.vm!;
  const [bios, setBios] = useState<"seabios" | "ovmf">(vm.bios === "ovmf" ? "ovmf" : "seabios");
  return (
    <Modal size="sm" icon={<Cpu className="h-5 w-5" />} title="BIOS" subtitle="The firmware the VM starts with." onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.busy} disabled={bios === vm.bios} onClick={() => save.run(() => api.item(ctx.vmid, "bios", { digest: ctx.d.digest, action: "set", bios }))}>Change BIOS</Button></>}>
      <div className="space-y-3">
        <Segmented size="sm" label="BIOS" value={bios} onChange={setBios} options={[{ value: "seabios", label: "SeaBIOS" }, { value: "ovmf", label: "UEFI (OVMF)" }]} />
        <Notice tone="warning">An operating system installed for one firmware usually won't start on the other. Change this for a new machine, or when you know the installation matches.</Notice>
        {bios === "ovmf" && !vm.efi && <Notice>UEFI keeps its settings on an EFI disk. Add one after this, under Firmware and devices.</Notice>}
        {save.error && <p role="alert" className="text-compact text-critical">{save.error}</p>}
      </div>
    </Modal>
  );
}

function DisplayModal({ ctx, onClose }: { ctx: DevCtx; onClose: () => void }) {
  const api = useGuestApi();
  const save = useSave(ctx, onClose);
  const cur = ctx.d.vm!.display;
  const [type, setType] = useState(cur.type);
  const [memory, setMemory] = useState(cur.memory ? String(cur.memory) : "");
  const [clip, setClip] = useState(cur.clipboard === "vnc");
  const noMem = type === "none" || type.startsWith("serial");
  return (
    <Modal size="sm" icon={<Monitor className="h-5 w-5" />} title="Display" subtitle="The virtual graphics card the VM sees." onClose={onClose}
      footer={<><Button variant="ghost" onClick={() => save.run(() => api.item(ctx.vmid, "display", { digest: ctx.d.digest, action: "remove" }))} loading={save.busy}>Use the default</Button><Button variant="primary" loading={save.busy} onClick={() => save.run(() => api.item(ctx.vmid, "display", { digest: ctx.d.digest, action: "set", type, memory: !noMem && memory.trim() ? Number(memory) : undefined, clipboard: clip ? "vnc" : undefined }))}>Save</Button></>}>
      <div className="space-y-4">
        <Field label="Type" htmlFor="vga-type"><Select id="vga-type" value={type} onChange={(e) => setType(e.target.value)}>{VGA.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        <Field label={<>Video memory <span className="text-ink-3 font-normal">(MiB)</span></>} htmlFor="vga-mem" hint="4 to 512. Empty uses the default."><Input id="vga-mem" type="number" min={4} max={512} value={memory} onChange={(e) => setMemory(e.target.value)} disabled={noMem} placeholder="Default" /></Field>
        <Check checked={clip} onChange={setClip} label="Share the clipboard over VNC" hint="Copy and paste between your browser and the VM's screen. Needs the guest to run a clipboard agent." />
        {save.error && <p role="alert" className="text-compact text-critical">{save.error}</p>}
      </div>
    </Modal>
  );
}

function AudioModal({ ctx, onClose }: { ctx: DevCtx; onClose: () => void }) {
  const api = useGuestApi();
  const save = useSave(ctx, onClose);
  const cur = ctx.d.vm!.audio;
  const [device, setDevice] = useState(cur?.device ?? "ich9-intel-hda");
  const [driver, setDriver] = useState(cur?.driver ?? "none");
  return (
    <Modal size="sm" icon={<AudioLines className="h-5 w-5" />} title="Audio device" subtitle="A virtual sound card. Sound only reaches you with a SPICE client." onClose={onClose}
      footer={<>{cur && <Button variant="danger" loading={save.busy} onClick={() => save.run(() => api.item(ctx.vmid, "audio", { digest: ctx.d.digest, action: "remove" }))}>Remove</Button>}<Button variant="primary" loading={save.busy} onClick={() => save.run(() => api.item(ctx.vmid, "audio", { digest: ctx.d.digest, action: "set", device, driver }))}>{cur ? "Save" : "Add device"}</Button></>}>
      <div className="space-y-4">
        <Field label="Device" htmlFor="audio-device"><Select id="audio-device" value={device} onChange={(e) => setDevice(e.target.value)}>{AUDIO.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        <Field label="Output" htmlFor="audio-driver"><Select id="audio-driver" value={driver} onChange={(e) => setDriver(e.target.value)}><option value="none">No output (the guest still sees a card)</option><option value="spice">Over SPICE</option></Select></Field>
        {save.error && <p role="alert" className="text-compact text-critical">{save.error}</p>}
      </div>
    </Modal>
  );
}

function EfiModal({ ctx, onClose }: { ctx: DevCtx; onClose: () => void }) {
  const api = useGuestApi();
  const save = useSave(ctx, onClose);
  const storages = useStorages();
  const [storage, setStorage] = useState("");
  const [efitype, setEfitype] = useState<"4m" | "2m">("4m");
  const [keys, setKeys] = useState(false);
  const [bios, setBios] = useState(ctx.d.vm!.bios !== "ovmf");
  const chosen = storage || storages[0]?.storage || "";
  return (
    <Modal size="sm" icon={<HardDrive className="h-5 w-5" />} title="Add an EFI disk" subtitle="Where a UEFI VM keeps its settings and Secure Boot keys." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.busy} disabled={!chosen} onClick={() => save.run(() => api.item(ctx.vmid, "efi", { digest: ctx.d.digest, action: "add", storage: chosen, efitype, preEnrolledKeys: keys && efitype === "4m", setBios: bios }))}>Add EFI disk</Button></>}>
      <div className="space-y-4">
        <Field label="Storage" htmlFor="efi-storage"><Select id="efi-storage" value={chosen} onChange={(e) => setStorage(e.target.value)}>{storages.length === 0 && <option value="">No storage for disks</option>}{storages.map((s) => <option key={s.storage} value={s.storage}>{s.storage}</option>)}</Select></Field>
        <Field label="Type" htmlFor="efi-type" hint="4m is newer and needed for Secure Boot."><Select id="efi-type" value={efitype} onChange={(e) => { setEfitype(e.target.value as "4m" | "2m"); if (e.target.value === "2m") setKeys(false); }}><option value="4m">4m (recommended)</option><option value="2m">2m (older systems)</option></Select></Field>
        <Check checked={keys && efitype === "4m"} disabled={efitype !== "4m"} onChange={setKeys} label="Pre-enroll Secure Boot keys" hint="Turns Secure Boot on with the standard Microsoft and distribution keys. Needed for Windows 11." />
        {ctx.d.vm!.bios !== "ovmf" && <Check checked={bios} onChange={setBios} label="Switch the BIOS to UEFI" hint="An EFI disk only works with UEFI firmware." />}
        {save.error && <p role="alert" className="text-compact text-critical">{save.error}</p>}
      </div>
    </Modal>
  );
}

function TpmModal({ ctx, onClose }: { ctx: DevCtx; onClose: () => void }) {
  const api = useGuestApi();
  const save = useSave(ctx, onClose);
  const storages = useStorages();
  const [storage, setStorage] = useState("");
  const [version, setVersion] = useState<"v2.0" | "v1.2">("v2.0");
  const chosen = storage || storages[0]?.storage || "";
  return (
    <Modal size="sm" icon={<ShieldCheck className="h-5 w-5" />} title="Add a TPM" subtitle="A virtual Trusted Platform Module, which Windows 11 requires." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.busy} disabled={!chosen} onClick={() => save.run(() => api.item(ctx.vmid, "tpm", { digest: ctx.d.digest, action: "add", storage: chosen, version }))}>Add TPM</Button></>}>
      <div className="space-y-4">
        <Field label="Storage" htmlFor="tpm-storage"><Select id="tpm-storage" value={chosen} onChange={(e) => setStorage(e.target.value)}>{storages.length === 0 && <option value="">No storage for disks</option>}{storages.map((s) => <option key={s.storage} value={s.storage}>{s.storage}</option>)}</Select></Field>
        <Field label="Version" htmlFor="tpm-version" hint="The version can't be changed later."><Select id="tpm-version" value={version} onChange={(e) => setVersion(e.target.value as "v2.0" | "v1.2")}><option value="v2.0">2.0 (recommended)</option><option value="v1.2">1.2</option></Select></Field>
        {save.error && <p role="alert" className="text-compact text-critical">{save.error}</p>}
      </div>
    </Modal>
  );
}

