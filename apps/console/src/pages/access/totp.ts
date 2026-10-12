const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding: the form authenticator apps expect in an otpauth link. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** A fresh 160-bit secret, made here in the browser. */
export function newSecret(): string {
  return base32(crypto.getRandomValues(new Uint8Array(20)));
}

/** The otpauth link an authenticator app scans: SHA-1, 6 digits, 30 seconds, which every app and Proxmox support. */
export function otpauthUri(p: { secret: string; userid: string; issuer: string }): string {
  const label = `${encodeURIComponent(p.issuer)}:${encodeURIComponent(p.userid)}`;
  return `otpauth://totp/${label}?secret=${p.secret}&period=30&digits=6&algorithm=SHA1&issuer=${encodeURIComponent(p.issuer)}`;
}

/** Groups a setup key in fours so it can be typed: ABCD EFGH … */
export const groupKey = (secret: string) => secret.replace(/(.{4})/g, "$1 ").trim();
