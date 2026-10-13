import { useEffect, useState } from "react";
import { Tag } from "../../../ui/Tag.tsx";
import { Field, Input, Textarea } from "../../../ui/primitives.tsx";
import { liveVmidCheck } from "./vmid.ts";
import { Grid, Num, Pick, Section, SwitchRow } from "./fields.tsx";
import type { CtForm, GeneralForm } from "./state.ts";
import type { StepProps } from "./types.ts";

interface Owner {
  slug: string | null;
  name: string;
}

/** The first step of both wizards: what to call it, where it lives, and when it starts. */
export function GeneralStep<F extends GeneralForm>({ f, set, o, err, kind, owners, owner, setOwner, ownerNote, vmidCheck }: StepProps<F> & { kind: "lxc" | "qemu"; owners: Owner[]; owner: string | null; setOwner: (slug: string | null) => void; ownerNote: string | null; vmidCheck: (n: number) => Promise<{ free: boolean; message: string }> }) {
  const [taken, setTaken] = useState<string | null>(null);
  useEffect(() => {
    setTaken(null);
    if (!/^\d{3,9}$/.test(f.vmid)) return;
    let alive = true;
    const t = setTimeout(() => liveVmidCheck(vmidCheck, Number(f.vmid)).then((r) => alive && setTaken(r.free ? null : r.message)), 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [f.vmid, vmidCheck]);
  const tags = f.tags.split(/[;,\s]+/).filter(Boolean);
  const nameLabel = kind === "lxc" ? "Hostname" : "Name";
  return (
    <div className="space-y-6">
      <Grid>
        <Field label={nameLabel} htmlFor="wz-name" error={err(kind === "lxc" ? "general.hostname" : "general.name")} hint={kind === "lxc" ? "The container's name on the network." : "How the machine is listed. Letters, digits, hyphens and dots."}>
          <Input id="wz-name" value={f.name} onChange={(e) => set({ name: e.target.value } as Partial<F>)} autoFocus spellCheck={false} autoCapitalize="none" />
        </Field>
        <Field label="Machine number" htmlFor="wz-vmid" error={err("general.vmid") ?? taken} hint={`Leave empty to use the next free number${o.nextid ? ` (${o.nextid})` : ""}.`}>
          <Num id="wz-vmid" value={f.vmid} onChange={(v) => set({ vmid: v } as Partial<F>)} placeholder={String(o.nextid || "")} />
        </Field>
        <Field label="Owner" htmlFor="wz-owner" hint={ownerNote ?? undefined}>
          <Pick id="wz-owner" value={owner ?? ""} onChange={(v) => setOwner(v || null)} options={owners.map((x) => ({ value: x.slug ?? "", label: x.name }))} />
        </Field>
        {owner === null && o.pools.length > 0 && (
          <Field label="Resource group" htmlFor="wz-pool" error={err("general.pool")} hint="Optional. Groups machines for permissions and limits.">
            <Pick id="wz-pool" value={f.pool} onChange={(v) => set({ pool: v } as Partial<F>)} options={[{ value: "", label: "None" }, ...o.pools.map((p) => ({ value: p, label: p }))]} />
          </Field>
        )}
      </Grid>
      <Section title="Startup" hint="What happens when this device starts.">
        <SwitchRow label="Start at boot" hint="Start this machine whenever the device starts." checked={f.onboot} onChange={(v) => set({ onboot: v } as Partial<F>)} />
        <Grid cols={3}>
          <Field label="Start order" htmlFor="wz-order" error={err("general.startup.order")} hint="Lower numbers start first.">
            <Num id="wz-order" value={f.order} onChange={(v) => set({ order: v } as Partial<F>)} placeholder="Any" />
          </Field>
          <Field label="Start delay" htmlFor="wz-up" error={err("general.startup.up")} hint="Wait before the next one.">
            <Num id="wz-up" value={f.up} onChange={(v) => set({ up: v } as Partial<F>)} placeholder="Default" suffix="s" />
          </Field>
          <Field label="Shutdown timeout" htmlFor="wz-down" error={err("general.startup.down")} hint="Wait before forcing it off.">
            <Num id="wz-down" value={f.down} onChange={(v) => set({ down: v } as Partial<F>)} placeholder="Default" suffix="s" />
          </Field>
        </Grid>
      </Section>
      <Grid>
        <Field label="Tags" htmlFor="wz-tags" error={err("general.tags")} hint="Separate with spaces or commas.">
          <Input id="wz-tags" value={f.tags} onChange={(e) => set({ tags: e.target.value } as Partial<F>)} spellCheck={false} autoCapitalize="none" />
          {tags.length > 0 && <div className="flex flex-wrap gap-1.5 mt-2">{tags.map((t) => <Tag key={t} name={t.toLowerCase()} />)}</div>}
        </Field>
        <Field label="Note" htmlFor="wz-desc" error={err("general.description")} hint="Optional. Shown in Proxmox.">
          <Textarea id="wz-desc" value={f.description} onChange={(e) => set({ description: e.target.value } as Partial<F>)} rows={2} />
        </Field>
      </Grid>
      {kind === "lxc" && <CtSignIn f={f as unknown as CtForm} set={set as unknown as (p: Partial<CtForm>) => void} err={err} />}
    </div>
  );
}

function CtSignIn({ f, set, err }: { f: CtForm; set: (p: Partial<CtForm>) => void; err: (field: string) => string | null }) {
  return (
    <Section title="Sign-in" hint="Both are write-only: they are sent to Proxmox and never shown again.">
      <Grid>
        <Field label="Root password" htmlFor="wz-pw" error={err("general.password")} hint="Optional. 8 characters or more.">
          <Input id="wz-pw" type="password" autoComplete="new-password" value={f.password} onChange={(e) => set({ password: e.target.value })} />
        </Field>
        <Field label="SSH public key" htmlFor="wz-keys" error={err("general.sshKeys")} hint="Optional. One key per line.">
          <Textarea id="wz-keys" value={f.sshKeys} onChange={(e) => set({ sshKeys: e.target.value })} placeholder="ssh-ed25519 AAAA…" rows={2} spellCheck={false} className="font-mono" />
        </Field>
      </Grid>
      <SwitchRow label="Unprivileged container" hint="Recommended. A privileged container shares more with the device; use it only when something needs it." checked={f.unprivileged} onChange={(v) => set({ unprivileged: v, keyctl: v ? f.keyctl : false })} />
    </Section>
  );
}
