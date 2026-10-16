import { MinusCircle, PlusCircle, Info, Users } from "lucide-react";
import type { Change, Plan } from "../../data/engine/accessAdmin.ts";
import { Chip } from "../../ui/primitives.tsx";

/** What a change will do in Proxmox and in the engine, before it is applied: permissions added and taken away, memberships, side effects. */
export function ChangeList({ changes, empty = "Nothing changes." }: { changes: Change[]; empty?: string }) {
  if (!changes.length) return <p className="text-compact text-ink-3">{empty}</p>;
  return (
    <ul className="rounded-lg border border-line divide-y divide-line" aria-label="Changes">
      {changes.map((c, i) => (
        <li key={i} className="flex items-start gap-3 px-3 py-2 text-compact">
          {c.kind === "acl" ? (
            c.op === "add" ? <PlusCircle className="h-4 w-4 mt-0.5 text-good shrink-0" aria-label="Adds" /> : <MinusCircle className="h-4 w-4 mt-0.5 text-critical shrink-0" aria-label="Removes" />
          ) : c.kind === "engine" ? (
            <Users className="h-4 w-4 mt-0.5 text-accent shrink-0" aria-label="Organization" />
          ) : (
            <Info className="h-4 w-4 mt-0.5 text-ink-3 shrink-0" aria-label="Effect" />
          )}
          <div className="min-w-0 flex-1">
            {c.kind === "acl" && (
              <>
                <div className="flex flex-wrap items-center gap-2"><span>{c.op === "add" ? "Adds" : "Removes"}</span><Chip tone="accent">{c.role}</Chip><span>on</span><span className="font-mono">{c.path}</span></div>
                <div className="text-xs text-ink-3">{c.reason}{c.privileges.length ? ` · ${c.privileges.length} privileges` : ""}</div>
              </>
            )}
            {c.kind === "engine" && <div>{c.text}</div>}
            {c.kind === "effect" && <div className="text-ink-2">{c.text}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function PlanView({ plan }: { plan: Plan }) {
  return (
    <div className="space-y-3">
      <ChangeList changes={plan.changes} />
      {plan.warnings.length > 0 && <ul className="text-compact text-warning list-disc pl-5 space-y-1">{plan.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
    </div>
  );
}
