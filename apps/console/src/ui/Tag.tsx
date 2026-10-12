import type { CSSProperties } from "react";

/** A Proxmox tag: its name on a stable identity hue (a hash of the name), so the same tag always looks the same. */
export function Tag({ name }: { name: string }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className="identity inline-flex items-center h-5 px-1.5 rounded-sm text-micro font-medium whitespace-nowrap" style={{ "--hue": h } as CSSProperties}>
      {name}
    </span>
  );
}
