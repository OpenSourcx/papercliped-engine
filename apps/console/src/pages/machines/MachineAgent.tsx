import { useState } from "react";
import { Eraser, FileText, KeyRound, Loader2, Snowflake, SquareTerminal, Terminal as TerminalIcon, Zap } from "lucide-react";
import { errorText } from "../../data/engine/guestApi.ts";
import { useMachineApi, type AgentResult } from "../../data/engine/machineApi.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, Input, Notice, SectionTitle } from "../../ui/primitives.tsx";
import { useLoad } from "../disks/common.tsx";
import { formatBytes } from "../../lib/storage.ts";
import { Dd, Dl, Dt } from "./MachineSettingsKit.tsx";

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");

/** What the guest agent knows about the machine, and what it can be asked to do. Needs the agent running inside the VM. */
export function MachineAgent({ vmid, name, running }: { vmid: number; name: string; running: boolean }) {
  const api = useMachineApi();
  const [tick, setTick] = useState(0);
  const load = (what: string) => useLoad(() => (running ? api.agentRead(vmid, what) : Promise.reject(new Error("off"))), [api, vmid, what, running, tick]); // eslint-disable-line react-hooks/rules-of-hooks
  const os = load("osinfo");
  const fs = load("fsinfo");
  const users = load("users");
  const tz = load("timezone");
  const cpus = load("vcpus");
  const info = load("info");
  const [action, setAction] = useState<"password" | "exec" | "file" | "freeze" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!running) return <Card className="p-8 text-center"><p className="text-ink-2">{name} is stopped.</p><p className="text-compact text-ink-3 mt-1">Start it to ask the guest agent about it. The agent runs inside the machine.</p></Card>;
  const down = [os, fs, users].find((x) => x.error)?.error;
  const quick = async (label: string, body: Record<string, unknown>) => {
    setBusy(label);
    setNote(null);
    try {
      const r: AgentResult = await api.agent(vmid, body);
      setNote(r.message ?? "Done.");
    } catch (e) {
      setNote(errorText(e, "The agent didn't answer"));
    }
    setBusy(null);
    setTick((n) => n + 1);
  };
  const o = (os.data?.result ?? null) as Row | null;
  const mounts = ((fs.data?.result ?? []) as Row[]).filter((m) => s(m.mountpoint));
  const userList = (users.data?.result ?? []) as Row[];
  const cpuList = (cpus.data?.result ?? []) as Row[];
  const cmds = (((info.data?.result ?? {}) as Row).supported_commands ?? []) as Row[];
  return (
    <div className="space-y-4 fade-in">
      {down && <Notice tone="warning" title="The guest agent isn't answering">{down} Turn it on under Hardware, Options, and install qemu-guest-agent inside the machine.</Notice>}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-5">
          <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => quick("ping", { action: "ping" })}>{busy === "ping" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}Ping</Button>}>Operating system</SectionTitle>
          {o ? (
            <Dl>
              <Dt>System</Dt><Dd>{s(o["pretty-name"]) || s(o.name)}</Dd>
              <Dt>Kernel</Dt><Dd><span className="font-mono text-compact">{s(o["kernel-release"])}</span></Dd>
              <Dt>Architecture</Dt><Dd>{s(o.machine)}</Dd>
              <Dt>Time zone</Dt><Dd>{s(((tz.data?.result ?? {}) as Row).zone) || "—"}</Dd>
              <Dt>Agent</Dt><Dd>{s(((info.data?.result ?? {}) as Row).version) || "—"}{cmds.length ? ` · ${cmds.filter((c) => c.enabled).length} commands` : ""}</Dd>
            </Dl>
          ) : <p className="text-sm text-ink-3">{os.error ?? "Reading…"}</p>}
        </Card>
        <Card className="p-5">
          <SectionTitle>Signed-in users and CPUs</SectionTitle>
          {users.data ? (userList.length ? <div className="text-sm space-y-1">{userList.map((u, i) => <div key={i} className="flex justify-between"><span className="font-mono">{s(u.user)}</span><span className="text-ink-3 text-compact">{typeof u["login-time"] === "number" ? new Date((u["login-time"] as number) * 1000).toLocaleString() : ""}</span></div>)}</div> : <p className="text-sm text-ink-3">Nobody is signed in.</p>) : <p className="text-sm text-ink-3">{users.error ?? "Reading…"}</p>}
          {cpus.data && <p className="text-compact text-ink-2 mt-3">{cpuList.filter((c) => c.online).length} of {cpuList.length} CPUs online</p>}
        </Card>
      </div>
      <Card className="p-5">
        <SectionTitle>File systems</SectionTitle>
        {fs.data ? (mounts.length ? (
          <div className="divide-y divide-line">{mounts.map((m, i) => {
            const used = Number(m["used-bytes"] ?? 0), total = Number(m["total-bytes"] ?? 0);
            return <div key={i} className="py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-compact"><span className="font-mono w-40 truncate">{s(m.mountpoint)}</span><Chip>{s(m.type)}</Chip><span className="text-ink-2 flex-1">{total ? `${formatBytes(used)} of ${formatBytes(total)} used` : ""}</span><span className="text-ink-3 font-mono">{s(m.name)}</span></div>;
          })}</div>
        ) : <p className="text-sm text-ink-3">The agent lists no file systems.</p>) : <p className="text-sm text-ink-3">{fs.error ?? "Reading…"}</p>}
      </Card>
      <Card className="p-5">
        <SectionTitle>Actions</SectionTitle>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => quick("trim", { action: "fstrim" })}>{busy === "trim" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eraser className="h-3.5 w-3.5" />}Trim unused space</Button>
          <Button size="sm" onClick={() => setAction("freeze")}><Snowflake className="h-3.5 w-3.5" />Freeze or thaw</Button>
          <Button size="sm" onClick={() => setAction("password")}><KeyRound className="h-3.5 w-3.5" />Set a user's password</Button>
          <Button size="sm" onClick={() => setAction("file")}><FileText className="h-3.5 w-3.5" />Read a file</Button>
          <Button size="sm" onClick={() => setAction("exec")}><TerminalIcon className="h-3.5 w-3.5" />Run a command</Button>
        </div>
        {note && <p role="status" className="text-compact text-ink-2 mt-3">{note}</p>}
        <p className="text-xs text-ink-3 mt-3">Running a command, reading a file and setting a password need the VM.GuestAgent.Unrestricted permission (file reading: VM.GuestAgent.FileRead). Proxmox decides; if it says no, you'll see why.</p>
      </Card>
      {action === "password" && <PasswordModal vmid={vmid} onClose={() => setAction(null)} />}
      {action === "exec" && <ExecModal vmid={vmid} onClose={() => setAction(null)} />}
      {action === "file" && <FileModal vmid={vmid} onClose={() => setAction(null)} />}
      {action === "freeze" && <FreezeModal vmid={vmid} onClose={() => setAction(null)} />}
    </div>
  );
}

function useAgentCall(vmid: number) {
  const api = useMachineApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AgentResult | null>(null);
  const call = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.agent(vmid, body));
    } catch (e) {
      setError(errorText(e, "The agent didn't answer"));
    }
    setBusy(false);
  };
  return { call, busy, error, result };
}

function PasswordModal({ vmid, onClose }: { vmid: number; onClose: () => void }) {
  const { call, busy, error, result } = useAgentCall(vmid);
  const [user, setUser] = useState("");
  const [pw, setPw] = useState("");
  return (
    <Modal size="sm" icon={<KeyRound className="h-5 w-5" />} title="Set a user's password" subtitle="Changes the password inside the machine through the guest agent." onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" disabled={busy || !user || pw.length < 5} onClick={() => call({ action: "set-password", user, password: pw })}>Set password</Button></>}>
      <div className="space-y-3">
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">User name inside the machine</span><Input value={user} onChange={(e) => setUser(e.target.value)} className="font-mono" autoComplete="off" /></label>
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">New password</span><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /><span className="block text-xs text-ink-3 mt-1.5">Write-only. It is never shown or logged.</span></label>
        {result?.message && <p role="status" className="text-compact text-ink-2">{result.message}</p>}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function ExecModal({ vmid, onClose }: { vmid: number; onClose: () => void }) {
  const { call, busy, error, result } = useAgentCall(vmid);
  const [cmd, setCmd] = useState("uname -a");
  const [typed, setTyped] = useState("");
  return (
    <Modal size="lg" icon={<SquareTerminal className="h-5 w-5" />} title="Run a command" subtitle="Runs inside the machine as the agent's user (usually root). No shell: pipes and wildcards are not expanded." onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" disabled={busy || !cmd.trim() || typed !== "run"} onClick={() => call({ action: "exec", command: cmd, confirm: "run" })}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Run</Button></>}>
      <div className="space-y-3">
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Command</span><Input value={cmd} onChange={(e) => setCmd(e.target.value)} className="font-mono" spellCheck={false} /></label>
        <label className="block"><span className="block text-xs text-ink-3 mb-1.5">Type <span className="font-mono text-ink-2">run</span> to confirm</span><Input value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" /></label>
        {result && <div><p className="text-compact text-ink-2 mb-1">{result.finished ? `Finished with exit code ${result.exitcode}` : result.message}</p>{result.out && <pre className="rounded-lg bg-surface-2 border border-line p-3 text-compact font-mono overflow-x-auto max-h-64 whitespace-pre-wrap">{result.out}</pre>}{result.err && <pre className="rounded-lg bg-surface-2 border border-line p-3 text-compact font-mono overflow-x-auto max-h-40 whitespace-pre-wrap text-critical">{result.err}</pre>}</div>}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function FileModal({ vmid, onClose }: { vmid: number; onClose: () => void }) {
  const { call, busy, error, result } = useAgentCall(vmid);
  const [file, setFile] = useState("/etc/os-release");
  return (
    <Modal size="lg" icon={<FileText className="h-5 w-5" />} title="Read a file" subtitle="Reads up to 64 KiB of a file inside the machine through the guest agent." onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" disabled={busy || !file.startsWith("/") && !/^[A-Za-z]:/.test(file)} onClick={() => call({ action: "read-file", file })}>Read</Button></>}>
      <div className="space-y-3">
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Full path</span><Input value={file} onChange={(e) => setFile(e.target.value)} className="font-mono" spellCheck={false} /></label>
        {result?.content !== undefined && <pre className="rounded-lg bg-surface-2 border border-line p-3 text-compact font-mono overflow-x-auto max-h-80 whitespace-pre-wrap">{result.content}{result.truncated ? "\n… (cut off at 64 KiB)" : ""}</pre>}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function FreezeModal({ vmid, onClose }: { vmid: number; onClose: () => void }) {
  const { call, busy, error, result } = useAgentCall(vmid);
  const [typed, setTyped] = useState("");
  return (
    <Modal size="sm" icon={<Snowflake className="h-5 w-5" />} title="Freeze or thaw file systems" subtitle="Freezing stops all writes inside the machine so a snapshot or copy is consistent. Always thaw afterwards." onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button disabled={busy} onClick={() => call({ action: "freeze-status" })}>Status</Button><Button disabled={busy} onClick={() => call({ action: "thaw" })}>Thaw</Button><Button variant="danger" disabled={busy || typed !== "freeze"} onClick={() => call({ action: "freeze", confirm: "freeze" })}>Freeze</Button></>}>
      <div className="space-y-3">
        <label className="block"><span className="block text-xs text-ink-3 mb-1.5">Type <span className="font-mono text-ink-2">freeze</span> to enable Freeze</span><Input value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" /></label>
        {result?.message && <p role="status" className="text-compact text-ink-2">{result.message}</p>}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}
