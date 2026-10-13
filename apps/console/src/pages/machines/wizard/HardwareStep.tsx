import { AUDIO_DEVICES, AUDIO_DRIVERS } from "@papercliped-engine/proxmox-client/wizard-schema";
import { Field, Input, Notice, Segmented } from "../../../ui/primitives.tsx";
import { AddButton, Grid, ListItem, Pick, Section, SwitchRow, patch, without } from "./fields.tsx";
import { nextKey, type PciForm, type UsbForm, type VmForm } from "./state.ts";
import type { StepProps } from "./types.ts";

const DEVICE_LABEL = { "ich9-intel-hda": "Intel HD Audio (ich9)", "intel-hda": "Intel HD Audio", AC97: "AC97" } as const;

/** PCI and USB passthrough, serial ports and audio: for the machines that need real hardware. */
export function HardwareStep({ f, set, o, err }: StepProps<VmForm>) {
  const q35 = f.machine === "q35" || f.machine.startsWith("pc-q35-");
  const setPci = (id: number, p: Partial<PciForm>) => set({ pci: patch(f.pci, id, p) });
  const setUsb = (id: number, p: Partial<UsbForm>) => set({ usb: patch(f.usb, id, p) });
  const canRaw = o.rawPassthrough;
  const hasMaps = o.pciMappings.length > 0;
  return (
    <div className="space-y-8">
      <Section title="PCI devices" hint="Give the machine a real device, such as a graphics card. The device is then unavailable to the host and other machines.">
        {!canRaw && <Notice>Proxmox lets only root@pam pass a raw device through. You can use a saved mapping, which an administrator sets up in Datacenter, Mappings.</Notice>}
        {f.pci.map((p, i) => {
          const e = (k: string) => err(`hardware.pci.${i}${k ? `.${k}` : ""}`);
          return (
            <ListItem key={p.id} title={<>PCI device {i + 1} <span className="font-mono text-xs text-ink-3 ml-1">hostpci{i}</span></>} removeLabel={`Remove PCI device ${i + 1}`} onRemove={() => set({ pci: without(f.pci, p.id) })}>
              <Grid>
                <Field label="Source" error={e("")}>
                  <Segmented value={p.source} onChange={(source) => setPci(p.id, { source })} label="PCI source" options={[...(canRaw ? [{ value: "device" as const, label: "Raw device" }] : []), { value: "mapping" as const, label: "Mapping" }]} />
                </Field>
                {p.source === "device" ? (
                  <Field label="Device" htmlFor={`wz-pci-${p.id}`} error={e("device")}>
                    {o.pci.length ? (
                      <Pick id={`wz-pci-${p.id}`} value={p.device} onChange={(device) => setPci(p.id, { device })} options={[{ value: "", label: "Choose a device…" }, ...o.pci.map((d) => ({ value: d.id, label: `${d.id} · ${d.vendor} ${d.device}${d.group !== null ? ` · group ${d.group}` : ""}` }))]} />
                    ) : (
                      <Input id={`wz-pci-${p.id}`} value={p.device} onChange={(ev) => setPci(p.id, { device: ev.target.value })} spellCheck={false} className="font-mono" placeholder="0000:01:00.0" />
                    )}
                  </Field>
                ) : (
                  <Field label="Mapping" htmlFor={`wz-pci-${p.id}`} error={e("mapping")}>
                    <Pick id={`wz-pci-${p.id}`} value={p.mapping} onChange={(mapping) => setPci(p.id, { mapping })} options={[{ value: "", label: hasMaps ? "Choose a mapping…" : "No mappings yet" }, ...o.pciMappings.map((m) => ({ value: m.id, label: m.description ? `${m.id} · ${m.description}` : m.id }))]} />
                  </Field>
                )}
              </Grid>
              <Grid cols={2} className="gap-y-2">
                <SwitchRow label="PCI-Express" hint={q35 ? "Present the device on the PCIe bus." : "Needs the q35 machine type (System step)."} checked={p.pcie} disabled={!q35} onChange={(pcie) => setPci(p.id, { pcie })} />
                <SwitchRow label="Primary GPU" hint="Use it as the machine's main display." checked={p.primaryGpu} onChange={(primaryGpu) => setPci(p.id, { primaryGpu })} />
                <SwitchRow label="ROM-bar" hint="Expose the device's option ROM. Turn off if the machine fails to start." checked={p.romBar} onChange={(romBar) => setPci(p.id, { romBar })} />
              </Grid>
            </ListItem>
          );
        })}
        <AddButton onClick={() => set({ pci: [...f.pci, { id: nextKey(), source: canRaw ? "device" : "mapping", device: "", mapping: "", pcie: q35, primaryGpu: false, romBar: true }] })} disabled={f.pci.length >= 16 || (!canRaw && !hasMaps)}>Add PCI device</AddButton>
        {!canRaw && !hasMaps && <p className="text-xs text-ink-3">There are no saved PCI mappings to choose from.</p>}
      </Section>

      <Section title="USB devices" hint="Pass a USB device through, or redirect one from the screen you are looking at with SPICE.">
        {f.usb.map((u, i) => {
          const e = (k: string) => err(`hardware.usb.${i}${k ? `.${k}` : ""}`);
          return (
            <ListItem key={u.id} title={<>USB device {i + 1} <span className="font-mono text-xs text-ink-3 ml-1">usb{i}</span></>} removeLabel={`Remove USB device ${i + 1}`} onRemove={() => set({ usb: without(f.usb, u.id) })}>
              <Grid>
                <Field label="Source" error={e("")}>
                  <Segmented value={u.source} onChange={(source) => setUsb(u.id, { source })} label="USB source" options={[...(canRaw ? [{ value: "host" as const, label: "Device" }] : []), { value: "mapping" as const, label: "Mapping" }, { value: "spice" as const, label: "SPICE" }]} />
                </Field>
                {u.source === "host" && (
                  <Field label="Device" htmlFor={`wz-usb-${u.id}`} error={e("host")}>
                    {o.usb.length ? (
                      <Pick id={`wz-usb-${u.id}`} value={u.host} onChange={(host) => setUsb(u.id, { host })} options={[{ value: "", label: "Choose a device…" }, ...o.usb.map((d) => ({ value: d.host, label: `${d.name} · ${d.host}` }))]} />
                    ) : (
                      <Input id={`wz-usb-${u.id}`} value={u.host} onChange={(ev) => setUsb(u.id, { host: ev.target.value })} spellCheck={false} className="font-mono" placeholder="0bda:0041" />
                    )}
                  </Field>
                )}
                {u.source === "mapping" && (
                  <Field label="Mapping" htmlFor={`wz-usb-${u.id}`} error={e("mapping")}>
                    <Pick id={`wz-usb-${u.id}`} value={u.mapping} onChange={(mapping) => setUsb(u.id, { mapping })} options={[{ value: "", label: o.usbMappings.length ? "Choose a mapping…" : "No mappings yet" }, ...o.usbMappings.map((m) => ({ value: m.id, label: m.description ? `${m.id} · ${m.description}` : m.id }))]} />
                  </Field>
                )}
              </Grid>
              {u.source !== "spice" && <SwitchRow label="USB 3" hint="Present the device on a USB 3 (xHCI) controller." checked={u.usb3} onChange={(usb3) => setUsb(u.id, { usb3 })} />}
            </ListItem>
          );
        })}
        <AddButton onClick={() => set({ usb: [...f.usb, { id: nextKey(), source: canRaw ? "host" : "spice", host: "", mapping: "", usb3: false }] })} disabled={f.usb.length >= 5}>Add USB device</AddButton>
      </Section>

      <Section title="Serial ports and audio">
        <Grid>
          <Field label="Serial ports" htmlFor="wz-serial" error={err("hardware.serial")} hint="Each is a socket the device can open as a terminal. Useful for machines without a display.">
            <Pick id="wz-serial" value={f.serial} onChange={(serial) => set({ serial })} options={["0", "1", "2", "3", "4"].map((v) => ({ value: v, label: v === "0" ? "None" : v }))} />
          </Field>
        </Grid>
        <SwitchRow label="Audio device" hint="A virtual sound card, heard through a SPICE connection." checked={f.audio} onChange={(audio) => set({ audio })} />
        {f.audio && (
          <Grid>
            <Field label="Device" htmlFor="wz-audio-dev" error={err("hardware.audio.device")}><Pick id="wz-audio-dev" value={f.audioDevice} onChange={(audioDevice) => set({ audioDevice })} options={AUDIO_DEVICES.map((d) => ({ value: d, label: DEVICE_LABEL[d] }))} /></Field>
            <Field label="Driver" htmlFor="wz-audio-drv" error={err("hardware.audio.driver")}><Pick id="wz-audio-drv" value={f.audioDriver} onChange={(audioDriver) => set({ audioDriver })} options={AUDIO_DRIVERS.map((d) => ({ value: d, label: d === "spice" ? "SPICE" : "None" }))} /></Field>
          </Grid>
        )}
        <p className="text-xs text-ink-3">The graphic card is on the System step.</p>
      </Section>
    </div>
  );
}
