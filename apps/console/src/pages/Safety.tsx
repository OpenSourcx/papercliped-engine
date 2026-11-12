import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, OctagonX, Upload } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { errorText } from "../data/engine/queries.ts";
import { KILL_PHRASE, RESTORE_PHRASE, safetyApi, type KillSwitch, type RecoveryFile } from "../data/engine/safetyApi.ts";
import { TypedConfirm } from "./node/common.tsx";
import { Button, Card, Chip, Field, Input, Notice, PageFrame, PageHeader, Spinner } from "../ui/primitives.tsx";

const KEY = ["safety"] as const;
const MIN = 12;

/** Settings → Safety: stop everything now, and keep a copy of the vault key so a lost key file isn't the end of every secret. */
export function Safety() {
  return useEngine().live ? <LiveSafety /> : (
    <PageFrame width="4xl">
      <PageHeader title="Safety" subtitle="Emergency controls." />
      <Notice>These controls act on the device, so they aren't part of the demo.</Notice>
    </PageFrame>
  );
}

function LiveSafety() {
  const q = useQuery({ queryKey: KEY, queryFn: safetyApi.state, retry: 1 });
  return (
    <PageFrame width="4xl">
      <PageHeader title="Safety" subtitle="Emergency controls for this device. Only Proxmox administrators can use them." />
      {q.isLoading && <Spinner />}
      {q.isError && <Notice tone="critical">{errorText(q.error)}</Notice>}
      {q.data && !q.data.canManage && <Notice tone="warning">Only Proxmox administrators (Sys.Modify on /) can use the emergency controls.{q.data.killSwitch?.on ? " The kill switch is on right now." : ""}</Notice>}
      {q.data?.canManage && (
        <div className="space-y-4">
          <KillSwitchCard sw={q.data.killSwitch} />
          <VaultRecoveryCard keyId={q.data.vault?.keyId ?? null} />
        </div>
      )}
    </PageFrame>
  );
}

function KillSwitchCard({ sw }: { sw: KillSwitch | null }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [unpause, setUnpause] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const done = () => void qc.invalidateQueries({ queryKey: KEY });
  const engage = useMutation({ mutationFn: safetyApi.killSwitch, onSuccess: () => { setConfirming(false); done(); }, onError: (e) => setNote(errorText(e)) });
  const resume = useMutation({
    mutationFn: () => safetyApi.resume(unpause),
    onSuccess: (r) => { setNote(`Switch cleared. ${r.resumedAgents} agent${r.resumedAgents === 1 ? "" : "s"} resumed; no containers were started.${r.failures.length ? ` Couldn't resume: ${r.failures.join("; ")}` : ""}`); done(); },
    onError: (e) => setNote(errorText(e)),
  });
  const on = sw?.on === true;
  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <OctagonX className="h-5 w-5 text-critical" aria-hidden />
        <h2 className="text-body font-semibold">Kill switch</h2>
        <Chip tone={on ? "critical" : "neutral"}>{on ? "On" : "Off"}</Chip>
      </div>
      <p className="text-compact text-ink-2">Stops every running agent container and VM that ePaperclip manages, and pauses every agent you can reach. It does not touch anything else on the host. Nothing is deleted, and nothing restarts when you clear it.</p>
      {on && sw && <Summary sw={sw} />}
      {note && <Notice tone={note.startsWith("Switch cleared") ? "good" : "critical"}>{note}</Notice>}
      {on ? (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-compact"><input type="checkbox" checked={unpause} onChange={(e) => setUnpause(e.target.checked)} />Also resume the {sw?.paused?.length ?? 0} agents the switch paused</label>
          <Button variant="primary" loading={resume.isPending} onClick={() => resume.mutate()}>Clear the kill switch</Button>
        </div>
      ) : (
        <Button variant="danger" onClick={() => { setNote(null); setConfirming(true); }}>Stop everything…</Button>
      )}
      {confirming && (
        <TypedConfirm title="Stop everything?" subtitle="Agent containers stop now and agents pause" phrase={KILL_PHRASE} action="Stop everything" busy={engage.isPending} error={engage.error ? errorText(engage.error) : null} onClose={() => setConfirming(false)} onConfirm={() => engage.mutate()}>
          <p className="text-compact text-ink-2">Running agent work is cut off without warning. Use this when something is wrong and you need it to stop.</p>
        </TypedConfirm>
      )}
    </Card>
  );
}

function Summary({ sw }: { sw: KillSwitch }) {
  const failures = sw.failures ?? [];
  return (
    <Notice tone={failures.length ? "warning" : "info"} title="What the switch did">
      <p>{sw.stopped?.length ?? 0} container{(sw.stopped?.length ?? 0) === 1 ? "" : "s"} stopped, {sw.paused?.length ?? 0} agent{(sw.paused?.length ?? 0) === 1 ? "" : "s"} paused{sw.by ? `, by ${sw.by}` : ""}.</p>
      {!!sw.unreachableOrganizations && <p>{sw.unreachableOrganizations} organization{sw.unreachableOrganizations === 1 ? "" : "s"} couldn't be reached because you aren't a member; their agents were not paused.</p>}
      {failures.length > 0 && <ul className="list-disc pl-5">{failures.map((f) => <li key={f}>{f}</li>)}</ul>}
    </Notice>
  );
}

function VaultRecoveryCard({ keyId }: { keyId: string | null }) {
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [note, setNote] = useState<{ tone: "good" | "critical" | "warning"; text: string } | null>(null);
  const [restoring, setRestoring] = useState<{ file: RecoveryFile; pass: string } | null>(null);
  const [rPass, setRPass] = useState("");
  const [file, setFile] = useState<RecoveryFile | null>(null);
  const exp = useMutation({
    mutationFn: () => safetyApi.exportRecovery(pass),
    onSuccess: (f) => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(f, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "epaperclip-vault-recovery.json";
      a.click();
      URL.revokeObjectURL(url);
      setPass(""); setPass2("");
      setNote({ tone: "good", text: "Recovery file downloaded. Keep it, and the passphrase, somewhere other than this device." });
    },
    onError: (e) => setNote({ tone: "critical", text: errorText(e) }),
  });
  const restore = useMutation({
    mutationFn: (r: { file: RecoveryFile; pass: string }) => safetyApi.restore(r.file, r.pass),
    onSuccess: (r) => {
      setRestoring(null); setRPass(""); setFile(null);
      setNote(r.same ? { tone: "good", text: "That is already the key this device is using. Nothing changed." } : { tone: "warning", text: "Key restored. Restart ePaperclip to finish: run `systemctl restart epaperclip` on the host. The key it replaced was kept next to vault.key." });
    },
    onError: (e) => setNote({ tone: "critical", text: errorText(e) }),
  });
  const mismatch = pass2.length > 0 && pass !== pass2;
  const readFile = async (f: File | undefined) => {
    setFile(null);
    if (!f) return;
    try { setFile(JSON.parse(await f.text()) as RecoveryFile); } catch { setNote({ tone: "critical", text: "That file isn't a vault recovery file." }); }
  };
  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Download className="h-5 w-5" aria-hidden />
        <h2 className="text-body font-semibold">Vault key recovery</h2>
        {keyId && <Chip>key {keyId}</Chip>}
      </div>
      <p className="text-compact text-ink-2">Every secret on this device is sealed with one key file. If that file is lost or damaged, the secrets can't be read again. Download a recovery file now and keep it elsewhere: it holds the key, locked with a passphrase only you know.</p>
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field htmlFor="recovery-pass" label="Recovery passphrase" hint={`At least ${MIN} characters. There is no way to recover it.`}><Input id="recovery-pass" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" /></Field>
        <Field htmlFor="recovery-pass2" label="Again" error={mismatch ? "The passphrases differ." : undefined}><Input id="recovery-pass2" type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" /></Field>
      </div>
      <Button loading={exp.isPending} disabled={pass.length < MIN || pass !== pass2} disabledReason={pass.length < MIN ? `Use at least ${MIN} characters` : "The passphrases must match"} onClick={() => exp.mutate()}><Download className="h-4 w-4" aria-hidden />Download recovery file</Button>
      <hr className="border-line" />
      <h3 className="text-compact font-semibold">Restore a lost key</h3>
      <p className="text-compact text-ink-2">Use this only when the key file is lost or damaged. It must match secrets already stored here.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field htmlFor="restore-file" label="Recovery file"><input id="restore-file" type="file" accept="application/json,.json" aria-label="Recovery file" onChange={(e) => void readFile(e.target.files?.[0])} /></Field>
        <Field htmlFor="restore-pass" label="Its passphrase"><Input id="restore-pass" type="password" value={rPass} onChange={(e) => setRPass(e.target.value)} autoComplete="off" /></Field>
      </div>
      <Button variant="danger" disabled={!file || !rPass} disabledReason={!file ? "Choose a recovery file" : "Enter its passphrase"} onClick={() => file && setRestoring({ file, pass: rPass })}><Upload className="h-4 w-4" aria-hidden />Restore key…</Button>
      {restoring && (
        <TypedConfirm title="Restore the vault key?" subtitle="Replaces the key file; a restart is needed" phrase={RESTORE_PHRASE} action="Restore key" busy={restore.isPending} error={restore.error ? errorText(restore.error) : null} onClose={() => setRestoring(null)} onConfirm={() => restore.mutate(restoring)}>
          <p className="text-compact text-ink-2">The current key is kept next to the new one, so this can be undone by hand.</p>
        </TypedConfirm>
      )}
    </Card>
  );
}
