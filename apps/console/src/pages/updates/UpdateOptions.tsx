import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { RebootDialog } from "../node/Power.tsx";
import { History, Hourglass, PauseCircle, Power, Rocket, ShieldCheck, Timer } from "lucide-react";
import { errorText } from "../../data/engine/queries.ts";
import { pinRt, type UpdateInfo, type UpdateWindowDay } from "../../data/engine/pinRuntimeApi.ts";
import { modalHref } from "../../modals/useModals.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, Input, Notice, Segmented, Select, Spinner, Toggle } from "../../ui/primitives.tsx";

/**
 * The update settings people expect from a system update page: which releases to follow, whether to be reminded or let the
 * device install in a maintenance window, pausing, the history, and the restart notice. Used by Settings → Updates and Pin's
 * Updates tab; both read and write the same device settings.
 */

const KEY = ["pin", "update"] as const;
const DAYS: [UpdateWindowDay, string][] = [["daily", "Every day"], [1, "Mondays"], [2, "Tuesdays"], [3, "Wednesdays"], [4, "Thursdays"], [5, "Fridays"], [6, "Saturdays"], [0, "Sundays"]];
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function usePolicy() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: pinRt.setUpdatePolicy, onSuccess: (d: UpdateInfo) => qc.setQueryData(KEY, d) });
}

function Option({ icon, title, body, children }: { icon: React.ReactNode; title: string; body: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
      <span className="h-9 w-9 shrink-0 rounded-lg bg-surface-2 text-ink-2 flex items-center justify-center" aria-hidden>{icon}</span>
      <div className="min-w-0 flex-1 basis-60">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-compact text-ink-3 text-pretty">{body}</div>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2 shrink-0">{children}</div>}
    </div>
  );
}

/** Proxmox installed a kernel that isn't running yet: say so plainly, with what to do and where. */
export function RestartNotice({ u }: { u: UpdateInfo; device?: string }) {
  const policy = usePolicy();
  const [asking, setAsking] = useState(false);
  if (!u.system.rebootRequired) return null;
  return (
    <Notice tone="warning" title="Restart needed to finish updating Proxmox" action={<Button size="sm" variant="primary" onClick={() => setAsking(true)}><Power className="h-3.5 w-3.5" />Restart now…</Button>}>
      {asking && <RebootDialog onClose={() => setAsking(false)} />}
      <span className="text-pretty">A new kernel (<span className="font-mono">{u.system.newestInstalled}</span>) is installed, but this device is still running <span className="font-mono">{u.system.running}</span>. Machines keep running until you restart; do it when nobody is relying on them.</span>
      <span className="block mt-1">
        {u.snoozed ? <span className="text-ink-3">Reminders are snoozed until {u.policy.snoozedUntil ? when(u.policy.snoozedUntil) : "later"}.</span> : <button type="button" className="text-accent hover:underline" disabled={policy.isPending} onClick={() => policy.mutate({ snoozeHours: 24 })}>Remind me tomorrow</button>}
      </span>
    </Notice>
  );
}

/** For the update that is waiting: install now, or be reminded later. */
export function RemindLater({ u }: { u: UpdateInfo }) {
  const policy = usePolicy();
  if (u.state !== "available") return null;
  if (u.snoozed && u.policy.snoozedUntil) {
    return <p className="text-xs text-ink-3">Reminders snoozed until {when(u.policy.snoozedUntil)}. <button type="button" className="text-accent hover:underline" onClick={() => policy.mutate({ snoozeHours: 0 })}>Remind me again</button></p>;
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-compact text-ink-3">Not now?</span>
      <Select aria-label="Remind me later" size="sm" value="" className="w-44" onChange={(e) => e.target.value && policy.mutate({ snoozeHours: Number(e.target.value) })}>
        <option value="">Remind me later…</option>
        <option value="24">Tomorrow</option>
        <option value="72">In 3 days</option>
        <option value="168">Next week</option>
      </Select>
    </div>
  );
}

export function UpdateOptions({ u, device }: { u: UpdateInfo; device: string }) {
  const qc = useQueryClient();
  const policy = usePolicy();
  const channel = useMutation({ mutationFn: pinRt.setUpdateChannel, onSuccess: (d: UpdateInfo) => qc.setQueryData(KEY, d) });
  const toggle = useMutation({ mutationFn: pinRt.setUpdateCheck, onSuccess: (d: UpdateInfo) => qc.setQueryData(KEY, d) });
  const err = policy.error ?? channel.error ?? toggle.error;
  const p = u.policy;
  const mode = u.canUpdate ? p.mode : "remind";
  if (!u.canManage) return <p className="text-compact text-ink-3">Only Proxmox administrators can change how updates are handled.</p>;
  return (
    <div className="space-y-3">
      <h2 className="text-compact font-semibold text-ink-2 px-1">More options</h2>
      <Card className="divide-y divide-line">
        <Option icon={<Rocket className="h-4 w-4" />} title="Get updates as soon as they're available" body="Follow release candidates: builds that arrive sooner and may have rough edges. You can switch back any time.">
          <Toggle label="Follow release candidates" checked={u.channel === "rc"} onChange={(v) => channel.mutate(v ? "rc" : "stable")} />
        </Option>

        <Option icon={<Timer className="h-4 w-4" />} title="Install updates by itself" body={mode === "window" ? <>ePaperclip updates itself inside the window below{u.nextWindowAt ? <>. Next window: {when(u.nextWindowAt)}</> : null}. It restarts for a minute or two, and goes back by itself if the new version doesn't come up. Proxmox packages are never upgraded automatically.</> : <>You're reminded once a day and install when it suits you. Proxmox packages are always upgraded by you, from the console, never automatically.</>}>
          <Segmented label="How updates are handled" value={mode} onChange={(v) => policy.mutate({ mode: v })} options={[{ value: "remind", label: "Remind me" }, ...(u.canUpdate ? [{ value: "window" as const, label: "Install in a window" }] : [])]} />
        </Option>
        {mode === "window" && (
          <div className="flex flex-wrap items-center gap-3 px-5 py-4 bg-surface-2/40">
            <span className="text-compact text-ink-2 mr-1">Maintenance window</span>
            <Select aria-label="Day" size="sm" className="w-40" value={String(p.window.day)} onChange={(e) => policy.mutate({ window: { day: (e.target.value === "daily" ? "daily" : Number(e.target.value)) as UpdateWindowDay } })}>
              {DAYS.map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>)}
            </Select>
            <span className="text-compact text-ink-3">at</span>
            <Input aria-label="Start time" type="time" defaultValue={p.window.at} key={p.window.at} className="w-32 h-9" onBlur={(e) => e.target.value && e.target.value !== p.window.at && policy.mutate({ window: { at: e.target.value } })} />
            <span className="text-compact text-ink-3">for</span>
            <Select aria-label="Length" size="sm" className="w-32" value={String(p.window.hours)} onChange={(e) => policy.mutate({ window: { hours: Number(e.target.value) } })}>
              {[1, 2, 3, 4, 6].map((h) => <option key={h} value={String(h)}>{h} hour{h === 1 ? "" : "s"}</option>)}
            </Select>
            <span className="text-xs text-ink-3">Uses this device's clock.</span>
          </div>
        )}

        <Option icon={<PauseCircle className="h-4 w-4" />} title="Pause updates" body={u.paused && p.pausedUntil ? <>Paused until {when(p.pausedUntil)}. Nothing installs by itself and reminders wait, but you can still update by hand.</> : "Hold back automatic installs and reminders for a while (up to 5 weeks). Restart reminders still show."}>
          {u.paused ? (
            <Button size="sm" onClick={() => policy.mutate({ pauseDays: 0 })} loading={policy.isPending}>Resume updates</Button>
          ) : (
            <Select aria-label="Pause updates for" size="sm" className="w-44" value="" onChange={(e) => e.target.value && policy.mutate({ pauseDays: Number(e.target.value) })}>
              <option value="">Pause for…</option>
              {[1, 2, 3, 4, 5].map((w) => <option key={w} value={String(w * 7)}>{w} week{w === 1 ? "" : "s"}</option>)}
            </Select>
          )}
        </Option>

        <Option icon={<History className="h-4 w-4" />} title="Update history" body="What was installed and when, who started it, and how it went. Includes Proxmox package runs.">
          <Link to={modalHref("update-history")} className="transition-control inline-flex items-center h-8 px-3 rounded-full border border-line bg-surface-2/60 text-compact font-medium hover:bg-surface-3">View history</Link>
        </Option>

        <Option icon={<ShieldCheck className="h-4 w-4" />} title="Check for updates" body={<>The device asks the project's update feed, signed with the release key every install trusts, and falls back to GitHub's release list. It sends nothing about you or this device.{u.source && <> Last answer came from {u.source === "feed" ? "the signed feed" : "GitHub"}.</>}</>}>
          <Toggle label="Check for updates" checked={u.checkEnabled} onChange={(v) => toggle.mutate(v)} />
        </Option>
      </Card>
      {u.feedNote && <Notice tone="warning" title="The signed update feed was ignored">{u.feedNote} GitHub's release list was used instead; every release is still checked against its own signature before it is installed.</Notice>}
      {err && <p role="alert" className="text-compact text-critical">{errorText(err)}</p>}
      <span className="sr-only" data-device={device} />
    </div>
  );
}

const result = { done: ["good", "Installed"], failed: ["critical", "Didn't finish"], rolled_back: ["warning", "Rolled back"] } as const;

/** Everything installed on this device: ePaperclip's updates and rollbacks, and Debian's record of package runs. */
export function UpdateHistoryModal({ onClose }: { onClose: () => void }) {
  const q = useQuery({ queryKey: ["pin", "update", "history"], queryFn: pinRt.updateHistory, retry: 1 });
  const when2 = (ms: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "unknown time");
  return (
    <Modal size="lg" icon={<History className="h-5 w-5" />} title="Update history" subtitle="ePaperclip's own updates and the package changes Proxmox made." onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {q.isPending && <div className="py-8 flex justify-center"><Spinner /></div>}
      {q.error && <p role="alert" className="text-compact text-critical">{errorText(q.error)}</p>}
      {q.data && (
        <div className="space-y-6">
          <section>
            <h3 className="text-compact font-semibold mb-2">ePaperclip</h3>
            {q.data.entries.length === 0 ? <p className="text-compact text-ink-3">Nothing yet. Updates made from here, on a schedule or in the host's shell are listed as they happen.</p> : (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {q.data.entries.map((e) => (
                  <li key={e.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-sm">{e.action === "rollback" ? "Went back" : "Updated"}{e.to ? <> to <span className="font-mono">{e.to}</span></> : null}{e.from && e.action === "update" ? <span className="text-ink-3 font-normal"> from <span className="font-mono">{e.from}</span></span> : null}</span>
                      <Chip tone={result[e.result][0]}>{result[e.result][1]}</Chip>
                    </div>
                    <div className="text-xs text-ink-3 mt-0.5">{when2(e.at)} · {e.by === "schedule" ? "by the maintenance window" : e.by === "host shell" ? "in the host's shell" : `by ${e.by}`}</div>
                    {e.result !== "done" && <p className="text-compact text-ink-2 mt-1 text-pretty">{e.message}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3 className="text-compact font-semibold mb-2 flex items-center gap-2"><Hourglass className="h-3.5 w-3.5 text-ink-3" aria-hidden />Proxmox packages</h3>
            {q.data.system.length === 0 ? <p className="text-compact text-ink-3">No package changes were found in this device's apt log.</p> : (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {q.data.system.map((r, i) => (
                  <li key={i} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-sm">{[r.upgraded && `${r.upgraded} upgraded`, r.installed && `${r.installed} installed`, r.removed && `${r.removed} removed`].filter(Boolean).join(", ")}</span>
                      {r.kernel && <Chip tone="warning">New kernel</Chip>}
                    </div>
                    <div className="text-xs text-ink-3 mt-0.5">{when2(r.at)} · <span className="font-mono">{r.command || "apt"}</span></div>
                    {r.packages.length > 0 && <p className="text-xs text-ink-2 font-mono mt-1 break-words">{r.packages.join(", ")}{r.upgraded + r.installed > r.packages.length ? ", …" : ""}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p className="text-xs text-ink-3 text-pretty">Proxmox's own packages can't be rolled back from here: apt has no undo. Take a backup or snapshot before upgrading, and keep the previous kernel (Proxmox keeps older kernels installed, so you can pick one at boot).</p>
        </div>
      )}
    </Modal>
  );
}
