import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { readJson, writeJson } from "../lib/storage.ts";

/**
 * The design framework's runtime. A theme is a preset (a full set of tokens) plus the user's overrides. Applying a
 * theme writes the tokens as CSS variables on <html>; every component reads only those variables.
 */

export type Tokens = Record<string, string>;

export interface Preset {
  id: string;
  name: string;
  scheme: "dark" | "light";
  tokens: Tokens;
}

/*
 * Every preset carries the full semantic and domain set (the warm preset is the base each one spreads), so switching
 * presets never leaves a value from the previous one behind. These are the only colour literals outside index.css;
 * see apps/console/DESIGN.md, "Token tiers".
 */
const warm: Tokens = {
  "--bg": "#171612", "--surface": "#1f1d19", "--surface-2": "#27251f", "--surface-3": "#312e27",
  "--ink": "#f4ecdc", "--ink-2": "#bdb4a2", "--ink-3": "#958c7b",
  "--line": "rgb(244 236 220 / 0.08)", "--line-strong": "rgb(244 236 220 / 0.16)",
  "--primary": "#ece3cf", "--primary-ink": "#1b1a16",
  "--accent": "#e8b25c", "--accent-soft": "rgb(232 178 92 / 0.14)",
  "--scrim": "rgb(8 7 5 / 0.6)", "--code": "#12110e", "--screen": "#000000", "--on-status": "#ffffff", "--shadow-color": "rgb(0 0 0 / 0.5)", "--rim": "rgb(255 255 255 / 0.07)",
  // Status hues, tuned for 3:1 or better against the dark surfaces.
  "--good": "#34c759", "--live": "#6aa5ff", "--warning": "#fab219", "--serious": "#ec835a", "--critical": "#f0585d",
  "--glow-1": "rgb(232 178 92 / 0.22)", "--glow-2": "rgb(214 104 84 / 0.14)", "--glow-3": "rgb(104 120 214 / 0.12)",
  "--pin-1": "#f2c16b", "--pin-2": "#e9776a", "--pin-3": "#8e7cf0", "--pin-highlight": "rgb(255 255 255 / 0.7)",
  "--series-1": "#3987e5", "--series-2": "#d95926",
};

/** Light schemes share their status hues, darkened to clear 3:1 on near-white surfaces, and softer shadows. */
const lightBase: Tokens = {
  "--scrim": "rgb(40 32 20 / 0.32)", "--code": "#f3efe7", "--shadow-color": "rgb(60 45 20 / 0.16)", "--rim": "rgb(255 255 255 / 0.6)",
  "--good": "#1f8a3e", "--live": "#2563eb", "--warning": "#a86200", "--serious": "#c2521f", "--critical": "#d1242f",
};

export const PRESETS: Preset[] = [
  { id: "warm", name: "Paperclip Warm", scheme: "dark", tokens: warm },
  {
    id: "graphite", name: "Graphite", scheme: "dark",
    tokens: { ...warm, "--bg": "#141414", "--surface": "#1b1b1b", "--surface-2": "#232323", "--surface-3": "#2d2d2d", "--ink": "#f5f5f5", "--ink-2": "#b4b4b4", "--ink-3": "#8c8c8c", "--line": "rgb(255 255 255 / 0.08)", "--line-strong": "rgb(255 255 255 / 0.15)", "--primary": "#ededed", "--primary-ink": "#141414", "--accent": "#9db4ff", "--accent-soft": "rgb(157 180 255 / 0.14)", "--glow-1": "rgb(157 180 255 / 0.16)", "--glow-2": "rgb(255 255 255 / 0.05)", "--glow-3": "rgb(157 180 255 / 0.08)" },
  },
  {
    id: "midnight", name: "Midnight", scheme: "dark",
    tokens: { ...warm, "--bg": "#0b0f1c", "--surface": "#11172a", "--surface-2": "#172036", "--surface-3": "#202b45", "--ink": "#eef2ff", "--ink-2": "#aab4d4", "--ink-3": "#7a86aa", "--line": "rgb(220 228 255 / 0.08)", "--line-strong": "rgb(220 228 255 / 0.16)", "--primary": "#e6ebff", "--primary-ink": "#0b0f1c", "--accent": "#7aa2ff", "--accent-soft": "rgb(122 162 255 / 0.15)", "--glow-1": "rgb(70 110 255 / 0.30)", "--glow-2": "rgb(120 80 230 / 0.16)", "--glow-3": "rgb(40 160 255 / 0.14)", "--pin-1": "#6fa8ff", "--pin-2": "#a77bff", "--pin-3": "#ff7ab0" },
  },
  {
    id: "daylight", name: "Daylight", scheme: "light",
    tokens: { ...warm, ...lightBase, "--bg": "#f7f4ee", "--surface": "#fffdf9", "--surface-2": "#f1ece2", "--surface-3": "#e6dfd1", "--ink": "#1d1b17", "--ink-2": "#5d564a", "--ink-3": "#756d5f", "--line": "rgb(29 27 23 / 0.09)", "--line-strong": "rgb(29 27 23 / 0.17)", "--primary": "#1d1b17", "--primary-ink": "#fffdf9", "--accent": "#a8680f", "--accent-soft": "rgb(183 116 26 / 0.12)", "--series-1": "#2a78d6", "--series-2": "#eb6834", "--glow-1": "rgb(232 178 92 / 0.28)", "--glow-2": "rgb(233 119 106 / 0.14)", "--glow-3": "rgb(142 124 240 / 0.12)" },
  },
];

export interface ThemeSettings {
  preset: string;
  /** "fixed" uses the preset as chosen; "system" follows the device: Daylight when it is light, the dark preset otherwise. */
  mode: "fixed" | "system";
  accent: string | null; // user override for --accent
  /** The accents chosen most recently, newest first, for the Recent colours row. */
  recentAccents: string[];
  /** Fills the rail's tiles with the accent on hover and for the page you are on, like a chat app's server list. */
  railAccent: boolean;
  radius: number; // rem
  /** Off: every surface is solid and nothing blurs what is behind it (also faster on slow machines). */
  transparency: boolean;
  /** How much liquid glass, 0 to 100; sets the blur and the see-through amount together. */
  glass: number;
  glassBlur: number; // px
  glassAlpha: number; // 0..1
  fontScale: number;
}

/** One slider for the whole effect: more glass blurs more and lets more of the page show through. */
export const glassFrom = (amount: number) => ({ glassBlur: Math.round((amount / 100) * 40), glassAlpha: Math.round((0.95 - (amount / 100) * 0.65) * 100) / 100 });

export const DEFAULT_THEME: ThemeSettings = { preset: "warm", mode: "fixed", accent: null, recentAccents: [], railAccent: true, radius: 0.625, transparency: true, glass: 55, glassBlur: 22, glassAlpha: 0.6, fontScale: 1 };

/** Remembers an accent at the front of the recent list (five at most). */
export const withRecent = (list: string[], accent: string) => [accent, ...list.filter((a) => a.toLowerCase() !== accent.toLowerCase())].slice(0, 5);

function hexToSoft(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgb(232 178 92 / ${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${alpha})`;
}

/** Dark or light text, whichever reads better on this colour (WCAG relative luminance). */
export function inkOn(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#1b1a16";
  const n = parseInt(m[1], 16);
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? "#1b1a16" : "#ffffff";
}

export function resolveTokens(s: ThemeSettings, deviceLight = false): { scheme: "dark" | "light"; tokens: Tokens } {
  const chosen = PRESETS.find((p) => p.id === s.preset) ?? PRESETS[0];
  const preset = s.mode === "system" ? (deviceLight ? PRESETS.find((p) => p.scheme === "light")! : chosen.scheme === "dark" ? chosen : PRESETS[0]) : chosen;
  const tokens: Tokens = { ...preset.tokens };
  if (s.accent && /^#[0-9a-f]{6}$/i.test(s.accent)) {
    tokens["--accent"] = s.accent;
    tokens["--accent-soft"] = hexToSoft(s.accent, 0.14);
    tokens["--glow-1"] = hexToSoft(s.accent, 0.22);
    tokens["--pin-1"] = s.accent;
  }
  tokens["--on-accent"] = inkOn(tokens["--accent"] ?? "#e8b25c");
  tokens["--radius"] = `${s.radius}rem`;
  tokens["--glass-blur"] = s.transparency ? `${s.glassBlur}px` : "0px";
  tokens["--glass-alpha"] = s.transparency ? String(s.glassAlpha) : "1";
  tokens["--font-scale"] = String(s.fontScale);
  return { scheme: preset.scheme, tokens };
}

interface ThemeCtx {
  settings: ThemeSettings;
  update: (patch: Partial<ThemeSettings>) => void;
  reset: () => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<ThemeSettings>(() => ({ ...DEFAULT_THEME, ...readJson<Partial<ThemeSettings>>("epc.theme", {}) }));
  const [deviceLight, setDeviceLight] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches);

  // "Match this device" follows the system's light or dark setting as it changes.
  useEffect(() => {
    if (settings.mode !== "system" || typeof window.matchMedia !== "function") return;
    const q = window.matchMedia("(prefers-color-scheme: light)");
    const on = () => setDeviceLight(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, [settings.mode]);

  useEffect(() => {
    const { scheme, tokens } = resolveTokens(settings, deviceLight);
    const root = document.documentElement;
    for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
    root.style.colorScheme = scheme;
    root.classList.toggle("dark", scheme === "dark");
    root.dataset.transparency = settings.transparency ? "on" : "off";
    root.dataset.railAccent = settings.railAccent ? "on" : "off";
    writeJson("epc.theme", settings);
  }, [settings, deviceLight]);

  const value = useMemo<ThemeCtx>(() => ({
    settings,
    update: (patch) => setSettings((s) => ({ ...s, ...patch, ...(patch.accent ? { recentAccents: withRecent(s.recentAccents, patch.accent) } : {}) })),
    reset: () => setSettings((s) => ({ ...DEFAULT_THEME, recentAccents: s.recentAccents })),
  }), [settings]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The settings for parts that only read them (the rail), with the defaults where no provider is mounted (tests, previews). */
export function useThemeSettings(): ThemeSettings {
  return useContext(Ctx)?.settings ?? DEFAULT_THEME;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme outside ThemeProvider");
  return v;
}
