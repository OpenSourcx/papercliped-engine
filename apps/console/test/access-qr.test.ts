import { describe, expect, it } from "vitest";
import { qrPath } from "../src/pages/access/qr.tsx";
import { base32, groupKey, newSecret, otpauthUri } from "../src/pages/access/totp.ts";

describe("authenticator setup helpers", () => {
  it("encodes base32 the way RFC 4648 does", () => {
    const text = (s: string) => base32(new TextEncoder().encode(s));
    expect(text("f")).toBe("MY");
    expect(text("fo")).toBe("MZXQ");
    expect(text("foobar")).toBe("MZXW6YTBOI");
  });

  it("makes a 32-character secret from the browser's random source, different every time", () => {
    const a = newSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(newSecret()).not.toBe(a);
    expect(groupKey(a).split(" ")).toHaveLength(8);
  });

  it("builds the otpauth link with a safe label", () => {
    const uri = otpauthUri({ secret: "JBSWY3DPEHPK3PXP", userid: "sam@pve", issuer: "Proxmox pve.lan" });
    expect(uri).toBe("otpauth://totp/Proxmox%20pve.lan:sam%40pve?secret=JBSWY3DPEHPK3PXP&period=30&digits=6&algorithm=SHA1&issuer=Proxmox%20pve.lan");
  });
});

describe("the vendored QR encoder", () => {
  it("draws a version-appropriate square with the finder patterns in the corners", () => {
    const { size, d } = qrPath("otpauth://totp/Proxmox:sam%40pve?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&period=30&digits=6&algorithm=SHA1&issuer=Proxmox");
    expect(size).toBeGreaterThanOrEqual(29);
    expect((size - 17) % 4).toBe(0);
    // The three finder patterns start with a 7-module dark bar on the first row at x = 0..6.
    for (let x = 0; x < 7; x++) expect(d).toContain(`M${x},0h1v1h-1z`);
    for (let x = size - 7; x < size; x++) expect(d).toContain(`M${x},0h1v1h-1z`);
    expect(d).not.toContain(`M${size},0`);
  });

  it("is deterministic", () => {
    expect(qrPath("hello").d).toBe(qrPath("hello").d);
    expect(qrPath("hello").d).not.toBe(qrPath("hellp").d);
  });
});
