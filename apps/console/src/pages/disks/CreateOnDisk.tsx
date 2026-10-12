import { useMemo, useState } from "react";
import { HardDrive } from "lucide-react";
import { RAID_LEVELS, ZFS_COMPRESSION, parseDraidConfig, planZfs } from "@papercliped-engine/proxmox-client/storage-schema";
import { errorText, useDisksApi, type DiskStorageKind, type PhysDisk } from "../../data/engine/disks.ts";
import { useEngine } from "../../data/store.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { formatBytes } from "../../lib/storage.ts";
import { Button, Chip, Field, Input, Notice, Segmented, Select } from "../../ui/primitives.tsx";
import { Check, diskSize } from "./common.tsx";

const KIND_HELP: Record<DiskStorageKind, string> = {
  directory: "Formats the disk with a file system and mounts it as a folder. The simplest choice, and it holds every kind of content.",
  lvm: "Makes the disk a volume group. Fast and simple for virtual machine disks, without snapshots.",
  lvmthin: "Makes a thin pool: space is handed out as it is used, with instant snapshots and clones.",
  zfs: "Builds a ZFS pool from one or more disks, with checksums, snapshots and optional redundancy.",
};

/** Turns unused disks into storage. Everything on the chosen disks is erased. */
export function CreateOnDisk({ disks, kind: initial, onClose, onDone }: { disks: PhysDisk[]; kind: DiskStorageKind; onClose: () => void; onDone: () => void }) {
  const api = useDisksApi();
  const engine = useEngine();
  const free = disks.filter((d) => d.usedBy === null && !d.parent);
  const [kind, setKind] = useState<DiskStorageKind>(initial);
  const [name, setName] = useState("");
  const [device, setDevice] = useState(free[0]?.devpath ?? "");
  const [fs, setFs] = useState<"ext4" | "xfs">("ext4");
  const [addStorage, setAddStorage] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [raid, setRaid] = useState("mirror");
  const [ashift, setAshift] = useState(12);
  const [compression, setCompression] = useState("on");
  const [draid, setDraid] = useState("data=4,spares=1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameErr = name && !/^[a-z][a-z0-9._-]{0,38}[a-z0-9]$/.test(name) ? "2 to 40 characters: lowercase letters, digits, - _ and ., starting with a letter." : null;
  const sizes = picked.map((p) => free.find((d) => d.devpath === p)?.sizeBytes ?? 0);
  const plan = useMemo(() => (kind === "zfs" ? planZfs(raid, sizes, raid.startsWith("draid") ? draid : null) : null), [kind, raid, picked, draid]); // eslint-disable-line react-hooks/exhaustive-deps
  const level = RAID_LEVELS.find((l) => l.value === raid)!;
  const valid = !!name && !nameErr && (kind === "zfs" ? plan?.ok === true && picked.length > 0 : !!device) && (!raid.startsWith("draid") || kind !== "zfs" || !!parseDraidConfig(draid));

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createOnDisk(kind, kind === "zfs" ? { name, devices: picked, raidlevel: raid, ashift, compression, draidConfig: raid.startsWith("draid") ? draid : undefined, addStorage } : { name, device, filesystem: kind === "directory" ? fs : undefined, addStorage });
      engine.watchTask(r.task, `Create ${kind === "zfs" ? "ZFS pool" : kind === "lvm" ? "LVM group" : kind === "lvmthin" ? "LVM-Thin pool" : "directory"} ${name}`);
      onDone();
      onClose();
    } catch (e) {
      setError(errorText(e, "Couldn't create it"));
      setBusy(false);
    }
  };

  return (
    <Modal
      size="lg"
      icon={<HardDrive className="h-5 w-5" />}
      title="Create storage on a disk"
      subtitle="Turns unused disks into storage machines can use. Everything on the disks you pick is erased."
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={go} disabled={!valid} loading={busy}>Create and erase disk{kind === "zfs" && picked.length !== 1 ? "s" : ""}</Button></>}
    >
      <div className="space-y-5">
        <Segmented<DiskStorageKind> label="Kind of storage" value={kind} onChange={setKind} options={[{ value: "directory", label: "Directory" }, { value: "lvm", label: "LVM" }, { value: "lvmthin", label: "LVM-Thin" }, { value: "zfs", label: "ZFS" }]} />
        <p className="text-compact text-ink-2">{KIND_HELP[kind]}</p>
        {free.length === 0 && <Notice tone="warning" title="No unused disks">Every disk is in use. Wipe a disk that is free, or remove the storage that uses it first.</Notice>}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Name" error={nameErr} hint="Also the storage's name in Proxmox." htmlFor="create-name">
            <Input id="create-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "zfs" ? "tank" : "data"} className="font-mono" autoComplete="off" />
          </Field>
          {kind !== "zfs" && (
            <Field label="Disk" htmlFor="create-disk">
              <Select id="create-disk" value={device} onChange={(e) => setDevice(e.target.value)}>
                {free.map((d) => <option key={d.devpath} value={d.devpath}>{d.name} · {diskSize(d.sizeBytes)} · {d.model ?? d.type}</option>)}
              </Select>
            </Field>
          )}
          {kind === "directory" && (
            <Field label="File system" hint="ext4 is the safe default; XFS suits very large files." htmlFor="create-fs">
              <Select id="create-fs" value={fs} onChange={(e) => setFs(e.target.value as "ext4" | "xfs")}><option value="ext4">ext4</option><option value="xfs">XFS</option></Select>
            </Field>
          )}
        </div>

        {kind === "zfs" && (
          <>
            <fieldset>
              <legend className="text-compact font-medium text-ink-2 mb-2">Disks in the pool</legend>
              <div className="rounded-lg border border-line divide-y divide-line">
                {free.length === 0 && <p className="px-3 py-2.5 text-compact text-ink-3">No unused disks.</p>}
                {free.map((d) => (
                  <label key={d.devpath} className="flex items-center gap-3 px-3 h-11 cursor-pointer">
                    <input type="checkbox" className="h-4 w-4 accent-(--accent)" checked={picked.includes(d.devpath)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, d.devpath] : p.filter((x) => x !== d.devpath)))} aria-label={`Use ${d.name}`} />
                    <span className="font-mono text-compact w-24 shrink-0">{d.name}</span>
                    <span className="text-compact text-ink-2 flex-1 truncate">{d.model ?? d.type}</span>
                    <span className="text-compact tabular-nums text-ink-3">{diskSize(d.sizeBytes)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <Field label="RAID level" htmlFor="create-raid">
              <Select id="create-raid" value={raid} onChange={(e) => setRaid(e.target.value)}>{RAID_LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}</Select>
            </Field>
            <p className="text-compact text-ink-2 -mt-3">{level.help} Needs at least {level.minDisks} disk{level.minDisks === 1 ? "" : "s"}.</p>
            {raid.startsWith("draid") && (
              <Field label="dRAID layout" hint="Data disks per group and spare disks, for example data=4,spares=1." error={parseDraidConfig(draid) ? null : "Use data=4,spares=1"} htmlFor="create-draid">
                <Input id="create-draid" value={draid} onChange={(e) => setDraid(e.target.value)} className="font-mono" />
              </Field>
            )}
            <div aria-live="polite" className="rounded-lg border border-line bg-surface-2/60 px-4 py-3">
              <div className="text-compact text-ink-3 mb-1">Capacity preview</div>
              {picked.length === 0 ? <span className="text-compact text-ink-3">Pick the disks to see what you get.</span> : plan?.ok ? (
                <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
                  <span className="text-lead font-semibold tabular-nums">{diskSize(plan.usableBytes)} usable</span>
                  <span className="text-compact text-ink-2">of {diskSize(sizes.reduce((a, b) => a + b, 0))} raw</span>
                  <span className="text-compact text-ink-2">{plan.tolerates === 0 ? "No disk can fail without losing data" : `Survives ${plan.tolerates} disk failure${plan.tolerates === 1 ? "" : "s"}`}</span>
                </div>
              ) : <span className="text-compact text-warning">{plan?.message}</span>}
              {plan?.ok && new Set(sizes).size > 1 && <p className="text-xs text-ink-3 mt-1">The disks differ in size, so each counts as the smallest one ({formatBytes(Math.min(...sizes))}).</p>}
            </div>
            <details className="rounded-lg border border-line px-4 py-3">
              <summary className="text-compact text-ink-2 cursor-pointer">More options</summary>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
                <Field label="Compression" hint="LZ4 or ZSTD cost almost nothing and save space." htmlFor="create-comp"><Select id="create-comp" value={compression} onChange={(e) => setCompression(e.target.value)}>{ZFS_COMPRESSION.map((c) => <option key={c} value={c}>{c}</option>)}</Select></Field>
                <Field label="Sector size (ashift)" hint="12 suits nearly all current disks (4 KiB sectors). Can't be changed later." htmlFor="create-ashift"><Input id="create-ashift" type="number" min={9} max={16} value={ashift} onChange={(e) => setAshift(Number(e.target.value))} /></Field>
              </div>
            </details>
          </>
        )}

        <Check checked={addStorage} onChange={setAddStorage} label="Also add it as storage in Proxmox" hint="Lets machines use it straight away." />
        {kind === "zfs" && picked.length > 0 && <div className="flex flex-wrap gap-1.5">{picked.map((p) => <Chip key={p} tone="warning">{p.replace("/dev/", "")} will be erased</Chip>)}</div>}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}
