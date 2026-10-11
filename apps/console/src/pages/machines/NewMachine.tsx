import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Box, ChevronDown, Loader2 } from "lucide-react";
import { api, ApiError, type MachineOptions } from "../../data/api.ts";
import { orgRoom, roomError } from "../../data/quota.ts";
import { useEngine } from "../../data/store.tsx";
import { cn, formatBytes } from "../../lib/storage.ts";
import { Button, Input } from "../../ui/primitives.tsx";
import { Modal } from "../../ui/Modal.tsx";

const SIZES = [
  { id: "small", label: "Small", cores: 1, memoryMb: 1024, diskGb: 8, hint: "Scripts, bots, a small service" },
  { id: "medium", label: "Medium", cores: 2, memoryMb: 4096, diskGb: 32, hint: "Web apps, databases, builds" },
  { id: "large", label: "Large", cores: 4, memoryMb: 8192, diskGb: 64, hint: "Heavier workloads" },
] as const;

const DEMO_OPTIONS: MachineOptions = {
  nextid: 0,
  templates: [
    { volid: "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst", name: "Debian 12 standard", size: null },
    { volid: "local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst", name: "Ubuntu 24.04 standard", size: null },
    { volid: "local:vztmpl/alpine-3.20-default_20240908_amd64.tar.xz", name: "Alpine 3.20 default", size: null },
  ],
  storages: [{ storage: "local-lvm", type: "lvmthin", avail: null }],
  pools: [],
};

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Spin up a container in a few clicks: a name, a size and a system. Owned by the device or by an organization, in
 * which case it lands in that organization's resource group and has to fit what the group has left.
 */
export function NewMachineModal({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const navigate = useNavigate();
  const device = engine.setup?.deviceName ?? "pve";
  const routeOrg = window.location.pathname.split("/")[2];
  const initialOrg = engine.data.orgs.find((o) => o.slug === routeOrg)?.slug ?? null;

  const [options, setOptions] = useState<MachineOptions | null>(engine.live ? null : DEMO_OPTIONS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(initialOrg);
  const [size, setSize] = useState<(typeof SIZES)[number]["id"]>("small");
  const [template, setTemplate] = useState("");
  const [storage, setStorage] = useState("");
  const [name, setName] = useState(() => {
    const taken = new Set(engine.data.guests.map((g) => g.name));
    let n = 1;
    while (taken.has(`quick-${n}`)) n++;
    return `quick-${n}`;
  });
  const [advanced, setAdvanced] = useState(false);
  const [password, setPassword] = useState("");
  const [sshKey, setSshKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!engine.live) return;
    api.machineOptions().then(setOptions, (e) => setLoadError(e instanceof ApiError ? e.message : "Couldn't load templates"));
  }, [engine.live]);
  useEffect(() => {
    if (!options) return;
    setTemplate((t) => t || (options.templates.find((x) => /debian/i.test(x.volid)) ?? options.templates[0])?.volid || "");
    setStorage((s) => s || options.storages[0]?.storage || "");
  }, [options]);

  const spec = SIZES.find((s) => s.id === size)!;
  const org = engine.data.orgs.find((o) => o.slug === owner) ?? null;
  const room = org ? orgRoom(org, engine.data.guests) : null;
  const fitError = room ? roomError(room, spec) : null;
  const nameError = name && !NAME_RE.test(name) ? "Lowercase letters, digits and hyphens." : engine.data.guests.some((g) => g.name === name) ? "A machine with that name exists." : null;
  const tpl = options?.templates.find((t) => t.volid === template);
  const noTemplates = options !== null && options.templates.length === 0;
  const canCreate = !!options && !!name && !nameError && !fitError && !!template && !!storage && !busy && (password === "" || password.length >= 8);

  const pool = useMemo(() => (org && options?.pools.includes(org.resourceGroup.pool) ? org.resourceGroup.pool : undefined), [org, options]);

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    const r = await engine.createMachine({ name, template, storage, cores: spec.cores, memoryMb: spec.memoryMb, diskGb: spec.diskGb, pool, password: password || undefined, sshKey: sshKey.trim() || undefined, org: owner, os: tpl?.name ?? "Linux" });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    engine.notify({ kind: "info", title: `${name} is ${engine.live ? "being created" : "running"}`, body: `${spec.label} container #${r.vmid}${org ? ` in ${org.name}` : ""}.` });
    onClose();
    navigate(owner ? `/${device}/${owner}/machines/${r.vmid}` : `/${device}/machines/${r.vmid}`);
  };

  return (
    <Modal
      size="lg"
      icon={<Box className="h-5 w-5" />}
      title="New machine"
      subtitle="A Linux container, ready in seconds. You can resize it later."
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-[12px] text-ink-3 tabular-nums hidden sm:block">{spec.cores} core{spec.cores === 1 ? "" : "s"} · {formatBytes(spec.memoryMb * 1024 ** 2)} · {spec.diskGb} GB{tpl ? ` · ${tpl.name}` : ""}</span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={create} disabled={!canCreate}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Create and start</Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="block text-[13px] text-ink-2 mb-2">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} onKeyDown={(e) => e.key === "Enter" && create()} autoFocus spellCheck={false} />
            <span className="block text-[12px] mt-1.5 min-h-4 text-critical">{nameError}</span>
          </label>
          <label className="block">
            <span className="block text-[13px] text-ink-2 mb-2">Owner</span>
            <select value={owner ?? ""} onChange={(e) => setOwner(e.target.value || null)} className="h-10 w-full rounded-lg bg-surface-2 border border-line px-3 text-[14px] outline-none focus:border-line-strong">
              <option value="">{device} (the device)</option>
              {engine.data.orgs.map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
            </select>
            <span className="block text-[12px] mt-1.5 min-h-4 text-ink-3">
              {room && `${room.guests} machine${room.guests === 1 ? "" : "s"}, ${Math.max(0, room.cores)} cores and ${formatBytes(Math.max(0, room.memoryMb) * 1024 ** 2)} left in its resource group`}
            </span>
          </label>
        </div>

        <fieldset>
          <legend className="text-[13px] text-ink-2 mb-2">Size</legend>
          <div className="grid grid-cols-3 gap-2">
            {SIZES.map((s) => {
              const tooBig = room ? roomError(room, s) !== null : false;
              return (
                <button key={s.id} type="button" onClick={() => setSize(s.id)} aria-pressed={size === s.id} className={cn("text-left rounded-xl border p-3 transition", size === s.id ? "border-accent/60 bg-accent-soft" : "border-line hover:border-line-strong", tooBig && "opacity-60")}>
                  <span className="block font-medium text-[14px]">{s.label}</span>
                  <span className="block text-[12px] text-ink-2 tabular-nums mt-0.5">{s.cores} core{s.cores === 1 ? "" : "s"} · {s.memoryMb / 1024} GiB · {s.diskGb} GB</span>
                  <span className="hidden sm:block text-[12px] text-ink-3 mt-1">{s.hint}</span>
                </button>
              );
            })}
          </div>
          {fitError && <p className="text-[12px] text-critical mt-2">{fitError}</p>}
        </fieldset>

        <label className="block">
          <span className="block text-[13px] text-ink-2 mb-2">System</span>
          {loadError ? (
            <p className="text-[13px] text-critical">{loadError}</p>
          ) : !options ? (
            <p className="text-[13px] text-ink-3 inline-flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading templates from {device}…</p>
          ) : noTemplates ? (
            <p className="text-[13px] text-ink-2">No container templates on {device} yet. Download one in the Proxmox console (a storage's CT Templates, then Templates), and it shows up here.</p>
          ) : (
            <select value={template} onChange={(e) => setTemplate(e.target.value)} className="h-10 w-full rounded-lg bg-surface-2 border border-line px-3 text-[14px] outline-none focus:border-line-strong">
              {options.templates.map((t) => <option key={t.volid} value={t.volid}>{t.name}</option>)}
            </select>
          )}
        </label>

        <div>
          <button type="button" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced} className="text-[13px] text-ink-2 hover:text-ink inline-flex items-center gap-1">
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", advanced && "rotate-180")} />Sign-in and storage
          </button>
          {advanced && (
            <div className="grid sm:grid-cols-2 gap-4 mt-3 fade-in">
              <label className="block">
                <span className="block text-[13px] text-ink-2 mb-2">Root password <span className="text-ink-3">(optional)</span></span>
                <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <span className="block text-[12px] mt-1.5 min-h-4 text-critical">{password && password.length < 8 ? "At least 8 characters." : ""}</span>
              </label>
              <label className="block">
                <span className="block text-[13px] text-ink-2 mb-2">Disk storage</span>
                <select value={storage} onChange={(e) => setStorage(e.target.value)} className="h-10 w-full rounded-lg bg-surface-2 border border-line px-3 text-[14px] outline-none focus:border-line-strong">
                  {options?.storages.map((s) => <option key={s.storage} value={s.storage}>{s.storage}{s.avail !== null ? ` · ${formatBytes(s.avail)} free` : ""}</option>)}
                </select>
              </label>
              <label className="block sm:col-span-2">
                <span className="block text-[13px] text-ink-2 mb-2">SSH public key <span className="text-ink-3">(optional)</span></span>
                <Input value={sshKey} onChange={(e) => setSshKey(e.target.value)} placeholder="ssh-ed25519 AAAA…" spellCheck={false} />
              </label>
            </div>
          )}
        </div>
        {error && <p role="alert" className="text-[13px] text-critical">{error}</p>}
      </div>
    </Modal>
  );
}
