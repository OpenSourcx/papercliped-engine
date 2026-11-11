import type { Capabilities } from "@papercliped-engine/worker-fabric";

/**
 * A small, honest model catalogue for worker setup. Sizes are the Ollama download size and the
 * memory figures are conservative floors, not benchmarks. The recommender never promises a model
 * will be fast; it only says whether it fits the machine and whether it will run on the GPU or CPU.
 */
export interface ModelSpec {
  id: string;
  label: string;
  sizeGb: number;
  minRamGb: number;
  minVramGb: number;
  tags: ("chat" | "code" | "reasoning" | "embedding" | "small")[];
  note: string;
}

export const MODEL_CATALOG: ModelSpec[] = [
  { id: "qwen2.5:0.5b", label: "Qwen 2.5 0.5B", sizeGb: 0.4, minRamGb: 1, minVramGb: 1, tags: ["small", "chat"], note: "Tiny; good for smoke tests and low-power boxes." },
  { id: "llama3.2:1b", label: "Llama 3.2 1B", sizeGb: 1.3, minRamGb: 2, minVramGb: 2, note: "Fast small chat model; weak on hard reasoning.", tags: ["chat"] },
  { id: "llama3.2:3b", label: "Llama 3.2 3B", sizeGb: 2, minRamGb: 4, minVramGb: 3, tags: ["chat"], note: "Balanced small model; a good default on 4 GB GPUs and CPU-only workers." },
  { id: "qwen2.5-coder:7b", label: "Qwen 2.5 Coder 7B", sizeGb: 4.7, minRamGb: 8, minVramGb: 6, tags: ["code"], note: "Strong local coding model; needs a real GPU for good speed." },
  { id: "llama3.1:8b", label: "Llama 3.1 8B", sizeGb: 4.9, minRamGb: 8, minVramGb: 6, tags: ["chat"], note: "General assistant; the usual 8 GB GPU baseline." },
  { id: "deepseek-r1:8b", label: "DeepSeek R1 8B", sizeGb: 5.2, minRamGb: 10, minVramGb: 8, tags: ["reasoning"], note: "Reasoning-oriented; slower and more memory-hungry." },
  { id: "qwen2.5:14b", label: "Qwen 2.5 14B", sizeGb: 9, minRamGb: 16, minVramGb: 12, tags: ["chat", "reasoning"], note: "Noticeably stronger; wants 12 GB+ VRAM." },
  { id: "llama3.1:70b", label: "Llama 3.1 70B", sizeGb: 40, minRamGb: 64, minVramGb: 48, tags: ["chat", "reasoning"], note: "Server-class; not practical on a desktop worker." },
  { id: "nomic-embed-text", label: "Nomic Embed Text", sizeGb: 0.3, minRamGb: 1, minVramGb: 1, tags: ["embedding", "small"], note: "Embeddings for search and memory; cheap." },
];

export interface ModelRecommendation {
  spec: ModelSpec;
  fit: "gpu" | "cpu" | "too_big";
  reason: string;
  command: string;
}

/** Memory the worker may use for a model without starving the OS and the ePaperclip worker itself. */
export function usableMemory(caps: Pick<Capabilities, "memMb" | "gpu">): { vramGb: number; ramGb: number } {
  const ramGb = Math.max(0, (caps.memMb / 1024) * 0.6);
  const vramGb = caps.gpu.present ? (caps.gpu.vramMb ? caps.gpu.vramMb / 1024 : ramGb * 0.5) : 0;
  return { vramGb, ramGb };
}

export function recommendModels(caps: Pick<Capabilities, "memMb" | "gpu" | "storage" | "arch">, opts: { limit?: number } = {}): ModelRecommendation[] {
  const { vramGb, ramGb } = usableMemory(caps);
  const freeGb = Math.max(0, ...caps.storage.map((s) => s.freeGb));
  const scored: ModelRecommendation[] = MODEL_CATALOG.map((spec) => {
    const disk = spec.sizeGb + 2 <= freeGb;
    const gpu = caps.gpu.present && vramGb >= spec.minVramGb;
    const cpu = ramGb >= spec.minRamGb;
    if (!disk) return { spec, fit: "too_big" as const, reason: `needs ~${Math.ceil(spec.sizeGb + 2)} GB free disk`, command: `ollama pull ${spec.id}` };
    if (gpu) return { spec, fit: "gpu" as const, reason: `fits ${Math.round(vramGb)} GB usable VRAM`, command: `ollama pull ${spec.id}` };
    if (cpu) return { spec, fit: "cpu" as const, reason: `fits ${Math.round(ramGb)} GB usable RAM; CPU inference is slower`, command: `ollama pull ${spec.id}` };
    return { spec, fit: "too_big" as const, reason: `needs more than ${Math.round(ramGb)} GB usable RAM`, command: `ollama pull ${spec.id}` };
  });
  const order = { gpu: 0, cpu: 1, too_big: 2 } as const;
  const fits = scored.filter((r) => r.fit !== "too_big").sort((a, b) => order[a.fit] - order[b.fit] || b.spec.sizeGb - a.spec.sizeGb);
  const tooBig = scored.filter((r) => r.fit === "too_big");
  return [...fits, ...tooBig].slice(0, opts.limit ?? 8);
}

/** The model we would pull first: the largest GPU fit, otherwise the largest CPU fit, otherwise the smallest. */
export function bestModel(caps: Pick<Capabilities, "memMb" | "gpu" | "storage" | "arch">): ModelRecommendation {
  const all = recommendModels(caps, { limit: MODEL_CATALOG.length });
  const gpu = all.find((r) => r.fit === "gpu");
  const cpu = all.find((r) => r.fit === "cpu");
  return gpu ?? cpu ?? all[all.length - 1]!;
}
