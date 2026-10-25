import { useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronUp, Contrast, LayoutPanelLeft, Palette, RotateCcw, Sparkles, SunMoon, Type } from "lucide-react";
import { cn } from "../lib/storage.ts";
import { PRESETS, glassFrom, useTheme, type ThemeSettings } from "../theme/theme.tsx";
import { Button, Card, ColorPicker, PageFrame, PageHeader, Select, Slider, Toggle } from "../ui/primitives.tsx";

/**
 * Appearance, laid out like a system's Colours page: a live preview, then one row per choice. Mode (dark, light or the
 * device's), the theme, transparency effects with how much liquid glass, the accent (recent colours, a palette and your
 * own), whether the rail takes the accent, then corners and text size. Every page, the rail and Pin's island follow it.
 */

/** ePaperclip's own accents first, then a broad palette like the system's. */
const OURS = ["#e8b25c", "#e9776a", "#7aa2ff", "#8e7cf0", "#4cc38a", "#f2f2f2"];
const PALETTE = [
  "#ffb900", "#ff8c00", "#f7630c", "#ca5010", "#da3b01", "#ef6950", "#d13438", "#ff4343", "#e74856",
  "#e81123", "#ea005e", "#c30052", "#e3008c", "#bf0077", "#c239b3", "#9a0089", "#0078d4", "#0063b1",
  "#8e8cd8", "#6b69d6", "#8764b8", "#744da9", "#b146c2", "#881798", "#0099bc", "#2d7d9a", "#00b7c3",
  "#038387", "#00b294", "#018574", "#00cc6a", "#10893e", "#7a7574", "#5d5a58", "#68768a", "#515c6b",
  "#567c73", "#486860", "#498205", "#107c10", "#767676", "#4c4a48", "#69797e", "#4a5459", "#647c64",
];

function Row({ icon, title, body, children, below }: { icon: ReactNode; title: string; body: ReactNode; children?: ReactNode; below?: ReactNode }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
        <span className="h-9 w-9 shrink-0 rounded-lg bg-surface-2 text-ink-2 flex items-center justify-center" aria-hidden>{icon}</span>
        <div className="min-w-0 flex-1 basis-56">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-compact text-ink-3 text-pretty">{body}</div>
        </div>
        {children && <div className="flex items-center gap-2 shrink-0">{children}</div>}
      </div>
      {below && <div className="px-5 pb-5 sm:pl-18">{below}</div>}
    </div>
  );
}

function Swatch({ colour, selected, onPick, label }: { colour: string; selected: boolean; onPick: () => void; label?: string }) {
  return (
    <button type="button" role="radio" aria-checked={selected} aria-label={label ?? `Accent ${colour}`} title={label ?? colour} onClick={onPick}
      className={cn("transition-control relative h-10 w-10 rounded-md border-2", selected ? "border-ink" : "border-transparent hover:border-line-strong")} style={{ background: colour }}>
      {selected && <span className="absolute top-0 right-0 h-4 w-4 rounded-bl-md rounded-tr-sm bg-ink text-bg flex items-center justify-center"><Check className="h-3 w-3" aria-hidden /></span>}
    </button>
  );
}

/** A small picture of the console in the chosen settings: the rail, a glass panel over the room's glow, the accent. */
function Preview({ s }: { s: ThemeSettings }) {
  return (
    <div aria-hidden className="relative h-40 w-full max-w-sm rounded-xl border border-line overflow-hidden bg-bg">
      <div className="absolute inset-0 hero-glow" />
      <div className="absolute left-0 top-0 bottom-0 w-12 glass-bar border-r border-line flex flex-col items-center gap-2 pt-3">
        <span className={cn("h-7 w-7 rounded-lg", s.railAccent ? "bg-accent" : "bg-surface-3")} />
        <span className="h-7 w-7 rounded-full bg-surface-2" />
        <span className="h-7 w-7 rounded-full bg-surface-2" />
      </div>
      <div className="absolute left-16 right-4 top-6 bottom-6">
        <div className="glass h-full rounded-xl p-3 space-y-2">
          <span className="block h-2 w-24 rounded-full bg-ink-3/60" />
          <span className="block h-2 w-36 rounded-full bg-ink-3/40" />
          <span className="block h-2 w-28 rounded-full bg-ink-3/40" />
          <span className="absolute right-3 bottom-3 h-6 w-16 rounded-full bg-accent" />
        </div>
      </div>
    </div>
  );
}

export function Appearance() {
  const { settings: s, update, reset } = useTheme();
  const [accentOpen, setAccentOpen] = useState(true);
  const [fine, setFine] = useState(false);
  const preset = PRESETS.find((p) => p.id === s.preset) ?? PRESETS[0];
  const mode = s.mode === "system" ? "system" : preset.scheme;
  const setMode = (m: string) => {
    if (m === "system") update({ mode: "system", ...(preset.scheme === "light" ? { preset: "warm" } : {}) });
    else if (m === "light") update({ mode: "fixed", preset: PRESETS.find((p) => p.scheme === "light")!.id });
    else update({ mode: "fixed", ...(preset.scheme === "light" ? { preset: "warm" } : {}) });
  };
  const custom = s.accent !== null && !OURS.includes(s.accent) && !PALETTE.includes(s.accent);

  return (
    <PageFrame width="4xl">
      <PageHeader title="Appearance" subtitle="Colours, transparency and liquid glass for every page, the rail and Pin's island." actions={<Button variant="ghost" onClick={reset}><RotateCcw className="h-4 w-4" />Reset</Button>} />
      <div className="mb-4"><Preview s={s} /></div>
      <Card className="divide-y divide-line">
        <Row icon={<SunMoon className="h-4 w-4" />} title="Choose your mode" body="Dark, light, or follow this device's setting as it changes.">
          <Select aria-label="Mode" size="sm" className="w-48" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">Match this device</option>
          </Select>
        </Row>
        <Row icon={<Palette className="h-4 w-4" />} title="Theme" body={s.mode === "system" ? "The dark theme to use when this device is dark; Daylight is used when it is light." : "A full set of colours. The accent and glass below apply on top."}
          below={
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {PRESETS.filter((p) => s.mode !== "system" || p.scheme === "dark").map((p) => (
                <button key={p.id} type="button" onClick={() => update({ preset: p.id, ...(s.mode === "system" ? {} : { mode: "fixed" }) })} aria-pressed={s.preset === p.id} className={cn("transition-control rounded-xl border p-2 text-left", s.preset === p.id ? "border-accent/60" : "border-line hover:border-line-strong")}>
                  <div className="h-16 rounded-lg relative overflow-hidden" style={{ background: p.tokens["--bg"] }}>
                    <div className="absolute inset-0" style={{ background: `radial-gradient(60% 60% at 50% 40%, ${p.tokens["--glow-1"]}, transparent 70%)` }} />
                    <div className="absolute left-2 right-2 bottom-2 h-5 rounded-full" style={{ background: p.tokens["--surface-2"], border: `1px solid ${p.tokens["--line-strong"]}` }} />
                  </div>
                  <div className="flex items-center justify-between mt-2 px-0.5">
                    <span className="text-compact font-medium">{p.name}</span>
                    {s.preset === p.id && <Check className="h-4 w-4 text-accent" aria-hidden />}
                  </div>
                </button>
              ))}
            </div>
          } />
        <Row icon={<Sparkles className="h-4 w-4" />} title="Transparency effects" body="Bars, menus and panels let the page show through, softly blurred.">
          <span className="text-compact text-ink-2">{s.transparency ? "On" : "Off"}</span>
          <Toggle label="Transparency effects" checked={s.transparency} onChange={(v) => update({ transparency: v })} />
        </Row>
        <Row icon={<Contrast className="h-4 w-4" />} title="Liquid glass" body={s.transparency ? "How much glass: more blurs more and shows more of what is behind." : "Turn on transparency effects to use glass."}
          below={
            <div className={cn("space-y-4 max-w-lg", !s.transparency && "opacity-50 pointer-events-none")} aria-disabled={!s.transparency || undefined}>
              <Slider label="Amount" value={s.glass} min={0} max={100} step={5} onChange={(v) => update({ glass: v, ...glassFrom(v) })} format={(v) => (v === 0 ? "Solid" : `${v}%`)} />
              <button type="button" aria-expanded={fine} onClick={() => setFine((v) => !v)} className="text-compact text-accent hover:underline inline-flex items-center gap-1">Fine-tune{fine ? <ChevronUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}</button>
              {fine && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <Slider label="Blur" value={s.glassBlur} min={0} max={40} step={2} onChange={(v) => update({ glassBlur: v })} format={(v) => `${v}px`} />
                  <Slider label="Opacity" value={s.glassAlpha} min={0.3} max={1} step={0.05} onChange={(v) => update({ glassAlpha: v })} format={(v) => `${Math.round(v * 100)}%`} />
                </div>
              )}
            </div>
          } />
        <Row icon={<Palette className="h-4 w-4" />} title="Accent colour" body={s.accent ? "Your colour, used for highlights, selections and the rail." : "The theme's own accent."}
          below={accentOpen && (
            <div className="space-y-5">
              {s.recentAccents.length > 0 && (
                <div>
                  <div className="text-compact text-ink-2 mb-2">Recent colours</div>
                  <div role="radiogroup" aria-label="Recent colours" className="flex flex-wrap gap-2">{s.recentAccents.map((c) => <Swatch key={c} colour={c} selected={s.accent?.toLowerCase() === c.toLowerCase()} onPick={() => update({ accent: c })} />)}</div>
                </div>
              )}
              <div>
                <div className="text-compact text-ink-2 mb-2">ePaperclip colours</div>
                <div role="radiogroup" aria-label="ePaperclip colours" className="flex flex-wrap gap-2">{OURS.map((c) => <Swatch key={c} colour={c} selected={s.accent === c} onPick={() => update({ accent: c })} />)}</div>
              </div>
              <div>
                <div className="text-compact text-ink-2 mb-2">More colours</div>
                <div role="radiogroup" aria-label="More colours" className="grid grid-cols-6 sm:grid-cols-9 gap-2 w-fit">{PALETTE.map((c) => <Swatch key={c} colour={c} selected={s.accent === c} onPick={() => update({ accent: c })} />)}</div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-compact text-ink-2">Custom colour</span>
                <ColorPicker label="Custom accent" value={s.accent ?? OURS[0]!} onChange={(accent) => update({ accent })} className={custom ? "border-ink" : undefined} />
              </div>
            </div>
          )}>
          <Select aria-label="Accent source" size="sm" className="w-40" value={s.accent ? "manual" : "theme"} onChange={(e) => update({ accent: e.target.value === "theme" ? null : s.accent ?? s.recentAccents[0] ?? OURS[0]! })}>
            <option value="theme">From the theme</option>
            <option value="manual">Manual</option>
          </Select>
          <button type="button" aria-label={accentOpen ? "Hide colours" : "Show colours"} aria-expanded={accentOpen} onClick={() => setAccentOpen((v) => !v)} className="transition-control h-9 w-9 rounded-lg text-ink-3 hover:text-ink hover:bg-surface-2 flex items-center justify-center">{accentOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</button>
        </Row>
        <Row icon={<LayoutPanelLeft className="h-4 w-4" />} title="Accent on the rail" body="The rail's tiles take the accent when you point at them and for the page you are on.">
          <Toggle label="Accent on the rail" checked={s.railAccent} onChange={(v) => update({ railAccent: v })} />
        </Row>
        <Row icon={<Type className="h-4 w-4" />} title="Corners and text" body="Rounder or squarer corners, and a larger or smaller text size everywhere."
          below={
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-2xl">
              <Slider label="Corner radius" value={s.radius} min={0.25} max={1.25} step={0.125} onChange={(v) => update({ radius: v })} format={(v) => `${Math.round(v * 16)}px`} />
              <Slider label="Text size" value={s.fontScale} min={0.9} max={1.15} step={0.05} onChange={(v) => update({ fontScale: v })} format={(v) => `${Math.round(v * 100)}%`} />
            </div>
          } />
      </Card>
    </PageFrame>
  );
}
