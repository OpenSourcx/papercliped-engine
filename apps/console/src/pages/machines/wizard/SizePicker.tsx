import { cn } from "../../../lib/storage.ts";
import type { Kind } from "./state.ts";
import { SIZES } from "./state.ts";

/** Quick starting points. They only set CPU, memory and the first disk; every one stays editable in its own step. */
export function SizePicker({ kind, current, onPick, tooBig }: { kind: Kind; current: { cores: number; memoryMb: number; diskGb: number }; onPick: (s: { cores: number; memoryMb: number; diskGb: number }) => void; tooBig: (s: { cores: number; memoryMb: number; diskGb: number }) => boolean }) {
  return (
    <fieldset>
      <legend className="text-compact font-semibold text-ink">Start from a size</legend>
      <p className="text-xs text-ink-3 mt-0.5 mb-3">Sets CPU, memory and disk. Fine-tune each one in the next steps.</p>
      <div className="grid grid-cols-3 gap-2">
        {SIZES[kind].map((s) => {
          const on = s.cores === current.cores && s.memoryMb === current.memoryMb && s.diskGb === current.diskGb;
          return (
            <button key={s.id} type="button" onClick={() => onPick(s)} aria-pressed={on} className={cn("transition-control text-left rounded-xl border p-3", on ? "border-accent/60 bg-accent-soft" : "border-line hover:border-line-strong", tooBig(s) && "opacity-60")}>
              <span className="block font-medium text-sm">{s.label}</span>
              <span className="block text-xs text-ink-2 tabular-nums mt-0.5">{s.cores} core{s.cores === 1 ? "" : "s"} · {s.memoryMb / 1024} GiB · {s.diskGb} GB</span>
              <span className="hidden sm:block text-xs text-ink-3 mt-1">{s.hint}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
