import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Boxes, Building2, HardDrive, ListChecks } from "lucide-react";
import { useEngine } from "../../../data/store.tsx";
import { notesApi, type NoteLink } from "../../../data/engine/notesApi.ts";
import { Chip } from "../../../ui/primitives.tsx";

export const NOTES_KEY = ["notes"] as const;

export const useDevice = () => useEngine().setup?.deviceName ?? "pve";

/** Words for a time in the past. */
export const agoMs = (ms: number, now = Date.now()) => {
  const s = Math.max(0, (now - ms) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

const ICON = { machine: Boxes, storage: HardDrive, org: Building2, task: ListChecks } as const;

/** A link from a note to a machine, storage or organization, as a chip that opens it when the console has a page for it. */
export function LinkChip({ link, onRemove }: { link: NoteLink; onRemove?: () => void }) {
  const device = useDevice();
  const engine = useEngine();
  const Icon = ICON[link.kind];
  const org = link.kind === "org" ? engine.data.orgs.find((o) => o.engine?.companyId === link.id) : undefined;
  const to = link.kind === "machine" ? `/${device}/machines/${link.id}` : link.kind === "storage" ? `/${device}/storage/${encodeURIComponent(link.id)}` : org ? `/${device}/${org.slug}` : null;
  const body = <><Icon className="h-3 w-3" aria-hidden />{link.label}</>;
  return (
    <span className="inline-flex items-center gap-1">
      {to ? <Link to={to} className="transition-control inline-flex"><Chip tone="live" className="hover:bg-live/20">{body}</Chip></Link> : <Chip tone="live">{body}</Chip>}
      {onRemove && <button type="button" onClick={onRemove} aria-label={`Remove link to ${link.label}`} className="text-ink-3 hover:text-ink text-compact px-1">×</button>}
    </span>
  );
}

/** Machines, storage and organizations the person can link a note to (their own visible inventory). */
export function useLinkOptions(enabled = true) {
  return useQuery({ queryKey: [...NOTES_KEY, "options"], queryFn: notesApi.options, enabled, staleTime: 60_000 });
}
