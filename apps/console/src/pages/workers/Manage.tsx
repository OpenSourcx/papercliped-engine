import { useState } from "react";
import { Download, RotateCw, ScrollText, Trash2 } from "lucide-react";
import { fabricApi, fabricErrorText, useFabricAction, type ManageAction, type Worker, type WorkerStats } from "../../data/engine/fabric.ts";
import { useConfirm } from "../../ui/Confirm.tsx";
import { Button, Card, Field, Input, Notice, SectionTitle } from "../../ui/primitives.tsx";
import { Select } from "../../ui/Select.tsx";
import { gb } from "./util.ts";

/** Suggested by memory, as the machine setup does. A suggestion only; any valid Ollama model name works. */
const SUGGEST = [["qwen2.5-coder:3b", "about 1.9 GB, fits 8 GB devices"], ["llama3.2:3b", "about 2 GB"], ["qwen2.5-coder:7b", "about 4.7 GB, needs 16 GB or more"]] as const;

export function ManagePanel({ w, stats }: { w: Worker; stats: WorkerStats | undefined }) {
  const { ask, dialog } = useConfirm();
  const run = useFabricAction((a: { action: ManageAction; params?: Record<string, unknown> }) => fabricApi.manage(w.id, a.action, a.params));
  const [model, setModel] = useState("");
  const [unit, setUnit] = useState("worker");
  const [log, setLog] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [sha, setSha] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const off = !w.online;
  const go = (action: ManageAction, params?: Record<string, unknown>, ok?: string) => run.mutateAsync({ action, params }).then((r) => { setNote(ok ?? "Done."); return r; });
  const s = stats?.latest;
  const pull = s?.pulls[0];
  return (
    <div className="grid gap-5">
      {dialog}
      <Notice tone="info">Every action here is signed by this device, checked again by the worker, and recorded in Activity with your name. The worker never runs a command line from here; each action is fixed. A worker set up by the machine setup script supports all of them; a worker installed by hand supports models and logs only.</Notice>
      {off && <Notice tone="warning">This worker is offline, so nothing here can run until it reconnects.</Notice>}
      {run.error && <p role="alert" className="text-compact text-critical">{fabricErrorText(run.error)}</p>}
      {note && !run.error && <p role="status" className="text-compact text-ink-2">{note}</p>}
      <Card className="p-4 sm:p-5">
        <SectionTitle>Services</SectionTitle>
        <div className="flex flex-wrap gap-3">
          <Button disabled={off} onClick={() => ask({ title: `Restart the worker on ${w.name}?`, label: "Restart worker", body: "The worker reconnects within seconds. Commands running right now on it are stopped.", run: () => go("restart-worker", undefined, "Restart scheduled; the worker reconnects shortly.") })}><RotateCw className="h-4 w-4" />Restart worker</Button>
          <Button disabled={off} onClick={() => ask({ title: `Restart Ollama on ${w.name}?`, label: "Restart Ollama", body: "Loaded models are unloaded and any generation in progress is cut off.", run: () => go("restart-ollama", undefined, "Ollama restarted.") })}><RotateCw className="h-4 w-4" />Restart Ollama</Button>
        </div>
      </Card>
      <Card className="p-4 sm:p-5">
        <SectionTitle>Models</SectionTitle>
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (model.trim()) void go("model-pull", { name: model.trim() }, `Downloading ${model.trim()}. Progress shows below.`).catch(() => {}); }}>
          <Field label="Download a model" htmlFor="model-name" className="flex-1 min-w-56"><Input id="model-name" value={model} onChange={(e) => setModel(e.target.value)} placeholder="qwen2.5-coder:3b" maxLength={120} list="model-suggest" /></Field>
          <datalist id="model-suggest">{SUGGEST.map(([n]) => <option key={n} value={n} />)}</datalist>
          <Button type="submit" disabled={off || !model.trim() || (!!pull && !pull.done)} loading={run.isPending}><Download className="h-4 w-4" />Download</Button>
        </form>
        <p className="mt-2 text-xs text-ink-3">{SUGGEST.map(([n, d]) => `${n}: ${d}`).join(". ")}. Check free disk and memory on the Health tab first.</p>
        {pull && <p className="mt-3 text-compact" role="status">{pull.name}: {pull.done ? (pull.error ? `failed, ${pull.error}` : "finished") : `${pull.status}${pull.pct !== null ? `, ${pull.pct}%` : ""}`}</p>}
        <ul className="mt-4 divide-y divide-line">
          {(s?.ollama?.available ?? []).map((m) => (
            <li key={m.name} className="py-2 flex items-center gap-3"><span className="font-mono text-compact flex-1 break-all">{m.name}</span><span className="text-xs text-ink-3 tabular-nums">{gb(m.sizeMb)}</span>
              <Button size="sm" variant="danger" disabled={off} aria-label={`Remove ${m.name}`} onClick={() => ask({ title: `Remove ${m.name}?`, label: "Remove model", danger: true, body: "The files are deleted from the worker. You can download it again later.", run: () => go("model-remove", { name: m.name }, `${m.name} removed.`) })}><Trash2 className="h-4 w-4" /></Button></li>
          ))}
          {!s?.ollama?.available.length && <li className="py-2 text-compact text-ink-3">No models installed.</li>}
        </ul>
      </Card>
      <Card className="p-4 sm:p-5">
        <SectionTitle>Logs</SectionTitle>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Service" htmlFor="log-unit"><Select id="log-unit" value={unit} onChange={(e) => setUnit(e.target.value)}><option value="worker">Worker</option><option value="ollama">Ollama</option><option value="tailscale">Tailscale</option></Select></Field>
          <Button disabled={off} loading={run.isPending} onClick={() => void run.mutateAsync({ action: "logs", params: { unit, lines: 200 } }).then((r) => setLog(String(r.result.text ?? ""))).catch(() => {})}><ScrollText className="h-4 w-4" />Show last 200 lines</Button>
        </div>
        {log !== null && <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-surface-2 p-3 text-xs font-mono whitespace-pre-wrap break-words" tabIndex={0} aria-label="Log output">{log || "Nothing logged."}</pre>}
      </Card>
      <Card className="p-4 sm:p-5">
        <SectionTitle>Update the worker</SectionTitle>
        <p className="text-compact text-ink-2 mb-3">Give the https address of a release tarball and its SHA-256 (from the release page). The worker downloads it, checks the checksum, and a root helper checks this device's signature again before installing. The previous version is kept for rollback.</p>
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); ask({ title: `Update the worker on ${w.name}?`, label: "Update", body: "The worker restarts on the new version.", run: () => go("update", { url: url.trim(), sha256: sha.trim().toLowerCase() }, "Update scheduled; the worker reconnects on the new version.") }); }}>
          <Field label="Tarball address" htmlFor="upd-url"><Input id="upd-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://.../epaperclip-worker-0.1.1.tar.gz" /></Field>
          <Field label="SHA-256" htmlFor="upd-sha"><Input id="upd-sha" value={sha} onChange={(e) => setSha(e.target.value)} className="font-mono" maxLength={64} /></Field>
          <div><Button type="submit" disabled={off || !/^https:\/\//.test(url.trim()) || !/^[A-Fa-f0-9]{64}$/.test(sha.trim())}>Update worker</Button></div>
        </form>
      </Card>
    </div>
  );
}
