import type { ReactNode } from "react";
import { IconButton } from "../../../ui/primitives.tsx";

/** The heading of a side panel view: an uppercase label like an editor's, with its actions on the right. */
export function SideHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="h-9 shrink-0 flex items-center gap-0.5 pl-4 pr-2">
      <h2 className="flex-1 min-w-0 truncate text-micro font-semibold uppercase tracking-label text-ink-3">{title}</h2>
      {actions}
    </div>
  );
}

/** A bare icon button for headers and bars (kept for callers; it is the shared IconButton). */
export function BarButton({ label, onClick, children, pressed, disabled }: { label: string; onClick: () => void; children: ReactNode; pressed?: boolean; disabled?: boolean; badge?: ReactNode }) {
  return <IconButton variant="bare" size="xs" label={label} pressed={pressed} disabled={disabled} onClick={onClick}>{children}</IconButton>;
}
