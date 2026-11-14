import { AlertTriangle, Box, Building2, Check, Play } from "lucide-react";
import { cn } from "../lib/storage.ts";
import { usePin, type PinSubjectView } from "./PinContext.tsx";

const ICON = { run: Play, machine: Box, organization: Building2 } as const;

/** What a chip says, for the screen reader as well as the eye. Plain functions so the words are tested. */
export function subjectSentence(s: Pick<PinSubjectView, "label" | "included" | "status">): string {
  if (!s.included) return `${s.label}: left out. Press to include it again.`;
  if (s.status === "unavailable") return `${s.label}: Pin couldn't read this for you (it may not exist, or belong to an organization you can't see). Press to leave it out.`;
  return `${s.label}: Pin can see this. Press to leave it out.`;
}

/**
 * What Pin is given from this page, each of which the person can take out before asking. The host reads the facts itself and
 * checks the person's access; this only names the thing and shows whether Pin could read it.
 */
export function PinSubjects({ className }: { className?: string }) {
  const pin = usePin();
  if (pin.subjects.length === 0) return null;
  return (
    <div role="group" aria-label="What Pin can see here" className={cn("flex flex-wrap items-center gap-1.5 px-4 py-2 border-b border-line", className)}>
      <span className="text-micro font-semibold uppercase tracking-label text-ink-3 mr-1">Pin sees</span>
      {pin.subjects.map((s) => {
        const Icon = ICON[s.kind];
        const bad = s.included && s.status === "unavailable";
        return (
          <button
            key={s.key}
            type="button"
            aria-pressed={s.included}
            aria-label={subjectSentence(s)}
            title={subjectSentence(s)}
            onClick={() => pin.toggleSubject(s.key)}
            className={cn(
              "transition-control inline-flex items-center gap-1.5 h-8 max-w-full rounded-full border px-3 text-compact focus-visible:outline-2 focus-visible:outline-offset-2",
              s.included ? (bad ? "border-warning text-ink-2" : "border-line-strong bg-surface-2 text-ink") : "border-dashed border-line text-ink-3 line-through",
            )}
          >
            {bad ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden /> : s.included ? <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <Check className="h-3.5 w-3.5 shrink-0 opacity-0" aria-hidden />}
            <span className="truncate">{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}
