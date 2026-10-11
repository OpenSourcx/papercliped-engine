import { describe, expect, it } from "vitest";
import { fetchVendorText } from "../src/vendorFetch.ts";

describe("vendor fetching limits", () => {
  it("refuses anything but https, and addresses on this network", async () => {
    await expect(fetchVendorText("http://example.com/sums")).rejects.toThrow(/https/);
    await expect(fetchVendorText("https://127.0.0.1/sums")).rejects.toThrow(/network/);
    await expect(fetchVendorText("https://[::1]/sums")).rejects.toThrow(/network/);
    await expect(fetchVendorText("https://localhost/sums")).rejects.toThrow(/network/);
    await expect(fetchVendorText("https://printer.local/sums")).rejects.toThrow(/network/);
    await expect(fetchVendorText("not a url")).rejects.toThrow();
  });
});
