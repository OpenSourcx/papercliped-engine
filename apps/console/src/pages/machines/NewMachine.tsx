import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Box, ChevronDown, Loader2, Monitor } from "lucide-react";
import { ApiError, type MachineOptions } from "../../data/api.ts";
import { orgRoom, roomError } from "../../data/quota.ts";
import { useEngine } from "../../data/store.tsx";
import { cn, formatBytes } from "../../lib/storage.ts";
import { Button, Input, Segmented, selectClass } from "../../ui/primitives.tsx";
import { Modal } from "../../ui/Modal.tsx";

type Kind = "lxc" | "qemu";

const SIZES: Record<Kind, { id: string; label: string; cores: number; memoryMb: number; diskGb: number; hint: string }[]> = {
  lxc: [
    { id: "small", label: "Small", cores: 1, memoryMb: 1024, diskGb: 8, hint: "Scripts, bots, a small service" },
    { id: "medium", label: "Medium", cores: 2, memoryMb: 4096, diskGb: 32, hint: "Web apps, databases, builds" },
    { id: "large", label: "Large", cores: 4, memoryMb: 8192, diskGb: 64, hint: "Heavier workloads" },
  ],
  qemu: [
    { id: "small", label: "Small", cores: 2, memoryMb: 2048, diskGb: 32, hint: "A light Linux server" },
    { id: "medium", label: "Medium", cores: 4, memoryMb: 8192, diskGb: 64, hint: "Windows, desktops, builds" },
    { id: "large", label: "Large", cores: 8, memoryMb: 16384, diskGb: 128, hint: "Heavier workloads" },
  ],
};

const OS_TYPES = [
  { value: "l26", label: "Linux" },
  { value: "win11", label: "Windows 11" },
  { value: "other", label: "Other" },
] as const;

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const select = selectClass;

/**
 * Spin up a machine in a few clicks: a container from a template, or a virtual machine booting an ISO. Owned by the
 * device or by an organization, in which case it lands in that organization's resource group and has to fit it.
 */
export function NewMachineModal({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const navigate = useNavigate();
  const device = engine.setup?.deviceName ?? "pve";
  const routeOrg = window.location.pathname.split("/")[2];
  const initialOrg = engine.data.orgs.find((o) => o.slug === routeOrg)?.slug ?? null;
  const initialKind: Kind = new URLSearchParams(window.location.search).get("kind") === "vm" ? "qemu" : "lxc";

  const [kind, setKind] = useState<Kind>(initialKind);
  const [options, setOptions] = useState<MachineOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(initialOrg);
  const asked = new URLSearchParams(window.location.search);
  const [size, setSize] = useState(["small", "medium", "large"].includes(asked.get("size") ?? "") ? asked.get("size")! : "small");
  const [template, setTemplate] = useState(asked.get("template") ?? "");
  const [iso, setIso] = useState(asked.get("iso") ?? "");
  const [ostype, setOstype] = useState<"l26" | "win11" | "other">(asked.get("ostype") === "win11" ? "win11" : asked.get("ostype") === "other" ? "other" : "l26");
  const [storage, setStorage] = useState("");
  const nextName = () => {
    const taken = new Set(engine.data.guests.map((g) => g.name));
    let n = 1;
    while (taken.has(`quick-${n}`)) n++;
    return `quick-${n}`;
  };
  const [name, setName] = useState(nextName);
  const [nameTouched, setNameTouched] = useState(false);
  // Live machines can arrive after the dialog opens; keep the suggested name free until the user types their own.
  useEffect(() => {
    if (!nameTouched) setName(nextName());
  }, [engine.data.guests.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [advanced, setAdvanced] = useState(false);
  const [password, setPassword] = useState("");
  const [sshKey, setSshKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    engine.backend.machineOptions().then(setOptions, (e) => setLoadError(e instanceof ApiError ? e.message : "Couldn't load templates"));
  }, [engine.backend]);
  useEffect(() => {
    if (!options) return;
    setTemplate((t) => t || (options.templates.find((x) => /debian/i.test(x.volid)) ?? options.templates[0])?.volid || "");
    setIso((i) => i || options.isos[0]?.volid || "");
  }, [options]);
  const disks = (kind === "lxc" ? options?.storages : options?.vmStorages) ?? [];
  useEffect(() => {
    setStorage((s) => (disks.some((d) => d.storage === s) ? s : disks[0]?.storage ?? ""));
  }, [kind, options]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (/win/i.test(iso)) setOstype("win11");
  }, [iso]);

  const spec = SIZES[kind].find((s) => s.id === size) ?? SIZES[kind][0];
  const org = engine.data.orgs.find((o) => o.slug === owner) ?? null;
  const room = org ? orgRoom(org, engine.data.guests) : null;
  const fitError = room ? roomError(room, spec) : null;
  const nameError = name && !NAME_RE.test(name) ? "Lowercase letters, digits and hyphens." : engine.data.guests.some((g) => g.name === name) ? "A machine with that name exists." : null;
  const tpl = options?.templates.find((t) => t.volid === template);
  const isoItem = options?.isos.find((t) => t.volid === iso);
  const noTemplates = options !== null && options.templates.length === 0;
  const source = kind === "lxc" ? !!template : true; // a VM can be created without media and booted from the network
  const canCreate = !!options && !!name && !nameError && !fitError && source && !!storage && !busy && (kind === "qemu" || password === "" || password.length >= 8);
  const pool = useMemo(() => (org && options?.pools.includes(org.resourceGroup.pool) ? org.resourceGroup.pool : undefined), [org, options]);

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    const r =
      kind === "lxc"
        ? await engine.createMachine({ name, template, storage, cores: spec.cores, memoryMb: spec.memoryMb, diskGb: spec.diskGb, pool, password: password || undefined, sshKey: sshKey.trim() || undefined, org: owner, os: tpl?.name ?? "Linux" })
        : await engine.createVm({ name, iso: iso || null, ostype, storage, cores: spec.cores, memoryMb: spec.memoryMb, diskGb: spec.diskGb, pool, start: true, org: owner });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    engine.notify({ kind: "info", title: `${name} is ${engine.live ? "being created" : "running"}`, body: `${spec.label} ${kind === "lxc" ? "container" : "virtual machine"} #${r.vmid}${org ? ` in ${org.name}` : ""}.` });
    onClose();
    navigate(owner ? `/${device}/${owner}/machines/${r.vmid}` : `/${device}/machines/${r.vmid}`);
  };

  return (
    <Modal
      size="lg"
      icon={kind === "lxc" ? <Box className="h-5 w-5" /> : <Monitor className="h-5 w-5" />}
      title="New machine"
      subtitle={kind === "lxc" ? "A Linux container, ready in seconds. You can resize it later." : "A full virtual machine that boots from an ISO image, for any operating system."}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-xs text-ink-3 tabular-nums hidden sm:block">{spec.cores} core{spec.cores === 1 ? "" : "s"} · {formatBytes(spec.memoryMb * 1024 ** 2)} · {spec.diskGb} GB{kind === "lxc" ? (tpl ? ` · ${tpl.name}` : "") : isoItem ? ` · ${isoItem.name}` : ""}</span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={create} disabled={!canCreate}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Create and start</Button>
        </>
      }
    >
      <div className="space-y-5">
        <Segmented value={kind} onChange={(k) => { setKind(k); setSize("small"); }} options={[{ value: "lxc", label: "Container" }, { value: "qemu", label: "Virtual machine" }]} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="block text-compact text-ink-2 mb-2">Name</span>
            <Input value={name} onChange={(e) => { setName(e.target.value.toLowerCase()); setNameTouched(true); }} onKeyDown={(e) => e.key === "Enter" && create()} autoFocus spellCheck={false} />
            <span className="block text-xs mt-1.5 min-h-4 text-critical">{nameError}</span>
          </label>
          <label className="block">
            <span className="block text-compact text-ink-2 mb-2">Owner</span>
            <select value={owner ?? ""} onChange={(e) => setOwner(e.target.value || null)} className={select}>
              <option value="">{device} (the device)</option>
              {engine.data.orgs.map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
            </select>
            <span className="block text-xs mt-1.5 min-h-4 text-ink-3">
              {room && `${room.guests} machine${room.guests === 1 ? "" : "s"}, ${Math.max(0, room.cores)} cores and ${formatBytes(Math.max(0, room.memoryMb) * 1024 ** 2)} left in its resource group`}
            </span>
          </label>
        </div>

        <fieldset>
          <legend className="text-compact text-ink-2 mb-2">Size</legend>
          <div className="grid grid-cols-3 gap-2">
            {SIZES[kind].map((s) => {
              const tooBig = room ? roomError(room, s) !== null : false;
              return (
                <button key={s.id} type="button" onClick={() => setSize(s.id)} aria-pressed={size === s.id} className={cn("text-left rounded-xl border p-3 transition", size === s.id ? "border-accent/60 bg-accent-soft" : "border-line hover:border-line-strong", tooBig && "opacity-60")}>
                  <span className="block font-medium text-sm">{s.label}</span>
                  <span className="block text-xs text-ink-2 tabular-nums mt-0.5">{s.cores} core{s.cores === 1 ? "" : "s"} · {s.memoryMb / 1024} GiB · {s.diskGb} GB</span>
                  <span className="hidden sm:block text-xs text-ink-3 mt-1">{s.hint}</span>
                </button>
              );
            })}
          </div>
          {fitError && <p className="text-xs text-critical mt-2">{fitError}</p>}
        </fieldset>

        {loadError ? (
          <p className="text-compact text-critical">{loadError}</p>
        ) : !options ? (
          <p className="text-compact text-ink-3 inline-flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading from {device}…</p>
        ) : kind === "lxc" ? (
          <label className="block">
            <span className="block text-compact text-ink-2 mb-2">System</span>
            {noTemplates ? (
              <p className="text-compact text-ink-2">No container templates on {device} yet. <Link onClick={onClose} to={`/${device}/storage`} className="text-accent hover:underline">Get one from the template catalog</Link> in Storage.</p>
            ) : (
              <select value={template} onChange={(e) => setTemplate(e.target.value)} className={select}>
                {options.templates.map((t) => <option key={t.volid} value={t.volid}>{t.name}</option>)}
              </select>
            )}
          </label>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_200px] gap-4">
            <label className="block">
              <span className="block text-compact text-ink-2 mb-2">Boot from</span>
              <select value={iso} onChange={(e) => setIso(e.target.value)} className={select}>
                {options.isos.map((t) => <option key={t.volid} value={t.volid}>{t.name}{t.size ? ` · ${formatBytes(t.size)}` : ""}</option>)}
                <option value="">No media (network boot)</option>
              </select>
              {options.isos.length === 0 && <span className="block text-xs mt-1.5 text-ink-3">No ISO images yet. <Link onClick={onClose} to={`/${device}/storage`} className="text-accent hover:underline">Upload one or download it from a URL</Link> in Storage.</span>}
            </label>
            <label className="block">
              <span className="block text-compact text-ink-2 mb-2">Operating system</span>
              <select value={ostype} onChange={(e) => setOstype(e.target.value as typeof ostype)} className={select}>
                {OS_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            {ostype === "win11" && <p className="sm:col-span-2 text-xs text-ink-3 -mt-2">Windows 11 gets UEFI, Secure Boot keys and a TPM 2.0, with SATA and e1000e so the installer sees the disk and network without extra drivers.</p>}
          </div>
        )}

        <div>
          <button type="button" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced} className="text-compact text-ink-2 hover:text-ink inline-flex items-center gap-1">
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", advanced && "rotate-180")} />{kind === "lxc" ? "Sign-in and storage" : "Storage"}
          </button>
          {advanced && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3 fade-in">
              {kind === "lxc" && (
                <label className="block">
                  <span className="block text-compact text-ink-2 mb-2">Root password <span className="text-ink-3">(optional)</span></span>
                  <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                  <span className="block text-xs mt-1.5 min-h-4 text-critical">{password && password.length < 8 ? "At least 8 characters." : ""}</span>
                </label>
              )}
              <label className="block">
                <span className="block text-compact text-ink-2 mb-2">Disk storage</span>
                <select value={storage} onChange={(e) => setStorage(e.target.value)} className={select}>
                  {disks.map((s) => <option key={s.storage} value={s.storage}>{s.storage}{s.avail !== null ? ` · ${formatBytes(s.avail)} free` : ""}</option>)}
                </select>
              </label>
              {kind === "lxc" && (
                <label className="block sm:col-span-2">
                  <span className="block text-compact text-ink-2 mb-2">SSH public key <span className="text-ink-3">(optional)</span></span>
                  <Input value={sshKey} onChange={(e) => setSshKey(e.target.value)} placeholder="ssh-ed25519 AAAA…" spellCheck={false} />
                </label>
              )}
            </div>
          )}
        </div>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}
