import { CheckCircle2, Download, RefreshCw } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { usePin } from "../pin/PinContext.tsx";
import { Button, Card, PageHeader, Status, PageFrame } from "../ui/primitives.tsx";

export function Updates() {
  const { data, host } = useEngine();
  const pin = usePin();
  const updates = data.notices.filter((n) => n.kind === "update");
  return (
    <PageFrame width="3xl">
      <PageHeader title="Updates" subtitle="Pin follows Proxmox and Paperclip releases and tells you when something new lands. Updates are applied only when you approve, after snapshots." actions={<Button onClick={() => pin.send("Are there any updates?")}><RefreshCw className="h-4 w-4" />Ask Pin</Button>} />
      <div className="grid sm:grid-cols-2 gap-4 mb-6">
        <Card className="p-5"><div className="text-[12px] text-ink-3">Proxmox VE</div><div className="text-[20px] font-semibold mt-1">{host.version}</div>{updates.length ? <Status kind="warning" label="Update available" /> : <Status kind="good" label="Up to date" />}</Card>
        <Card className="p-5"><div className="text-[12px] text-ink-3">ePaperclip</div><div className="text-[20px] font-semibold mt-1">0.1.0</div><Status kind="good" label="Up to date" /></Card>
      </div>
      <div className="space-y-3">
        {updates.length === 0 && <Card className="p-5 flex items-center gap-3"><CheckCircle2 className="h-5 w-5 text-good" />Everything is up to date.</Card>}
        {updates.map((u) => (
          <Card key={u.id} className="p-5">
            <div className="font-medium">{u.title}</div>
            <p className="text-[14px] text-ink-2 mt-1">{u.body}</p>
            <div className="mt-4 flex gap-2">
              <Button variant="primary" disabled title="Applying updates arrives with the host broker"><Download className="h-4 w-4" />Snapshot and update</Button>
              <Button variant="ghost" onClick={() => pin.send("What's in the update?")}>Ask Pin about it</Button>
            </div>
          </Card>
        ))}
      </div>
    </PageFrame>
  );
}
