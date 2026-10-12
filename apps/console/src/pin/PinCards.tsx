import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Building2, Camera, Check, CircleSlash, Cpu, ListPlus, MemoryStick, Power, Workflow, XCircle, Zap } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { engine as engineClient } from "../data/engine/queries.ts";
import { qk } from "../data/engine/keys.ts";
import { cn, formatBytes } from "../lib/storage.ts";
import { Button } from "../ui/primitives.tsx";
import { BarMeter } from "../ui/meters.tsx";
import type { PinCard } from "./brain.ts";
import { usePin, type PinToolState } from "./PinContext.tsx";
import { describeTool, kindOf, runTool } from "./tools.ts";

/** The one shell every card in Pin's conversation uses: a label, the content, then its actions or outcome. */
export function CardShell({ icon, label, children, footer, tone = "neutral" }: { icon: ReactNode; label: string; children: ReactNode; footer?: ReactNode; tone?: "neutral" | "danger" }) {
  return (
    <div className={cn("mt-2 rounded-xl border bg-surface-2/50 p-3.5 fade-in", tone === "danger" ? "border-critical/25" : "border-line")}>
      <div className="flex items-center gap-1.5 text-micro font-semibold uppercase tracking-label text-ink-3 mb-1.5">
        <span aria-hidden className="[&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
        {label}
      </div>
      {children}
      {footer && <div className="mt-3 flex flex-wrap items-center gap-2">{footer}</div>}
    </div>
  );
}

const Outcome = ({ ok, children }: { ok: boolean; children: ReactNode }) => (
  <span role="status" className={cn("inline-flex items-center gap-1.5 text-compact", ok ? "text-good" : "text-critical")}>
    {ok ? <Check className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
    {children}
  </span>
);

export function PinCardView({ card, done, onDone }: { card: PinCard; done?: boolean; onDone: () => void }) {
  const engine = useEngine();
  const navigate = useNavigate();
  const device = engine.setup?.deviceName ?? "pve";
  const [error, setError] = useState<string | null>(null);

  if (card.type === "rule") {
    return (
      <CardShell
        icon={<Workflow />}
        label="Automation"
        footer={done ? <Outcome ok>Saved</Outcome> : (
          <>
            <Button size="sm" variant="primary" onClick={() => { engine.saveRule(card.rule); engine.notify({ kind: "automation", title: "Automation saved", body: card.readBack }); onDone(); }}>Save automation</Button>
            <Button size="sm" variant="ghost" onClick={() => navigate(`/${device}/automations`)}>View all</Button>
          </>
        )}
      >
        <p className="text-sm text-pretty">{card.readBack}</p>
        <div className="mt-2 font-mono text-micro text-ink-3 break-all">
          {card.rule.when.metric} {card.rule.when.op} {String(card.rule.when.value)} · {card.rule.then.action} · cooldown {card.rule.cooldownSeconds}s
        </div>
      </CardShell>
    );
  }

  if (card.type === "org") {
    return (
      <CardShell
        icon={<Building2 />}
        label="New organization"
        footer={done ? <Outcome ok>Created</Outcome> : (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              const r = engine.createOrg(card.name, card.size, "pin");
              if (!r.ok) return setError(r.error);
              engine.notify({ kind: "info", title: `${card.name} is ready`, body: "Pin created it with its own resource group." });
              onDone();
              navigate(`/${device}/${r.org.slug}`);
            }}
          >
            Create {card.name}
          </Button>
        )}
      >
        <div className="font-medium">{card.name}</div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-2 text-compact text-ink-2">
          <span className="inline-flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5 text-ink-3" />{card.size.cores} core{card.size.cores === 1 ? "" : "s"}</span>
          <span className="inline-flex items-center gap-1.5"><MemoryStick className="h-3.5 w-3.5 text-ink-3" />{formatBytes(card.size.memoryMb * 1024 ** 2)}</span>
          <span>{card.size.diskGb} GB disk</span>
          <span>Up to {card.size.maxGuests} containers</span>
        </div>
        <p className="text-xs text-ink-3 mt-2">{card.why}</p>
        {error && <p role="alert" className="text-xs text-critical mt-2">{error}</p>}
      </CardShell>
    );
  }

  if (card.type === "status") {
    const h = engine.host;
    return (
      <div className="mt-2 rounded-xl border border-line bg-surface-2/50 p-3.5 grid gap-3 fade-in">
        <BarMeter label="CPU" pct={h.cpuPct} value={`${h.cpuPct.toFixed(0)}% of ${h.cpus} CPUs`} />
        <BarMeter label="Memory" pct={(h.memUsed / h.memTotal) * 100} value={`${formatBytes(h.memUsed)} of ${formatBytes(h.memTotal)}`} />
        <BarMeter label="Storage" pct={(h.diskUsed / h.diskTotal) * 100} value={`${formatBytes(h.diskUsed)} of ${formatBytes(h.diskTotal)}`} />
      </div>
    );
  }

  return (
    <Link to={card.to} className="transition-control mt-2 inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-line bg-surface-2/60 text-compact font-medium hover:bg-surface-3">
      {card.label} <ArrowRight className="h-3.5 w-3.5" />
    </Link>
  );
}

const TOOL_ICON = { power: <Power />, snapshot: <Camera />, task: <ListPlus />, rule: <Workflow />, navigate: <ArrowRight />, unknown: <Zap /> };

/**
 * A proposal from Pin (a `tool` event). Proposed actions wait for the person: Confirm runs the console's own action,
 * Cancel leaves everything as it was. Actions Pin already did (status done or error) show their outcome.
 */
export function ToolCard({ messageId, tool }: { messageId: string; tool: PinToolState }) {
  const engine = useEngine();
  const pin = usePin();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const view = describeTool(tool, engine);
  const kind = kindOf(tool);

  if (tool.status !== "proposed") {
    return (
      <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-line bg-surface-2/50 h-8 px-3 text-compact text-ink-2 fade-in">
        {tool.status === "done" ? <Check className="h-3.5 w-3.5 text-good" aria-hidden /> : <XCircle className="h-3.5 w-3.5 text-critical" aria-hidden />}
        <span className="truncate">{tool.status === "done" ? `Looked up ${tool.name.replace(/_/g, " ")}` : tool.error ?? `${tool.name.replace(/_/g, " ")} failed`}</span>
      </div>
    );
  }

  const confirm = async () => {
    setBusy(true);
    const r = await runTool(tool, engine, {
      nav,
      createTask: engine.live
        ? async (companyId, title, description) => {
            await engineClient.issues.create(companyId, { title, ...(description ? { description } : {}) });
            await qc.invalidateQueries({ queryKey: qk.company(companyId) });
          }
        : undefined,
    });
    setBusy(false);
    pin.resolveTool(messageId, r.ok ? { resolved: "done", note: r.note } : { resolved: "failed", note: r.error });
  };

  return (
    <CardShell
      icon={TOOL_ICON[kind]}
      label={tool.resolved ? "Pin's proposal" : "Pin proposes"}
      tone={view.danger && !tool.resolved ? "danger" : "neutral"}
      footer={
        tool.resolved === "done" ? <Outcome ok>{tool.note ?? "Done"}</Outcome>
        : tool.resolved === "failed" ? <Outcome ok={false}>{tool.note ?? "That didn't work."}</Outcome>
        : tool.resolved === "cancelled" ? <span className="inline-flex items-center gap-1.5 text-compact text-ink-3"><CircleSlash className="h-4 w-4" />Cancelled. Nothing changed.</span>
        : (
          <>
            <Button size="sm" variant={view.danger ? "danger" : "primary"} disabled={!view.runnable} loading={busy} onClick={confirm}>{view.confirmLabel}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => pin.resolveTool(messageId, { resolved: "cancelled" })}>Cancel</Button>
          </>
        )
      }
    >
      <div className="font-medium text-sm">{view.title}</div>
      <p className="text-compact text-ink-2 mt-0.5 text-pretty">{view.body}</p>
      {view.details.length > 0 && <div className="mt-2 font-mono text-micro text-ink-3 break-all">{view.details.join(" · ")}</div>}
    </CardShell>
  );
}
