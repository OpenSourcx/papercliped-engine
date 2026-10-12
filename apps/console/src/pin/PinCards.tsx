import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Building2, Check, Cpu, MemoryStick, Workflow } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { formatBytes } from "../lib/storage.ts";
import { Button } from "../ui/primitives.tsx";
import { BarMeter } from "../ui/meters.tsx";
import type { PinCard } from "./brain.ts";

export function PinCardView({ card, done, onDone }: { card: PinCard; done?: boolean; onDone: () => void }) {
  const engine = useEngine();
  const navigate = useNavigate();
  const device = engine.setup?.deviceName ?? "pve";
  const [error, setError] = useState<string | null>(null);

  if (card.type === "rule") {
    return (
      <div className="mt-2 rounded-xl border border-line bg-surface/70 p-3">
        <div className="flex items-center gap-2 text-xs text-ink-3 mb-1.5">
          <Workflow className="h-3.5 w-3.5" /> Automation
        </div>
        <p className="text-sm leading-snug">{card.readBack}</p>
        <div className="mt-2 font-mono text-micro text-ink-3 break-all">
          {card.rule.when.metric} {card.rule.when.op} {String(card.rule.when.value)} · {card.rule.then.action} · cooldown {card.rule.cooldownSeconds}s
        </div>
        <div className="mt-3 flex gap-2">
          {done ? (
            <span className="inline-flex items-center gap-1.5 text-compact text-good"><Check className="h-4 w-4" /> Saved</span>
          ) : (
            <>
              <Button size="sm" variant="primary" onClick={() => { engine.saveRule(card.rule); engine.notify({ kind: "automation", title: "Automation saved", body: card.readBack }); onDone(); }}>Save automation</Button>
              <Button size="sm" variant="ghost" onClick={() => navigate(`/${device}/automations`)}>View all</Button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (card.type === "org") {
    return (
      <div className="mt-2 rounded-xl border border-line bg-surface/70 p-3">
        <div className="flex items-center gap-2 text-xs text-ink-3 mb-1.5">
          <Building2 className="h-3.5 w-3.5" /> New organization
        </div>
        <div className="font-medium">{card.name}</div>
        <div className="grid grid-cols-2 gap-2 mt-2 text-compact text-ink-2">
          <span className="inline-flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5 text-ink-3" />{card.size.cores} core{card.size.cores === 1 ? "" : "s"}</span>
          <span className="inline-flex items-center gap-1.5"><MemoryStick className="h-3.5 w-3.5 text-ink-3" />{formatBytes(card.size.memoryMb * 1024 ** 2)}</span>
          <span>{card.size.diskGb} GB disk</span>
          <span>Up to {card.size.maxGuests} containers</span>
        </div>
        <p className="text-xs text-ink-3 mt-2">{card.why}</p>
        {error && <p className="text-xs text-critical mt-2">{error}</p>}
        <div className="mt-3">
          {done ? (
            <span className="inline-flex items-center gap-1.5 text-compact text-good"><Check className="h-4 w-4" /> Created</span>
          ) : (
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
        </div>
      </div>
    );
  }

  if (card.type === "status") {
    const h = engine.host;
    return (
      <div className="mt-2 rounded-xl border border-line bg-surface/70 p-3 grid gap-3">
        <BarMeter label="CPU" pct={h.cpuPct} value={`${h.cpuPct.toFixed(0)}% of ${h.cpus} CPUs`} />
        <BarMeter label="Memory" pct={(h.memUsed / h.memTotal) * 100} value={`${formatBytes(h.memUsed)} of ${formatBytes(h.memTotal)}`} />
        <BarMeter label="Storage" pct={(h.diskUsed / h.diskTotal) * 100} value={`${formatBytes(h.diskUsed)} of ${formatBytes(h.diskTotal)}`} />
      </div>
    );
  }

  return (
    <Link to={card.to} className="mt-2 inline-flex items-center gap-1.5 text-compact text-accent hover:underline">
      {card.label} <ArrowRight className="h-3.5 w-3.5" />
    </Link>
  );
}
