import { describe, expect, it } from "vitest";
import { recommendModels } from "@papercliped-engine/worker-fabric";
import { defaultDirs, ollamaInstall, pidsWithEnvTag } from "../src/platform.ts";

describe("platform defaults", () => {
  it("keeps the Linux locations and gives a Mac its own folders", () => {
    expect(defaultDirs("linux", "/home/sam")).toEqual({ data: "/var/lib/epaperclip-worker", workspaces: "/workspaces" });
    expect(defaultDirs("darwin", "/Users/sam")).toEqual({ data: "/Users/sam/Library/Application Support/epaperclip-worker", workspaces: "/Users/sam/epaperclip-workspaces" });
  });

  it("installs Ollama the way each OS does it", () => {
    expect(ollamaInstall("linux")).toMatchObject({ automatic: true, needsRoot: true, command: expect.stringContaining("install.sh") });
    expect(ollamaInstall("darwin", true)).toEqual({ command: "brew install ollama", automatic: true, needsRoot: false });
    const noBrew = ollamaInstall("darwin", false);
    expect(noBrew.automatic).toBe(false);
    expect(noBrew.command).toContain("https://ollama.com/download/mac");
  });

  it("finds processes by the lease tag in `ps eww` output, and never itself", () => {
    const ps = [
      "  101 /usr/bin/sleep 60 FOO=1 EPAPERCLIP_LEASE_OWNER=lease-a HOME=/Users/sam",
      "  102 /usr/bin/sleep 60 EPAPERCLIP_LEASE_OWNER=lease-ab HOME=/Users/sam",
      "  103 node server.js EPAPERCLIP_LEASE_OWNER=lease-a",
      "  104 /bin/zsh HOME=/Users/sam",
      "  999 node worker EPAPERCLIP_LEASE_OWNER=lease-a",
    ].join("\n");
    expect(pidsWithEnvTag(ps, "EPAPERCLIP_LEASE_OWNER=lease-a", 999)).toEqual([101, 103]);
  });
});

describe("Apple Silicon is a GPU worker", () => {
  it("recommends GPU-class models on a 16 GB Mac (unified memory)", () => {
    const caps = { memMb: 16384, arch: "arm64", gpu: { present: true, kind: "apple" as const, name: "Apple M2", vramMb: Math.round(16384 * 0.66) }, storage: [{ path: "/", totalGb: 500, freeGb: 300 }] };
    const r8b = recommendModels(caps).find((r) => r.spec.id === "llama3.1:8b");
    expect(r8b?.fit).toBe("gpu");
  });
});
