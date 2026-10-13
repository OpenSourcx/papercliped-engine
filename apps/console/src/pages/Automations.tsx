import { describeRule } from "@papercliped-engine/automations";
import { Sparkles, Trash2, Workflow } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { usePin } from "../pin/PinContext.tsx";
import { Button, Card, Chip, EmptyState, PageHeader, Toggle, PageFrame } from "../ui/primitives.tsx";
import { AutomationsLive } from "./pin/runtime.tsx";

export function Automations() {
  const { data, setup, toggleRule, deleteRule, live } = useEngine();
  const pin = usePin();
  const mode = setup?.pinMode ?? "assistant";
  // On a connected device automations run on the host; the rules below are the demo's, kept in the browser.
  if (live) {
    return (
      <PageFrame width="4xl">
        <PageHeader title="Automations" subtitle="Rules and schedules that run on this device, with their history. Tell Pin what you want, or build one here." actions={<Button onClick={() => pin.send("If a container uses more than 80% of its memory for 5 minutes, notify me")}><Sparkles className="h-4 w-4" />Ask Pin</Button>} />
        <AutomationsLive />
      </PageFrame>
    );
  }
  return (
    <PageFrame width="4xl">
      <PageHeader
        title="Automations"
        subtitle={<>Rules Pin runs for you. Tell Pin what you want in plain words; it writes the rule and a strict validator checks it. {mode === "assistant" ? "Pin is in Assistant mode, so firing rules ask you before acting." : "Pin is in Agent mode, so firing rules act right away and tell you after."}</>}
        actions={<Button variant="primary" onClick={() => pin.send("If a container uses more than 50% of its memory, shut it down")}><Sparkles className="h-4 w-4" />New with Pin</Button>}
      />
      {data.rules.length === 0 ? (
        <Card><EmptyState icon={<Workflow className="h-5 w-5" />} title="No automations yet" body='Try telling Pin: "If a container uses more than 50% of its memory, shut it down."' /></Card>
      ) : (
        <div className="space-y-3">
          {data.rules.map((r) => (
            <Card key={r.id} className="p-4 flex items-start gap-4">
              <span className="h-9 w-9 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2 shrink-0"><Workflow className="h-4 w-4" /></span>
              <div className="flex-1 min-w-0">
                <p className="text-body">{describeRule(r)}</p>
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <span className="font-mono text-micro text-ink-3">{r.when.metric} {r.when.op} {String(r.when.value)} · {r.then.action} · cooldown {r.cooldownSeconds}s</span>
                  {r.createdBy === "pin" && <Chip tone="accent"><Sparkles className="h-3 w-3" />By Pin</Chip>}
                </div>
              </div>
              <Toggle label={`Enable ${r.name}`} checked={r.enabled} onChange={() => toggleRule(r.id)} />
              <button onClick={() => deleteRule(r.id)} className="h-8 w-8 rounded-lg hover:bg-surface-2 flex items-center justify-center text-ink-3 hover:text-critical" aria-label={`Delete ${r.name}`}><Trash2 className="h-4 w-4" /></button>
            </Card>
          ))}
        </div>
      )}
      <p className="text-xs text-ink-3 mt-4">Automations can notify, shut down, stop, start or snapshot guests. They can never delete anything, and protected guests only ever get a notification.</p>
    </PageFrame>
  );
}
