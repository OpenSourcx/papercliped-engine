import type { Capabilities } from "./protocol.ts";

/** Physical memory budgets. Swap is deliberately never a source of capacity. */
export const DEFAULT_JOB_MEMORY_MB = 512;
export const CODING_PROFILES = {
  "qwen2.5-coder:1.5b": { memoryMb: 2048, maxContext: 2048 },
  "qwen2.5-coder:3b": { memoryMb: 3072, maxContext: 4096 },
  "qwen2.5-coder:7b": { memoryMb: 7168, maxContext: 4096 },
} as const;

export function workerLimits(c: Pick<Capabilities, "memMb" | "cpu">) {
  return {
    shellSlots: c.memMb <= 8192 ? 1 : Math.max(1, Math.min(8, Math.floor(c.cpu.cores / 2), Math.floor(c.memMb / 4096))),
    reserveMemoryMb: Math.max(1024, Math.ceil(c.memMb * 0.2)),
  };
}

export function codingProfile(model: string) {
  return CODING_PROFILES[model as keyof typeof CODING_PROFILES];
}
