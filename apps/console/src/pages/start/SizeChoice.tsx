import { Sparkles } from "lucide-react";
import type { HostMetrics } from "../../data/types.ts";
import { formatBytes } from "../../lib/storage.ts";
import { suggestSize } from "../../pin/brain.ts";
import { Card, Slider, Toggle } from "../../ui/primitives.tsx";

export type Size = ReturnType<typeof suggestSize>;

/** How big an organization's share of this device is: Pin sizes it from what is free, or the person sets it. Shared by the start wizard and the New organization modal. */
export function SizeChoice({ device, host, suggested, pinDecides, onPinDecides, size, onSize }: { device: string; host: HostMetrics; suggested: Size; pinDecides: boolean; onPinDecides: (v: boolean) => void; size: Size; onSize: (s: Size) => void }) {
  const s = pinDecides ? suggested : size;
  const totalMemMb = Math.floor(host.memTotal / 1024 ** 2);
  const setSize = onSize;
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="font-medium flex items-center gap-2"><Sparkles className="h-4 w-4 text-accent" />Let Pin decide the resources</div>
          <p className="text-compact text-ink-3 mt-0.5">Pin sizes it from what's free on {device} and adjusts it as the org grows.</p>
        </div>
        <Toggle checked={pinDecides} onChange={(v) => { onPinDecides(v); if (!v) setSize(suggested); }} label="Let Pin decide the resources" />
      </div>
      <div className="mt-5 grid sm:grid-cols-2 gap-5">
        {pinDecides ? (
          <>
            {[["CPU", `${s.cores} core${s.cores === 1 ? "" : "s"}`], ["Memory", formatBytes(s.memoryMb * 1024 ** 2)], ["Disk", `${s.diskGb} GB`], ["Containers", `Up to ${s.maxGuests}`]].map(([k, v]) => (
              <div key={k} className="rounded-lg bg-surface-2 border border-line px-3.5 py-2.5"><div className="text-xs text-ink-3">{k}</div><div className="text-body font-medium tabular-nums">{v}</div></div>
            ))}
          </>
        ) : (
          <>
            <Slider label="CPU" value={size.cores} min={1} max={host.cpus} step={1} onChange={(v) => setSize({ ...size, cores: v })} format={(v) => `${v} core${v === 1 ? "" : "s"}`} />
            <Slider label="Memory" value={size.memoryMb} min={512} max={totalMemMb} step={512} onChange={(v) => setSize({ ...size, memoryMb: v })} format={(v) => formatBytes(v * 1024 ** 2)} />
            <Slider label="Disk" value={size.diskGb} min={8} max={500} step={8} onChange={(v) => setSize({ ...size, diskGb: v })} format={(v) => `${v} GB`} />
            <Slider label="Containers" value={size.maxGuests} min={1} max={20} step={1} onChange={(v) => setSize({ ...size, maxGuests: v })} format={(v) => `Up to ${v}`} />
          </>
        )}
      </div>
        </Card>

  );
}
