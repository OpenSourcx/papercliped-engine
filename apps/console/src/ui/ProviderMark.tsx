import { BrandMark } from "./BrandMark.tsx";

/** A provider's official mark (or a labelled generic glyph for an unknown or custom one) in a tile. */
export function ProviderMark({ id, name }: { id: string; name: string }) {
  return <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-2"><BrandMark id={id} name={name} size={20} /></span>;
}
