import { cn } from "../lib/storage.ts";

/** Pin's mark: a slowly turning gradient orb. It turns faster and draws in slightly while Pin is thinking. */
export function PinOrb({ size = 22, thinking = false, className }: { size?: number; thinking?: boolean; className?: string }) {
  return <span aria-hidden className={cn("pin-orb", thinking && "thinking", className)} style={{ width: size, height: size }} />;
}
