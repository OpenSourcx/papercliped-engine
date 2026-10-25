import { forwardRef, useId, type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, CirclePause, Info, Loader2, XCircle } from "lucide-react";
import { cn } from "../lib/storage.ts";
import { useInModal } from "./Modal.tsx";

/*
 * ePaperclip's primitives: one component per job (see apps/console/DESIGN.md, "Component inventory"). Every value here
 * is a token from index.css. Variants are props, never new components.
 */

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const buttonBase = "transition-control inline-flex items-center justify-center gap-2 font-medium select-none whitespace-nowrap active:scale-98 disabled:opacity-45 disabled:pointer-events-none";
const buttonSize: Record<Size, string> = {
  sm: "h-8 px-3 text-compact rounded-md",
  md: "h-10 px-4 text-sm rounded-lg",
  lg: "h-11 px-6 text-body rounded-full",
};
const buttonVariant: Record<Variant, string> = {
  primary: "bg-primary text-primary-ink shadow-raised hover:opacity-90",
  secondary: "bg-surface-2 text-ink border border-line hover:bg-surface-3 hover:border-line-strong",
  ghost: "text-ink-2 hover:text-ink hover:bg-surface-2",
  danger: "bg-critical/12 text-critical border border-critical/30 hover:bg-critical/20",
};

/** Buttons name the action ("Create machine", not "Submit"). One primary per view. */
export function Button({ variant = "secondary", size = "md", loading, className, children, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean }) {
  return (
    <button {...rest} disabled={disabled || loading} aria-busy={loading || undefined} className={cn(buttonBase, buttonSize[size], buttonVariant[variant], className)}>
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

/** A button holding only an icon. `bare` is the workspace's icon control: no box until hovered, `pressed` fills it while what it opens is open. The label is required: it becomes the accessible name and the tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: "xs" | "sm" | "md"; variant?: "bare" | "ghost" | "secondary"; pressed?: boolean }>(function IconButton(
  { label, size = "md", variant = "ghost", pressed, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      {...rest}
      className={cn(
        "transition-control relative inline-flex items-center justify-center shrink-0 disabled:opacity-40 disabled:pointer-events-none",
        variant === "bare" ? "rounded-md" : "rounded-full",
        size === "xs" ? "h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11" : size === "sm" ? "h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11" : "h-10 w-10",
        variant === "secondary" ? "bg-surface-2 text-ink-2 border border-line hover:bg-surface-3 hover:text-ink" : "text-ink-3 hover:text-ink hover:bg-surface-2 aria-pressed:bg-surface-3 aria-pressed:text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
});

export function Card({ className, children, interactive, style }: { className?: string; children: ReactNode; interactive?: boolean; style?: CSSProperties }) {
  return <div style={style} className={cn("relative rounded-xl border border-line bg-surface", interactive && "transition-control hover:border-line-strong hover:bg-surface-2", className)}>{children}</div>;
}

/** A small uppercase label over a group. Hierarchy comes from position and weight, not from boxes. */
export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3 min-h-8">
      <h2 className="text-compact font-semibold uppercase tracking-label text-ink-3">{children}</h2>
      {action}
    </div>
  );
}

/** A page's outer frame: roomy and centered as a main view, flush inside a modal. */
export function PageFrame({ width = "6xl", className, children }: { width?: "3xl" | "4xl" | "6xl"; className?: string; children: ReactNode }) {
  const inModal = useInModal();
  if (inModal) return <div className={cn("min-w-0", className)}>{children}</div>;
  return <div className={cn("mx-auto min-w-0 px-4 sm:px-6 pt-20 sm:pt-24 pb-20", width === "3xl" ? "max-w-3xl" : width === "4xl" ? "max-w-4xl" : "max-w-6xl", className)}>{children}</div>;
}

export function PageHeader({ title, subtitle, actions, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  const inModal = useInModal();
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-4 gap-y-3", inModal ? "mb-6" : "mb-8")}>
      <div className="min-w-0 flex-1 basis-64">
        {eyebrow && <div className="text-compact text-ink-3 mb-1.5">{eyebrow}</div>}
        <h1 className={cn("font-semibold tracking-tight text-balance", inModal ? "text-title" : "text-heading sm:text-display")}>{title}</h1>
        {subtitle && <p className="text-ink-2 mt-1.5 text-body max-w-2xl text-pretty">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ── Forms ─────────────────────────────────────────────────────────────────────────── */

/** The one recipe for text fields, selects and text areas: same height, fill, border and focus ring. */
export const controlClass = "transition-control w-full rounded-lg bg-surface-2 border border-line text-sm text-ink placeholder:text-ink-3 outline-none hover:border-line-strong focus:border-line-strong focus-visible:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50";
export const selectClass = cn(controlClass, "h-10 px-3");

/** A labelled field: the label, the control, then a hint or an error that says what to do. */
export function Field({ label, hint, error, children, className, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <label htmlFor={htmlFor} className="block text-compact font-medium text-ink-2 mb-1.5">{label}</label>
      {children}
      {error ? <p role="alert" className="text-xs text-critical mt-1.5">{error}</p> : hint ? <p className="text-xs text-ink-3 mt-1.5">{hint}</p> : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { size?: "md" | "lg" }>(function Input({ className, size = "md", ...rest }, ref) {
  return <input ref={ref} {...rest} className={cn(controlClass, size === "lg" ? "h-12 px-4 text-body rounded-xl" : "h-10 px-3", className)} />;
});

export { Select } from "./Select.tsx";
export { Slider } from "./Slider.tsx";
export { ColorPicker } from "./ColorPicker.tsx";
export { Menu, type MenuEntry } from "./Menu.tsx";
export { ResizeHandle } from "./ResizeHandle.tsx";

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cn(controlClass, "px-3 py-2.5 leading-relaxed resize-y min-h-24", className)} />;
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn("transition-control relative inline-flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 disabled:opacity-40", checked ? "bg-accent" : "bg-surface-3")}
    >
      <span aria-hidden className={cn("h-5 w-5 rounded-full bg-on-status shadow-raised transition-transform duration-(--duration-base) ease-spring", checked ? "translate-x-4" : "translate-x-0")} />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size = "md", label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; size?: "sm" | "md"; label?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full overflow-x-auto edge-fade-x [scrollbar-width:none] rounded-full bg-surface-2 border border-line p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("transition-control shrink-0 rounded-full font-medium whitespace-nowrap", size === "sm" ? "px-2.5 h-7 text-xs" : "px-3.5 h-8 text-compact", value === o.value ? "bg-surface-3 text-ink shadow-raised" : "text-ink-3 hover:text-ink")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Underlined tabs for a page's sections. Scrolls sideways on a phone instead of wrapping. */
/** A strip of tabs. By default it scrolls sideways; with `wrap` a long strip flows onto more rows so every tab stays visible (use it where there are many). */
export function Tabs<T extends string>({ value, tabs, onChange, className, wrap }: { value: T; tabs: { id: T; label: ReactNode; count?: number }[]; onChange: (v: T) => void; className?: string; wrap?: boolean }) {
  return (
    <div role="tablist" className={cn("flex gap-1 border-b border-line", wrap ? "flex-wrap" : "overflow-x-auto overflow-y-hidden edge-fade-x [scrollbar-width:none]", className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cn("transition-control inline-flex items-center gap-1.5 px-3.5 h-10 text-sm whitespace-nowrap border-b-2 -mb-px", value === t.id ? "border-accent text-ink font-medium" : "border-transparent text-ink-3 hover:text-ink")}
        >
          {t.label}
          {t.count ? <span className="text-micro tabular-nums text-ink-3">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/* ── Identity and status ───────────────────────────────────────────────────────────── */

/** Initials on a stable identity hue. Used for people, organizations and apps. */
export function Avatar({ name, hue, size = 32, className }: { name: string; hue: number; size?: number; className?: string }) {
  const initials = name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <span aria-hidden className={cn("identity inline-flex items-center justify-center rounded-squircle font-semibold shrink-0", className)} style={{ width: size, height: size, fontSize: size * 0.38, "--hue": hue } as CSSProperties}>
      {initials}
    </span>
  );
}

/**
 * The status vocabulary. Status always pairs an icon with a label, so state never rides on colour alone:
 *   good      running, connected, done          green check
 *   working   in progress, a task running       blue spinner (liveness is always blue)
 *   idle      nothing to do                     grey dashed ring
 *   off       stopped, switched off             grey dashed ring
 *   paused    paused, waiting                   amber pause
 *   warning   needs setup, needs attention      amber triangle
 *   critical  failed, error, unreachable        red cross
 */
export type StatusKind = "good" | "idle" | "working" | "warning" | "critical" | "paused" | "off";

const STATUS_ICON: Record<StatusKind, ReactNode> = {
  good: <CheckCircle2 className="h-3.5 w-3.5 text-good" />,
  working: <Loader2 className="h-3.5 w-3.5 text-live animate-spin-slow" />,
  idle: <CircleDashed className="h-3.5 w-3.5 text-ink-3" />,
  paused: <CirclePause className="h-3.5 w-3.5 text-warning" />,
  warning: <AlertTriangle className="h-3.5 w-3.5 text-warning" />,
  critical: <XCircle className="h-3.5 w-3.5 text-critical" />,
  off: <CircleDashed className="h-3.5 w-3.5 text-ink-3" />,
};

export function Status({ kind, label, className }: { kind: StatusKind; label: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-compact text-ink-2 whitespace-nowrap", className)}>
      <span className="shrink-0" aria-hidden>{STATUS_ICON[kind]}</span>
      {label}
    </span>
  );
}

/** A dot for dense places (sidebars, rails): solid when on, a hollow ring when off. Shape carries the state. */
export function StatusDot({ kind, label, className }: { kind: StatusKind; label: string; className?: string }) {
  const solid = kind === "good" || kind === "working" || kind === "warning" || kind === "critical" || kind === "paused";
  const tone = { good: "bg-good", working: "bg-live", warning: "bg-warning", paused: "bg-warning", critical: "bg-critical", idle: "", off: "" }[kind];
  return <span role="img" aria-label={label} className={cn("inline-block h-2 w-2 rounded-full shrink-0", solid ? tone : "ring-1 ring-inset ring-ink-3", className)} />;
}

type Tone = "neutral" | "accent" | "warning" | "good" | "critical" | "live";
const CHIP_TONE: Record<Tone, string> = {
  neutral: "bg-surface-2 text-ink-2 border-line",
  accent: "bg-accent-soft text-accent border-accent/25",
  warning: "bg-warning/10 text-warning border-warning/25",
  good: "bg-good/10 text-good border-good/25",
  critical: "bg-critical/10 text-critical border-critical/25",
  live: "bg-live/10 text-live border-live/25",
};

export function Chip({ children, tone = "neutral", className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 h-5 text-micro font-medium border whitespace-nowrap", CHIP_TONE[tone], className)}>{children}</span>;
}

/* ── Feedback ──────────────────────────────────────────────────────────────────────── */

/** Empty states say what this is for and what to do first. */
export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center py-14 px-6">
      <div className="h-11 w-11 rounded-xl bg-surface-2 border border-line flex items-center justify-center text-ink-2 mb-4">{icon}</div>
      <div className="font-medium text-balance">{title}</div>
      <p className="text-ink-3 text-sm mt-1 max-w-sm text-pretty">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** A calm inline message: what happened and what to do, with the fix as an action. Never a toast for local state. */
export function Notice({ tone = "info", title, children, action, className }: { tone?: "info" | "warning" | "critical" | "good"; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  const icon = { info: <Info className="h-4 w-4 text-ink-3" />, warning: <AlertTriangle className="h-4 w-4 text-warning" />, critical: <XCircle className="h-4 w-4 text-critical" />, good: <CheckCircle2 className="h-4 w-4 text-good" /> }[tone];
  return (
    <div role={tone === "critical" ? "alert" : "status"} className={cn("flex items-start gap-3 rounded-lg border px-3.5 py-3", tone === "info" ? "border-line bg-surface-2/60" : tone === "warning" ? "border-warning/25 bg-warning/5" : tone === "critical" ? "border-critical/25 bg-critical/5" : "border-good/25 bg-good/5", className)}>
      <span className="mt-0.5 shrink-0" aria-hidden>{icon}</span>
      <div className="min-w-0 flex-1 text-compact text-ink-2">
        {title && <div className="font-medium text-ink">{title}</div>}
        {children}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("skeleton block h-4", className)} />;
}

export function Spinner({ label = "Loading", className }: { label?: string; className?: string }) {
  return (
    <span role="status" className={cn("inline-flex items-center gap-2 text-compact text-ink-3", className)}>
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      <span>{label}</span>
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex items-center h-5 min-w-5 justify-center rounded-sm border border-line bg-surface-2 px-1 font-mono text-micro text-ink-3">{children}</kbd>;
}

/** A label tied to a control without wrapping it, for rows where the control sits on the far side. */
export function useFieldId(prefix = "f") {
  return `${prefix}-${useId()}`;
}
