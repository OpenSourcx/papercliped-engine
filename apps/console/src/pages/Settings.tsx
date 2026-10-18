import { Link, useNavigate } from "react-router-dom";
import { BookOpen, FileText, LogOut, Server, ShieldCheck } from "lucide-react";
import { useSession } from "../auth/session.tsx";
import { useEngine } from "../data/store.tsx";
import { usePin } from "../pin/PinContext.tsx";
import { formatBytes, formatUptime } from "../lib/storage.ts";
import { Button, Card, Chip, PageHeader, Segmented, SectionTitle, PageFrame } from "../ui/primitives.tsx";

export function Settings() {
  const { setup, host, resetAll, live } = useEngine();
  const pin = usePin();
  const { session, signOut } = useSession();
  const navigate = useNavigate();
  return (
    <PageFrame width="3xl" className="space-y-4">
      <PageHeader title="General" />
      {session.mode === "live" && (
        <Card className="p-5">
          <SectionTitle>Account</SectionTitle>
          <div className="flex flex-wrap items-center gap-3">
            <span className="h-10 w-10 rounded-lg bg-surface-2 flex items-center justify-center"><ShieldCheck className="h-5 w-5 text-ink-2" /></span>
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{session.user.username}</div>
              <div className="text-compact text-ink-3">Signed in with Proxmox. What you can see and change here is what this Proxmox user is allowed to.</div>
            </div>
            <Button onClick={() => void signOut()}><LogOut className="h-4 w-4" />Sign out</Button>
          </div>
        </Card>
      )}
      <Card className="p-5">
        <SectionTitle>Device</SectionTitle>
        <div className="flex items-center gap-3">
          <span className="h-10 w-10 rounded-lg bg-surface-2 flex items-center justify-center"><Server className="h-5 w-5 text-ink-2" /></span>
          <div>
            <div className="font-medium">{setup?.deviceName}</div>
            <div className="text-compact text-ink-3">{host.cpuModel} · {host.cpus} CPUs · {formatBytes(host.memTotal)} · up {formatUptime(host.uptimeSec)}</div>
          </div>
        </div>
        <p className="text-xs text-ink-3 mt-3">This name is the root of every address in the console: /{setup?.deviceName}/home, /{setup?.deviceName}/&lt;organization&gt;. It does not rename the server; its hostname is changed on the host itself (see the Proxmox documentation on renaming a node).</p>
      </Card>
      <Card className="p-5">
        <SectionTitle action={<Link to={`/${setup?.deviceName ?? "pve"}/pin`} className="text-compact text-ink-3 hover:text-ink">Open Pin's page</Link>}>Pin</SectionTitle>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-ink-2">Mode</div>
          <Segmented value={setup?.pinMode ?? "assistant"} label="Pin's mode" onChange={pin.setMode} options={[{ value: "assistant", label: "Assistant" }, { value: "agent", label: "Agent" }]} />
        </div>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[[<FileText key="s" className="h-4 w-4" />, "SOUL.md", "Who Pin is and how it behaves"], [<BookOpen key="m" className="h-4 w-4" />, "MEMORY.md", "What Pin has learned about you and this device"]].map(([icon, file, body]) => (
            <div key={String(file)} className="rounded-lg border border-line p-3">
              <div className="flex items-center gap-2 font-mono text-compact">{icon}{file}</div>
              <div className="text-xs text-ink-3 mt-1">{body}</div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {setup && Object.entries(setup.pinAccess).filter(([, v]) => v).map(([k]) => <Chip key={k}>{{ system: "Manages this device", orgs: "Manages organizations", connectors: "Uses connectors", docs: "Reads Proxmox docs" }[k]}</Chip>)}
        </div>
      </Card>
      <Card className="p-5">
        <SectionTitle>{live ? "This browser" : "Demo"}</SectionTitle>
        <p className="text-sm text-ink-2">{live ? "The device, its machines, organizations, agents and tasks are kept on the device, not in this browser. This browser only remembers the console's own settings: the device name, Pin's mode and files, and your appearance. Resetting clears those here and runs onboarding again. Nothing on the device changes." : "The console is running on demo data in this browser. Starting over clears it and runs onboarding again."}</p>
        <Button variant={live ? "secondary" : "danger"} className="mt-3" onClick={() => { resetAll(); navigate("/setup"); }}>{live ? "Reset this browser's settings" : "Start over"}</Button>
      </Card>
    </PageFrame>
  );
}
