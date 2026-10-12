import { qrcodegen } from "../../vendor/qrcodegen.js";

/**
 * A QR code drawn in the browser as inline SVG: nothing is sent anywhere, and no script or style needs loading, so the
 * strict content policy holds. The encoder is Project Nayuki's QR Code generator (MIT), vendored in src/vendor.
 */
export function qrPath(text: string): { size: number; d: string } {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) parts.push(`M${x},${y}h1v1h-1z`);
  return { size: qr.size, d: parts.join("") };
}

/** Dark modules on a light field in every theme (scanners expect that): the light is --on-status, the dark is --screen. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, d } = qrPath(text);
  const full = size + 8; // a 4-module quiet zone around the code
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${full} ${full}`} className="h-48 w-48 rounded-lg" shapeRendering="crispEdges">
      <rect width={full} height={full} className="fill-(--on-status)" />
      <path d={d} transform="translate(4 4)" className="fill-(--screen)" />
    </svg>
  );
}
