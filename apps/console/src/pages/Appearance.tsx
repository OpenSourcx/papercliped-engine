import { Check, RotateCcw } from "lucide-react";
import { cn } from "../lib/storage.ts";
import { PRESETS, useTheme } from "../theme/theme.tsx";
import { Button, Card, PageHeader, SectionTitle, PageFrame } from "../ui/primitives.tsx";

const ACCENTS = ["#e8b25c", "#e9776a", "#7aa2ff", "#8e7cf0", "#4cc38a", "#f2f2f2"];

function Range({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string }) {
  return (
    <label className="block">
      <div className="flex justify-between text-[13px] mb-2"><span className="text-ink-2">{label}</span><span className="tabular-nums text-ink-3">{format(value)}</span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
    </label>
  );
}

/** The design framework's user surface: pick a preset, then tune accent, corners, glass and type. */
export function Appearance() {
  const { settings, update, reset } = useTheme();
  return (
    <PageFrame width="4xl">
      <PageHeader title="Appearance" subtitle="ePaperclip is built on design tokens. Pick a theme, then make it yours: every page and Pin's island follow these settings." actions={<Button variant="ghost" onClick={reset}><RotateCcw className="h-4 w-4" />Reset</Button>} />
      <Card className="p-5">
        <SectionTitle>Theme</SectionTitle>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {PRESETS.map((p) => (
            <button key={p.id} onClick={() => update({ preset: p.id })} aria-pressed={settings.preset === p.id} className={cn("rounded-xl border p-2 text-left transition", settings.preset === p.id ? "border-accent/60" : "border-line hover:border-line-strong")}>
              <div className="h-20 rounded-lg relative overflow-hidden" style={{ background: p.tokens["--bg"] }}>
                <div className="absolute inset-0" style={{ background: `radial-gradient(60% 60% at 50% 40%, ${p.tokens["--glow-1"]}, transparent 70%)` }} />
                <div className="absolute left-2 right-2 bottom-2 h-6 rounded-full" style={{ background: p.tokens["--surface-2"], border: `1px solid ${p.tokens["--line-strong"]}` }} />
                <div className="absolute top-2 left-1/2 -translate-x-1/2 h-3 w-12 rounded-full" style={{ background: p.tokens["--surface-3"] }} />
              </div>
              <div className="flex items-center justify-between mt-2 px-0.5">
                <span className="text-[13px] font-medium">{p.name}</span>
                {settings.preset === p.id && <Check className="h-4 w-4 text-accent" />}
              </div>
            </button>
          ))}
        </div>
      </Card>
      <Card className="p-5 mt-4">
        <SectionTitle>Accent</SectionTitle>
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => update({ accent: null })} className={cn("h-9 px-3 rounded-full border text-[13px]", settings.accent === null ? "border-accent/60" : "border-line")}>Theme default</button>
          {ACCENTS.map((a) => (
            <button key={a} onClick={() => update({ accent: a })} aria-label={`Accent ${a}`} aria-pressed={settings.accent === a} className={cn("h-9 w-9 rounded-full border-2 transition", settings.accent === a ? "border-ink scale-110" : "border-transparent")} style={{ background: a }} />
          ))}
          <label className="inline-flex items-center gap-2 text-[13px] text-ink-2">
            Custom
            <input type="color" value={settings.accent ?? "#e8b25c"} onChange={(e) => update({ accent: e.target.value })} className="h-9 w-12 rounded-md bg-transparent border border-line" />
          </label>
        </div>
      </Card>
      <Card className="p-5 mt-4 grid sm:grid-cols-2 gap-6">
        <Range label="Corner radius" value={settings.radius} min={0.25} max={1.25} step={0.125} onChange={(v) => update({ radius: v })} format={(v) => `${Math.round(v * 16)}px`} />
        <Range label="Text size" value={settings.fontScale} min={0.9} max={1.15} step={0.05} onChange={(v) => update({ fontScale: v })} format={(v) => `${Math.round(v * 100)}%`} />
        <Range label="Glass blur" value={settings.glassBlur} min={0} max={40} step={2} onChange={(v) => update({ glassBlur: v })} format={(v) => `${v}px`} />
        <Range label="Glass opacity" value={settings.glassAlpha} min={0.3} max={0.95} step={0.05} onChange={(v) => update({ glassAlpha: v })} format={(v) => `${Math.round(v * 100)}%`} />
      </Card>
    </PageFrame>
  );
}
