import { Bot, Cable, Disc3, Globe, HardDrive, Package, Sparkles, SquareTerminal, Workflow, type LucideIcon } from "lucide-react";
import { resolveMark, type Glyph } from "../data/brandMarks.ts";

const GLYPHS: Record<Glyph, LucideIcon> = { disc: Disc3, driver: HardDrive, app: Package, gateway: Cable, process: SquareTerminal, http: Globe, skill: Sparkles, runner: Workflow, custom: Bot };

/** A product's mark at `size` px: the official mark in the current text colour, or a labelled generic glyph. Never a letter tile. */
export function BrandMark({ id, name, size = 20, decorative = false }: { id: string; name?: string; size?: number; decorative?: boolean }) {
  const m = resolveMark(id, name);
  const a11y = decorative ? { "aria-hidden": true as const } : { role: "img" as const, "aria-label": m.kind === "generic" ? m.label : (name ?? m.title) };
  if (m.kind === "image") return <img src={m.src} width={size} height={size} alt={decorative ? "" : (name ?? m.title)} />;
  if (m.kind === "brand") return <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" fillRule={m.evenodd ? "evenodd" : "nonzero"} {...a11y}><path d={m.path} /></svg>;
  const G = GLYPHS[m.glyph];
  return <G width={size} height={size} strokeWidth={1.6} {...a11y} />;
}
