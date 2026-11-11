import { AlertTriangle, Check, CircleHelp, CircleX, Loader2 } from "lucide-react";
import type { AgentReadiness as Readiness } from "../../../data/engine/readiness.ts";
import { Chip } from "../../../ui/primitives.tsx";
import { cn } from "../../../lib/storage.ts";

const ICON = { ok: Check, blocked: CircleX, unknown: CircleHelp } as const;
const TONE = { ok: "text-good", blocked: "text-critical", unknown: "text-warning" } as const;

/** A short, honest readiness line for an agent card. Never says "ready" when a check is missing. */
export function ReadinessPill({ readiness }: { readiness: Readiness | undefined }) {
  if (!readiness) return null;
  if (readiness.state === "ready") return <Chip tone="good"><Check className="h-3 w-3" />Ready to run</Chip>;
  if (readiness.settingUp) return <Chip tone="warning"><Loader2 className="h-3 w-3" />Still setting up</Chip>;
  if (readiness.state === "blocked") return <Chip tone="warning"><AlertTriangle className="h-3 w-3" />Can't run yet</Chip>;
  return <Chip><CircleHelp className="h-3 w-3" />Readiness unknown</Chip>;
}

/** The three real checks behind an agent's readiness, for the agent's Overview tab. */
export function ReadinessPanel({ readiness }: { readiness: Readiness | undefined }) {
  if (!readiness) return null;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-compact font-semibold uppercase tracking-label text-ink-3">Readiness</span>
        <ReadinessPill readiness={readiness} />
        {readiness.source === "backend" && <span className="text-xs text-ink-3">Reported by the engine</span>}
      </div>
      <p className="mt-2 text-sm text-ink-2">{readiness.summary}</p>
      <ul className="mt-3 space-y-2">
        {readiness.checks.map((check) => {
          const Icon = ICON[check.state];
          return (
            <li key={check.id} className="flex items-start gap-2 text-compact">
              <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", TONE[check.state])} aria-hidden />
              <div className="min-w-0"><span className="font-medium">{check.label}</span><span className={cn("ml-1.5", TONE[check.state])}>{check.state === "ok" ? "ready" : check.state === "blocked" ? "not ready" : "unknown"}</span><p className="text-xs text-ink-3 mt-0.5">{check.detail}</p></div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
