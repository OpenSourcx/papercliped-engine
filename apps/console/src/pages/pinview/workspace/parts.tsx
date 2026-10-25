import type { ReactNode } from "react";

/** The heading of a side panel view: an uppercase label like an editor's, with its actions on the right. */
export function SideHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="h-10 shrink-0 flex items-center gap-1 pl-4 pr-2">
      <h2 className="flex-1 min-w-0 truncate text-micro font-semibold uppercase tracking-label text-ink-3">{title}</h2>
      {actions}
    </div>
  );
}

/** A small square icon button for headers and bars. The label becomes its name and tooltip. */
export function BarButton({ label, onClick, children, pressed, disabled, badge }: { label: string; onClick: () => void; children: ReactNode; pressed?: boolean; disabled?: boolean; badge?: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}
      className={`transition-control relative h-7 w-7 rounded-md flex items-center justify-center hover:bg-surface-2 disabled:opacity-40 ${pressed ? "text-ink bg-surface-2" : "text-ink-3 hover:text-ink"}`}>
      {children}{badge}
    </button>
  );
}
