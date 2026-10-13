import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Box, Monitor } from "lucide-react";
import type { Params } from "@papercliped-engine/proxmox-client/wizard-schema";
import { checkSpec, errorText, useWizardApi, type WizardOptions } from "../../data/engine/wizard.ts";
import { orgRoom, roomError } from "../../data/quota.ts";
import { useEngine } from "../../data/store.tsx";
import { cn, formatBytes } from "../../lib/storage.ts";
import { Button, Notice, Segmented, Skeleton } from "../../ui/primitives.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { ConfirmStep } from "./wizard/Confirm.tsx";
import { CtCpuStep, CtDiskStep, CtMemoryStep, TemplateStep } from "./wizard/CtSteps.tsx";
import { GeneralStep } from "./wizard/GeneralStep.tsx";
import { HardwareStep } from "./wizard/HardwareStep.tsx";
import { CloudInitStep, CtDnsStep, CtNetworkStep, VmNetworkStep } from "./wizard/NetSteps.tsx";
import { CpuStep, DisksStep, MemoryStep, OsStep, SystemStep } from "./wizard/VmSteps.tsx";
import { SizePicker } from "./wizard/SizePicker.tsx";
import { CT_STEPS, VM_STEPS, applyOsDefaults, ctSpec, defaultCt, defaultVm, stepOfField, vmSpec, type CtForm, type Kind, type StepDef, type VmForm } from "./wizard/state.ts";
import { summarize } from "./wizard/summary.ts";

/**
 * Create a machine: a full container or virtual machine wizard, every choice Proxmox's own wizards offer plus
 * cloud-init and hardware passthrough. The same checks run here and on the host (`wizard-schema`), the Confirm step
 * shows the exact Proxmox request, and the machine is owned by the device or by an organization (its resource group).
 * See docs/WIZARDS.md.
 */
export function NewMachineModal({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const api = useWizardApi();
  const navigate = useNavigate();
  const device = engine.setup?.deviceName ?? "pve";
  const routeOrg = window.location.pathname.split("/")[2];
  const asked = useMemo(() => new URLSearchParams(window.location.search), []);
  const [kind, setKind] = useState<Kind>(asked.get("kind") === "vm" ? "qemu" : "lxc");
  const [owner, setOwnerSlug] = useState<string | null>(engine.data.orgs.find((o) => o.slug === routeOrg)?.slug ?? null);

  const [options, setOptions] = useState<WizardOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoadError(null);
    api.options().then(setOptions, (e) => setLoadError(errorText(e, "Couldn't load what this device offers")));
  }, [api]);
  useEffect(load, [load]);

  const [vm, setVm] = useState<VmForm | null>(null);
  const [ct, setCt] = useState<CtForm | null>(null);
  const [stepOf, setStepOf] = useState<Record<Kind, number>>({ lxc: 0, qemu: 0 });
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const ownerPool = useCallback(
    (slug: string | null, o: WizardOptions) => {
      const org = engine.data.orgs.find((x) => x.slug === slug);
      return org && o.pools.includes(org.resourceGroup.pool) ? org.resourceGroup.pool : "";
    },
    [engine.data.orgs],
  );

  // Once the device has answered, build both forms from what it offers.
  useEffect(() => {
    if (!options || (vm && ct)) return;
    const taken = new Set(engine.data.guests.map((g) => g.name));
    let n = 1;
    while (taken.has(`quick-${n}`)) n++;
    const name = `quick-${n}`;
    const size = ["small", "medium", "large"].includes(asked.get("size") ?? "") ? asked.get("size")! : "small";
    const pool = ownerPool(owner, options);
    const tpl = asked.get("template") || (options.templates.find((x) => /debian/i.test(x.volid)) ?? options.templates[0])?.volid || "";
    let v = { ...defaultVm(options, name, size), pool };
    const os = asked.get("ostype");
    if (os === "win11") v = applyOsDefaults(v, "win11");
    else if (os === "other") v = applyOsDefaults(v, "other");
    const iso = asked.get("iso");
    if (iso) v.iso = iso;
    else if (/win/i.test(v.iso) && os === null) v = applyOsDefaults(v, "win11");
    setVm(v);
    setCt({ ...defaultCt(options, name, size, tpl), pool });
  }, [options]); // eslint-disable-line react-hooks/exhaustive-deps

  const steps: StepDef[] = kind === "lxc" ? CT_STEPS : VM_STEPS;
  const idx = Math.min(stepOf[kind], steps.length - 1);
  const step = steps[idx];
  const markSeen = (id: string) => setSeen((s) => (s.has(id) ? s : new Set(s).add(id)));
  const go = (i: number) => {
    markSeen(`${kind}:${step.id}`);
    setStepOf((s) => ({ ...s, [kind]: Math.max(0, Math.min(steps.length - 1, i)) }));
  };
  const setVmForm = (p: Partial<VmForm>) => {
    markSeen(`${kind}:${step.id}`);
    setVm((v) => (v ? { ...v, ...p } : v));
  };
  const setCtForm = (p: Partial<CtForm>) => {
    markSeen(`${kind}:${step.id}`);
    setCt((c) => (c ? { ...c, ...p } : c));
  };
  const setOwner = (slug: string | null) => {
    setOwnerSlug(slug);
    if (options) {
      const pool = ownerPool(slug, options);
      setVm((v) => (v ? { ...v, pool } : v));
      setCt((c) => (c ? { ...c, pool } : c));
    }
  };

  const k = kind === "lxc" ? "ct" : "vm";
  const form = kind === "lxc" ? ct : vm;
  const spec = useMemo(() => (kind === "lxc" ? (ct ? ctSpec(ct) : null) : vm ? vmSpec(vm) : null), [kind, vm, ct]);
  const check = useMemo(() => (spec && options ? checkSpec(k, spec, options) : null), [spec, options, k]);

  // A new machine in an organization has to fit its resource group.
  const org = engine.data.orgs.find((o) => o.slug === owner) ?? null;
  const room = org ? orgRoom(org, engine.data.guests) : null;
  const size = useMemo(() => {
    if (!form || !spec) return { cores: 0, memoryMb: 0, diskGb: 0 };
    if (kind === "lxc") return { cores: Number(ct!.cores) || 0, memoryMb: Number(ct!.memoryMb) || 0, diskGb: Number(ct!.sizeGb) || 0 };
    return { cores: (Number(vm!.sockets) || 1) * (Number(vm!.cores) || 0), memoryMb: Number(vm!.memoryMb) || 0, diskGb: vm!.disks.reduce((n, d) => n + (Number(d.sizeGb) || 0), 0) };
  }, [form, spec, kind, vm, ct]);
  const fitError = room ? roomError(room, size) : null;
  const pickSize = (x: { cores: number; memoryMb: number; diskGb: number }) => {
    markSeen(`${kind}:${step.id}`);
    if (kind === "lxc") setCt((c) => (c ? { ...c, cores: String(x.cores), memoryMb: String(x.memoryMb), sizeGb: String(x.diskGb) } : c));
    else setVm((v) => (v ? { ...v, cores: String(x.cores), sockets: "1", memoryMb: String(x.memoryMb), disks: v.disks.map((d, i) => (i === 0 ? { ...d, sizeGb: String(x.diskGb) } : d)) } : v));
  };
  const ownerNote = org ? (room ? `${room.guests} machine${room.guests === 1 ? "" : "s"}, ${Math.max(0, room.cores)} cores and ${formatBytes(Math.max(0, room.memoryMb) * 1024 ** 2)} left in its resource group` : null) : null;

  const failure = check && !check.ok ? check : null;
  const failStep = failure ? stepOfField(steps, failure.field) : -1;
  const shown = (i: number) => seen.has(`${kind}:${steps[i].id}`) || submitError !== null;
  const err = (field: string): string | null => {
    if (!failure || failStep !== idx || !shown(idx)) return null;
    return failure.field === field || failure.field.startsWith(`${field}.`) ? failure.message : null;
  };
  const stepHasError = (i: number) => !!failure && failStep === i && i !== idx && shown(i);

  // Confirm: ask the device for the exact request (live) or build it here (demo).
  const [preview, setPreview] = useState<{ vmid: number; params: Params } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const onConfirm = step.id === "confirm";
  const specKey = JSON.stringify(spec);
  const lastKey = useRef("");
  useEffect(() => {
    if (!onConfirm || !spec || !check?.ok) return setPreview(null);
    if (lastKey.current === specKey + kind) return;
    lastKey.current = specKey + kind;
    let alive = true;
    setPreviewing(true);
    api.preview(k, spec).then(
      (p) => alive && (setPreview({ vmid: p.vmid, params: p.params }), setPreviewing(false)),
      () => alive && (setPreview(null), setPreviewing(false)),
    );
    return () => {
      alive = false;
    };
  }, [onConfirm, specKey, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const canCreate = !!check?.ok && !fitError && !busy && !!form;
  const create = async () => {
    if (!canCreate || !spec) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const r = await api.create(k, spec, owner);
      const name = kind === "lxc" ? ct!.name : vm!.name;
      if (engine.live) engine.watchTask(r.task, `Create ${kind === "lxc" ? "container" : "VM"} ${name}`);
      engine.notify({ kind: "info", title: `${name} is ${engine.live ? "being created" : "running"}`, body: `${kind === "lxc" ? "Container" : "Virtual machine"} #${r.vmid}${org ? ` in ${org.name}` : ""}.` });
      onClose();
      navigate(owner ? `/${device}/${owner}/machines/${r.vmid}` : `/${device}/machines/${r.vmid}`);
    } catch (e) {
      setSubmitError(errorText(e, "Can't reach this device"));
    }
    setBusy(false);
  };

  const owners = [{ slug: null as string | null, name: `${device} (the device)` }, ...engine.data.orgs.map((o) => ({ slug: o.slug as string | null, name: o.name }))];
  const ownerName = org ? org.name : `${device} (the device)`;
  const rows = spec && check?.ok ? summarize(k, spec, options, preview?.vmid ?? check.vmid ?? null, ownerName) : null;
  const startForm = kind === "lxc" ? ct?.start : vm?.start;
  const setStart = (v: boolean) => (kind === "lxc" ? setCtForm({ start: v }) : setVmForm({ start: v }));
  const startHint = kind === "lxc" ? "Starts the container as soon as it exists." : "Starts the machine as soon as it exists, so the installer begins.";

  const common = options && form ? { o: options, err } : null;
  const body = !common ? null : (
    <div key={`${kind}-${step.id}`} className="fade-in">
      {kind === "lxc" && ct && (
        <>
          {step.id === "general" && <GeneralStep f={ct} set={setCtForm} {...common} kind="lxc" owners={owners} owner={owner} setOwner={setOwner} ownerNote={ownerNote} vmidCheck={api.vmidFree} />}
          {step.id === "template" && <TemplateStep f={ct} set={setCtForm} {...common} device={device} onClose={onClose} />}
          {step.id === "disk" && <CtDiskStep f={ct} set={setCtForm} {...common} />}
          {step.id === "cpu" && <CtCpuStep f={ct} set={setCtForm} {...common} />}
          {step.id === "memory" && <CtMemoryStep f={ct} set={setCtForm} {...common} />}
          {step.id === "network" && <CtNetworkStep f={ct} set={setCtForm} {...common} />}
          {step.id === "dns" && <CtDnsStep f={ct} set={setCtForm} {...common} />}
        </>
      )}
      {kind === "qemu" && vm && (
        <>
          {step.id === "general" && <GeneralStep f={vm} set={setVmForm} {...common} kind="qemu" owners={owners} owner={owner} setOwner={setOwner} ownerNote={ownerNote} vmidCheck={api.vmidFree} />}
          {step.id === "os" && <OsStep f={vm} set={setVmForm} {...common} device={device} onClose={onClose} />}
          {step.id === "system" && <SystemStep f={vm} set={setVmForm} {...common} />}
          {step.id === "disks" && <DisksStep f={vm} set={setVmForm} {...common} />}
          {step.id === "cpu" && <CpuStep f={vm} set={setVmForm} {...common} />}
          {step.id === "memory" && <MemoryStep f={vm} set={setVmForm} {...common} />}
          {step.id === "network" && <VmNetworkStep f={vm} set={setVmForm} {...common} />}
          {step.id === "cloudinit" && <CloudInitStep f={vm} set={setVmForm} {...common} />}
          {step.id === "hardware" && <HardwareStep f={vm} set={setVmForm} {...common} />}
        </>
      )}
      {step.id === "general" && (
        <div className="mt-6">
          <SizePicker kind={kind} current={size} onPick={pickSize} tooBig={(x) => (room ? roomError(room, x) !== null : false)} />
        </div>
      )}
      {step.id === "confirm" && (
        <ConfirmStep
          kind={k}
          rows={rows}
          warnings={check?.ok ? check.warnings : []}
          error={failure ? { message: failure.message, step: steps[failStep].label } : fitError ? { message: fitError, step: "General" } : null}
          params={preview?.params ?? null}
          loading={previewing}
          start={startForm ?? true}
          setStart={setStart}
          startHint={startHint}
        />
      )}
    </div>
  );

  const footerNote = failure && failStep === idx && shown(idx) ? failure.message : submitError;
  const summaryLine = `${size.cores} core${size.cores === 1 ? "" : "s"} · ${formatBytes(size.memoryMb * 1024 ** 2)} · ${size.diskGb} GB`;

  return (
    <Modal
      size="lg"
      icon={kind === "lxc" ? <Box className="h-5 w-5" /> : <Monitor className="h-5 w-5" />}
      title="New machine"
      subtitle={kind === "lxc" ? "A Linux container, ready in seconds. You can change it later." : "A full virtual machine for any operating system."}
      onClose={onClose}
      footer={
        <>
          <span role={footerNote ? "alert" : undefined} className={cn("mr-auto text-xs min-w-0 sm:max-w-[60%]", footerNote ? "text-critical" : "text-ink-3 tabular-nums hidden sm:block")}>{footerNote ?? summaryLine}</span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {idx > 0 && <Button variant="secondary" onClick={() => go(idx - 1)}>Back</Button>}
          {step.id === "confirm" ? (
            <Button variant="primary" onClick={create} disabled={!canCreate} loading={busy}>{startForm === false ? "Create machine" : "Create and start"}</Button>
          ) : (
            <>
              {idx < steps.length - 2 && <Button variant="ghost" onClick={() => go(steps.length - 1)} disabled={!options}>Review</Button>}
              <Button variant="primary" onClick={() => go(idx + 1)} disabled={!options}>Next</Button>
            </>
          )}
        </>
      }
    >
      <div className="space-y-5">
        <Segmented value={kind} onChange={(x) => { setKind(x); setSubmitError(null); }} label="Kind of machine" options={[{ value: "lxc", label: "Container" }, { value: "qemu", label: "Virtual machine" }]} />
        <nav aria-label="Steps" className="sticky top-0 z-(--z-raised) -mx-5 px-5 py-2 bg-surface border-b border-line">
          <ol className="flex gap-1 overflow-x-auto [scrollbar-width:none]">
            {steps.map((st, i) => (
              <li key={st.id} className="shrink-0">
                <button type="button" onClick={() => go(i)} aria-current={i === idx ? "step" : undefined} className={cn("transition-control inline-flex items-center gap-1.5 h-8 px-2.5 rounded-full text-compact whitespace-nowrap", i === idx ? "bg-surface-3 text-ink font-medium" : "text-ink-3 hover:text-ink hover:bg-surface-2")}>
                  <span aria-hidden className={cn("inline-flex h-5 w-5 items-center justify-center rounded-full text-micro tabular-nums border", i === idx ? "border-accent/60 text-ink" : "border-line")}>{i + 1}</span>
                  {st.label}
                  {stepHasError(i) && (
                    <>
                      <AlertTriangle aria-hidden className="h-3.5 w-3.5 text-warning" />
                      <span className="sr-only">needs attention</span>
                    </>
                  )}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        {loadError ? (
          <Notice tone="critical" title="Couldn't load what this device offers" action={<Button size="sm" onClick={load}>Try again</Button>}>{loadError}</Notice>
        ) : !options || !form ? (
          <div role="status" aria-label="Loading" className="space-y-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-2/3" /><Skeleton className="h-24 w-full" /></div>
        ) : (
          body
        )}
      </div>
    </Modal>
  );
}
