import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseMeminfo } from "../src/memory.ts";
import { commandEnvironment, inferenceEnvironment } from "../src/environment.ts";
import { qualifyCoding, readQualifications, type QualificationExec } from "../src/qualification.ts";
import { type Capabilities } from "@papercliped-engine/worker-fabric";
import { networks, runningModels } from "../src/caps.ts";

const caps: Capabilities = {
  os: { name: "Ubuntu", version: "24" }, arch: "arm64", hostname: "orion",
  memMb: 7475, memory: { availableMb: 5530, swapTotalMb: 4096, swapUsedMb: 124 },
  cpu: { model: "Orin", cores: 6 }, gpu: { present: true, kind: "jetson" }, storage: [],
  tools: { aider: "0.86.2", python: "3.10" }, networks: [], workspaceRoot: "/tmp",
  execution: { user: "worker", uid: 2002, shellSlots: 1, reserveMemoryMb: 1495 },
  inference: { runtime: "ollama", url: "http://raw:11434", maxContext: 4096, models: [{ name: "qwen2.5-coder:3b", digest: "sha3" }, { name: "qwen2.5-coder:7b", digest: "sha7" }] },
};
const health = (async () => new Response(JSON.stringify({ gate: true, maxContext: 4096, running: 0, queued: 0 }))) as typeof fetch;

describe("worker readiness", () => {
  it("uses reclaimable Linux MemAvailable and keeps swap separate", () => {
    expect(parseMeminfo("MemTotal: 7654400 kB\nMemFree: 115712 kB\nMemAvailable: 382976 kB\nSwapTotal: 4194304 kB\nSwapFree: 4067328 kB\n"))
      .toEqual({ totalMb: 7475, availableMb: 374, swapTotalMb: 4096, swapUsedMb: 124 });
    expect(parseMeminfo("MemTotal: 7654400 kB\nMemFree: 115712 kB\n").availableMb).toBeNull();
  });
  it("continues when Linux denies network interface enumeration", () => {
    expect(networks(null, () => { throw new Error("EPERM"); })).toEqual([]);
  });
  it("pins Ollama and Aider to one gate without replacing cloud endpoints", () => {
    const env = commandEnvironment(inferenceEnvironment(11435), { OLLAMA_HOST: "http://raw:11434", OLLAMA_API_BASE: "http://raw:11434", OPENAI_BASE_URL: "https://openrouter.ai/api/v1" });
    expect(env.OLLAMA_API_BASE).toBe("http://127.0.0.1:11435");
    expect(env.OLLAMA_HOST).toBe(env.OLLAMA_API_BASE);
    expect(env.EPAPERCLIP_OPENAI_BASE_URL).toBe("http://127.0.0.1:11435/v1");
    expect(env.OPENAI_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });
  it("counts resident shared RAM once and excludes dedicated VRAM from RAM credit", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:3b", digest: "sha3", size: 2200 * 1048576, size_vram: 2000 * 1048576, context_length: 4096 }] }))) as typeof fetch;
    expect((await runningModels(caps, fetchFn))[0]!.ramMb).toBe(2200);
    expect((await runningModels({ ...caps, gpu: { present: true, kind: "nvidia" } }, fetchFn))[0]!.ramMb).toBe(200);
  });
  it.each(["correct", "broken", "tampered"])("records %s coding results using real Python tests and unchanged test input", async (kind) => {
    const dir = mkdtempSync(join(tmpdir(), "epw-test-"));
    const execute: QualificationExec = async (command, args, cwd, env) => {
      if (command === "aider") {
        expect(env.OLLAMA_API_BASE).toBe("http://127.0.0.1:11435");
        expect(args).toContain("--no-auto-test");
        writeFileSync(join(cwd, "slug.py"), `import re\ndef slugify(text):\n    text = re.sub(r'[^a-z0-9]${kind === "broken" ? "" : "+"}', '-', text.lower()).strip('-')\n    if not text: raise ValueError('empty')\n    return text\n`);
        if (kind === "tampered") writeFileSync(join(cwd, "test_slug.py"), "# no tests\n");
        return { ok: true, output: "model output" };
      }
      return new Promise((resolve) => execFile(command, args, { cwd, env }, (e, out, err) => resolve({ ok: !e, output: out + err })));
    };
    try {
      const result = await qualifyCoding({ dir, caps, model: "qwen2.5-coder:3b", gatePort: 11435, execute, fetchFn: health });
      expect(result.passed).toBe(kind === "correct");
      expect(result.executedAs).toBe("2002:worker");
      expect(readQualifications(dir)).toEqual([result]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("refuses 7B on Orion despite swap and never loads it", async () => {
    await expect(qualifyCoding({ dir: "/unused", caps, model: "qwen2.5-coder:7b", gatePort: 11435 })).rejects.toThrow(/physical memory/);
  });
  it("refuses to qualify through an ordinary Ollama listener", async () => {
    await expect(qualifyCoding({ dir: "/unused", caps, model: "qwen2.5-coder:3b", gatePort: 11434, fetchFn: (async () => new Response('{}')) as typeof fetch })).rejects.toThrow(/gate/);
  });
});
