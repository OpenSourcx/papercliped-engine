import type { ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { cn } from "../../../lib/storage.ts";
import { Button, Input, Toggle, selectClass, Select } from "../../../ui/primitives.tsx";

/** Small building blocks the wizard steps share. Tokens only; the shared form primitives do the rest. */

export function Grid({ children, cols = 2, className }: { children: ReactNode; cols?: 1 | 2 | 3; className?: string }) {
  return <div className={cn("grid grid-cols-1 gap-x-4 gap-y-4", cols === 2 && "sm:grid-cols-2", cols === 3 && "sm:grid-cols-3", className)}>{children}</div>;
}

export function Section({ title, hint, action, children }: { title: string; hint?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-compact font-semibold text-ink">{title}</h3>
          {hint && <p className="text-xs text-ink-3 mt-0.5 text-pretty">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A label and explanation on the left, a switch on the right. */
export function SwitchRow({ label, hint, checked, onChange, disabled }: { label: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className={cn("flex items-center gap-4 rounded-lg border border-line px-3.5 py-3", disabled && "opacity-60")}>
      <div className="min-w-0 flex-1">
        <div className="text-compact font-medium text-ink">{label}</div>
        {hint && <div className="text-xs text-ink-3 mt-0.5 text-pretty">{hint}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );
}

export function Num({ value, onChange, id, placeholder, suffix, min, max }: { value: string; onChange: (v: string) => void; id?: string; placeholder?: string; suffix?: string; min?: number; max?: number }) {
  return (
    <div className="relative">
      <Input id={id} value={value} inputMode="decimal" onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))} placeholder={placeholder} aria-valuemin={min} aria-valuemax={max} className={cn("tabular-nums", suffix && "pr-14")} />
      {suffix && <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-ink-3">{suffix}</span>}
    </div>
  );
}

export function Pick<T extends string>({ value, onChange, options, id, disabled }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; disabled?: boolean }[]; id?: string; disabled?: boolean }) {
  return (
    <Select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
    </Select>
  );
}

/** One row of a repeating list (a disk, a network device): a header with a remove button, then the fields. */
export function ListItem({ title, onRemove, removeLabel, children }: { title: ReactNode; onRemove?: () => void; removeLabel: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-line p-4 space-y-4">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 text-compact font-medium text-ink">{title}</div>
        {onRemove && (
          <Button variant="ghost" size="sm" onClick={onRemove} aria-label={removeLabel}><Trash2 className="h-3.5 w-3.5" />Remove</Button>
        )}
      </div>
      {children}
    </div>
  );
}

export function AddButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <Button variant="secondary" size="sm" onClick={onClick} disabled={disabled}><Plus className="h-3.5 w-3.5" />{children}</Button>;
}

/** Moves a list item out of an array by id, immutably. */
export const without = <T extends { id: number }>(l: T[], id: number) => l.filter((x) => x.id !== id);
export const patch = <T extends { id: number }>(l: T[], id: number, p: Partial<T>) => l.map((x) => (x.id === id ? { ...x, ...p } : x));
