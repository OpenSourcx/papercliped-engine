import { describe, expect, it } from "vitest";
import { proxmoxVersion } from "../src/lib/version.ts";

describe("proxmoxVersion", () => {
  it("shows the version people mean, without the package name and build hash", () => {
    expect(proxmoxVersion("pve-manager/9.2.3/d0fde103346cf89a")).toBe("9.2.3");
    expect(proxmoxVersion("pve-manager/8.4.1/2a5fa54a8503f96d (running kernel: 6.8.12-9-pve)")).toBe("8.4.1");
    expect(proxmoxVersion("9.2.3")).toBe("9.2.3");
    expect(proxmoxVersion("8.4")).toBe("8.4");
  });
  it("copes with nothing, and never returns a long unbroken string", () => {
    expect(proxmoxVersion(null)).toBe("");
    expect(proxmoxVersion(undefined)).toBe("");
    expect(proxmoxVersion("some-unrecognised-build-string-with-no-numbers-in-it")).toHaveLength(25);
  });
});
