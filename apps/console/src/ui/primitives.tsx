import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, CirclePause, Loader2, XCircle } from "lucide-react";
import { cn } from "../lib/storage.ts";

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({ variant = "secondary", size = "md", className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg" }) {
  return (
    <button
      {...rest}
      className={cn(
        "inline-flex items-center justify-center gap-2 font-medium transition-[background,color,box-shadow,transform] duration-150 active:scale-[0.98] disabled:opacity-45 disabled:pointer-events-none select-none whitespace-nowrap",
        size === "sm" && "h-8 px-3 text-[13px] rounded-md",
        size === "md" && "h-9 px-4 text-sm rounded-lg",
        size === "lg" && "h-11 px-6 text-[15px] rounded-full",
        variant === "primary" && "bg-primary text-primary-ink hover:brightness-95 shadow-sm",
        variant === "secondary" && "bg-surface-2 text-ink border border-line hover:bg-surface-3",
        variant === "ghost" && "text-ink-2 hover:text-ink hover:bg-surface-2",
        variant === "danger" && "bg-critical/15 text-critical border border-critical/30 hover:bg-critical/25",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Card({ className, children, interactive }: { className?: string; children: ReactNode; interactive?: boolean }) {
  return <div className={cn("rounded-xl border border-line bg-surface", interactive && "transition-[border-color,transform,background] hover:border-line-strong hover:bg-surface-2/60", className)}>{children}</div>;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3">
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-ink-3">{children}</h2>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
      <div className="min-w-0">
        {eyebrow && <div className="text-[13px] text-ink-3 mb-1.5">{eyebrow}</div>}
        <h1 className="text-[26px] sm:text-[30px] font-semibold tracking-tight leading-tight">{title}</h1>
        {subtitle && <p className="text-ink-2 mt-1.5 text-[15px] max-w-2xl">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cn("h-11 w-full rounded-lg bg-surface-2 border border-line px-3.5 text-[15px] text-ink placeholder:text-ink-3 outline-none focus:border-line-strong focus:ring-2 focus:ring-accent/30 transition", className)} />;
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
      className={cn("relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-40", checked ? "bg-accent" : "bg-surface-3")}
    >
      <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size = "md" }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; size?: "sm" | "md" }) {
  return (
    <div role="radiogroup" className="inline-flex rounded-full bg-surface-2 border border-line p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("rounded-full font-medium transition", size === "sm" ? "px-2.5 h-6 text-xs" : "px-3.5 h-8 text-[13px]", value === o.value ? "bg-surface-3 text-ink shadow-sm" : "text-ink-3 hover:text-ink-2")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Avatar({ name, hue, size = 32 }: { name: string; hue: number; size?: number }) {
  const initials = name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <span
      aria-hidden
      className="inline-flex items-center justify-center rounded-[30%] font-semibold shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.38, background: `oklch(0.42 0.09 ${hue})`, color: `oklch(0.95 0.03 ${hue})` }}
    >
      {initials}
    </span>
  );
}

/** Status always pairs an icon with a label, so state never rides on color alone. */
export type StatusKind = "good" | "idle" | "working" | "warning" | "critical" | "paused" | "off";

export function Status({ kind, label, className }: { kind: StatusKind; label: string; className?: string }) {
  const icon = {
    good: <CheckCircle2 className="h-3.5 w-3.5 text-good" />,
    working: <Loader2 className="h-3.5 w-3.5 text-good animate-[spin_2.4s_linear_infinite]" />,
    idle: <CircleDashed className="h-3.5 w-3.5 text-ink-3" />,
    paused: <CirclePause className="h-3.5 w-3.5 text-warning" />,
    warning: <AlertTriangle className="h-3.5 w-3.5 text-warning" />,
    critical: <XCircle className="h-3.5 w-3.5 text-critical" />,
    off: <CircleDashed className="h-3.5 w-3.5 text-ink-3" />,
  }[kind];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[13px] text-ink-2", className)}>
      {icon}
      {label}
    </span>
  );
}

export function Chip({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "accent" | "warning"; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 h-5 text-[11px] font-medium border",
        tone === "neutral" && "bg-surface-2 text-ink-2 border-line",
        tone === "accent" && "bg-accent-soft text-accent border-accent/25",
        tone === "warning" && "bg-warning/10 text-warning border-warning/25",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center py-14 px-6">
      <div className="h-11 w-11 rounded-xl bg-surface-2 border border-line flex items-center justify-center text-ink-2 mb-4">{icon}</div>
      <div className="font-medium">{title}</div>
      <p className="text-ink-3 text-sm mt-1 max-w-sm">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
