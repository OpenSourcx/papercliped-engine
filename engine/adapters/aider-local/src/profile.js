export const AIDER_VERSION = "0.86.2";

/**
 * Small-device defaults are intentionally conservative. The 8 GB tier is the
 * reference Jetson Orin Nano Super profile; larger devices may use more context
 * but this lane never grows beyond three editable files without an explicit
 * future design change.
 */
export function profileForMemory(memMb) {
  if (!Number.isFinite(memMb) || memMb < 3072) {
    throw new Error(`Aider small-device lane needs at least 3 GiB of memory; detected ${Math.round(memMb || 0)} MiB.`);
  }
  if (memMb < 6144) {
    return {
      tier: "4gb",
      minMemMb: 3072,
      model: "qwen2.5-coder:3b",
      aiderModel: "ollama_chat/qwen2.5-coder:3b",
      editFormat: "whole",
      numCtx: 8192,
      mapTokens: 512,
      maxEditableFiles: 1,
    };
  }
  if (memMb < 12288) {
    return {
      tier: "8gb",
      minMemMb: 6144,
      model: "qwen2.5-coder:7b",
      aiderModel: "ollama_chat/qwen2.5-coder:7b",
      editFormat: "diff",
      numCtx: 8192,
      mapTokens: 768,
      maxEditableFiles: 3,
    };
  }
  return {
    tier: "12gb+",
    minMemMb: 12288,
    model: "qwen2.5-coder:7b",
    aiderModel: "ollama_chat/qwen2.5-coder:7b",
    editFormat: "diff",
    numCtx: 16384,
    mapTokens: 1024,
    maxEditableFiles: 3,
  };
}

export function modelSettingsYaml(profile) {
  return [
    `- name: ${profile.aiderModel}`,
    "  extra_params:",
    `    num_ctx: ${profile.numCtx}`,
    "",
  ].join("\n");
}

/** Aider prints token summaries such as "Tokens: 1.2k sent, 345 received". */
export function parseAiderTokens(text) {
  let inputTokens = 0;
  let outputTokens = 0;
  const count = (raw) => {
    const m = /^([0-9]+(?:\.[0-9]+)?)([kKmM]?)$/.exec(raw.trim());
    if (!m) return 0;
    const n = Number(m[1]);
    const mult = m[2].toLowerCase() === "k" ? 1000 : m[2].toLowerCase() === "m" ? 1_000_000 : 1;
    return Math.round(n * mult);
  };
  for (const m of text.matchAll(/Tokens:\s*([0-9.]+[kKmM]?)\s+sent,\s*([0-9.]+[kKmM]?)\s+received/gi)) {
    inputTokens += count(m[1]);
    outputTokens += count(m[2]);
  }
  return { inputTokens, outputTokens };
}

export async function probeOllama(baseUrl, fetchFn = fetch) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new Error("Ollama endpoint must start with http:// or https://");
  const r = await fetchFn(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`Ollama answered ${r.status}`);
  const body = await r.json();
  const models = Array.isArray(body?.models) ? body.models.map((m) => String(m?.name || m?.model || "")).filter(Boolean) : [];
  return { baseUrl: base, models };
}
