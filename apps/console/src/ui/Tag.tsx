/** A Proxmox tag: its name, tinted by a hash of the name so the same tag always looks the same. Identity only. */
export function Tag({ name }: { name: string }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className="inline-flex items-center h-5 px-1.5 rounded text-[11px] font-medium whitespace-nowrap" style={{ background: `oklch(0.42 0.08 ${h})`, color: `oklch(0.96 0.02 ${h})` }}>
      {name}
    </span>
  );
}
