import { describe, expect, it } from "vitest";
import type { Capabilities } from "@papercliped-engine/worker-fabric";
import { bestModel, recommendModels, usableMemory } from "@papercliped-engine/worker-fabric";

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  os: { name: "Debian", version: "12" },
  arch: "amd64",
  hostname: "worker",
  cpu: { model: "test", cores: 8 },
  memMb: 16_384,
  gpu: { present: false },
  storage: [{ path: "/", totalGb: 200, freeGb: 100 }],
  tools: {},
  inference: null,
  networks: [],
  workspaceRoot: "/workspaces",
  ...over,
});

describe("worker model recommendations", () => {
  it("uses the GPU when it has enough VRAM, and CPU otherwise", () => {
    expect(usableMemory(caps({ gpu: { present: true, kind: "nvidia", vramMb: 8192 } })).vramGb).toBe(8);
    const gpu = recommendModels(caps({ gpu: { present: true, kind: "nvidia", vramMb: 8192 } }));
    expect(gpu.some((r) => r.fit === "gpu" && r.spec.id.includes("8b"))).toBe(true);
    const cpu = recommendModels(caps());
    expect(cpu.some((r) => r.fit === "cpu")).toBe(true);
    expect(cpu.every((r) => r.fit !== "gpu")).toBe(true);
  });

  it("never suggests a model that does not fit the disk", () => {
    const tiny = caps({ storage: [{ path: "/", totalGb: 8, freeGb: 4 }] });
    const recs = recommendModels(tiny, { limit: 100 });
    expect(recs.find((r) => r.spec.id === "llama3.1:70b")!.fit).toBe("too_big");
    expect(recs.find((r) => r.spec.id === "qwen2.5:0.5b")!.fit).not.toBe("too_big");
  });

  it("picks a sensible first pull", () => {
    expect(bestModel(caps()).fit).not.toBe("too_big");
    expect(bestModel(caps({ gpu: { present: true, kind: "nvidia", vramMb: 8192 } })).fit).toBe("gpu");
  });
});
