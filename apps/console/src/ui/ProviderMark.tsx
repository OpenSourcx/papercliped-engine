import { BRAND_ICONS } from "../data/brandIcons.ts";

/** Bundled provider artwork, with a monogram until a reviewed mark is available. */
export function ProviderMark({ id, name }: { id: string; name: string }) {
  // Slack artwork bundled from Paperclip's vendor artwork registry (ui/public/brands/apps/slack.svg).
  if (id === "slack") return <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2"><img src="/brands/slack.svg" width={20} height={20} alt={name} /></span>;
  const mark = BRAND_ICONS[id];
  return <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-2">
    {mark ? <svg viewBox="0 0 24 24" width={20} height={20} fill="currentColor" role="img" aria-label={name}><path d={mark.path} /></svg> : <span aria-label={name} className="text-xs font-semibold">{name.slice(0, 2)}</span>}
  </span>;
}
