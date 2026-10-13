import { describe, expect, it, vi } from "vitest";

// A public-looking name that resolves to this network (or rebinds there): the answer, not the name, is what's checked.
vi.mock("node:dns", () => ({
  lookup: (host: string, _o: unknown, cb: (e: Error | null, l?: { address: string; family: number }[]) => void) =>
    host === "rebind.example.com" ? cb(null, [{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }]) : host === "evil.example.com" ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(new Error("no such host")),
}));
import { fetchVendorText, isPrivateAddress } from "../src/vendorFetch.ts";

describe("vendor fetching limits", () => {
  it("refuses anything but https, and addresses on this network", async () => {
    await expect(fetchVendorText("http://example.com/sums")).rejects.toThrow(/https/);
    await expect(fetchVendorText("https://127.0.0.1/sums")).rejects.toThrow(/network/);
    await expect(fetchVendorText("https://[::1]/sums")).rejects.toThrow(/network/);
    await expect(fetchVendorText("https://localhost/sums")).rejects.toThrow(/network/);
    await expect(fetchVendorText("https://printer.local/sums")).rejects.toThrow(/network/);
    await expect(fetchVendorText("not a url")).rejects.toThrow();
  });

  it("can't be pointed at this network by spelling the name differently", async () => {
    for (const u of ["https://localhost./sums", "https://LOCALHOST/sums", "https://app.localhost/sums", "https://nas/sums", "https://router.lan/sums", "https://db.internal/sums", "https://x.home.arpa/sums", "https://2130706433/sums", "https://0x7f.1/sums", "https://[::ffff:127.0.0.1]/sums", "https://127.1/sums"])
      await expect(fetchVendorText(u), u).rejects.toThrow(/network/);
  });

  it("recognises addresses that are never a public vendor, including after a DNS answer", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd12::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "nonsense"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.63.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses a public-looking name whose DNS answer is on this network", async () => {
    await expect(fetchVendorText("https://evil.example.com/sums")).rejects.toThrow(/network/);
    // One bad answer among good ones is enough to refuse (a rebind to the metadata address).
    await expect(fetchVendorText("https://rebind.example.com/sums")).rejects.toThrow(/network/);
  });
});
